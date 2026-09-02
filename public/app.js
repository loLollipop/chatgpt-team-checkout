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
  countrySortLabel: $('#country-sort-label'),
  countryInput: $('#country'),
  priceFlag: $('#price-flag'),
  priceCountry: $('#price-country'),
  priceCurrency: $('#price-currency'),
  priceLocal: $('#price-local'),
  priceUsd: $('#price-usd'),
  priceLocalLabel: $('#price-local-label'),
  priceUsdLabel: $('#price-usd-label'),
  fxStatus: $('#fx-status'),
  fxNote: $('#fx-note'),
  seatDefault: $('#seat-default'),
  seatProlite: $('#seat-prolite'),
  seatTotalChip: $('#seat-total-chip'),
  seatMessage: $('#seat-message'),
  workspaceName: $('#workspace-name'),
  promoCode: $('#promo-code'),
  formStatus: $('#form-status'),
  generateButton: $('#generate-button'),
  generateLabel: $('#generate-label'),
  workflowProgress: $('#workflow-progress'),
  submitReadiness: $('.submit-readiness'),
  submitReadinessTitle: $('#submit-readiness-title'),
  submitReadinessDetail: $('#submit-readiness-detail'),
  summaryFlag: $('#summary-flag'),
  summaryCountry: $('#summary-country'),
  summaryRoute: $('#summary-route'),
  summarySync: $('#summary-sync'),
  summaryBilling: $('#summary-billing'),
  summaryPrice: $('#summary-price'),
  summaryDefault: $('#summary-default'),
  summaryProlite: $('#summary-prolite'),
  summaryDiscount: $('#summary-discount'),
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
  invalid_promo_code: '优惠码格式不正确，请填写 /p/ 后面的代码或完整优惠链接。',
  promo_not_registered: '该优惠码未在管理后台登记，无法使用本工作台提链。',
  promo_service_not_configured: '优惠码校验服务尚未配置，请联系管理员。',
  promo_database_error: '优惠码校验服务暂时不可用，请稍后再试。',
  promo_not_available_for_annual: '优惠码不能用于年付订单，请切换为月付或清空优惠码。',
  promo_requires_standard_seat: '优惠码只能抵扣标准席位，请至少选择 1 个标准席位或清空优惠码。',
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

// Token 显隐按钮的两枚 SVG 图标（显示 ↔ 隐藏）
const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/></svg>';

const state = {
  config: null,
  activeCdk: '',
  cdkExpiresAtMs: 0,
  cdkExpiryTimer: null,
  country: null,
  tokenVisible: false,
  exchange: { status: 'loading', rates: null, live: false, source: '', updatedAt: null },
  exchangePromise: null,
};

const workflowSteps = [...document.querySelectorAll('[data-workflow-target]')];
const workflowSections = [...document.querySelectorAll('[data-workflow-section]')];
let workflowScrollFrame = 0;

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

/**
 * 创建国旗 <img>。SVG 国旗放在本地 public/flags/ 下（Windows 无法渲染旗帜 emoji，
 * 只能用图片）；图片加载失败时回退到 emoji 文本，保证任何环境都有可读标识。
 */
function flagImage(country, className = 'flag-img') {
  const image = document.createElement('img');
  image.className = className;
  image.src = `/flags/${country.code.toLowerCase()}.svg`;
  image.alt = `${country.name}国旗`;
  image.loading = 'lazy';
  image.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = 'flag-emoji';
    fallback.textContent = country.flag || '🌐';
    image.replaceWith(fallback);
  }, { once: true });
  return image;
}

async function loadConfig() {
  if (state.config) return state.config;
  const config = await requestJson('/api/config', { method: 'GET', headers: {} });
  if (!config.cdkServiceReady) throw new Error('CDK 服务尚未就绪，请联系管理员。');
  state.config = config;
  renderCountryOptions('');
  const preferred = sortedCountries().find((country) => country.proxyConfigured)
    || config.countries.find((country) => country.code === config.defaultCountry && country.proxyConfigured)
    || config.countries[0];
  if (preferred) selectCountry(preferred.code);
  loadExchangeRates();
  return config;
}

