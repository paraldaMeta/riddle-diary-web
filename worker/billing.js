import {
  CREDIT_PACKAGES,
  MEMBERSHIP_PLANS,
  findMembershipPlan,
  findPackage,
  membershipPeriodSeconds,
} from './config.js';
import { requireDatabase, requireUser, userResponse } from './db.js';
import {
  RequestError,
  assertSameOrigin,
  hmacSha256,
  json,
  randomId,
  readJson,
  readText,
  safeEqual,
  unixNow,
} from './http.js';

function requireStripe(env) {
  if (!env.STRIPE_SECRET_KEY) throw new RequestError('充值服务尚未配置', 503, 'BILLING_UNAVAILABLE');
  return env.STRIPE_SECRET_KEY;
}

async function stripeRequest(env, path, options = {}) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${requireStripe(env)}`,
      ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: options.body ? options.body.toString() : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Stripe request failed', response.status, payload?.error?.code || 'unknown');
    throw new RequestError('支付服务暂时不可用，请稍后重试', 502, 'STRIPE_REQUEST_FAILED');
  }
  return payload;
}

async function createLegacyCheckout(request, env, item) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const origin = new URL(request.url).origin;
  const english = String(body.locale || '').toLowerCase().startsWith('en');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('client_reference_id', user.id);
  params.set('success_url', `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/?checkout=cancelled`);
  params.set('locale', 'zh');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', item.currency);
  params.set('line_items[0][price_data][unit_amount]', String(item.amount));
  params.set('line_items[0][price_data][product_data][name]', `地占解答书 ${item.credits} 次`);
  params.set('line_items[0][price_data][product_data][description]', '永久有效的提问次数，一次成功回答扣除一次');
  params.set('metadata[user_id]', user.id);
  params.set('metadata[package_id]', item.id);
  params.set('payment_intent_data[metadata][user_id]', user.id);
  params.set('payment_intent_data[metadata][package_id]', item.id);
  if (user.email) params.set('customer_email', user.email);
  const session = await stripeRequest(env, '/checkout/sessions', { method: 'POST', body: params });
  const now = unixNow();
  await requireDatabase(env).prepare(`
    INSERT OR IGNORE INTO payments
      (id, user_id, stripe_session_id, package_id, amount_cny, credits, status, customer_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(randomId('pay_'), user.id, session.id, item.id, item.amount, item.credits, user.email, now, now).run();
  return json({ checkoutUrl: session.url, sessionId: session.id });
}

async function createMembershipCheckout(request, env, plan, body) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  const existing = await db.prepare(`
    SELECT id, tier, interval FROM subscriptions
    WHERE user_id = ? AND status IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid')
    ORDER BY updated_at DESC LIMIT 1
  `).bind(user.id).first();
  if (existing) throw new RequestError('你已有会员，请先在帐号页管理当前会员', 409, 'SUBSCRIPTION_EXISTS');

  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('client_reference_id', user.id);
  params.set('success_url', `${origin}/?checkout=success&kind=membership&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/?checkout=cancelled`);
  params.set('locale', english ? 'en' : 'zh');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', plan.currency);
  params.set('line_items[0][price_data][unit_amount]', String(plan.amount));
  params.set('line_items[0][price_data][recurring][interval]', plan.interval);
  params.set('line_items[0][price_data][product_data][name]', english
    ? `${plan.tier === 'advanced' ? 'Advanced' : 'Basic'} membership · The Geomancer’s Book of Answers`
    : `地占解答书 ${plan.tier === 'advanced' ? '高级' : '初级'}会员`);
  params.set('line_items[0][price_data][product_data][description]', english
    ? `${plan.credits} questions per ${plan.interval === 'year' ? 'year' : 'month'}; unused questions do not roll over`
    : `每${plan.interval === 'year' ? '年' : '月'}包含 ${plan.credits} 次提问，未使用次数不结转`);
  params.set('metadata[user_id]', user.id);
  params.set('metadata[plan_id]', plan.id);
  params.set('subscription_data[metadata][user_id]', user.id);
  params.set('subscription_data[metadata][plan_id]', plan.id);
  if (user.email) params.set('customer_email', user.email);
  const session = await stripeRequest(env, '/checkout/sessions', { method: 'POST', body: params });
  return json({ checkoutUrl: session.url, sessionId: session.id, planId: plan.id });
}

