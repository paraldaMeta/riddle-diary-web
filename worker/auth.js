import { hashPassword, createOtpCode, verifyPassword } from './crypto.js';
import {
  createSession,
  createUserWithTrial,
  enforceRateLimit,
  findUserIdByEmail,
  findUserIdByPhone,
  getCurrentUser,
  requireDatabase,
  requireUser,
  revokeCurrentSession,
  userResponse,
} from './db.js';
import { isDevelopment, phoneAuthEnabled, publicConfiguration } from './config.js';
import { sendAliyunSmsCode, sendEmailCode, verifyTurnstile } from './integrations.js';
import {
  RequestError,
  assertSameOrigin,
  clearSessionCookie,
  clientIp,
  hmacSha256,
  json,
  normalizeCnPhone,
  normalizeEmail,
  normalizeReturnTo,
  randomId,
  randomToken,
  readJson,
  safeEqual,
  sha256,
  unixNow,
} from './http.js';

const OTP_TTL_SECONDS = 10 * 60;

function authSecret(env) {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (isDevelopment(env)) return 'local-development-auth-secret-not-for-production';
  throw new RequestError('帐号加密服务尚未配置', 503, 'AUTH_UNAVAILABLE');
}

function withSession(data, cookie, status = 200) {
  return json(data, status, { 'Set-Cookie': cookie });
}

async function authRateLimits(request, env, account, action) {
  await Promise.all([
    enforceRateLimit(env, `auth:ip:${clientIp(request)}:${action}`, 12, 15 * 60),
    enforceRateLimit(env, `auth:account:${account}:${action}`, 6, 15 * 60),
  ]);
}

