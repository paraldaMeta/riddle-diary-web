import { RequestError, hmacSha256, sha256 } from './http.js';
import { isDevelopment, phoneAuthEnabled } from './config.js';

export async function verifyTurnstile(request, env, token, expectedAction = '') {
  if (isDevelopment(env) && token === 'dev-test') return;
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new RequestError('人机验证尚未配置', 503, 'TURNSTILE_UNAVAILABLE');
  }
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', String(token || ''));
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success || (expectedAction && result.action !== expectedAction)) {
    throw new RequestError('人机验证未通过，请重试', 403, 'TURNSTILE_FAILED');
  }
}

export async function sendEmailCode(env, email, code, purpose) {
  if (isDevelopment(env) && !env.RESEND_API_KEY) return;
  if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL) {
    throw new RequestError('邮件服务尚未配置', 503, 'EMAIL_UNAVAILABLE');
  }
  const action = purpose === 'reset' ? '重置密码' : purpose === 'register' ? '完成注册' : '登录答案之书';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [email],
      subject: `答案之书验证码：${code}`,
      text: `你的验证码是 ${code}，用于${action}。验证码十分钟内有效，请勿转发。`,
      html: `<div style="font-family:serif;color:#23180e"><p>你的验证码是</p><p style="font-size:28px;letter-spacing:8px"><strong>${code}</strong></p><p>用于${action}，十分钟内有效。请勿转发。</p></div>`,
    }),
  });
  if (!response.ok) {
    console.error('Resend failed', response.status, (await response.text()).slice(0, 500));
    throw new RequestError('验证码邮件暂时无法发送', 502, 'EMAIL_DELIVERY_FAILED');
  }
}

function aliyunDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function sendAliyunSmsCode(env, phone, code) {
  if (!phoneAuthEnabled(env)) throw new RequestError('手机号登录尚未开放', 503, 'PHONE_AUTH_DISABLED');
  const host = 'dysmsapi.aliyuncs.com';
  const action = 'SendSms';
  const version = '2017-05-25';
  const date = aliyunDate(new Date());
  const nonce = crypto.randomUUID();
  const queryParameters = {
    PhoneNumbers: phone.replace(/^\+86/, ''),
    SignName: env.ALIYUN_SMS_SIGN_NAME,
    TemplateCode: env.ALIYUN_SMS_TEMPLATE_CODE,
    TemplateParam: JSON.stringify({ code }),
  };
  const canonicalQuery = Object.entries(queryParameters).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join('&');
  const payloadHash = await sha256('', 'hex');
  const signedHeaders = 'host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version';
  const canonicalHeaders = [
    `host:${host}`,
    `x-acs-action:${action}`,
    `x-acs-content-sha256:${payloadHash}`,
    `x-acs-date:${date}`,
    `x-acs-signature-nonce:${nonce}`,
    `x-acs-version:${version}`,
    '',
  ].join('\n');
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${await sha256(canonicalRequest, 'hex')}`;
  const signature = await hmacSha256(env.ALIYUN_SMS_ACCESS_KEY_SECRET, stringToSign, 'hex');
  const response = await fetch(`https://${host}/?${canonicalQuery}`, {
    method: 'POST',
    headers: {
      Authorization: `ACS3-HMAC-SHA256 Credential=${env.ALIYUN_SMS_ACCESS_KEY_ID},SignedHeaders=${signedHeaders},Signature=${signature}`,
      'x-acs-action': action,
      'x-acs-content-sha256': payloadHash,
      'x-acs-date': date,
      'x-acs-signature-nonce': nonce,
      'x-acs-version': version,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Code !== 'OK') {
    console.error('Aliyun SMS failed', response.status, result.Code || 'unknown');
    throw new RequestError('短信验证码暂时无法发送', 502, 'SMS_DELIVERY_FAILED');
  }
}
