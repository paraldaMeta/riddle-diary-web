export const CREDIT_PACKAGES = Object.freeze([
  { id: 'credits_30', credits: 30, amount: 3000, currency: 'cny', label: '三十次' },
  { id: 'credits_60', credits: 60, amount: 6000, currency: 'cny', label: '六十次' },
  { id: 'credits_100', credits: 100, amount: 10000, currency: 'cny', label: '一百次' },
  { id: 'credits_200', credits: 200, amount: 20000, currency: 'cny', label: '二百次' },
  { id: 'credits_500', credits: 500, amount: 50000, currency: 'cny', label: '五百次' },
  { id: 'credits_1000', credits: 1000, amount: 100000, currency: 'cny', label: '一千次' },
]);

export function findPackage(id) {
  return CREDIT_PACKAGES.find(item => item.id === id) || null;
}

export function isDevelopment(env) {
  return env.ENVIRONMENT === 'development' && env.AUTH_DEV_MODE === 'true';
}

export function phoneAuthEnabled(env) {
  return env.ENABLE_PHONE_AUTH === 'true' && Boolean(
    env.ALIYUN_SMS_ACCESS_KEY_ID &&
    env.ALIYUN_SMS_ACCESS_KEY_SECRET &&
    env.ALIYUN_SMS_SIGN_NAME &&
    env.ALIYUN_SMS_TEMPLATE_CODE
  );
}

export function publicConfiguration(env) {
  const development = isDevelopment(env);
  return {
    auth: {
      emailEnabled: Boolean(development || (env.RESEND_API_KEY && env.AUTH_FROM_EMAIL)),
      passwordEnabled: true,
      googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      phoneEnabled: phoneAuthEnabled(env),
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || (development ? '1x00000000000000000000AA' : ''),
    },
    billing: {
      enabled: Boolean(env.STRIPE_SECRET_KEY),
      currency: 'CNY',
      packages: CREDIT_PACKAGES.map(({ id, credits, amount, currency, label }) => ({ id, credits, amount, currency, label })),
    },
    historyLimit: 100,
  };
}

