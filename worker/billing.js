import { CREDIT_PACKAGES, findPackage } from './config.js';
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

async function createCheckout(request, env) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const item = findPackage(String(body.packageId || ''));
  if (!item) throw new RequestError('充值套餐无效', 400, 'INVALID_PACKAGE');
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('client_reference_id', user.id);
  params.set('success_url', `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/?checkout=cancelled`);
  params.set('locale', 'zh');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', item.currency);
  params.set('line_items[0][price_data][unit_amount]', String(item.amount));
  params.set('line_items[0][price_data][product_data][name]', `答案之书 ${item.credits} 次`);
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

async function confirmCheckout(request, env) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const sessionId = String(body.sessionId || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new RequestError('支付会话无效', 400, 'INVALID_CHECKOUT_SESSION');
  const session = await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`);
  const ownerId = String(session?.metadata?.user_id || session?.client_reference_id || '');
  if (ownerId !== user.id) throw new RequestError('无权查看这个支付会话', 403, 'CHECKOUT_FORBIDDEN');
  const payment = await requireDatabase(env).prepare(`
    SELECT status FROM payments WHERE stripe_session_id = ? AND user_id = ?
  `).bind(sessionId, user.id).first();
  const refreshed = await userResponse(user.id, env);
  return json({
    paid: ['paid', 'no_payment_required'].includes(session.payment_status),
    credited: payment?.status === 'paid',
    credits: refreshed.admin ? null : refreshed.credits,
    unlimited: refreshed.admin,
  });
}

async function listPayments(request, env) {
  const user = await requireUser(request, env);
  const rows = await requireDatabase(env).prepare(`
    SELECT id, stripe_session_id, package_id, amount_cny, credits, status, refunded_amount, created_at
    FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(user.id).all();
  return json({ payments: (rows.results || []).map(row => ({
    id: row.id,
    sessionId: row.stripe_session_id,
    packageId: row.package_id,
    amount: Number(row.amount_cny),
    credits: Number(row.credits),
    status: row.status,
    refundedAmount: Number(row.refunded_amount),
    createdAt: Number(row.created_at),
  })) });
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

export function creditsForRefund(payment, amount) {
  const credits = Math.max(0, Number(payment?.credits) || 0);
  const paidAmount = Math.max(0, Number(payment?.amount_cny) || 0);
  const refundedAmount = Math.max(0, Number(amount) || 0);
  if (!credits || !paidAmount || !refundedAmount) return 0;
  return Math.min(credits, Math.ceil(credits * refundedAmount / paidAmount));
}

async function applyRefund(env, charge) {
  const db = requireDatabase(env);
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
    await fulfillCheckout(env, object);
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    await markPaymentFailed(env, object);
  } else if (event.type === 'charge.refunded') {
    await applyRefund(env, object);
  } else if (event.type === 'charge.dispute.created') {
    await applyDispute(env, object);
  }
  await db.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)
  `).bind(event.id, event.type, unixNow()).run();
  return json({ received: true });
}

export async function handleBillingRoute(request, env, pathname) {
  if (pathname === '/api/billing/packages' && request.method === 'GET') {
    return json({ enabled: Boolean(env.STRIPE_SECRET_KEY), currency: 'CNY', packages: CREDIT_PACKAGES });
  }
  if (pathname === '/api/billing/checkout' && request.method === 'POST') return createCheckout(request, env);
  if (pathname === '/api/billing/confirm' && request.method === 'POST') return confirmCheckout(request, env);
  if (pathname === '/api/billing/payments' && request.method === 'GET') return listPayments(request, env);
  if (pathname === '/api/webhooks/stripe' && request.method === 'POST') return stripeWebhook(request, env);
  return null;
}
