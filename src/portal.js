import { TRACKS } from './music.js';
import {
  figureLabel,
  getLocale,
  membershipIntervalLabel,
  membershipTierLabel,
  t,
} from './i18n.js';

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || t('requestFailed', getLocale()), response.status, payload.code, payload.details);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function dateText(timestamp) {
  return new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(Number(timestamp) * 1000));
}

function money(cents) {
  return new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(Number(cents) / 100);
}

function paymentStatus(value, language) {
  return ({
    pending: t('pendingStatus', language),
    paid: t('paidStatus', language),
    failed: t('failedStatus', language),
    refunded: t('refundedStatus', language),
    disputed: t('disputedStatus', language),
  })[value] || value;
}

export function createPortal({ music, beforeExternal, restoreExternal, onMembershipChange } = {}) {
  const locale = getLocale();
  const copy = (key, values) => t(key, locale, values);
  const root = document.getElementById('portal-root');
  const accountButton = document.getElementById('account-button');
  let user = null;
  let config = null;
  let initialized = false;
  let active = 'overview';
  let authMode = 'register';
  let challenge = null;
  let turnstileToken = '';
  let turnstileWidget = null;
  let toastTimer = null;
  let opening = false;
  let hasOpened = false;

  root.innerHTML = `
    <button class="portal-veil" type="button" aria-label="${copy('closeAccountPage')}"></button>
    <aside class="portal-drawer" role="dialog" aria-modal="true" aria-labelledby="portal-title" aria-hidden="true">
      <div class="portal-frame">
        <header class="portal-head">
          <div><div class="portal-kicker">${copy('brandKicker')}</div><h2 id="portal-title">${copy('portalTitle')}</h2></div>
          <button class="portal-close" type="button" aria-label="${copy('close')}">×</button>
        </header>
        <nav class="portal-nav" aria-label="${copy('accountFeatures')}"></nav>
        <main class="portal-body"></main>
      </div>
    </aside>
    <div class="portal-toast" role="status" aria-live="polite"></div>`;

  const drawer = root.querySelector('.portal-drawer');
  const nav = root.querySelector('.portal-nav');
  const body = root.querySelector('.portal-body');
  const toastElement = root.querySelector('.portal-toast');

  function toast(message) {
    clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.classList.add('visible');
    toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 4200);
  }

  function updateButtons() {
    const availableQuestions = user && !user.admin
      ? Number(user.credits || 0) + Number(user.membership?.remaining || 0)
      : null;
    accountButton.dataset.credit = user ? (user.admin ? '∞' : String(availableQuestions)) : '';
    if (!user) accountButton.removeAttribute('data-credit');
    accountButton.textContent = user ? copy('account') : copy('accountSignIn');
    accountButton.setAttribute('aria-label', user ? copy('accountLabelAccount') : copy('accountLabelSignIn'));
  }

  async function refresh() {
    try {
      const data = await api('/api/auth/me');
      user = data.user;
      config = data.config;
      initialized = true;
      onMembershipChange?.(user?.membership || null, config?.billing?.premiumAnimations || config?.billing?.premiumAnimationUrl || '');
      updateButtons();
      return user;
    } catch (error) {
      initialized = true;
      config = null;
      user = null;
      onMembershipChange?.(null, '');
      updateButtons();
      throw error;
    }
  }

  function navItems() {
    if (!user) return [
      ['history', copy('history')], ['overview', copy('login')], ['about', copy('about')], ['sound', copy('sound')],
    ];
    return [
      ['history', copy('history')], ['overview', copy('accountNav')], ['sound', copy('sound')],
    ];
  }

  function selectedNavItem() {
    return ['overview', 'recharge', 'payments', 'account', 'origin'].includes(active) ? 'overview' : active;
  }

  function renderNav() {
    nav.replaceChildren();
    for (const [id, label] of navItems()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.section = id;
      button.textContent = label;
      button.setAttribute('aria-selected', String(selectedNavItem() === id));
      nav.appendChild(button);
    }
  }

  function section(html) {
    body.innerHTML = `<section class="portal-section">${html}</section>`;
    body.scrollTop = 0;
  }

  function render() {
    if (!user && !['overview', 'sound', 'about'].includes(active)) active = 'overview';
    const immersiveAuth = !user && active === 'overview';
    root.classList.toggle('portal-auth-scene', immersiveAuth);
    if (immersiveAuth) window.dispatchEvent(new CustomEvent('geomancer:auth-open'));
    renderNav();
    if (active === 'overview') user ? renderOverview() : renderAuth();
    else if (active === 'origin') renderOriginStory();
    else if (active === 'recharge') renderRecharge();
    else if (active === 'history') renderHistory();
    else if (active === 'payments') renderPayments();
    else if (active === 'account') renderAccount();
    else if (active === 'sound') renderSound();
    else renderAbout();
  }

  async function open(sectionName) {
    if (opening) return;
    opening = true;
    hasOpened = true;
    if (sectionName) active = sectionName;
    root.classList.add('portal-open');
    drawer.setAttribute('aria-hidden', 'false');
    try { await refresh(); } catch (error) { toast(error.message); }
    render();
    opening = false;
    requestAnimationFrame(() => root.querySelector('.portal-close').focus());
  }

  function close() {
    root.classList.remove('portal-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (turnstileWidget !== null && window.turnstile) {
      try { window.turnstile.remove(turnstileWidget); } catch {}
      turnstileWidget = null;
    }
    window.dispatchEvent(new CustomEvent('geomancer:auth-close'));
    accountButton.focus();
  }

  function revealInk() {
    body.querySelectorAll('[data-ink-reveal]').forEach((element, blockIndex) => {
      const value = element.dataset.inkReveal || '';
      element.textContent = '';
      element.setAttribute('aria-label', value);
      Array.from(value).forEach((character, index) => {
        const span = document.createElement('span');
        span.className = 'portal-ink-unit';
        span.setAttribute('aria-hidden', 'true');
        span.textContent = character === ' ' ? '\u00a0' : character;
        span.style.animationDelay = `${700 + blockIndex * 420 + index * 42}ms`;
        element.appendChild(span);
      });
    });
  }

  async function ensureCanAsk() {
    if (!initialized) {
      try { await refresh(); } catch (error) { toast(error.message); return false; }
    }
    if (!user) {
      await open('overview');
      toast(copy('loginRequired'));
      return false;
    }
    if (!user.admin && user.credits < 1 && (user.membership?.remaining || 0) < 1) {
      await open('recharge');
      toast(copy('creditsEmpty'));
      return false;
    }
    return true;
  }

  function updateAfterAnswer(reply) {
    if (user && !user.admin && Number.isFinite(reply.remainingCredits)) user.credits = reply.remainingCredits;
    if (user && reply.membership) user.membership = reply.membership;
    updateButtons();
  }

  async function handleApiError(error) {
    if (error.status === 401) await open('overview');
    else if (error.status === 402) await open('recharge');
    toast(error.message || copy('requestFailed'));
  }

  function authTabs() {
    const tabs = [
      ['otp', copy('emailCode')], ['password', copy('passwordLogin')], ['register', copy('register')], ['reset', copy('resetPassword')],
    ];
    if (config?.auth?.phoneEnabled) tabs.push(['phone', copy('phone')]);
    return `<div class="portal-auth-switch">${tabs.map(([id, label]) =>
      `<button type="button" data-auth-mode="${id}" class="${authMode === id ? 'active' : ''}">${label}</button>`
    ).join('')}</div>`;
  }

  function renderAuth() {
    if (challenge) return renderChallenge();
    let fields = '';
    let submit = '';
    if (authMode === 'otp') {
      fields = '<label class="portal-field">' + copy('email') + '<input name="email" type="email" autocomplete="email" required></label>';
      submit = copy('sendLoginCode');
    } else if (authMode === 'password') {
      fields = '<label class="portal-field">' + copy('email') + '<input name="email" type="email" autocomplete="email" required></label><label class="portal-field">' + copy('password') + '<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required></label>';
      submit = copy('loginButton');
    } else if (authMode === 'register') {
      fields = '<label class="portal-field">' + copy('email') + '<input name="email" type="email" autocomplete="email" required></label><label class="portal-field">' + copy('setPassword') + '<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>';
      submit = copy('verifyAndRegister');
    } else if (authMode === 'reset') {
      fields = '<label class="portal-field">' + copy('registerEmail') + '<input name="email" type="email" autocomplete="email" required></label><label class="portal-field">' + copy('newPassword') + '<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>';
      submit = copy('sendResetCode');
    } else {
      fields = '<label class="portal-field">' + copy('mainlandPhone') + '<input name="phone" type="tel" autocomplete="tel" placeholder="13800000000" required></label>';
      submit = copy('sendSms');
    }
    const unavailable = !config?.auth?.turnstileSiteKey;
    section(`
      <div class="portal-auth-prologue">
        <h3 class="portal-ink-prompt" data-ink-reveal="${escapeHtml(copy('whoAreYou'))}"></h3>
        <p class="portal-ink-copy" data-ink-reveal="${escapeHtml(copy('tellName'))}"></p>
      </div>
      ${authTabs()}
      <form class="portal-form portal-auth-ui" id="portal-auth-form">
        ${fields}
        <div class="portal-turnstile" id="portal-turnstile"></div>
        <button class="portal-button primary" type="submit" ${unavailable ? 'disabled' : ''}>${submit}</button>
        ${config?.auth?.googleEnabled ? '<button class="portal-button" type="button" id="portal-google">' + copy('useGoogle') + '</button>' : ''}
      </form>
      <p class="portal-message ${unavailable ? 'error' : ''}" id="portal-auth-message">${unavailable ? copy('authConfig') : ''}</p>
    `);
    if (!unavailable) mountTurnstile(authMode === 'register' ? 'register' : authMode === 'password' ? 'login' : authMode === 'reset' ? 'reset' : 'otp');
    body.querySelector('#portal-auth-form')?.addEventListener('submit', submitAuth);
    body.querySelector('#portal-google')?.addEventListener('click', startGoogle);
    revealInk();
  }

  function setAuthMessage(message, isError = false) {
    const element = body.querySelector('#portal-auth-message');
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('error', isError);
  }

  function mountTurnstile(action) {
    turnstileToken = '';
    const host = body.querySelector('#portal-turnstile');
    if (!host || !config?.auth?.turnstileSiteKey) return;
    let attempts = 0;
    const tryRender = () => {
      if (!host.isConnected) return;
      if (!window.turnstile) {
        if (++attempts < 50) setTimeout(tryRender, 100);
        else setAuthMessage(copy('turnstileLoad'), true);
        return;
      }
      if (turnstileWidget !== null) {
        try { window.turnstile.remove(turnstileWidget); } catch {}
      }
      turnstileWidget = window.turnstile.render(host, {
        sitekey: config.auth.turnstileSiteKey,
        theme: 'dark',
        size: 'flexible',
        language: 'zh-cn',
        action,
        callback: token => { turnstileToken = token; setAuthMessage(''); },
        'expired-callback': () => { turnstileToken = ''; },
        'error-callback': () => setAuthMessage(copy('turnstileRetry'), true),
      });
    };
    tryRender();
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (!turnstileToken) return setAuthMessage(copy('verifyFirst'), true);
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    setAuthMessage(copy('requesting'));
    try {
      let result;
      if (authMode === 'password') {
        result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password'), turnstileToken }) });
        user = result.user;
        updateButtons();
        active = 'overview';
        render();
        toast(copy('alreadyLoggedIn'));
        return;
      }
      if (authMode === 'register') {
        result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password'), turnstileToken }) });
      } else if (authMode === 'reset') {
        result = await api('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password'), turnstileToken }) });
        if (!result.challengeId) { setAuthMessage(result.message); button.disabled = false; mountTurnstile('reset'); return; }
      } else {
        const isPhone = authMode === 'phone';
        result = await api('/api/auth/otp/request', { method: 'POST', body: JSON.stringify({
          channel: isPhone ? 'phone' : 'email', identifier: isPhone ? form.get('phone') : form.get('email'), purpose: 'login', turnstileToken,
        }) });
      }
      challenge = { id: result.challengeId, mode: authMode, debugCode: result.debugCode || '', message: result.message };
      renderChallenge();
    } catch (error) {
      setAuthMessage(error.message, true);
      button.disabled = false;
      mountTurnstile(authMode === 'register' ? 'register' : authMode === 'reset' ? 'reset' : 'otp');
    }
  }

  function renderChallenge() {
    section(`
      <div class="portal-auth-prologue">
        <h3 class="portal-ink-prompt" data-ink-reveal="${escapeHtml(copy('letterSent'))}"></h3>
        <p class="portal-ink-copy" data-ink-reveal="${escapeHtml((challenge.message || copy('codeSent')) + (locale === 'en' ? '. ' : '。') + copy('challengeCopy'))}"></p>
      </div>
      <form class="portal-form portal-auth-ui" id="portal-code-form">
        <label class="portal-field">${copy('verificationCode')}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
        <button class="portal-button primary" type="submit">${copy('confirmCode')}</button>
        <button class="portal-button" type="button" id="portal-code-back">${copy('back')}</button>
      </form>
      <p class="portal-message" id="portal-auth-message">${challenge.debugCode ? escapeHtml(t('localCode', locale, { code: challenge.debugCode })) : ''}</p>
    `);
    body.querySelector('#portal-code-form').addEventListener('submit', async event => {
      event.preventDefault();
      const code = new FormData(event.currentTarget).get('code');
      const button = event.currentTarget.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const completedMode = challenge.mode;
        const result = await api('/api/auth/otp/verify', { method: 'POST', body: JSON.stringify({ challengeId: challenge.id, code }) });
        user = result.user;
        challenge = null;
        active = completedMode === 'register' ? 'origin' : 'overview';
        updateButtons();
        render();
        toast(user ? copy('recognized') : copy('verified'));
      } catch (error) {
        setAuthMessage(error.message, true);
        button.disabled = false;
      }
    });
    body.querySelector('#portal-code-back').addEventListener('click', () => {
      challenge = null;
      if (user) renderAccount(); else renderAuth();
    });
    revealInk();
  }

  function renderOriginStory() {
    section(`
      <div class="portal-origin">
        <div class="portal-auth-prologue">
          <h3 class="portal-ink-prompt" data-ink-reveal="${escapeHtml(copy('originTitle'))}"></h3>
          <p class="portal-ink-copy" data-ink-reveal="${escapeHtml(copy('originOne'))}"></p>
        </div>
        <div class="portal-card portal-origin-card">
          <p>${escapeHtml(copy('originTwo'))}</p>
          <p>${escapeHtml(copy('originThree'))}</p>
        </div>
        <div class="portal-actions portal-origin-actions">
          <button class="portal-button primary" type="button" data-close-portal>${copy('beginWriting')}</button>
          <button class="portal-button" type="button" data-go="overview">${copy('stayInAccount')}</button>
        </div>
      </div>
    `);
    revealInk();
  }

  async function startGoogle() {
    if (!turnstileToken) return setAuthMessage(copy('verifyFirst'), true);
    try {
      beforeExternal?.();
      const result = await api('/api/auth/google/start', { method: 'POST', body: JSON.stringify({ turnstileToken, returnTo: '/' }) });
      location.assign(result.url);
    } catch (error) { setAuthMessage(error.message, true); mountTurnstile('google'); }
  }

  function renderOverview() {
    const membership = user.membership;
    const availableQuestions = user.admin ? null : Number(user.credits || 0) + Number(membership?.remaining || 0);
    const membershipStatus = membership?.status === 'past_due' ? copy('membershipPastDue') : copy('membershipActive');
    const membershipEnd = membership?.cancelAtPeriodEnd
      ? copy('membershipEnding', { date: dateText(membership.periodEndsAt) })
      : '';
    const membershipTier = membership ? membershipTierLabel(membership.tier, locale) : copy('noMembership');
    section(`
      <div class="portal-card">
        <div class="portal-label">${copy('availableCredits')}</div>
        <div class="portal-balance"><strong>${user.admin ? '∞' : availableQuestions}</strong><span>${user.admin ? copy('adminCredits') : copy('creditUnit')}</span></div>
      </div>
      <div class="portal-card portal-membership-card">
        <div class="portal-label">${copy('currentMembership')}</div>
        <div class="portal-membership-head">
          <strong>${escapeHtml(membershipTier)}</strong>
          ${membership ? `<span class="portal-status">${escapeHtml(membershipStatus)}</span>` : ''}
        </div>
        ${membership
          ? `<p class="portal-lead" style="margin:.55rem 0 0">${escapeHtml(t('membershipQuota', locale, { count: membership.remaining }))} · ${escapeHtml(membershipIntervalLabel(membership.interval, locale))}${membershipEnd ? ` · ${escapeHtml(membershipEnd)}` : ''}</p>`
          : `<p class="portal-lead" style="margin:.55rem 0 0">${copy('membershipLead')}</p>`}
        ${membership ? `<button class="portal-button" type="button" data-manage-subscription>${copy('membershipManage')}</button>` : `<button class="portal-button primary" type="button" data-go="recharge">${copy('membershipChoose')}</button>`}
      </div>
      <div class="portal-card">
        <div class="portal-label">${copy('currentAccount')}</div>
        <div>${escapeHtml(user.email || user.phone || copy('verifiedAccount'))}</div>
        <p class="portal-lead" style="margin:.55rem 0 0">${copy('refundLead')}</p>
      </div>
      <div class="portal-card portal-account-actions">
        <div class="portal-label">${copy('pageOptions')}</div>
        <div class="portal-actions">
          ${user.admin ? '' : (membership ? '' : '<button class="portal-button primary" type="button" data-go="recharge">' + copy('buyCredits') + '</button>')}
          <button class="portal-button" type="button" data-go="payments">${copy('transactions')}</button>
          <button class="portal-button" type="button" data-go="account">${copy('accountSettings')}</button>
        </div>
      </div>
    `);
  }

  function renderRecharge() {
    const memberships = config?.billing?.memberships || [];
    section(`
      <button class="portal-back" type="button" data-go="overview">← ${copy('rechargeBack')}</button>
      <h3>${copy('membershipTitle')}</h3>
      <p class="portal-lead">${copy('rechargeLead')}</p>
      <div class="portal-segmented" role="tablist" aria-label="${copy('membershipTitle')}">
        <button class="portal-segment" type="button" role="tab" aria-selected="true" data-membership-interval="month">${copy('monthly')}</button>
        <button class="portal-segment" type="button" role="tab" aria-selected="false" data-membership-interval="year">${copy('yearly')} <small>${copy('membershipYearlyValue')}</small></button>
      </div>
      <div class="portal-packages portal-memberships">${memberships.map(item => `
        <button class="portal-button portal-package portal-membership-plan" type="button" data-membership-plan="${escapeHtml(item.id)}" data-interval="${escapeHtml(item.interval)}" ${config?.billing?.enabled ? '' : 'disabled'}>
          <span class="portal-plan-kicker">${escapeHtml(membershipTierLabel(item.tier, locale))}</span>
          <strong>${money(item.amount)}<small> / ${escapeHtml(membershipIntervalLabel(item.interval, locale))}</small></strong>
          <span>${escapeHtml(t('membershipCycle', locale, { count: item.credits }))}</span>
          <small>${item.tier === 'advanced' ? copy('membershipAnimation') : copy('membershipRollover')}</small>
        </button>`).join('')}</div>
      ${config?.billing?.enabled ? '' : '<p class="portal-message error">' + copy('billingUnavailable') + '</p>'}
      <p class="portal-message">${copy('paymentLead')}<a href="/refund" target="_blank" rel="noopener" style="color:inherit">${copy('refundLink')}</a>${copy('refundTail')}</p>
    `);
    const setInterval = interval => {
      body.querySelectorAll('[data-membership-interval]').forEach(button => {
        button.setAttribute('aria-selected', String(button.dataset.membershipInterval === interval));
      });
      body.querySelectorAll('[data-membership-plan]').forEach(button => {
        button.hidden = button.dataset.interval !== interval;
      });
    };
    body.querySelectorAll('[data-membership-interval]').forEach(button => button.addEventListener('click', () => setInterval(button.dataset.membershipInterval)));
    body.querySelectorAll('[data-membership-plan]').forEach(button => button.addEventListener('click', () => beginCheckout(button)));
    setInterval('month');
  }

  async function beginCheckout(button) {
    button.disabled = true;
    try {
      beforeExternal?.();
      toast(copy('membershipCheckout'));
      const result = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ planId: button.dataset.membershipPlan, locale }) });
      location.assign(result.checkoutUrl);
    } catch (error) { toast(error.message); button.disabled = false; }
  }

  async function manageSubscription(button) {
    button.disabled = true;
    try {
      beforeExternal?.();
      const result = await api('/api/billing/portal', { method: 'POST' });
      location.assign(result.url);
    } catch (error) { toast(error.message || copy('membershipNotFound')); button.disabled = false; }
  }

  async function renderHistory() {
    section('<p class="portal-lead">' + copy('readingHistory') + '</p><div class="portal-empty">' + copy('reading') + '</div>');
    try {
      const result = await api('/api/conversations');
      const list = result.conversations || [];
      section(`
        <div class="portal-actions" style="justify-content:space-between;margin-bottom:1rem">
          <span class="portal-lead" style="margin:0">${t('total', locale, { count: list.length })}</span>
          ${list.length ? '<button class="portal-button danger" type="button" id="portal-clear-history">' + copy('clearAll') + '</button>' : ''}
        </div>
        <div class="portal-list" id="portal-history-list"></div>
        ${list.length ? '' : '<div class="portal-empty">' + copy('noHistory') + '</div>'}
      `);
      const container = body.querySelector('#portal-history-list');
      for (const item of list) container.appendChild(historyEntry(item));
      body.querySelector('#portal-clear-history')?.addEventListener('click', clearHistory);
    } catch (error) { section(`<div class="portal-empty">${escapeHtml(error.message)}</div>`); }
  }

  function historyEntry(item) {
    const article = document.createElement('article');
    article.className = 'portal-entry';
    const oracle = item.geomancy ? `${figureLabel(item.geomancy.left, locale)} ${locale === 'en' ? '+' : '＋'} ${figureLabel(item.geomancy.right, locale)} ${locale === 'en' ? '=' : '＝'} ${figureLabel(item.geomancy.result, locale)} · ${item.topic === '基本卦义' ? copy('coreFigures') : item.topic}` : '';
    article.innerHTML = `
      <time>${dateText(item.createdAt)}</time>
      <div class="portal-question"></div>
      ${oracle ? '<div class="portal-oracle"></div>' : ''}
      <div class="portal-answer"></div>
      <div class="portal-entry-tools"><button type="button">${copy('deleteEntry')}</button></div>`;
    article.querySelector('.portal-question').textContent = t('questionPrefix', locale, { question: item.question });
    article.querySelector('.portal-answer').textContent = item.text;
    if (oracle) article.querySelector('.portal-oracle').textContent = oracle;
    article.querySelector('button').addEventListener('click', async () => {
      if (!confirm(copy('deleteConfirm'))) return;
      try { await api(`/api/conversations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); article.remove(); toast(copy('deleted')); }
      catch (error) { toast(error.message); }
    });
    return article;
  }

  async function clearHistory() {
    if (!confirm(copy('clearHistoryConfirm'))) return;
    try { await api('/api/conversations', { method: 'DELETE' }); renderHistory(); toast(copy('historyCleared')); }
    catch (error) { toast(error.message); }
  }

  async function renderPayments() {
    section('<div class="portal-empty">' + copy('readingPayments') + '</div>');
    try {
      const result = await api('/api/billing/payments');
      const list = result.payments || [];
      section(`
        <button class="portal-back" type="button" data-go="overview">← ${copy('rechargeBack')}</button>
        <p class="portal-lead">${copy('auditLead')}</p>
        <div class="portal-list">${list.map(item => {
          const plan = item.kind === 'membership' ? (config?.billing?.memberships || []).find(candidate => candidate.id === item.planId) : null;
          const label = plan ? membershipTierLabel(plan.tier, locale) : item.kind === 'membership' ? copy('membership') : copy('membershipLegacy');
          const count = item.kind === 'membership'
            ? t('membershipPaymentCount', locale, { amount: money(item.amount), count: item.credits })
            : t('paymentCount', locale, { amount: money(item.amount), count: item.credits });
          return `
          <div class="portal-card portal-payment">
            <strong>${escapeHtml(label)}</strong><span class="portal-status">${paymentStatus(item.status, locale)}</span>
            <small>${escapeHtml(count)}</small><small>${dateText(item.createdAt)}</small>
            <small>${item.refundedAmount ? escapeHtml(t('refunded', locale, { amount: money(item.refundedAmount) })) : ''}</small>
          </div>`;
        }).join('')}</div>
        ${list.length ? '' : '<div class="portal-empty">' + copy('noPayments') + '</div>'}
      `);
    } catch (error) { section(`<div class="portal-empty">${escapeHtml(error.message)}</div>`); }
  }

  function renderAccount() {
    const canLinkPhone = config?.auth?.phoneEnabled && !user.phone;
    section(`
      <button class="portal-back" type="button" data-go="overview">← ${copy('rechargeBack')}</button>
      <div class="portal-card">
        <div class="portal-label">${copy('loginIdentity')}</div>
        <div>${escapeHtml(user.email || user.phone || copy('verifiedAccount'))}</div>
        <p class="portal-lead" style="margin:.6rem 0 0">${user.hasPassword ? copy('passwordSet') : copy('passwordNotSet')}${user.hasGoogle ? ' · ' + copy('googleLinked') : ''}${user.phone ? ' · ' + copy('phoneLinked') : ''}</p>
      </div>
      <div class="portal-actions">
        ${canLinkPhone ? '<button class="portal-button" type="button" id="portal-link-phone">' + copy('linkPhone') + '</button>' : ''}
        <button class="portal-button" type="button" id="portal-logout">${copy('logout')}</button>
        <button class="portal-button danger" type="button" id="portal-delete-account">${copy('deleteAccount')}</button>
      </div>
      <p class="portal-message">${copy('deleteWarning')}</p>
      <div class="portal-legal" style="margin-top:1rem"><a href="/privacy" target="_blank">${copy('privacy')}</a><a href="/terms" target="_blank">${copy('terms')}</a></div>
    `);
    body.querySelector('#portal-logout').addEventListener('click', logout);
    body.querySelector('#portal-delete-account').addEventListener('click', deleteAccount);
    body.querySelector('#portal-link-phone')?.addEventListener('click', renderPhoneLink);
  }

  function renderPhoneLink() {
    section(`
      <p class="portal-lead">${copy('linkPhoneLead')}</p>
      <form class="portal-form" id="portal-phone-link-form">
        <label class="portal-field">${copy('phone')}<input name="phone" type="tel" autocomplete="tel" placeholder="13800000000" required></label>
        <div class="portal-turnstile" id="portal-turnstile"></div>
        <button class="portal-button primary" type="submit">${copy('sendLinkCode')}</button>
        <button class="portal-button" type="button" id="portal-phone-link-back">${copy('rechargeBack')}</button>
      </form>
      <p class="portal-message" id="portal-auth-message"></p>
    `);
    mountTurnstile('otp');
    body.querySelector('#portal-phone-link-back').addEventListener('click', renderAccount);
    body.querySelector('#portal-phone-link-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!turnstileToken) return setAuthMessage(copy('verifyFirst'), true);
      const button = event.currentTarget.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const result = await api('/api/auth/otp/request', { method: 'POST', body: JSON.stringify({
          channel: 'phone', identifier: new FormData(event.currentTarget).get('phone'), purpose: 'link', turnstileToken,
        }) });
        challenge = { id: result.challengeId, mode: 'link-phone', debugCode: result.debugCode || '', message: result.message };
        renderChallenge();
      } catch (error) {
        setAuthMessage(error.message, true);
        button.disabled = false;
        mountTurnstile('otp');
      }
    });
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      user = null;
      active = 'overview';
      updateButtons();
      render();
      toast(copy('loggedOut'));
    } catch (error) { toast(error.message); }
  }

  async function deleteAccount() {
    const confirmation = prompt(copy('deletePrompt'));
    const expectedConfirmation = locale === 'en' ? 'Delete account' : '注销帐号';
    if (confirmation !== expectedConfirmation) return;
    try {
      await api('/api/account', { method: 'DELETE', body: JSON.stringify({ confirmation: '注销帐号' }) });
      user = null;
      active = 'overview';
      updateButtons();
      render();
      toast(copy('deletedAccount'));
    } catch (error) { toast(error.message); }
  }

  function renderSound() {
    const state = music.getState();
    section(`
      <div class="portal-card">
        <div class="portal-label">${copy('rotating')}</div>
        <div class="portal-track" id="portal-track-title">${escapeHtml(state.track.title)}</div>
        <p class="portal-message">${state.waitingForGesture ? copy('autoplayBlocked') : state.playing ? copy('playing') : copy('paused')}</p>
        <div class="portal-actions">
          <button class="portal-button" type="button" id="portal-play">${state.playing ? copy('pause') : copy('play')}</button>
          <button class="portal-button" type="button" id="portal-mute">${state.muted ? copy('unmute') : copy('mute')}</button>
          <button class="portal-button" type="button" id="portal-next">${copy('next')}</button>
        </div>
        <label class="portal-field" style="margin-top:1rem">${copy('volume')}
          <input id="portal-volume" type="range" min="0" max="0.35" step="0.01" value="${state.volume}">
        </label>
      </div>
      <div class="portal-attribution">
        <p>${copy('musicCredit')}</p>
        <div class="portal-legal">${TRACKS.map(track => `<a href="${track.source}" target="_blank" rel="noopener">${escapeHtml(track.title)} ↗</a>`).join('')}<a href="/music-credits" target="_blank">${copy('fullMusicCredit')}</a></div>
      </div>
    `);
    body.querySelector('#portal-play').addEventListener('click', async () => {
      if (state.playing) music.pause();
      else await music.play();
      renderSound();
    });
    body.querySelector('#portal-mute').addEventListener('click', async () => {
      await music.toggleMuted();
      renderSound();
    });
    body.querySelector('#portal-next').addEventListener('click', async () => {
      await music.next();
      renderSound();
    });
    body.querySelector('#portal-volume').addEventListener('input', event => music.setVolume(event.target.value));
  }

  function renderAbout() {
    section(`
      <p class="portal-lead">${copy('aboutLead')}</p>
      <div class="portal-card"><div class="portal-label">${copy('creditRules')}</div><p class="portal-answer">${copy('creditRulesCopy')}</p></div>
      <div class="portal-legal"><a href="/privacy" target="_blank">${copy('privacy')}</a><a href="/terms" target="_blank">${copy('terms')}</a><a href="/refund" target="_blank">${copy('refundLink')}</a><a href="/music-credits" target="_blank">${copy('music')}</a></div>
    `);
  }

  async function handleReturn() {
    const url = new URL(location.href);
    const auth = url.searchParams.get('auth');
    const checkout = url.searchParams.get('checkout');
    const sessionId = url.searchParams.get('session_id');
    if (!auth && !checkout) return;
    url.searchParams.delete('auth');
    url.searchParams.delete('checkout');
    url.searchParams.delete('session_id');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
    try {
      if (checkout === 'success' && sessionId) {
        const result = await api('/api/billing/confirm', { method: 'POST', body: JSON.stringify({ sessionId }) });
        toast(result.credited
          ? copy('paidConfirmed')
          : result.paid
            ? copy('paidWaiting')
            : copy('paidProcessing'));
      } else if (checkout === 'cancelled') toast(copy('paymentCancelled'));
      else if (auth === 'success') toast(copy('loginRestored'));
      else if (auth === 'error') toast(copy('googleIncomplete'));
      await refresh();
    } catch (error) { toast(error.message); }
    restoreExternal?.();
  }

  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-section]');
    if (!button) return;
    if (button.dataset.section === 'history' && !user) {
      open('overview');
      toast(copy('historyLogin'));
      return;
    }
    active = button.dataset.section;
    render();
  });
  body.addEventListener('click', event => {
    const authButton = event.target.closest('[data-auth-mode]');
    if (authButton) { authMode = authButton.dataset.authMode; challenge = null; renderAuth(); return; }
    const closeButton = event.target.closest('[data-close-portal]');
    if (closeButton) { close(); return; }
    const manageButton = event.target.closest('[data-manage-subscription]');
    if (manageButton) { manageSubscription(manageButton); return; }
    const go = event.target.closest('[data-go]');
    if (go) { active = go.dataset.go; render(); }
  });
  root.querySelector('.portal-veil').addEventListener('click', close);
  root.querySelector('.portal-close').addEventListener('click', close);
  accountButton.addEventListener('click', () => open('overview'));
  window.addEventListener('geomancer:install-start', () => { hasOpened = true; });

  async function initialize() {
    try { await refresh(); } catch {}
    await handleReturn();
    if (!user) {
      setTimeout(() => {
        if (!user && !hasOpened && !root.classList.contains('portal-open')) open('overview');
      }, 2600);
    }
  }

  initialize();

  return {
    open,
    close,
    isOpen: () => root.classList.contains('portal-open'),
    ensureCanAsk,
    updateAfterAnswer,
    handleApiError,
    refresh,
    toast,
  };
}