async function createCheckout(request, env) {
  const body = await readJson(request);
  const plan = findMembershipPlan(String(body.planId || ''));
  if (plan) return createMembershipCheckout(request, env, plan, body);
  const item = findPackage(String(body.packageId || ''));
  if (item) return createLegacyCheckout(request, env, item);
  throw new RequestError('会员方案无效', 400, 'INVALID_MEMBERSHIP_PLAN');
}

function stripeId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

async function fulfillCheckout(env, session) {
  const userId = String(session?.metadata?.user_id || session?.client_reference_id || '');
  const packageId = String(session?.metadata?.package_id || '');
  const item = findPackage(packageId);
  if (!session?.id || !userId || !item) throw new Error('Checkout metadata is invalid');
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return false;
  if (String(session.currency || '').toLowerCase() !== item.currency || Number(session.amount_total) !== item.amount) {
    throw new Error('Checkout amount does not match package');
  }
  const db = requireDatabase(env);
  const owner = await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!owner) {
    await db.prepare(`
      UPDATE payments SET status = 'paid', payment_intent_id = COALESCE(?, payment_intent_id),
        updated_at = ? WHERE stripe_session_id = ?
    `).bind(stripeId(session.payment_intent), unixNow(), session.id).run();
    return false;
  }
  const existing = await db.prepare('SELECT * FROM payments WHERE stripe_session_id = ?').bind(session.id).first();
  if (existing && ['refunded', 'disputed'].includes(existing.status)) return false;
  const now = unixNow();
  const paymentId = existing?.id || randomId('pay_');
  const intentId = stripeId(session.payment_intent);
  const email = session.customer_details?.email || session.customer_email || null;
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO payments
        (id, user_id, stripe_session_id, payment_intent_id, package_id, amount_cny, credits, status, customer_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).bind(paymentId, userId, session.id, intentId, item.id, item.amount, item.credits, email, now, now),
    db.prepare(`
      UPDATE payments SET status = 'paid', payment_intent_id = COALESCE(?, payment_intent_id),
        customer_email = COALESCE(?, customer_email), updated_at = ?
      WHERE stripe_session_id = ? AND status IN ('pending', 'failed')
    `).bind(intentId, email, now, session.id),
    db.prepare(`
      INSERT OR IGNORE INTO credit_ledger
        (id, user_id, delta, kind, source_key, metadata_json, created_at)
      VALUES (?, ?, ?, 'purchase', ?, ?, ?)
    `).bind(
      randomId('led_'), userId, item.credits, `payment:${session.id}`,
      JSON.stringify({ sessionId: session.id, packageId: item.id, amount: item.amount }), now,
    ),
  ]);
  return true;
}

const STRIPE_SUBSCRIPTION_STATUSES = new Set([
  'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
]);

function subscriptionStatus(value) {
  const status = String(value || '').toLowerCase();
  return STRIPE_SUBSCRIPTION_STATUSES.has(status) ? status : 'active';
}

function unixValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

async function fetchSubscription(env, value) {
  const id = stripeId(value);
  if (!id) return null;
  if (typeof value === 'object') return value;
  return stripeRequest(env, `/subscriptions/${encodeURIComponent(id)}`);
}

