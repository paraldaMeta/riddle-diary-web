import { scrypt, timingSafeEqual } from 'node:crypto';
import { RequestError, base64Url, decodeBase64Url, randomToken } from './http.js';

const PASSWORD_VERSION = 1;
const PASSWORD_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32 });

function normalizedPassword(value) {
  const password = String(value || '').normalize('NFKC');
  if (password.length < 8 || password.length > 128) {
    throw new RequestError('密码须为 8 至 128 个字符', 400, 'INVALID_PASSWORD');
  }
  return password;
}

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keyLength, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(new Uint8Array(key)));
  });
}

export async function hashPassword(value) {
  const password = normalizedPassword(value);
  const salt = randomToken(16);
  const key = await derive(password, decodeBase64Url(salt), PASSWORD_PARAMS);
  return {
    hash: base64Url(key),
    salt,
    params: JSON.stringify({ version: PASSWORD_VERSION, ...PASSWORD_PARAMS }),
  };
}

export async function verifyPassword(value, credential) {
  let params;
  try {
    params = JSON.parse(credential.password_params);
  } catch {
    return false;
  }
  if (params.version !== PASSWORD_VERSION || params.N !== PASSWORD_PARAMS.N ||
      params.r !== PASSWORD_PARAMS.r || params.p !== PASSWORD_PARAMS.p ||
      params.keyLength !== PASSWORD_PARAMS.keyLength) return false;

  let password;
  try {
    password = normalizedPassword(value);
  } catch {
    return false;
  }
  const candidate = await derive(password, decodeBase64Url(credential.password_salt), params);
  const expected = decodeBase64Url(credential.password_hash);
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
}

export function createOtpCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1000000).padStart(6, '0');
}
