const $ = (selector) => document.querySelector(selector);

const elements = {
  gateView: $('#gate-view'),
  cdkForm: $('#cdk-form'),
  cdkInput: $('#cdk-input'),
  cdkSubmit: $('#cdk-submit'),
  cdkStatus: $('#cdk-status'),
  workbench: $('#workbench'),
  lockButton: $('#lock-button'),
  cdkRemaining: $('#cdk-remaining'),
  form: $('#checkout-form'),
  accessToken: $('#access-token'),
  toggleToken: $('#toggle-token'),
  countryTrigger: $('#country-trigger'),
  countryTriggerMain: $('#country-trigger-main'),
  countryMenu: $('#country-menu'),
  countrySearch: $('#country-search'),
  countryOptions: $('#country-options'),
  countryInput: $('#country'),
  priceFlag: $('#price-flag'),
  priceCountry: $('#price-country'),
  priceCurrency: $('#price-currency'),
  priceLocal: $('#price-local'),
  priceUsd: $('#price-usd'),
  seatDefault: $('#seat-default'),
  seatProlite: $('#seat-prolite'),
  seatTotalChip: $('#seat-total-chip'),
  seatMessage: $('#seat-message'),
  workspaceName: $('#workspace-name'),
  promoCode: $('#promo-code'),
  formStatus: $('#form-status'),
  generateButton: $('#generate-button'),
  generateLabel: $('#generate-label'),
  summaryFlag: $('#summary-flag'),
  summaryCountry: $('#summary-country'),
  summaryRoute: $('#summary-route'),
  summaryBilling: $('#summary-billing'),
  summaryDefault: $('#summary-default'),
  summaryProlite: $('#summary-prolite'),
  summaryTotal: $('#summary-total'),
  resultCard: $('#result-card'),
  resultUrl: $('#result-url'),
  copyResult: $('#copy-result'),
  openResult: $('#open-result'),
};

const ERROR_MESSAGES = {
  invalid_json: '请求格式错误，请刷新后重试。',
  cdk_service_not_configured: 'CDK 服务尚未配置，请联系管理员。',
  cdk_database_error: 'CDK 数据库暂时不可用，请稍后重试。',
  cdk_invalid_format: 'CDK 格式不正确，应为 XXXX-XXXX-XXXX-XXXX。',
  cdk_invalid: 'CDK 不存在，请检查后重试。',
  cdk_revoked: '该 CDK 已被停用。',
  cdk_expired: '该 CDK 已过期。',
  cdk_exhausted: '该 CDK 的使用次数已耗尽。',
  cdk_verify_rate_limited: '校验过于频繁，请稍后再试。',
  missing_access_token: '请先粘贴 Access Token。',
  access_token_too_short: 'Access Token 长度异常，请重新复制完整内容。',
  unsupported_country: '所选国家暂不支持。',
  invalid_seat_quantity: '标准席位与高级席位合计必须为 2–999。',
  invalid_billing_period: '请选择月付或年付。',
  proxy_not_configured: '该国家尚未配置代理，请选择其他国家或联系管理员。',
  proxy_database_error: '代理配置暂时无法读取。',
  proxy_decryption_failed: '该国家代理配置异常，请联系管理员重新导入。',
  relay_not_configured: '代理中继尚未配置。',
  relay_config_invalid: '代理中继配置无效。',
  rate_limited: '请求过于频繁，请稍后再试。',
  checkout_rejected: 'ChatGPT 拒绝了本次 Checkout 请求，请检查 Token 和账户状态。',
  no_checkout_url: '上游未返回支付链接，请稍后重试。',
  all_origins_failed: 'Checkout 服务暂时不可用，请检查代理后重试。',
};

const state = {
  config: null,
  activeCdk: '',
  country: null,
  tokenVisible: false,
};

function setStatus(element, message = '', type = '') {
  element.textContent = message;
  element.className = 'inline-status' + (element === elements.formStatus ? ' form-status' : '') + (type ? ' ' + type : '');
}

function errorMessage(data, fallback = '操作失败，请稍后重试。') {
  if (!data) return fallback;
  if (ERROR_MESSAGES[data.error]) return ERROR_MESSAGES[data.error];
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  return fallback;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({ error: 'invalid_json' }));
  if (!response.ok) {
    const error = new Error(errorMessage(data));
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function normalizeCdkDisplay(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return compact.match(/.{1,4}/g)?.join('-') || '';
}

function extractToken(rawValue) {
  let raw = String(rawValue || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^Bearer\s+/i, '');
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return String(parsed.accessToken || parsed.access_token || '').trim();
    } catch {
      return '';
    }
  }
  return raw.replace(/\s+/g, '');
}