async function loadExchangeRates() {
  if (state.exchangePromise) return state.exchangePromise;
  state.exchange.status = 'loading';
  renderExchangeStatus();
  state.exchangePromise = requestJson('/api/exchange-rates', { method: 'GET', headers: {} })
    .then((data) => {
      state.exchange = {
        status: data.live ? 'live' : 'fallback',
        rates: data.rates || null,
        live: Boolean(data.live),
        source: data.source || '',
        updatedAt: data.updatedAt || null,
      };
    })
    .catch(() => {
      state.exchange = { status: 'fallback', rates: null, live: false, source: '内置参考汇率', updatedAt: null };
    })
    .finally(() => {
      state.exchangePromise = null;
      renderExchangeStatus();
      renderCountryOptions(elements.countrySearch.value);
      renderPricing();
    });
  return state.exchangePromise;
}

function countryMatches(country, query) {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  return [country.name, country.code, country.currency, country.pinyin]
    .some((value) => String(value || '').toLowerCase().includes(normalized));
}

function pricingConfig() {
  return state.config?.pricing || {
    standard: { monthUsd: 25, yearUsd: 240 },
    prolite: { monthUsd: 125, yearUsd: 1200 },
    promoDiscountUsd: 25,
  };
}

function officialSeatUsd(seatType) {
  const period = currentBillingPeriod();
  const prices = pricingConfig()[seatType] || pricingConfig().standard;
  return Number(period === 'year' ? prices.yearUsd : prices.monthUsd);
}

function standardSeatPrice(country) {
  const officialMonthlyUsd = Number(pricingConfig().standard.monthUsd) || 25;
  const officialPeriodUsd = officialSeatUsd('standard');
  const multiplier = officialPeriodUsd / officialMonthlyUsd;
  const monthlyLocal = Number(country.localMonthlyAmount);
  const fallbackUsd = Number(country.usdPrice);
  const local = Number.isFinite(monthlyLocal) ? monthlyLocal * multiplier : 0;
  const exchangeRate = Number(state.exchange.rates?.[country.currency]);
  const usd = exchangeRate > 0 && local > 0 ? local / exchangeRate : fallbackUsd * multiplier;
  return { local, usd: Number.isFinite(usd) ? usd : Number.POSITIVE_INFINITY };
}

function seatPrice(country, seatType) {
  const standard = standardSeatPrice(country);
  const standardUsd = officialSeatUsd('standard');
  const targetUsd = officialSeatUsd(seatType);
  const multiplier = standardUsd > 0 ? targetUsd / standardUsd : 1;
  return { local: standard.local * multiplier, usd: standard.usd * multiplier };
}

function promoSelection() {
  const code = promoValue(elements.promoCode.value);
  if (!code) return { code: '', eligible: false, reason: '' };
  if (currentBillingPeriod() === 'year') return { code, eligible: false, reason: 'promo_not_available_for_annual' };
  if (seatValues().standard < 1) return { code, eligible: false, reason: 'promo_requires_standard_seat' };
  return { code, eligible: true, reason: '' };
}

function orderPrice(country) {
  const seats = seatValues();
  const standardSeat = seatPrice(country, 'standard');
  const proliteSeat = seatPrice(country, 'prolite');
  const standardSubtotal = { local: standardSeat.local * seats.standard, usd: standardSeat.usd * seats.standard };
  const proliteSubtotal = { local: proliteSeat.local * seats.prolite, usd: proliteSeat.usd * seats.prolite };
  const promo = promoSelection();
  const discountUsd = promo.eligible
    ? Math.min(Number(pricingConfig().promoDiscountUsd) || 25, standardSubtotal.usd)
    : 0;
  const usdToLocal = standardSeat.usd > 0 ? standardSeat.local / standardSeat.usd : 0;
  const discountLocal = Math.min(discountUsd * usdToLocal, standardSubtotal.local);
  return {
    standardSeat,
    proliteSeat,
    standardSubtotal,
    proliteSubtotal,
    discount: { local: discountLocal, usd: discountUsd },
    total: {
      local: standardSubtotal.local + proliteSubtotal.local - discountLocal,
      usd: standardSubtotal.usd + proliteSubtotal.usd - discountUsd,
    },
    promo,
  };
}