async function fulfillMembershipPayment(env, details) {
  const {
    userId, plan, subscriptionId, customerId, invoiceId, paymentIntentId,
    periodStart, periodEnd, status, cancelAtPeriodEnd, amount, customerEmail,
  } = details;
  if (!userId || !plan || !subscriptionId) throw new Error('Subscription metadata is invalid');
  const db = requireDatabase(env);
  const owner = await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!owner) return false;

  const current = await db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').bind(subscriptionId).first();
  if (current && current.user_id !== userId) throw new Error('Subscription owner does not match');
  const now = unixNow();
  const startsAt = unixValue(periodStart, now);
  const endsAt = Math.max(startsAt + 60, unixValue(periodEnd, startsAt + membershipPeriodSeconds(plan.interval)));
  const periodKey = `${subscriptionId}:${startsAt}`;
  const existingPeriod = await db.prepare('SELECT * FROM membership_periods WHERE source_key = ?').bind(periodKey).first();
  const existingPayment = await db.prepare('SELECT * FROM membership_payments WHERE period_key = ?').bind(periodKey).first();
  if (existingPayment && ['refunded', 'disputed'].includes(existingPayment.status)) return false;
  const subscriptionRowId = current?.id || randomId('sub_');
  const periodId = existingPeriod?.id || randomId('mpr_');
  const paymentId = existingPayment?.id || randomId('mpp_');
  const paidAmount = Math.max(0, Number(amount) || plan.amount);
  const normalizedStatus = subscriptionStatus(status);
  await db.batch([
    db.prepare(`
      INSERT INTO subscriptions
        (id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, tier, interval, status,
         current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stripe_subscription_id) DO UPDATE SET
        stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
        plan_id = excluded.plan_id,
        tier = excluded.tier,
        interval = excluded.interval,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = excluded.updated_at
    `).bind(
      subscriptionRowId, userId, subscriptionId, customerId || null, plan.id, plan.tier, plan.interval,
      normalizedStatus, startsAt, endsAt, cancelAtPeriodEnd ? 1 : 0, current?.created_at || now, now,
    ),
    db.prepare(`
      INSERT OR IGNORE INTO membership_periods
        (id, user_id, subscription_id, source_key, plan_id, tier, interval, allocated, used, refunded,
         starts_at, ends_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'active', ?, ?)
    `).bind(
      periodId, userId, subscriptionRowId, periodKey, plan.id, plan.tier, plan.interval,
      plan.credits, startsAt, endsAt, now, now,
    ),
    db.prepare(`
      INSERT OR IGNORE INTO membership_payments
        (id, user_id, subscription_id, period_id, period_key, stripe_invoice_id,
         stripe_payment_intent_id, plan_id, amount_cny, credits, status, customer_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)
    `).bind(
      paymentId, userId, subscriptionRowId, periodId, periodKey, invoiceId || null,
      paymentIntentId || null, plan.id, paidAmount, plan.credits, customerEmail || null, now, now,
    ),
    db.prepare(`
      UPDATE membership_payments
      SET status = 'paid',
          stripe_invoice_id = COALESCE(?, stripe_invoice_id),
          stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
          customer_email = COALESCE(?, customer_email),
          updated_at = ?
      WHERE period_key = ? AND status IN ('pending', 'failed')
    `).bind(invoiceId || null, paymentIntentId || null, customerEmail || null, now, periodKey),
  ]);
  return true;
}