function promoValue(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';
  try {
    const value = /^(?:www\.)?chatgpt\.com\//i.test(raw) ? 'https://' + raw : raw;
    const url = new URL(value);
    const match = /^\/p\/([^/]+)\/?$/.exec(url.pathname);
    if (url.hostname.replace(/^www\./, '') === 'chatgpt.com' && match) return match[1];
  } catch {
    // 普通优惠码无需按 URL 解析。
  }
  return raw;
}

async function loadConfig() {
  if (state.config) return state.config;
  const config = await requestJson('/api/config', { method: 'GET', headers: {} });
  if (!config.cdkServiceReady) throw new Error('CDK 服务尚未就绪，请联系管理员。');
  state.config = config;
  renderCountryOptions('');
  const preferred = config.countries.find((country) => country.code === config.defaultCountry && country.proxyConfigured)
    || config.countries.find((country) => country.proxyConfigured)
    || config.countries[0];
  if (preferred) selectCountry(preferred.code);
  return config;
}

function countryMatches(country, query) {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  return [country.name, country.code, country.currency, country.pinyin]
    .some((value) => String(value || '').toLowerCase().includes(normalized));
}

function renderCountryOptions(query = '') {
  elements.countryOptions.replaceChildren();
  const countries = (state.config?.countries || []).filter((country) => countryMatches(country, query));
  if (!countries.length) {
    const empty = document.createElement('div');
    empty.className = 'country-empty';
    empty.textContent = '没有匹配的国家';
    elements.countryOptions.append(empty);
    return;
  }
  countries.forEach((country) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'country-option';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(state.country?.code === country.code));
    button.disabled = !country.proxyConfigured;
    button.dataset.country = country.code;

    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = country.flag;
    const copy = document.createElement('span');
    copy.className = 'country-copy';
    const name = document.createElement('b');
    name.textContent = `${country.name} · ${country.code}`;
    const currency = document.createElement('small');
    currency.textContent = country.proxyConfigured ? country.currency : `${country.currency} · 未配置代理`;
    copy.append(name, currency);
    const prices = document.createElement('span');
    prices.className = 'country-price';
    const local = document.createElement('b');
    local.textContent = country.localPrice;
    const usd = document.createElement('small');
    usd.textContent = `≈ $${country.usdPrice} USD`;
    prices.append(local, usd);
    button.append(flag, copy, prices);
    button.addEventListener('click', () => selectCountry(country.code));
    elements.countryOptions.append(button);
  });
}

function selectCountry(code) {
  const country = state.config?.countries.find((item) => item.code === code);
  if (!country) return;
  state.country = country;
  elements.countryInput.value = country.code;
  elements.countryTriggerMain.replaceChildren();
  const flag = document.createElement('span');
  flag.className = 'selected-flag';
  flag.textContent = country.flag;
  const copy = document.createElement('span');
  copy.className = 'selected-copy';
  const name = document.createElement('b');
  name.textContent = `${country.name} · ${country.code}`;
  const meta = document.createElement('small');
  meta.textContent = `${country.currency} · ${country.proxyConfigured ? '代理已配置' : '代理未配置'}`;
  copy.append(name, meta);
  elements.countryTriggerMain.append(flag, copy);

  elements.priceFlag.textContent = country.flag;
  elements.priceCountry.textContent = `${country.name} · ${country.code}`;
  elements.priceCurrency.textContent = `${country.currency} 自动结算`;
  elements.priceLocal.textContent = country.localPrice;
  elements.priceUsd.textContent = `$${country.usdPrice}`;
  elements.summaryFlag.textContent = country.flag;
  elements.summaryCountry.textContent = `${country.name} · ${country.currency}`;
  elements.summaryRoute.textContent = country.proxyConfigured ? '专属国家代理已就绪' : '该国家代理未配置';
  closeCountryMenu();
  renderCountryOptions(elements.countrySearch.value);
}

function openCountryMenu() {
  elements.countryMenu.hidden = false;
  elements.countryTrigger.setAttribute('aria-expanded', 'true');
  elements.countrySearch.value = '';
  renderCountryOptions('');
  requestAnimationFrame(() => elements.countrySearch.focus());
}

