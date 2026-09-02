import { TRACKS } from './music.js';

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
  if (!response.ok) throw new ApiError(payload.error || '请求失败，请稍后重试', response.status, payload.code, payload.details);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function dateText(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(Number(timestamp) * 1000));
}

function money(cents) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(Number(cents) / 100);
}

function paymentStatus(value) {
  return ({ pending: '等待付款', paid: '已到账', failed: '未完成', refunded: '已退款', disputed: '争议处理中' })[value] || value;
}

export function createPortal({ music, beforeExternal, restoreExternal } = {}) {
  const root = document.getElementById('portal-root');
  const accountButton = document.getElementById('account-button');
  const soundButton = document.getElementById('sound-button');
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
    <button class="portal-veil" type="button" aria-label="关闭帐号与声音"></button>
    <aside class="portal-drawer" role="dialog" aria-modal="true" aria-labelledby="portal-title" aria-hidden="true">
      <div class="portal-frame">
        <header class="portal-head">
          <div><div class="portal-kicker">答案之书内页</div><h2 id="portal-title">帐号与声音</h2></div>
          <button class="portal-close" type="button" aria-label="关闭">×</button>
        </header>
        <nav class="portal-nav" aria-label="帐号功能"></nav>
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
    accountButton.dataset.credit = user ? (user.admin ? '∞' : String(user.credits)) : '';
    if (!user) accountButton.removeAttribute('data-credit');
    accountButton.textContent = user ? '帐' : '入';
    const sound = music.getState();
    soundButton.textContent = sound.muted ? '静' : '音';
    soundButton.setAttribute('aria-label', sound.muted ? '音乐已静音，点按开启' : `正在播放 ${sound.track.title}，点按静音`);
  }

  async function refresh() {
    try {
      const data = await api('/api/auth/me');
      user = data.user;
      config = data.config;
      initialized = true;
      updateButtons();
      return user;
    } catch (error) {
      initialized = true;
      config = null;
      user = null;
      updateButtons();
      throw error;
    }
  }

  function navItems() {
    if (!user) return [
      ['overview', '登录'], ['sound', '声音'], ['about', '说明'],
    ];
    return [
      ['overview', '概览'], ['recharge', '充值'], ['history', '记录'], ['payments', '交易'], ['account', '帐号'], ['sound', '声音'],
    ];
  }

  function renderNav() {
    nav.replaceChildren();
    for (const [id, label] of navItems()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.section = id;
      button.textContent = label;
      button.setAttribute('aria-selected', String(active === id));
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
      toast('先登录，首次验证帐号会赠送三次提问');
      return false;
    }
    if (!user.admin && user.credits < 1) {
      await open('recharge');
      toast('剩余次数不足，请先充值');
      return false;
    }
    return true;
  }

  function updateAfterAnswer(reply) {
    if (user && !user.admin && Number.isFinite(reply.remainingCredits)) user.credits = reply.remainingCredits;
    updateButtons();
  }

  async function handleApiError(error) {
    if (error.status === 401) await open('overview');
    else if (error.status === 402) await open('recharge');
    toast(error.message || '请求失败，请稍后重试');
  }

  function authTabs() {
    const tabs = [
      ['otp', '邮箱验证码'], ['password', '密码登录'], ['register', '注册'], ['reset', '重置密码'],
    ];
    if (config?.auth?.phoneEnabled) tabs.push(['phone', '手机号']);
    return `<div class="portal-auth-switch">${tabs.map(([id, label]) =>
      `<button type="button" data-auth-mode="${id}" class="${authMode === id ? 'active' : ''}">${label}</button>`
    ).join('')}</div>`;
  }

  function renderAuth() {
    if (challenge) return renderChallenge();
    let fields = '';
    let submit = '';
    if (authMode === 'otp') {
      fields = '<label class="portal-field">邮箱<input name="email" type="email" autocomplete="email" required></label>';
      submit = '发送登录验证码';
    } else if (authMode === 'password') {
      fields = '<label class="portal-field">邮箱<input name="email" type="email" autocomplete="email" required></label><label class="portal-field">密码<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required></label>';
      submit = '登录';
    } else if (authMode === 'register') {
      fields = '<label class="portal-field">邮箱<input name="email" type="email" autocomplete="email" required></label><label class="portal-field">设置密码<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>';
      submit = '验证邮箱并注册';
    } else if (authMode === 'reset') {
      fields = '<label class="portal-field">注册邮箱<input name="email" type="email" autocomplete="email" required></label><label class="portal-field">新密码<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>';
      submit = '发送重置验证码';
    } else {
      fields = '<label class="portal-field">中国大陆手机号<input name="phone" type="tel" autocomplete="tel" placeholder="13800000000" required></label>';
      submit = '发送短信验证码';
    }
    const unavailable = !config?.auth?.turnstileSiteKey;
    section(`
      <div class="portal-auth-prologue">
        <h3 class="portal-ink-prompt" data-ink-reveal="先让我记住你。"></h3>
        <p class="portal-ink-copy" data-ink-reveal="留下一个可以找回的身份。首次验证后，书页会赠你三次提问。"></p>
      </div>
      ${authTabs()}
      <form class="portal-form portal-auth-ui" id="portal-auth-form">
        ${fields}
        <div class="portal-turnstile" id="portal-turnstile"></div>
        <button class="portal-button primary" type="submit" ${unavailable ? 'disabled' : ''}>${submit}</button>
        ${config?.auth?.googleEnabled ? '<button class="portal-button" type="button" id="portal-google">使用 Google 登录</button>' : ''}
      </form>
      <p class="portal-message ${unavailable ? 'error' : ''}" id="portal-auth-message">${unavailable ? '登录服务正在配置中，暂时无法验证身份。' : ''}</p>
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
        else setAuthMessage('人机验证加载失败，请检查网络后重试。', true);
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
        'error-callback': () => setAuthMessage('人机验证加载失败，请重试。', true),
      });
    };
    tryRender();
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (!turnstileToken) return setAuthMessage('请先完成人机验证。', true);
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    setAuthMessage('正在请求答案之书……');
    try {
      let result;
      if (authMode === 'password') {
        result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password'), turnstileToken }) });
        user = result.user;
        updateButtons();
        active = 'overview';
        render();
        toast('已经登录');
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
        <h3 class="portal-ink-prompt" data-ink-reveal="信已经送到。"></h3>
        <p class="portal-ink-copy" data-ink-reveal="${escapeHtml(challenge.message || '验证码已发送')}。写下六位数字，我便会认出你。"></p>
      </div>
      <form class="portal-form portal-auth-ui" id="portal-code-form">
        <label class="portal-field">验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
        <button class="portal-button primary" type="submit">确认验证码</button>
        <button class="portal-button" type="button" id="portal-code-back">返回</button>
      </form>
      <p class="portal-message" id="portal-auth-message">${challenge.debugCode ? `本地测试验证码：${escapeHtml(challenge.debugCode)}` : ''}</p>
    `);
    body.querySelector('#portal-code-form').addEventListener('submit', async event => {
      event.preventDefault();
      const code = new FormData(event.currentTarget).get('code');
      const button = event.currentTarget.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const result = await api('/api/auth/otp/verify', { method: 'POST', body: JSON.stringify({ challengeId: challenge.id, code }) });
        user = result.user;
        challenge = null;
        active = 'overview';
        updateButtons();
        render();
        toast(user ? '验证成功，答案之书已经认出你' : '验证成功');
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

  async function startGoogle() {
    if (!turnstileToken) return setAuthMessage('请先完成人机验证。', true);
    try {
      beforeExternal?.();
      const result = await api('/api/auth/google/start', { method: 'POST', body: JSON.stringify({ turnstileToken, returnTo: '/' }) });
      location.assign(result.url);
    } catch (error) { setAuthMessage(error.message, true); mountTurnstile('google'); }
  }

  function renderOverview() {
    section(`
      <div class="portal-card">
        <div class="portal-label">可用次数</div>
        <div class="portal-balance"><strong>${user.admin ? '∞' : user.credits}</strong><span>${user.admin ? '管理员不限次数' : '次'}</span></div>
      </div>
      <div class="portal-card">
        <div class="portal-label">当前帐号</div>
        <div>${escapeHtml(user.email || user.phone || '已验证帐号')}</div>
        <p class="portal-lead" style="margin:.55rem 0 0">每次成功回答扣除一次；无法识别、模型失败或格式异常会自动退回。</p>
      </div>
      <div class="portal-actions">
        ${user.admin ? '' : '<button class="portal-button primary" type="button" data-go="recharge">购买次数</button>'}
        <button class="portal-button" type="button" data-go="history">查看问答记录</button>
      </div>
    `);
  }

  function renderRecharge() {
    const packages = config?.billing?.packages || [];
    section(`
      <p class="portal-lead">一次性购买，次数永久有效。由 Stripe 安全结算；银行卡、Apple Pay、支付宝与微信支付是否显示，以结账页和 Stripe 帐号开通状态为准。</p>
      <div class="portal-packages">${packages.map(item => `
        <button class="portal-button portal-package" type="button" data-package="${escapeHtml(item.id)}" ${config?.billing?.enabled ? '' : 'disabled'}>
          <strong>${money(item.amount)}</strong><small>${item.credits} 次提问</small>
        </button>`).join('')}</div>
      ${config?.billing?.enabled ? '' : '<p class="portal-message error">充值服务正在配置中，目前无法创建订单。</p>'}
      <p class="portal-message">支付即表示同意<a href="/refund" target="_blank" rel="noopener" style="color:inherit">充值与退款说明</a>。除重复扣款、系统错误、法律要求等情形外，充值后原则上不退款。</p>
    `);
    body.querySelectorAll('[data-package]').forEach(button => button.addEventListener('click', () => beginCheckout(button)));
  }

  async function beginCheckout(button) {
    button.disabled = true;
    try {
      beforeExternal?.();
      const result = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ packageId: button.dataset.package }) });
      location.assign(result.checkoutUrl);
    } catch (error) { toast(error.message); button.disabled = false; }
  }

  async function renderHistory() {
    section('<p class="portal-lead">只保存识别后的问题、回答和卦象，不保存手写图片。最多保留最近一百条。</p><div class="portal-empty">正在翻阅记录……</div>');
    try {
      const result = await api('/api/conversations');
      const list = result.conversations || [];
      section(`
        <div class="portal-actions" style="justify-content:space-between;margin-bottom:1rem">
          <span class="portal-lead" style="margin:0">共 ${list.length} 条</span>
          ${list.length ? '<button class="portal-button danger" type="button" id="portal-clear-history">清空全部</button>' : ''}
        </div>
        <div class="portal-list" id="portal-history-list"></div>
        ${list.length ? '' : '<div class="portal-empty">还没有问答记录。<br>在书页上写下第一个问题吧。</div>'}
      `);
      const container = body.querySelector('#portal-history-list');
      for (const item of list) container.appendChild(historyEntry(item));
      body.querySelector('#portal-clear-history')?.addEventListener('click', clearHistory);
    } catch (error) { section(`<div class="portal-empty">${escapeHtml(error.message)}</div>`); }
  }

  function historyEntry(item) {
    const article = document.createElement('article');
    article.className = 'portal-entry';
    const oracle = item.geomancy ? `${item.geomancy.left} ＋ ${item.geomancy.right} ＝ ${item.geomancy.result} · ${item.topic}` : '';
    article.innerHTML = `
      <time>${dateText(item.createdAt)}</time>
      <div class="portal-question"></div>
      ${oracle ? '<div class="portal-oracle"></div>' : ''}
      <div class="portal-answer"></div>
      <div class="portal-entry-tools"><button type="button">删除这条</button></div>`;
    article.querySelector('.portal-question').textContent = `问：${item.question}`;
    article.querySelector('.portal-answer').textContent = item.text;
    if (oracle) article.querySelector('.portal-oracle').textContent = oracle;
    article.querySelector('button').addEventListener('click', async () => {
      if (!confirm('删除这条问答记录？')) return;
      try { await api(`/api/conversations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); article.remove(); toast('记录已删除'); }
      catch (error) { toast(error.message); }
    });
    return article;
  }

  async function clearHistory() {
    if (!confirm('确定清空全部问答记录？此操作无法撤销。')) return;
    try { await api('/api/conversations', { method: 'DELETE' }); renderHistory(); toast('问答记录已清空'); }
    catch (error) { toast(error.message); }
  }

  async function renderPayments() {
    section('<div class="portal-empty">正在读取交易记录……</div>');
    try {
      const result = await api('/api/billing/payments');
      const list = result.payments || [];
      section(`
        <p class="portal-lead">支付记录作为财务审计记录长期保留。注销帐号后会去除帐号和邮箱关联。</p>
        <div class="portal-list">${list.map(item => `
          <div class="portal-card portal-payment">
            <strong>${money(item.amount)} · ${item.credits} 次</strong><span class="portal-status">${paymentStatus(item.status)}</span>
            <small>${dateText(item.createdAt)}</small><small>${item.refundedAmount ? `已退 ${money(item.refundedAmount)}` : ''}</small>
          </div>`).join('')}</div>
        ${list.length ? '' : '<div class="portal-empty">还没有交易记录。</div>'}
      `);
    } catch (error) { section(`<div class="portal-empty">${escapeHtml(error.message)}</div>`); }
  }

  function renderAccount() {
    const canLinkPhone = config?.auth?.phoneEnabled && !user.phone;
    section(`
      <div class="portal-card">
        <div class="portal-label">登录身份</div>
        <div>${escapeHtml(user.email || user.phone || '已验证帐号')}</div>
        <p class="portal-lead" style="margin:.6rem 0 0">${user.hasPassword ? '已设置密码' : '未设置密码'}${user.hasGoogle ? ' · 已关联 Google' : ''}${user.phone ? ' · 已绑定手机号' : ''}</p>
      </div>
      <div class="portal-actions">
        ${canLinkPhone ? '<button class="portal-button" type="button" id="portal-link-phone">绑定手机号</button>' : ''}
        <button class="portal-button" type="button" id="portal-logout">退出登录</button>
        <button class="portal-button danger" type="button" id="portal-delete-account">注销帐号</button>
      </div>
      <p class="portal-message">注销将删除身份、会话和问答内容；支付记录会去标识化保留。此操作无法撤销。</p>
      <div class="portal-legal" style="margin-top:1rem"><a href="/privacy" target="_blank">隐私政策</a><a href="/terms" target="_blank">用户条款</a></div>
    `);
    body.querySelector('#portal-logout').addEventListener('click', logout);
    body.querySelector('#portal-delete-account').addEventListener('click', deleteAccount);
    body.querySelector('#portal-link-phone')?.addEventListener('click', renderPhoneLink);
  }

  function renderPhoneLink() {
    section(`
      <p class="portal-lead">绑定中国大陆手机号后，可以直接使用短信验证码登录。绑定身份不会重复赠送试用次数。</p>
      <form class="portal-form" id="portal-phone-link-form">
        <label class="portal-field">手机号<input name="phone" type="tel" autocomplete="tel" placeholder="13800000000" required></label>
        <div class="portal-turnstile" id="portal-turnstile"></div>
        <button class="portal-button primary" type="submit">发送绑定验证码</button>
        <button class="portal-button" type="button" id="portal-phone-link-back">返回帐号</button>
      </form>
      <p class="portal-message" id="portal-auth-message"></p>
    `);
    mountTurnstile('otp');
    body.querySelector('#portal-phone-link-back').addEventListener('click', renderAccount);
    body.querySelector('#portal-phone-link-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!turnstileToken) return setAuthMessage('请先完成人机验证。', true);
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
      toast('已经退出登录');
    } catch (error) { toast(error.message); }
  }

  async function deleteAccount() {
    const confirmation = prompt('此操作无法撤销。请输入“注销帐号”确认：');
    if (confirmation !== '注销帐号') return;
    try {
      await api('/api/account', { method: 'DELETE', body: JSON.stringify({ confirmation }) });
      user = null;
      active = 'overview';
      updateButtons();
      render();
      toast('帐号已经注销');
    } catch (error) { toast(error.message); }
  }

  function renderSound() {
    const state = music.getState();
    section(`
      <div class="portal-card">
        <div class="portal-label">正在轮转</div>
        <div class="portal-track" id="portal-track-title">${escapeHtml(state.track.title)}</div>
        <p class="portal-message">${state.waitingForGesture ? '浏览器阻止了自动播放，触碰页面后音乐会开始。' : state.playing ? '低音量播放中' : '已暂停'}</p>
        <div class="portal-actions">
          <button class="portal-button" type="button" id="portal-play">${state.playing ? '暂停' : '播放'}</button>
          <button class="portal-button" type="button" id="portal-mute">${state.muted ? '取消静音' : '静音'}</button>
          <button class="portal-button" type="button" id="portal-next">下一首</button>
        </div>
        <label class="portal-field" style="margin-top:1rem">音量
          <input id="portal-volume" type="range" min="0" max="0.35" step="0.01" value="${state.volume}">
        </label>
      </div>
      <div class="portal-attribution">
        <p>音乐：Kevin MacLeod（incompetech.com），按 CC BY 4.0 授权。本站仅进行了适合网页播放的 MP3 压缩转换。</p>
        <div class="portal-legal">${TRACKS.map(track => `<a href="${track.source}" target="_blank" rel="noopener">${escapeHtml(track.title)} ↗</a>`).join('')}<a href="/music-credits" target="_blank">完整音乐署名与许可</a></div>
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
      <p class="portal-lead">把问题写在书页上，答案会像墨迹一样出现。预测性问题会随机抽取固定的地占组合；非预测问题继续由日记本身回应。</p>
      <div class="portal-card"><div class="portal-label">次数规则</div><p class="portal-answer">首次验证赠送三次。每个成功回答扣一次；识别失败、模型失败或格式异常自动退回。购买与赠送次数永久有效。</p></div>
      <div class="portal-legal"><a href="/privacy" target="_blank">隐私政策</a><a href="/terms" target="_blank">用户条款</a><a href="/refund" target="_blank">充值与退款说明</a><a href="/music-credits" target="_blank">音乐署名</a></div>
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
          ? '付款已经确认，次数已到账'
          : result.paid
            ? '付款成功，正在等待支付通知入账'
            : '付款仍在处理中，到账后余额会自动更新');
      } else if (checkout === 'cancelled') toast('已取消付款，笔迹仍然保留');
      else if (auth === 'success') toast('登录成功，笔迹已经恢复');
      else if (auth === 'error') toast('Google 登录没有完成，请重试');
      await refresh();
    } catch (error) { toast(error.message); }
    restoreExternal?.();
  }

  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-section]');
    if (!button) return;
    active = button.dataset.section;
    render();
  });
  body.addEventListener('click', event => {
    const authButton = event.target.closest('[data-auth-mode]');
    if (authButton) { authMode = authButton.dataset.authMode; challenge = null; renderAuth(); return; }
    const go = event.target.closest('[data-go]');
    if (go) { active = go.dataset.go; render(); }
  });
  root.querySelector('.portal-veil').addEventListener('click', close);
  root.querySelector('.portal-close').addEventListener('click', close);
  accountButton.addEventListener('click', () => open('overview'));
  soundButton.addEventListener('click', () => music.toggleMuted());
  music.subscribe(updateButtons);
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