async function fulfillSubscriptionCheckout(env, session) {
  if (!session?.id || !['paid', 'no_payment_required'].includes(session.payment_status)) return false;
  const remoteSubscription = await fetchSubscription(env, session.subscription);
  const subscriptionId = stripeId(session.subscription) || stripeId(remoteSubscription);
  const metadata = { ...(remoteSubscription?.metadata || {}), ...(session.metadata || {}) };
  const userId = String(metadata.user_id || session.client_reference_id || '');
  const plan = findMembershipPlan(String(metadata.plan_id || ''));
  if (!subscriptionId || !userId || !plan) throw new Error('Subscription metadata is invalid');
  if (String(session.currency || '').toLowerCase() !== plan.currency || Number(session.amount_total) !== plan.amount) {
    throw new Error('Checkout amount does not match membership plan');
  }
  const now = unixNow();
  const latestInvoice = remoteSubscription?.latest_invoice;
  const startsAt = unixValue(remoteSubscription?.current_period_start, now);
  const endsAt = Math.max(startsAt + 60, unixValue(remoteSubscription?.current_period_end, startsAt + membershipPeriodSeconds(plan.interval)));
  return fulfillMembershipPayment(env, {
    userId,
    plan,
    subscriptionId,
    customerId: stripeId(session.customer) || stripeId(remoteSubscription?.customer),
    invoiceId: stripeId(session.invoice) || stripeId(latestInvoice),
    paymentIntentId: stripeId(session.payment_intent) || stripeId(latestInvoice?.payment_intent),
    periodStart: startsAt,
    periodEnd: endsAt,
    status: remoteSubscription?.status || 'active',
    cancelAtPeriodEnd: remoteSubscription?.cancel_at_period_end,
    amount: session.amount_total,
    customerEmail: session.customer_details?.email || session.customer_email || null,
  });
}

async function fulfillMembershipInvoice(env, invoice) {
  const subscriptionId = stripeId(invoice?.subscription);
  if (!subscriptionId || invoice?.status === 'void') return false;
  const db = requireDatabase(env);
  const current = await db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').bind(subscriptionId).first();
  const remoteSubscription = current ? null : await fetchSubscription(env, subscriptionId);
  const metadata = { ...(remoteSubscription?.metadata || {}), ...(invoice?.metadata || {}) };
  const userId = String(current?.user_id || metadata.user_id || '');
  const plan = findMembershipPlan(String(current?.plan_id || metadata.plan_id || ''));
  if (!userId || !plan) return false;
  const firstLine = invoice?.lines?.data?.[0]?.period || {};
  const now = unixNow();
  const startsAt = unixValue(invoice.period_start || firstLine.start || remoteSubscription?.current_period_start, now);
  const endsAt = Math.max(startsAt + 60, unixValue(invoice.period_end || firstLine.end || remoteSubscription?.current_period_end, startsAt + membershipPeriodSeconds(plan.interval)));
  return fulfillMembershipPayment(env, {
    userId,
    plan,
    subscriptionId,
    customerId: stripeId(invoice.customer) || stripeId(remoteSubscription?.customer) || current?.stripe_customer_id,
    invoiceId: stripeId(invoice),
    paymentIntentId: stripeId(invoice.payment_intent),
    periodStart: startsAt,
    periodEnd: endsAt,
    status: remoteSubscription?.status || current?.status || 'active',
    cancelAtPeriodEnd: remoteSubscription?.cancel_at_period_end ?? current?.cancel_at_period_end,
    amount: invoice.amount_paid || invoice.total || plan.amount,
    customerEmail: invoice.customer_email || null,
  });
}

async function syncSubscription(env, rawSubscription, forcedStatus = null) {
  const subscriptionId = stripeId(rawSubscription);
  if (!subscriptionId) return false;
  const db = requireDatabase(env);
  const current = await db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').bind(subscriptionId).first();
  const metadata = rawSubscription?.metadata || {};
  const userId = String(current?.user_id || metadata.user_id || '');
  const plan = findMembershipPlan(String(current?.plan_id || metadata.plan_id || ''));
  if (!userId || !plan) return false;
  const owner = await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!owner) return false;
  const now = unixNow();
  const startsAt = unixValue(rawSubscription.current_period_start, current?.current_period_start || now);
  const endsAt = Math.max(startsAt + 60, unixValue(rawSubscription.current_period_end, current?.current_period_end || startsAt + membershipPeriodSeconds(plan.interval)));
  const status = subscriptionStatus(forcedStatus || rawSubscription.status || current?.status);
  const localId = current?.id || randomId('sub_');
  await db.batch([
    db.prepare(`
      INSERT INTO subscriptions
        (id, user_id, stripe_subscription_id, stripe_customer_id, plan_id, tier, interval, status,
         current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stripe_subscription_id) DO UPDATE SET
        stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
        plan_id = excluded.plan_id,
        tier = excluded.tier,
        interval = excluded.interval,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = excluded.updated_at
    `).bind(
      localId, userId, subscriptionId, stripeId(rawSubscription.customer) || current?.stripe_customer_id || null,
      plan.id, plan.tier, plan.interval, status, startsAt, endsAt,
      rawSubscription.cancel_at_period_end ? 1 : 0, current?.created_at || now, now,
    ),
    ...(status === 'canceled' ? [db.prepare("UPDATE membership_periods SET status = 'ended', updated_at = ? WHERE subscription_id = ? AND status = 'active'").bind(now, localId)] : []),
  ]);
  return true;
}

