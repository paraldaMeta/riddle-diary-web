import { timingSafeEqual } from 'node:crypto';

const encoder = new TextEncoder();

export class RequestError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', details = undefined) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function jsonError(error) {
  const known = error instanceof RequestError;
  return json({
    error: known ? error.message : '服务器内部错误',
    code: known ? error.code : 'INTERNAL_ERROR',
    ...(known && error.details ? { details: error.details } : {}),
  }, known ? error.status : 500);
}

export async function readJson(request, maxBytes = 64 * 1024) {
  const text = await readText(request, maxBytes);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw new RequestError('JSON 格式无效', 400, 'INVALID_JSON');
  }
}

export async function readText(request, maxBytes = 64 * 1024) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestError('请求正文过大', 413, 'PAYLOAD_TOO_LARGE');
  }
  if (!request.body) throw new RequestError('缺少请求正文', 400, 'MISSING_BODY');

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestError('请求正文过大', 413, 'PAYLOAD_TOO_LARGE');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return text;
}

export function assertSameOrigin(request) {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') {
    throw new RequestError('请求来源无效', 403, 'INVALID_ORIGIN');
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new RequestError('请求来源无效', 403, 'INVALID_ORIGIN');
  }
}

export function parseCookies(request) {
  const output = {};
  const raw = request.headers.get('Cookie') || '';
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) output[key] = value;
  }
  return output;
}

export function sessionCookie(token, maxAge = 30 * 24 * 60 * 60) {
  return `__Host-geomancer_session=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return '__Host-geomancer_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function randomId(prefix = '') {
  return prefix + crypto.randomUUID();
}

export function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function sha256(value, output = 'base64url') {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (output === 'hex') return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return base64Url(digest);
}

export async function hmacSha256(secret, value, output = 'base64url') {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  if (output === 'hex') return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return base64Url(signature);
}

export function safeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RequestError('请输入有效的邮箱地址', 400, 'INVALID_EMAIL');
  }
  return email;
}

export function normalizeCnPhone(value) {
  let phone = String(value || '').replace(/[\s()-]/g, '');
  if (phone.startsWith('0086')) phone = '+' + phone.slice(2);
  if (/^1[3-9]\d{9}$/.test(phone)) phone = '+86' + phone;
  if (!/^\+861[3-9]\d{9}$/.test(phone)) {
    throw new RequestError('请输入有效的中国大陆手机号', 400, 'INVALID_PHONE');
  }
  return phone;
}

export function normalizeReturnTo(value) {
  const path = String(value || '/');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  return path.slice(0, 1024);
}

export function requireString(value, name, min = 1, max = 1024) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) {
    throw new RequestError(`${name}格式无效`, 400, 'INVALID_INPUT');
  }
  return text;
}