function closeCountryMenu() {
  elements.countryMenu.hidden = true;
  elements.countryTrigger.setAttribute('aria-expanded', 'false');
}

function seatValues() {
  const standard = Number(elements.seatDefault.value);
  const prolite = Number(elements.seatProlite.value);
  return {
    standard: Number.isInteger(standard) ? standard : 0,
    prolite: Number.isInteger(prolite) ? prolite : 0,
    total: (Number.isInteger(standard) ? standard : 0) + (Number.isInteger(prolite) ? prolite : 0),
  };
}

function currentBillingPeriod() {
  return document.querySelector('input[name="billing-period"]:checked')?.value || 'month';
}

function updateSummary() {
  const seats = seatValues();
  const valid = seats.standard >= 0 && seats.prolite >= 0 && seats.total >= 2 && seats.total <= 999;
  elements.seatTotalChip.textContent = `共 ${seats.total} 席`;
  elements.seatMessage.classList.toggle('seat-invalid', !valid);
  elements.seatMessage.textContent = valid
    ? '标准席位和高级席位可以同时选择，合计至少 2 席。'
    : '席位配置无效：两种席位合计必须为 2–999。';
  elements.summaryDefault.textContent = String(seats.standard);
  elements.summaryProlite.textContent = String(seats.prolite);
  elements.summaryTotal.textContent = String(seats.total);
  elements.summaryBilling.textContent = currentBillingPeriod() === 'year' ? '年付' : '月付';
  return valid;
}

function setLoading(button, loading, labelElement, loadingText, idleText) {
  button.disabled = loading;
  labelElement.textContent = loading ? loadingText : idleText;
}

function unlockWorkbench(verification) {
  elements.gateView.hidden = true;
  elements.workbench.hidden = false;
  if (verification.unlimited || verification.kind === 'admin') {
    elements.cdkRemaining.textContent = '管理员通用 · 长期有效';
    window.scrollTo({ top: 0, behavior: 'instant' });
    setTimeout(() => elements.accessToken.focus(), 80);
    return;
  }
  const expiry = verification.expiresAt ? ` · ${new Date(verification.expiresAt).toLocaleDateString('zh-CN')} 到期` : '';
  elements.cdkRemaining.textContent = `剩余 ${verification.remainingUses} 次${expiry}`;
  window.scrollTo({ top: 0, behavior: 'instant' });
  setTimeout(() => elements.accessToken.focus(), 80);
}

function lockWorkbench() {
  state.activeCdk = '';
  elements.accessToken.value = '';
  elements.promoCode.value = '';
  elements.resultCard.hidden = true;
  elements.resultUrl.value = '';
  elements.openResult.href = '#';
  elements.workbench.hidden = true;
  elements.gateView.hidden = false;
  elements.cdkInput.value = '';
  setStatus(elements.formStatus);
  setStatus(elements.cdkStatus);
  window.scrollTo({ top: 0, behavior: 'instant' });
  setTimeout(() => elements.cdkInput.focus(), 80);
}

elements.cdkInput.addEventListener('input', () => {
  elements.cdkInput.value = normalizeCdkDisplay(elements.cdkInput.value);
  setStatus(elements.cdkStatus);
});

elements.cdkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const cdk = normalizeCdkDisplay(elements.cdkInput.value);
  if (cdk.length !== 19) {
    setStatus(elements.cdkStatus, ERROR_MESSAGES.cdk_invalid_format, 'error');
    return;
  }
  elements.cdkSubmit.disabled = true;
  elements.cdkSubmit.firstElementChild.textContent = '正在验证…';
  setStatus(elements.cdkStatus, '正在连接授权服务…', 'info');
  try {
    await loadConfig();
    const verification = await requestJson('/api/cdk/verify', {
      method: 'POST',
      body: JSON.stringify({ cdk }),
    });
    state.activeCdk = cdk;
    setStatus(elements.cdkStatus, '验证成功，正在进入工作台…', 'success');
    setTimeout(() => unlockWorkbench(verification), 260);
  } catch (error) {
    setStatus(elements.cdkStatus, error.message || 'CDK 校验失败。', 'error');
  } finally {
    elements.cdkSubmit.disabled = false;
    elements.cdkSubmit.firstElementChild.textContent = '验证并进入';
  }
});