async function createChallenge(request, env, { channel, identifier, purpose, payload = {} }) {
  const db = requireDatabase(env);
  const id = randomId('otp_');
  const code = createOtpCode();
  const now = unixNow();
  const codeHash = await hmacSha256(authSecret(env), `${id}:${code}`);
  await db.prepare(`
    INSERT INTO verification_challenges
      (id, channel, identifier, purpose, code_hash, payload_json, expires_at, requested_ip_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, channel, identifier, purpose, codeHash, JSON.stringify(payload),
    now + OTP_TTL_SECONDS, await sha256(clientIp(request)), now,
  ).run();
  if (channel === 'email') await sendEmailCode(env, identifier, code, purpose);
  else await sendAliyunSmsCode(env, identifier, code);
  return { id, ...(isDevelopment(env) ? { debugCode: code } : {}) };
}

async function register(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  await verifyTurnstile(request, env, body.turnstileToken, 'register');
  await authRateLimits(request, env, email, 'register');
  if (await findUserIdByEmail(env, email)) throw new RequestError('该邮箱已经注册，请直接登录', 409, 'EMAIL_IN_USE');
  const password = await hashPassword(body.password);
  const challenge = await createChallenge(request, env, {
    channel: 'email', identifier: email, purpose: 'register', payload: { password },
  });
  return json({ ok: true, challengeId: challenge.id, debugCode: challenge.debugCode, message: '验证码已发送，请完成邮箱验证' }, 202);
}

async function passwordLogin(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  await verifyTurnstile(request, env, body.turnstileToken, 'login');
  await authRateLimits(request, env, email, 'password-login');
  const db = requireDatabase(env);
  const credential = await db.prepare(`
    SELECT p.*, e.user_id FROM user_emails e
    JOIN password_credentials p ON p.user_id = e.user_id
    JOIN users u ON u.id = e.user_id
    WHERE e.email = ? COLLATE NOCASE AND u.deleted_at IS NULL
  `).bind(email).first();
  if (!credential) {
    await hashPassword(body.password).catch(() => null);
    throw new RequestError('邮箱或密码不正确', 401, 'INVALID_CREDENTIALS');
  }
  if (!await verifyPassword(body.password, credential)) {
    throw new RequestError('邮箱或密码不正确', 401, 'INVALID_CREDENTIALS');
  }
  const cookie = await createSession(credential.user_id, request, env);
  return withSession({ ok: true, user: await userResponse(credential.user_id, env) }, cookie);
}

async function requestOtp(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const channel = body.channel === 'phone' ? 'phone' : 'email';
  const purpose = String(body.purpose || 'login');
  if (!['login', 'link'].includes(purpose)) throw new RequestError('验证码用途无效', 400, 'INVALID_PURPOSE');
  if (channel === 'phone' && !phoneAuthEnabled(env)) {
    throw new RequestError('手机号登录尚未开放', 503, 'PHONE_AUTH_DISABLED');
  }
  const identifier = channel === 'phone' ? normalizeCnPhone(body.identifier) : normalizeEmail(body.identifier);
  await verifyTurnstile(request, env, body.turnstileToken, 'otp');
  await authRateLimits(request, env, identifier, `otp-${purpose}`);

  let payload = {};
  if (purpose === 'link') {
    const user = await requireUser(request, env);
    if (channel !== 'phone') throw new RequestError('当前仅支持绑定手机号', 400, 'INVALID_LINK');
    const owner = await findUserIdByPhone(env, identifier);
    if (owner && owner !== user.id) throw new RequestError('该手机号已绑定其他帐号', 409, 'PHONE_IN_USE');
    payload = { userId: user.id };
  } else if (channel === 'phone' && !await findUserIdByPhone(env, identifier)) {
    throw new RequestError('该手机号尚未绑定帐号', 404, 'PHONE_NOT_FOUND');
  }

  const challenge = await createChallenge(request, env, { channel, identifier, purpose, payload });
  return json({ ok: true, challengeId: challenge.id, debugCode: challenge.debugCode, message: '验证码已发送' }, 202);
}

async function requestPasswordReset(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  await verifyTurnstile(request, env, body.turnstileToken, 'reset');
  await authRateLimits(request, env, email, 'password-reset');
  const userId = await findUserIdByEmail(env, email);
  const password = await hashPassword(body.password);
  if (!userId) {
    return json({ ok: true, challengeId: null, message: '如果该邮箱已注册，验证码将会发送' }, 202);
  }
  const challenge = await createChallenge(request, env, {
    channel: 'email', identifier: email, purpose: 'reset', payload: { userId, password },
  });
  return json({ ok: true, challengeId: challenge.id, debugCode: challenge.debugCode, message: '验证码已发送' }, 202);
}

async function consumeChallenge(request, env) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const challengeId = String(body.challengeId || '').slice(0, 100);
  const code = String(body.code || '').trim();
  if (!/^otp_[\w-]{10,}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
    throw new RequestError('验证码无效', 400, 'INVALID_CODE');
  }
  await enforceRateLimit(env, `otp-verify:${clientIp(request)}:${challengeId}`, 8, 15 * 60);
  const db = requireDatabase(env);
  const challenge = await db.prepare(`
    SELECT * FROM verification_challenges WHERE id = ?
  `).bind(challengeId).first();
  const now = unixNow();
  if (!challenge || challenge.consumed_at || Number(challenge.expires_at) <= now || Number(challenge.attempts) >= Number(challenge.max_attempts)) {
    throw new RequestError('验证码已失效，请重新获取', 410, 'CODE_EXPIRED');
  }
  const expected = await hmacSha256(authSecret(env), `${challengeId}:${code}`);
  if (!safeEqual(expected, challenge.code_hash)) {
    await db.prepare('UPDATE verification_challenges SET attempts = attempts + 1 WHERE id = ?').bind(challengeId).run();
    throw new RequestError('验证码不正确', 400, 'INVALID_CODE');
  }
  const claimed = await db.prepare(`
    UPDATE verification_challenges SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < max_attempts
    RETURNING id
  `).bind(now, challengeId, now).first();
  if (!claimed) throw new RequestError('验证码已被使用', 409, 'CODE_ALREADY_USED');

  let payload = {};
  try { payload = JSON.parse(challenge.payload_json || '{}'); } catch {}
  let userId;
  if (challenge.purpose === 'register') {
    if (await findUserIdByEmail(env, challenge.identifier)) {
      throw new RequestError('该邮箱已经注册，请直接登录', 409, 'EMAIL_IN_USE');
    }
    if (!payload.password?.hash || !payload.password?.salt || !payload.password?.params) {
      throw new RequestError('密码设置无效', 400, 'INVALID_PASSWORD_PAYLOAD');
    }
    userId = await createUserWithTrial(env, { email: challenge.identifier, password: payload.password });
  } else if (challenge.purpose === 'reset') {
    userId = payload.userId;
    if (!userId || userId !== await findUserIdByEmail(env, challenge.identifier)) {
      throw new RequestError('重置请求无效', 400, 'INVALID_RESET');
    }
    await upsertPassword(db, userId, payload.password, now);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  } else if (challenge.purpose === 'link') {
    const current = await requireUser(request, env);
    if (challenge.channel !== 'phone' || current.id !== payload.userId) {
      throw new RequestError('绑定请求无效', 403, 'INVALID_LINK');
    }
    const owner = await findUserIdByPhone(env, challenge.identifier);
    if (owner && owner !== current.id) throw new RequestError('该手机号已绑定其他帐号', 409, 'PHONE_IN_USE');
    await db.prepare(`
      INSERT INTO user_phones (phone, user_id, verified_at, is_primary, created_at)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT(phone) DO NOTHING
    `).bind(challenge.identifier, current.id, now, now).run();
    return json({ ok: true, user: await userResponse(current.id, env) });
  } else if (challenge.purpose === 'login') {
    if (challenge.channel === 'email') {
      userId = await findUserIdByEmail(env, challenge.identifier);
      if (!userId) userId = await createUserWithTrial(env, { email: challenge.identifier });
    } else {
      userId = await findUserIdByPhone(env, challenge.identifier);
      if (!userId) throw new RequestError('该手机号尚未绑定帐号', 404, 'PHONE_NOT_FOUND');
    }
  } else {
    throw new RequestError('验证码用途无效', 400, 'INVALID_PURPOSE');
  }

  const cookie = await createSession(userId, request, env);
  return withSession({ ok: true, user: await userResponse(userId, env) }, cookie);
}

async function upsertPassword(db, userId, password, now) {
  if (!password?.hash || !password?.salt || !password?.params) {
    throw new RequestError('密码设置无效', 400, 'INVALID_PASSWORD_PAYLOAD');
  }
  await db.prepare(`
    INSERT INTO password_credentials (user_id, password_hash, password_salt, password_params, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash,
      password_salt = excluded.password_salt, password_params = excluded.password_params,
      updated_at = excluded.updated_at
  `).bind(userId, password.hash, password.salt, password.params, now).run();
}

async function googleStart(request, env) {
  assertSameOrigin(request);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new RequestError('Google 登录尚未配置', 503, 'GOOGLE_UNAVAILABLE');
  }
  const body = await readJson(request);
  // A Google button can be shown beside any current auth form, so accept the
  // already completed Turnstile widget regardless of that form's action tag.
  await verifyTurnstile(request, env, body.turnstileToken);
  await enforceRateLimit(env, `google-start:${clientIp(request)}`, 10, 15 * 60);
  const verifier = randomToken(48);
  const state = randomToken(32);
  const now = unixNow();
  await requireDatabase(env).prepare(`
    INSERT INTO oauth_states (state_hash, provider, code_verifier, return_to, expires_at, created_at)
    VALUES (?, 'google', ?, ?, ?, ?)
  `).bind(await sha256(state), verifier, normalizeReturnTo(body.returnTo), now + 10 * 60, now).run();
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}

async function googleCallback(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const db = requireDatabase(env);
  const row = state ? await db.prepare(`
    SELECT * FROM oauth_states WHERE state_hash = ? AND provider = 'google' AND expires_at > ?
  `).bind(await sha256(state), unixNow()).first() : null;
  if (!row || !code) return Response.redirect(`${origin}/?auth=error`, 302);
  await db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(await sha256(state)).run();

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: row.code_verifier,
        grant_type: 'authorization_code',
        redirect_uri: `${origin}/api/auth/google/callback`,
      }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) throw new Error('token exchange failed');
    const infoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const info = await infoResponse.json();
    if (!infoResponse.ok || !info.sub || !info.email || info.email_verified !== true) throw new Error('userinfo failed');
    const email = normalizeEmail(info.email);
    let identity = await db.prepare(`
      SELECT user_id FROM oauth_identities WHERE provider = 'google' AND subject = ?
    `).bind(String(info.sub)).first();
    let userId = identity?.user_id || await findUserIdByEmail(env, email);
    if (!userId) userId = await createUserWithTrial(env, { email });
    if (!identity) await db.prepare(`
      INSERT INTO oauth_identities (provider, subject, user_id, email, created_at)
      VALUES ('google', ?, ?, ?, ?)
    `).bind(String(info.sub), userId, email, unixNow()).run();
    const cookie = await createSession(userId, request, env);
    const destination = new URL(normalizeReturnTo(row.return_to), origin);
    destination.searchParams.set('auth', 'success');
    return new Response(null, { status: 302, headers: { Location: destination.toString(), 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Google callback failed', error instanceof Error ? error.message : String(error));
    return Response.redirect(`${origin}/?auth=error`, 302);
  }
}

async function logout(request, env) {
  assertSameOrigin(request);
  await revokeCurrentSession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

async function me(request, env) {
  return json({ user: await getCurrentUser(request, env), config: publicConfiguration(env) });
}

async function deleteAccount(request, env) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (body.confirmation !== '注销帐号') throw new RequestError('请输入“注销帐号”以确认', 400, 'CONFIRMATION_REQUIRED');
  const db = requireDatabase(env);
  await db.batch([
    db.prepare('UPDATE payments SET user_id = NULL, customer_email = NULL WHERE user_id = ?').bind(user.id),
    db.prepare('UPDATE membership_payments SET user_id = NULL, customer_email = NULL WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

export async function handleAuthRoute(request, env, pathname) {
  if (pathname === '/api/auth/me' && request.method === 'GET') return me(request, env);
  if (pathname === '/api/auth/register' && request.method === 'POST') return register(request, env);
  if (pathname === '/api/auth/login' && request.method === 'POST') return passwordLogin(request, env);
  if (pathname === '/api/auth/otp/request' && request.method === 'POST') return requestOtp(request, env);
  if (pathname === '/api/auth/otp/verify' && request.method === 'POST') return consumeChallenge(request, env);
  if (pathname === '/api/auth/password/reset' && request.method === 'POST') return requestPasswordReset(request, env);
  if (pathname === '/api/auth/google/start' && request.method === 'POST') return googleStart(request, env);
  if (pathname === '/api/auth/google/callback' && request.method === 'GET') return googleCallback(request, env);
  if (pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (pathname === '/api/account' && request.method === 'DELETE') return deleteAccount(request, env);
  return null;
}