function sortedCountries() {
  return [...(state.config?.countries || [])].sort((left, right) => {
    const priceDifference = standardSeatPrice(left).usd - standardSeatPrice(right).usd;
    return Math.abs(priceDifference) > 0.001 ? priceDifference : left.name.localeCompare(right.name, 'zh-CN');
  });
}

function formatLocalAmount(country, amount) {
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: country.currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: ['CLP', 'JPY'].includes(country.currency) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${country.currency} ${amount.toLocaleString('zh-CN')}`;
  }
}

function formatUsdAmount(amount) {
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
    : '—';
}

function setSyncBadge(element, text, status) {
  if (!element) return;
  element.dataset.state = status;
  const dot = document.createElement('i');
  dot.className = 'live-dot';
  dot.setAttribute('aria-hidden', 'true');
  element.replaceChildren(dot, document.createTextNode(text));
}

function exchangeTimestamp() {
  if (!state.exchange.updatedAt) return '';
  const date = new Date(state.exchange.updatedAt);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function renderExchangeStatus() {
  const timestamp = exchangeTimestamp();
  if (state.exchange.status === 'live') {
    const label = timestamp ? `汇率已同步 · ${timestamp}` : '汇率已实时同步';
    setSyncBadge(elements.fxStatus, label, 'live');
    setSyncBadge(elements.summarySync, '实时汇率', 'live');
    elements.fxNote.textContent = `汇率来源：${state.exchange.source || '实时汇率服务'}。价格为单席参考值，最终以 ChatGPT Checkout 为准。`;
    return;
  }
  if (state.exchange.status === 'fallback') {
    setSyncBadge(elements.fxStatus, '当前使用参考汇率', 'fallback');
    setSyncBadge(elements.summarySync, '参考汇率', 'fallback');
    elements.fxNote.textContent = '实时汇率暂时不可用，已自动回退到内置参考价；最终金额以 ChatGPT Checkout 为准。';
    return;
  }
  setSyncBadge(elements.fxStatus, '正在同步汇率', 'loading');
  setSyncBadge(elements.summarySync, '同步中', 'loading');
}

function renderCountryOptions(query = '') {
  elements.countryOptions.replaceChildren();
  const allCountries = sortedCountries();
  const ranks = new Map(allCountries.map((country, index) => [country.code, index + 1]));
  const countries = allCountries.filter((country) => countryMatches(country, query));
  elements.countrySortLabel.textContent = `按${currentBillingPeriod() === 'year' ? '年付' : '月付'}美元价升序`;
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

    const rank = document.createElement('span');
    rank.className = 'country-rank';
    rank.textContent = String(ranks.get(country.code)).padStart(2, '0');

    const copy = document.createElement('span');
    copy.className = 'country-copy';
    const name = document.createElement('b');
    name.textContent = `${country.name} · ${country.code}`;
    const currency = document.createElement('small');
    currency.textContent = country.proxyConfigured ? country.currency : `${country.currency} · 未配置代理`;
    copy.append(name, currency);
    const prices = document.createElement('span');
    prices.className = 'country-price';
    const price = standardSeatPrice(country);
    const local = document.createElement('b');
    local.textContent = formatLocalAmount(country, price.local);
    const usd = document.createElement('small');
    usd.textContent = `≈ ${formatUsdAmount(price.usd)} USD`;
    prices.append(local, usd);
    button.append(rank, flagImage(country, 'flag-img'), copy, prices);
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
  const copy = document.createElement('span');
  copy.className = 'selected-copy';
  const name = document.createElement('b');
  name.textContent = `${country.name} · ${country.code}`;
  const meta = document.createElement('small');
  meta.textContent = `${country.currency} · ${country.proxyConfigured ? '代理已配置' : '代理未配置'}`;
  copy.append(name, meta);
  elements.countryTriggerMain.append(flagImage(country, 'flag-img flag-img-sm'), copy);
  elements.summaryFlag.replaceChildren(flagImage(country, 'flag-img flag-img-lg'));
  elements.summaryCountry.textContent = `${country.name} · ${country.currency}`;
  elements.summaryRoute.textContent = country.proxyConfigured ? '专属国家代理已就绪' : '该国家代理未配置';
  renderPricing();
  updateWorkflowState();
  closeCountryMenu();
  renderCountryOptions(elements.countrySearch.value);
}

function renderPricing() {
  const country = state.country;
  if (!country) return;
  const annual = currentBillingPeriod() === 'year';
  const price = orderPrice(country);
  const standardSeat = seatPrice(country, 'standard');
  const seats = seatValues();
  const proliteOfficial = officialSeatUsd('prolite');
  elements.priceFlag.replaceChildren(flagImage(country, 'flag-img flag-img-lg'));
  elements.priceCountry.textContent = `${country.name} · ${country.code}`;
  elements.priceCurrency.textContent = `${country.currency} 自动结算 · 标准单席参考`;
  elements.priceLocalLabel.textContent = annual ? '当地标准单席年付' : '当地标准单席月付';
  elements.priceUsdLabel.textContent = annual ? '标准单席年付美元' : '标准单席月付美元';
  elements.priceLocal.textContent = formatLocalAmount(country, standardSeat.local);
  elements.priceUsd.textContent = formatUsdAmount(standardSeat.usd);
  elements.summaryDefault.textContent = `${seats.standard} × ${formatUsdAmount(price.standardSeat.usd)} = ${formatUsdAmount(price.standardSubtotal.usd)}`;
  elements.summaryProlite.textContent = `${seats.prolite} × ${formatUsdAmount(price.proliteSeat.usd)} = ${formatUsdAmount(price.proliteSubtotal.usd)}`;
  elements.summaryDiscount.textContent = price.promo.eligible
    ? `− ${formatUsdAmount(price.discount.usd)}`
    : (price.promo.reason ? '当前订单不适用' : '未使用');
  elements.summaryPrice.textContent = formatUsdAmount(price.total.usd);
  elements.fxNote.textContent = `当前展示标准单席价格；高级席位 ${formatUsdAmount(proliteOfficial)}${annual ? '/席/年' : '/席/月'}。实际订单金额以右侧预览和 ChatGPT Checkout 为准。`;
}

function updatePromoState() {
  const selection = promoSelection();
  elements.promoCode.setAttribute('aria-invalid', String(Boolean(selection.reason)));
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
  updatePromoState();
  renderPricing();
  updateWorkflowState();
  return valid;
}

function updateWorkflowState() {
  const seats = seatValues();
  const promo = promoSelection();
  const checks = {
    'account-section': Boolean(extractToken(elements.accessToken.value)),
    'region-section': Boolean(state.country?.proxyConfigured),
    'seat-section': seats.standard >= 0 && seats.prolite >= 0 && seats.total >= 2 && seats.total <= 999,
    'order-section': !promo.reason,
  };
  workflowSteps.forEach((step) => { step.dataset.state = checks[step.dataset.workflowTarget] ? 'complete' : 'pending'; });
  const completed = Object.values(checks).filter(Boolean).length;
  if (elements.workflowProgress) elements.workflowProgress.style.width = `${completed / Object.keys(checks).length * 100}%`;

  const missing = [];
  if (!checks['account-section']) missing.push('Session');
  if (!checks['region-section']) missing.push('可用国家');
  if (!checks['seat-section']) missing.push('席位数量');
  if (!checks['order-section']) missing.push('优惠码规则');
  const ready = missing.length === 0;
  elements.submitReadiness.dataset.ready = String(ready);
  elements.submitReadinessTitle.textContent = ready ? '配置已就绪' : `还需完成 ${missing.length} 项`;
  elements.submitReadinessDetail.textContent = ready ? '提交后将通过所选国家代理创建 Checkout。' : `请检查：${missing.join('、')}。`;
  return ready;
}

function setActiveWorkflowStep(target) {
  workflowSteps.forEach((step) => {
    const active = step.dataset.workflowTarget === target;
    step.classList.toggle('active', active);
    if (active) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
}

function syncWorkflowStepFromScroll() {
  const activationLine = Math.min(260, window.innerHeight * 0.4);
  let current = workflowSections[0];
  workflowSections.forEach((section) => { if (section.getBoundingClientRect().top <= activationLine) current = section; });
  if (current) setActiveWorkflowStep(current.id);
}

function setLoading(button, loading, labelElement, loadingText, idleText) {
  button.disabled = loading;
  labelElement.textContent = loading ? loadingText : idleText;
}

function formatExpiry(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function updateCdkChip(details) {
  if (details.unlimited || details.kind === 'admin' || details.cdkKind === 'admin') {
    elements.cdkRemaining.textContent = '管理员通用 · 长期有效';
    return;
  }
  elements.cdkRemaining.textContent = '授权有效 · 可继续使用';
}

function clearCdkExpiryTimer() {
  if (state.cdkExpiryTimer) clearTimeout(state.cdkExpiryTimer);
  state.cdkExpiryTimer = null;
  state.cdkExpiresAtMs = 0;
}

function expireCdkSession() {
  if (!state.activeCdk) return;
  lockWorkbench();
  setStatus(elements.cdkStatus, '当前 CDK 已过期，请输入新的 CDK 后继续使用。', 'error');
}

function armCdkExpiryTimer() {
  const remaining = state.cdkExpiresAtMs - Date.now();
  if (remaining <= 0) {
    expireCdkSession();
    return;
  }
  state.cdkExpiryTimer = setTimeout(armCdkExpiryTimer, Math.min(remaining + 50, 2_147_000_000));
}

function scheduleCdkExpiry(details) {
  clearCdkExpiryTimer();
  if (details.unlimited || details.kind === 'admin' || details.cdkKind === 'admin') return true;
  const expiresAt = details.expiresAt || details.cdkExpiresAt;
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
  state.cdkExpiresAtMs = expiresAtMs;
  armCdkExpiryTimer();
  return true;
}

function enforceCdkExpiry() {
  if (state.activeCdk && state.cdkExpiresAtMs && Date.now() >= state.cdkExpiresAtMs) expireCdkSession();
}

function unlockWorkbench(verification) {
  if (!scheduleCdkExpiry(verification)) {
    lockWorkbench();
    setStatus(elements.cdkStatus, '当前 CDK 已过期，请输入新的 CDK 后继续使用。', 'error');
    return;
  }
  elements.gateView.hidden = true;
  elements.workbench.hidden = false;
  updateCdkChip(verification);
  window.scrollTo({ top: 0, behavior: 'instant' });
  setTimeout(() => elements.accessToken.focus(), 80);
}

function lockWorkbench({ clearSession = true } = {}) {
  if (clearSession) fetch('/api/cdk/session', { method: 'DELETE' }).catch(() => {});
  clearCdkExpiryTimer();
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
  updateWorkflowState();
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

elements.lockButton.addEventListener('click', () => lockWorkbench());
document.addEventListener('visibilitychange', () => { if (!document.hidden) enforceCdkExpiry(); });
window.addEventListener('focus', enforceCdkExpiry);
window.addEventListener('pageshow', enforceCdkExpiry);
workflowSteps.forEach((step) => step.addEventListener('click', () => {
  const section = document.getElementById(step.dataset.workflowTarget);
  if (!section) return;
  setActiveWorkflowStep(step.dataset.workflowTarget);
  const top = section.getBoundingClientRect().top + window.scrollY - 88;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}));
window.addEventListener('scroll', () => {
  if (workflowScrollFrame) return;
  workflowScrollFrame = requestAnimationFrame(() => { workflowScrollFrame = 0; syncWorkflowStepFromScroll(); });
}, { passive: true });
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
document.querySelectorAll('input[name="billing-period"]').forEach((input) => input.addEventListener('change', () => {
  updateSummary();
  renderCountryOptions(elements.countrySearch.value);
}));
elements.promoCode.addEventListener('input', () => {
  updatePromoState();
  renderPricing();
  updateWorkflowState();
});
elements.workspaceName.addEventListener('input', updateWorkflowState);
elements.accessToken.addEventListener('input', updateWorkflowState);

elements.accessToken.classList.add('token-hidden');
elements.toggleToken.addEventListener('click', () => {
  state.tokenVisible = !state.tokenVisible;
  elements.accessToken.classList.toggle('token-hidden', !state.tokenVisible);
  elements.toggleToken.innerHTML = state.tokenVisible ? ICON_EYE_OFF : ICON_EYE;
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
    setActiveWorkflowStep('account-section');
    elements.accessToken.focus();
    return;
  }
  if (!state.country?.proxyConfigured) {
    setStatus(elements.formStatus, ERROR_MESSAGES.proxy_not_configured, 'error');
    setActiveWorkflowStep('region-section');
    elements.countryTrigger.focus();
    return;
  }
  if (!updateSummary()) {
    setStatus(elements.formStatus, ERROR_MESSAGES.invalid_seat_quantity, 'error');
    setActiveWorkflowStep('seat-section');
    elements.seatDefault.focus();
    return;
  }

  const seats = seatValues();
  const selectedPromo = promoSelection();
  if (selectedPromo.reason) {
    setStatus(elements.formStatus, ERROR_MESSAGES[selectedPromo.reason], 'error');
    setActiveWorkflowStep('order-section');
    elements.promoCode.focus();
    return;
  }
  setLoading(elements.generateButton, true, elements.generateLabel, '正在创建 Checkout…', '生成支付长链');
  setStatus(elements.formStatus, '正在通过所选国家代理创建 ChatGPT Checkout…', 'info');
  try {
    const data = await requestJson('/api/checkout/team', {
      method: 'POST',
      body: JSON.stringify({
        cdk: state.activeCdk === 'session' ? '' : state.activeCdk,
        accessToken,
        country: state.country.code,
        workspaceName: elements.workspaceName.value.trim() || 'myWorkspace',
        promoCode: selectedPromo.code,
        seatDefault: seats.standard,
        seatProlite: seats.prolite,
        billingPeriod: currentBillingPeriod(),
      }),
    });
    elements.resultUrl.value = data.url;
    elements.openResult.href = data.url;
    elements.resultCard.hidden = false;
    if (!scheduleCdkExpiry(data)) {
      expireCdkSession();
      return;
    }
    updateCdkChip(data);
    const cleanupText = data.promoCleanupScheduled && data.promoAutoDeleteAt
      ? ` 该优惠码将在 ${formatExpiry(data.promoAutoDeleteAt)} 后自动从后台清理。`
      : '';
    setStatus(elements.formStatus, `支付长链创建成功。${cleanupText}`, 'success');
    elements.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    setStatus(elements.formStatus, error.message || '创建失败，请稍后重试。', 'error');
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

async function initializeWorkbench() {
  renderExchangeStatus();
  updateSummary();
  try {
    await loadConfig();
    const verification = await requestJson('/api/cdk/session', { method: 'GET', headers: {} });
    state.activeCdk = 'session';
    unlockWorkbench(verification);
  } catch (error) {
    if (!state.config) setStatus(elements.cdkStatus, error.message || '初始配置加载失败。', 'error');
    elements.cdkInput.focus();
  }
}

initializeWorkbench();