elements.lockButton.addEventListener('click', lockWorkbench);
elements.countryTrigger.addEventListener('click', () => {
  if (elements.countryMenu.hidden) openCountryMenu(); else closeCountryMenu();
});
elements.countrySearch.addEventListener('input', () => renderCountryOptions(elements.countrySearch.value));
document.addEventListener('click', (event) => {
  if (!event.target.closest('.country-field')) closeCountryMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.countryMenu.hidden) {
    closeCountryMenu();
    elements.countryTrigger.focus();
  }
});

document.querySelectorAll('.stepper button').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.closest('.stepper').dataset.target);
    const next = Math.min(999, Math.max(0, (Number(input.value) || 0) + Number(button.dataset.step)));
    input.value = String(next);
    updateSummary();
  });
});
[elements.seatDefault, elements.seatProlite].forEach((input) => {
  input.addEventListener('input', updateSummary);
  input.addEventListener('blur', () => {
    input.value = String(Math.min(999, Math.max(0, Math.trunc(Number(input.value) || 0))));
    updateSummary();
  });
});
document.querySelectorAll('input[name="billing-period"]').forEach((input) => input.addEventListener('change', updateSummary));

elements.accessToken.classList.add('token-hidden');
elements.toggleToken.addEventListener('click', () => {
  state.tokenVisible = !state.tokenVisible;
  elements.accessToken.classList.toggle('token-hidden', !state.tokenVisible);
  elements.toggleToken.textContent = state.tokenVisible ? '◌' : '◉';
  elements.toggleToken.setAttribute('aria-label', state.tokenVisible ? '隐藏 Token' : '显示 Token');
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(elements.formStatus);
  if (!state.activeCdk) {
    lockWorkbench();
    return;
  }
  const accessToken = extractToken(elements.accessToken.value);
  if (!accessToken) {
    setStatus(elements.formStatus, ERROR_MESSAGES.missing_access_token, 'error');
    elements.accessToken.focus();
    return;
  }
  if (!state.country?.proxyConfigured) {
    setStatus(elements.formStatus, ERROR_MESSAGES.proxy_not_configured, 'error');
    return;
  }
  if (!updateSummary()) {
    setStatus(elements.formStatus, ERROR_MESSAGES.invalid_seat_quantity, 'error');
    return;
  }

  const seats = seatValues();
  setLoading(elements.generateButton, true, elements.generateLabel, '正在创建 Checkout…', '生成支付长链');
  setStatus(elements.formStatus, '正在通过国家代理连接 ChatGPT Checkout…', 'info');
  try {
    const data = await requestJson('/api/checkout/team', {
      method: 'POST',
      body: JSON.stringify({
        cdk: state.activeCdk,
        accessToken,
        country: state.country.code,
        workspaceName: elements.workspaceName.value.trim() || 'myWorkspace',
        promoCode: promoValue(elements.promoCode.value),
        seatDefault: seats.standard,
        seatProlite: seats.prolite,
        billingPeriod: currentBillingPeriod(),
      }),
    });
    elements.resultUrl.value = data.url;
    elements.openResult.href = data.url;
    elements.resultCard.hidden = false;
    elements.cdkRemaining.textContent = data.cdkRemainingUses == null ? '管理员通用 · 长期有效' : `剩余 ${data.cdkRemainingUses} 次`;
    setStatus(elements.formStatus, '支付长链已生成。', 'success');
    elements.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    setStatus(elements.formStatus, error.message || '生成失败，请稍后重试。', 'error');
    if (String(error.data?.error || '').startsWith('cdk_')) {
      setTimeout(lockWorkbench, 1400);
    }
  } finally {
    setLoading(elements.generateButton, false, elements.generateLabel, '正在创建 Checkout…', '生成支付长链');
  }
});

elements.copyResult.addEventListener('click', async () => {
  if (!elements.resultUrl.value) return;
  try {
    await navigator.clipboard.writeText(elements.resultUrl.value);
    elements.copyResult.textContent = '已复制';
    setTimeout(() => { elements.copyResult.textContent = '复制'; }, 1400);
  } catch {
    elements.resultUrl.select();
    document.execCommand('copy');
  }
});

updateSummary();
loadConfig().catch((error) => setStatus(elements.cdkStatus, error.message || '服务配置加载失败。', 'error'));
elements.cdkInput.focus();
