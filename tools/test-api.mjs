import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:8787';
const email = `codex-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const firstPassword = 'local-test-password-1';
const resetPassword = 'local-test-password-2';

async function request(path, { method = 'GET', body, cookie, origin = BASE } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

const registration = await request('/api/auth/register', {
  method: 'POST',
  body: { email, password: firstPassword, turnstileToken: 'dev-test' },
});
assert.equal(registration.response.status, 202);
assert.match(registration.payload.challengeId, /^otp_/);
assert.match(registration.payload.debugCode, /^\d{6}$/);

const wrongCode = registration.payload.debugCode === '000000' ? '999999' : '000000';
const rejectedCode = await request('/api/auth/otp/verify', {
  method: 'POST', body: { challengeId: registration.payload.challengeId, code: wrongCode },
});
assert.equal(rejectedCode.response.status, 400);
assert.equal(rejectedCode.payload.code, 'INVALID_CODE');

const verified = await request('/api/auth/otp/verify', {
  method: 'POST',
  body: { challengeId: registration.payload.challengeId, code: registration.payload.debugCode },
});
assert.equal(verified.response.status, 200);
assert.ok(verified.cookie.startsWith('__Host-geomancer_session='));
assert.equal(verified.payload.user.email, email);
assert.equal(verified.payload.user.credits, 3);

const consumedCode = await request('/api/auth/otp/verify', {
  method: 'POST',
  body: { challengeId: registration.payload.challengeId, code: registration.payload.debugCode },
});
assert.equal(consumedCode.response.status, 410);

const crossOriginLogout = await request('/api/auth/logout', {
  method: 'POST', cookie: verified.cookie, origin: 'https://attacker.example',
});
assert.equal(crossOriginLogout.response.status, 403);
assert.equal(crossOriginLogout.payload.code, 'INVALID_ORIGIN');

const missingAiRequestId = `req_${crypto.randomUUID()}`;
const unavailableAnswer = await request('/api/ask', {
  method: 'POST',
  cookie: verified.cookie,
  body: {
    requestId: missingAiRequestId,
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  },
});
assert.equal(unavailableAnswer.response.status, 503);
assert.equal(unavailableAnswer.payload.code, 'AI_UNAVAILABLE');

const afterRefund = await request('/api/auth/me', { cookie: verified.cookie });
assert.equal(afterRefund.response.status, 200);
assert.equal(afterRefund.payload.user.credits, 3);

const duplicateRefundedRequest = await request('/api/ask', {
  method: 'POST',
  cookie: verified.cookie,
  body: {
    requestId: missingAiRequestId,
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  },
});
assert.equal(duplicateRefundedRequest.response.status, 409);
assert.equal(duplicateRefundedRequest.payload.code, 'AI_UNAVAILABLE');

const emptyHistory = await request('/api/conversations', { cookie: verified.cookie });
assert.equal(emptyHistory.response.status, 200);
assert.deepEqual(emptyHistory.payload.conversations, []);

const reset = await request('/api/auth/password/reset', {
  method: 'POST',
  body: { email, password: resetPassword, turnstileToken: 'dev-test' },
});
assert.equal(reset.response.status, 202);
assert.match(reset.payload.debugCode, /^\d{6}$/);
const resetVerified = await request('/api/auth/otp/verify', {
  method: 'POST',
  body: { challengeId: reset.payload.challengeId, code: reset.payload.debugCode },
});
assert.equal(resetVerified.response.status, 200);

const revokedSession = await request('/api/auth/me', { cookie: verified.cookie });
assert.equal(revokedSession.payload.user, null);

const login = await request('/api/auth/login', {
  method: 'POST',
  body: { email, password: resetPassword, turnstileToken: 'dev-test' },
});
assert.equal(login.response.status, 200);
assert.equal(login.payload.user.credits, 3);

const phoneDisabled = await request('/api/auth/otp/request', {
  method: 'POST',
  body: { channel: 'phone', identifier: '13800000000', purpose: 'login', turnstileToken: 'dev-test' },
});
assert.equal(phoneDisabled.response.status, 503);
assert.equal(phoneDisabled.payload.code, 'PHONE_AUTH_DISABLED');

const deleted = await request('/api/account', {
  method: 'DELETE', cookie: login.cookie,
  body: { confirmation: '注销帐号' },
});
assert.equal(deleted.response.status, 200);
const afterDeletion = await request('/api/auth/me', { cookie: login.cookie });
assert.equal(afterDeletion.payload.user, null);

console.log('api: registration, one-time code, trial credit, CSRF, refund, reset, session revocation and deletion passed');
