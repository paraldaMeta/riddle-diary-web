import {
  RequestError,
  clientIp,
  parseCookies,
  randomId,
  randomToken,
  sessionCookie,
  sha256,
  unixNow,
} from './http.js';

const SESSION_SECONDS = 30 * 24 * 60 * 60;

export function requireDatabase(env) {
  if (!env.DB) throw new RequestError('帐号服务尚未配置', 503, 'DATABASE_UNAVAILABLE');
  return env.DB;
}

export function adminEmailSet(env) {
  return new Set(String(env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

export async function getCurrentUser(request, env) {
  const token = parseCookies(request)['__Host-geomancer_session'];
  if (!token) return null;
  const now = unixNow();
  const tokenHash = await sha256(token);
  const row = await requireDatabase(env).prepare(`
    SELECT u.id, u.credit_balance, u.created_at, s.expires_at,
           (SELECT email FROM user_emails WHERE user_id = u.id AND is_primary = 1 ORDER BY created_at LIMIT 1) AS email,
           (SELECT phone FROM user_phones WHERE user_id = u.id AND is_primary = 1 ORDER BY created_at LIMIT 1) AS phone,
           EXISTS(SELECT 1 FROM password_credentials WHERE user_id = u.id) AS has_password,
           EXISTS(SELECT 1 FROM oauth_identities WHERE user_id = u.id AND provider = 'google') AS has_google
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL
  `).bind(tokenHash, now).first();
  if (!row) return null;

  const email = row.email || '';
  return {
    id: row.id,
    email: email || null,
    phone: row.phone || null,
    hasPassword: Boolean(row.has_password),
    hasGoogle: Boolean(row.has_google),
    admin: Boolean(email && adminEmailSet(env).has(email.toLowerCase())),
    credits: Number(row.credit_balance || 0),
    createdAt: Number(row.created_at),
  };
}

export async function requireUser(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) throw new RequestError('请先登录再向答案之书提问', 401, 'AUTH_REQUIRED');
  return user;
}

export async function createSession(userId, request, env) {
  const db = requireDatabase(env);
  const token = randomToken(32);
  const now = unixNow();
  const ipHash = await sha256(clientIp(request));
  const uaHash = await sha256(request.headers.get('User-Agent') || '');
  await db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, ip_hash, user_agent_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(await sha256(token), userId, now + SESSION_SECONDS, now, now, ipHash, uaHash).run();
  return sessionCookie(token, SESSION_SECONDS);
}

export async function revokeCurrentSession(request, env) {
  const token = parseCookies(request)['__Host-geomancer_session'];
  if (token) await requireDatabase(env).prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export async function enforceRateLimit(env, key, limit, windowSeconds) {
  const now = unixNow();
  const bucketKey = await sha256(key);
  const row = await requireDatabase(env).prepare(`
    INSERT INTO rate_limits (bucket_key, hits, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      hits = CASE WHEN reset_at <= ? THEN 1 ELSE hits + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING hits, reset_at
  `).bind(bucketKey, now + windowSeconds, now, now).first();
  if (Number(row?.hits || limit + 1) > limit) {
    throw new RequestError('尝试次数过多，请稍后再试', 429, 'RATE_LIMITED', {
      retryAfter: Math.max(1, Number(row.reset_at) - now),
    });
  }
}

export async function createUserWithTrial(env, { email = null, phone = null, password = null } = {}) {
  const db = requireDatabase(env);
  const now = unixNow();
  const userId = randomId('usr_');
  const statements = [
    db.prepare('INSERT INTO users (id, trial_granted, created_at, updated_at) VALUES (?, 1, ?, ?)').bind(userId, now, now),
  ];
  if (email) statements.push(db.prepare(`
    INSERT INTO user_emails (email, user_id, verified_at, is_primary, created_at) VALUES (?, ?, ?, 1, ?)
  `).bind(email, userId, now, now));
  if (phone) statements.push(db.prepare(`
    INSERT INTO user_phones (phone, user_id, verified_at, is_primary, created_at) VALUES (?, ?, ?, 1, ?)
  `).bind(phone, userId, now, now));
  if (password) statements.push(db.prepare(`
    INSERT INTO password_credentials (user_id, password_hash, password_salt, password_params, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, password.hash, password.salt, password.params, now));
  statements.push(db.prepare(`
    INSERT INTO credit_ledger (id, user_id, delta, kind, source_key, metadata_json, created_at)
    VALUES (?, ?, 3, 'trial', ?, '{"credits":3}', ?)
  `).bind(randomId('led_'), userId, `trial:${userId}`, now));
  await db.batch(statements);
  return userId;
}

export async function findUserIdByEmail(env, email) {
  const row = await requireDatabase(env).prepare('SELECT user_id FROM user_emails WHERE email = ? COLLATE NOCASE').bind(email).first();
  return row?.user_id || null;
}

export async function findUserIdByPhone(env, phone) {
  const row = await requireDatabase(env).prepare('SELECT user_id FROM user_phones WHERE phone = ?').bind(phone).first();
  return row?.user_id || null;
}

export async function userResponse(userId, env) {
  const row = await requireDatabase(env).prepare(`
    SELECT u.id, u.credit_balance, u.created_at,
           (SELECT email FROM user_emails WHERE user_id = u.id AND is_primary = 1 ORDER BY created_at LIMIT 1) AS email,
           (SELECT phone FROM user_phones WHERE user_id = u.id AND is_primary = 1 ORDER BY created_at LIMIT 1) AS phone,
           EXISTS(SELECT 1 FROM password_credentials WHERE user_id = u.id) AS has_password,
           EXISTS(SELECT 1 FROM oauth_identities WHERE user_id = u.id AND provider = 'google') AS has_google
    FROM users u WHERE u.id = ? AND u.deleted_at IS NULL
  `).bind(userId).first();
  if (!row) return null;
  const email = row.email || '';
  return {
    id: row.id,
    email: email || null,
    phone: row.phone || null,
    hasPassword: Boolean(row.has_password),
    hasGoogle: Boolean(row.has_google),
    admin: Boolean(email && adminEmailSet(env).has(email.toLowerCase())),
    credits: Number(row.credit_balance || 0),
    createdAt: Number(row.created_at),
  };
}