async function markInvoiceFailed(env, invoice) {
  const subscriptionId = stripeId(invoice?.subscription);
  if (!subscriptionId) return;
  const db = requireDatabase(env);
  await db.prepare(`
    UPDATE subscriptions SET status = CASE WHEN status = 'canceled' THEN status ELSE 'past_due' END, updated_at = ?
    WHERE stripe_subscription_id = ?
  `).bind(unixNow(), subscriptionId).run();
}

async function createCustomerPortal(request, env) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const row = await requireDatabase(env).prepare(`
    SELECT stripe_customer_id FROM subscriptions
    WHERE user_id = ? AND stripe_customer_id IS NOT NULL
      AND status IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid')
    ORDER BY updated_at DESC LIMIT 1
  `).bind(user.id).first();
  if (!row?.stripe_customer_id) throw new RequestError('当前帐号没有可管理的会员', 404, 'SUBSCRIPTION_NOT_FOUND');
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams({ customer: row.stripe_customer_id, return_url: `${origin}/` });
  const session = await stripeRequest(env, '/billing_portal/sessions', { method: 'POST', body: params });
  return json({ url: session.url });
}

async function confirmCheckout(request, env) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const sessionId = String(body.sessionId || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new RequestError('支付会话无效', 400, 'INVALID_CHECKOUT_SESSION');
  const session = await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`);
  const ownerId = String(session?.metadata?.user_id || session?.client_reference_id || '');
  if (ownerId !== user.id) throw new RequestError('无权查看这个支付会话', 403, 'CHECKOUT_FORBIDDEN');
  let credited = false;
  if (session.mode === 'subscription') {
    credited = await fulfillSubscriptionCheckout(env, session);
  } else {
    const payment = await requireDatabase(env).prepare(`
      SELECT status FROM payments WHERE stripe_session_id = ? AND user_id = ?
    `).bind(sessionId, user.id).first();
    credited = payment?.status === 'paid';
  }
  const refreshed = await userResponse(user.id, env);
  return json({
    paid: ['paid', 'no_payment_required'].includes(session.payment_status),
    credited,
    credits: refreshed.admin ? null : refreshed.credits,
    unlimited: refreshed.admin,
    membership: refreshed.membership,
  });
}

async function listPayments(request, env) {
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  const [rows, membershipRows] = await Promise.all([db.prepare(`
    SELECT id, stripe_session_id, package_id, amount_cny, credits, status, refunded_amount, created_at
    FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(user.id).all(), db.prepare(`
    SELECT id, period_key, plan_id, amount_cny, credits, status, refunded_amount, created_at
    FROM membership_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(user.id).all()]);
  const legacy = (rows.results || []).map(row => ({
    kind: 'credits',
    id: row.id,
    sessionId: row.stripe_session_id,
    packageId: row.package_id,
    amount: Number(row.amount_cny),
    credits: Number(row.credits),
    status: row.status,
    refundedAmount: Number(row.refunded_amount),
    createdAt: Number(row.created_at),
  }));
  const memberships = (membershipRows.results || []).map(row => ({
    kind: 'membership',
    id: row.id,
    periodKey: row.period_key,
    planId: row.plan_id,
    amount: Number(row.amount_cny),
    credits: Number(row.credits),
    status: row.status,
    refundedAmount: Number(row.refunded_amount),
    createdAt: Number(row.created_at),
  }));
  return json({ payments: [...legacy, ...memberships].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100) });
}

export function parseStripeSignature(header) {
  const values = {};
  for (const part of String(header || '').split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (!key || !value) continue;
    (values[key] ||= []).push(value);
  }
  return { timestamp: Number(values.t?.[0]), signatures: values.v1 || [] };
}

export async function verifyWebhook(request, env, rawBody) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new RequestError('Webhook 尚未配置', 503, 'WEBHOOK_UNAVAILABLE');
  const parsed = parseStripeSignature(request.headers.get('Stripe-Signature'));
  if (!Number.isFinite(parsed.timestamp) || Math.abs(unixNow() - parsed.timestamp) > 300) {
    throw new RequestError('Webhook 签名已过期', 400, 'INVALID_WEBHOOK_SIGNATURE');
  }
  const expected = await hmacSha256(env.STRIPE_WEBHOOK_SECRET, `${parsed.timestamp}.${rawBody}`, 'hex');
  if (!parsed.signatures.some(signature => safeEqual(signature, expected))) {
    throw new RequestError('Webhook 签名无效', 400, 'INVALID_WEBHOOK_SIGNATURE');
  }
}

async function markPaymentFailed(env, session) {
  if (!session?.id) return;
  await requireDatabase(env).prepare(`
    UPDATE payments SET status = 'failed', updated_at = ? WHERE stripe_session_id = ? AND status = 'pending'
  `).bind(unixNow(), session.id).run();
}

async function findPaymentForCharge(db, charge) {
  const intentId = stripeId(charge?.payment_intent);
  const chargeId = stripeId(charge);
  if (!intentId && !chargeId) return null;
  return db.prepare(`
    SELECT * FROM payments WHERE payment_intent_id = ? OR charge_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(intentId || '', chargeId || '').first();
}

async function ensurePaymentForCharge(env, charge) {
  const db = requireDatabase(env);
  const existing = await findPaymentForCharge(db, charge);
  if (existing) return existing;
  const chargeId = stripeId(charge);
  let intentId = stripeId(charge?.payment_intent);
  if (!intentId && chargeId) {
    const remoteCharge = await stripeRequest(env, `/charges/${encodeURIComponent(chargeId)}`);
    intentId = stripeId(remoteCharge?.payment_intent);
  }
  if (!intentId) return null;
  const byIntent = await db.prepare(`
    SELECT * FROM payments WHERE payment_intent_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(intentId).first();
  if (byIntent) return byIntent;
  const sessions = await stripeRequest(
    env,
    `/checkout/sessions?payment_intent=${encodeURIComponent(intentId)}&limit=1`,
  );
  const session = sessions?.data?.[0];
  if (!session) return null;
  await fulfillCheckout(env, session);
  return db.prepare(`
    SELECT * FROM payments WHERE payment_intent_id = ? OR charge_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(intentId, chargeId || '').first();
}

async function findMembershipPaymentForCharge(db, charge) {
  const intentId = stripeId(charge?.payment_intent);
  const chargeId = stripeId(charge);
  if (!intentId && !chargeId) return null;
  return db.prepare(`
    SELECT * FROM membership_payments
    WHERE stripe_payment_intent_id = ? OR stripe_charge_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(intentId || '', chargeId || '').first();
}

export function creditsForRefund(payment, amount) {
  const credits = Math.max(0, Number(payment?.credits) || 0);
  const paidAmount = Math.max(0, Number(payment?.amount_cny) || 0);
  const refundedAmount = Math.max(0, Number(amount) || 0);
  if (!credits || !paidAmount || !refundedAmount) return 0;
  return Math.min(credits, Math.ceil(credits * refundedAmount / paidAmount));
}

async function applyRefund(env, charge) {
  const db = requireDatabase(env);
  if (await findMembershipPaymentForCharge(db, charge)) return;
  const payment = await ensurePaymentForCharge(env, charge);
  if (!payment || payment.status === 'disputed') return;
  const refundedAmount = Math.min(Number(payment.amount_cny), Math.max(0, Number(charge.amount_refunded || charge.amount || 0)));
  if (refundedAmount <= Number(payment.refunded_amount)) return;
  const oldCredits = creditsForRefund(payment, Number(payment.refunded_amount));
  const newCredits = creditsForRefund(payment, refundedAmount);
  const delta = newCredits - oldCredits;
  const now = unixNow();
  const statements = [db.prepare(`
    UPDATE payments SET status = 'refunded', refunded_amount = ?, charge_id = COALESCE(?, charge_id), updated_at = ?
    WHERE id = ? AND refunded_amount < ?
  `).bind(refundedAmount, stripeId(charge), now, payment.id, refundedAmount)];
  if (payment.user_id && delta > 0) statements.push(db.prepare(`
    INSERT OR IGNORE INTO credit_ledger
      (id, user_id, delta, kind, source_key, metadata_json, created_at)
    VALUES (?, ?, ?, 'refund', ?, ?, ?)
  `).bind(
    randomId('led_'), payment.user_id, -delta, `refund:${payment.id}:${refundedAmount}`,
    JSON.stringify({ paymentId: payment.id, refundedAmount }), now,
  ));
  await db.batch(statements);
}

async function applyDispute(env, dispute) {
  const db = requireDatabase(env);
  const charge = typeof dispute?.charge === 'object' ? dispute.charge : {
    id: dispute?.charge,
    payment_intent: dispute?.payment_intent,
  };
  if (await findMembershipPaymentForCharge(db, charge)) return;
  const payment = await ensurePaymentForCharge(env, charge);
  if (!payment || payment.status === 'disputed') return;
  const alreadyRemoved = creditsForRefund(payment, Number(payment.refunded_amount));
  const remove = Math.max(0, Number(payment.credits) - alreadyRemoved);
  const now = unixNow();
  const statements = [db.prepare(`
    UPDATE payments SET status = 'disputed', charge_id = COALESCE(?, charge_id), updated_at = ? WHERE id = ?
  `).bind(stripeId(charge), now, payment.id)];
  if (payment.user_id && remove) statements.push(db.prepare(`
    INSERT OR IGNORE INTO credit_ledger
      (id, user_id, delta, kind, source_key, metadata_json, created_at)
    VALUES (?, ?, ?, 'dispute', ?, ?, ?)
  `).bind(
    randomId('led_'), payment.user_id, -remove, `dispute:${payment.id}`,
    JSON.stringify({ paymentId: payment.id, disputeId: dispute.id }), now,
  ));
  await db.batch(statements);
}

async function applyMembershipRefund(env, charge) {
  const db = requireDatabase(env);
  const payment = await findMembershipPaymentForCharge(db, charge);
  if (!payment || payment.status === 'disputed') return;
  const refundedAmount = Math.min(Number(payment.amount_cny), Math.max(0, Number(charge.amount_refunded || charge.amount || 0)));
  if (refundedAmount <= Number(payment.refunded_amount)) return;
  const oldCredits = creditsForRefund(payment, Number(payment.refunded_amount));
  const newCredits = creditsForRefund(payment, refundedAmount);
  const revoke = Math.max(0, newCredits - oldCredits);
  const now = unixNow();
  const statements = [db.prepare(`
    UPDATE membership_payments
    SET status = 'refunded', refunded_amount = ?, stripe_charge_id = COALESCE(?, stripe_charge_id), updated_at = ?
    WHERE id = ? AND refunded_amount < ?
  `).bind(refundedAmount, stripeId(charge), now, payment.id, refundedAmount)];
  if (payment.period_id && revoke) statements.push(db.prepare(`
    UPDATE membership_periods
    SET refunded = MIN(allocated, refunded + ?), updated_at = ?
    WHERE id = ?
  `).bind(revoke, now, payment.period_id));
  await db.batch(statements);
}

async function applyMembershipDispute(env, dispute) {
  const db = requireDatabase(env);
  const charge = typeof dispute?.charge === 'object' ? dispute.charge : {
    id: dispute?.charge,
    payment_intent: dispute?.payment_intent,
  };
  const payment = await findMembershipPaymentForCharge(db, charge);
  if (!payment || payment.status === 'disputed') return;
  const now = unixNow();
  const statements = [db.prepare(`
    UPDATE membership_payments
    SET status = 'disputed', stripe_charge_id = COALESCE(?, stripe_charge_id), updated_at = ?
    WHERE id = ?
  `).bind(stripeId(charge), now, payment.id)];
  if (payment.period_id) statements.push(db.prepare(`
    UPDATE membership_periods SET refunded = allocated, updated_at = ? WHERE id = ?
  `).bind(now, payment.period_id));
  if (payment.subscription_id) statements.push(db.prepare(`
    UPDATE subscriptions SET status = 'unpaid', updated_at = ? WHERE id = ? AND status <> 'canceled'
  `).bind(now, payment.subscription_id));
  await db.batch(statements);
}

async function stripeWebhook(request, env) {
  const rawBody = await readText(request, 1024 * 1024);
  await verifyWebhook(request, env, rawBody);
  let event;
  try { event = JSON.parse(rawBody); } catch { throw new RequestError('Webhook JSON 无效', 400, 'INVALID_JSON'); }
  if (!event?.id || !event?.type) throw new RequestError('Webhook 事件无效', 400, 'INVALID_WEBHOOK_EVENT');
  const db = requireDatabase(env);
  if (await db.prepare('SELECT event_id FROM webhook_events WHERE event_id = ?').bind(event.id).first()) return json({ received: true, duplicate: true });
  const object = event.data?.object;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (object?.mode === 'subscription') await fulfillSubscriptionCheckout(env, object);
    else await fulfillCheckout(env, object);
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    await markPaymentFailed(env, object);
  } else if (event.type === 'invoice.paid') {
    await fulfillMembershipInvoice(env, object);
  } else if (event.type === 'invoice.payment_failed') {
    await markInvoiceFailed(env, object);
  } else if (event.type === 'customer.subscription.updated') {
    await syncSubscription(env, object);
  } else if (event.type === 'customer.subscription.deleted') {
    await syncSubscription(env, object, 'canceled');
  } else if (event.type === 'charge.refunded') {
    await applyMembershipRefund(env, object);
    await applyRefund(env, object);
  } else if (event.type === 'charge.dispute.created') {
    await applyMembershipDispute(env, object);
    await applyDispute(env, object);
  }
  await db.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)
  `).bind(event.id, event.type, unixNow()).run();
  return json({ received: true });
}

export async function handleBillingRoute(request, env, pathname) {
  if (pathname === '/api/billing/packages' && request.method === 'GET') {
    return json({ enabled: Boolean(env.STRIPE_SECRET_KEY), currency: 'CNY', memberships: MEMBERSHIP_PLANS });
  }
  if (pathname === '/api/billing/checkout' && request.method === 'POST') return createCheckout(request, env);
  if (pathname === '/api/billing/confirm' && request.method === 'POST') return confirmCheckout(request, env);
  if (pathname === '/api/billing/portal' && request.method === 'POST') return createCustomerPortal(request, env);
  if (pathname === '/api/billing/payments' && request.method === 'GET') return listPayments(request, env);
  if (pathname === '/api/webhooks/stripe' && request.method === 'POST') return stripeWebhook(request, env);
  return null;
}
