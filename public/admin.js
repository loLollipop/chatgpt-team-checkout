const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  loadingView: $('#admin-loading'),
  loginView: $('#login-view'), loginForm: $('#login-form'), adminToken: $('#admin-token'), loginButton: $('#login-button'), loginStatus: $('#login-status'),
  app: $('#admin-app'), sidebar: $('#sidebar'), backdrop: $('#mobile-backdrop'), menuButton: $('#menu-button'), logoutButton: $('#logout-button'), refreshButton: $('#refresh-button'),
  pageTitle: $('#page-title'), pageEyebrow: $('#page-eyebrow'), pageDescription: $('#page-description'), globalStatus: $('#global-status'), serviceDot: $('#service-dot'), serviceTitle: $('#service-title'), serviceDetail: $('#service-detail'),
  navCdkCount: $('#nav-cdk-count'), navPromoCount: $('#nav-promo-count'), navProxyCount: $('#nav-proxy-count'),
  overviewCdkActive: $('#overview-cdk-active'), overviewCdkTotal: $('#overview-cdk-total'), overviewPromoAvailable: $('#overview-promo-available'), overviewPromoTotal: $('#overview-promo-total'), overviewProxyReady: $('#overview-proxy-ready'), overviewProxyTotal: $('#overview-proxy-total'), overviewPromoAssigned: $('#overview-promo-assigned'), inventoryList: $('#inventory-list'),
  cdkForm: $('#cdk-create-form'), cdkLabel: $('#cdk-label'), cdkCount: $('#cdk-count'), cdkInventoryHint: $('#cdk-inventory-hint'), cdkCreateButton: $('#cdk-create-button'), cdkCreateStatus: $('#cdk-create-status'), cdkTableBody: $('#cdk-table-body'), cdkSearch: $('#cdk-search'), cdkPageSize: $('#cdk-page-size'), cdkResultsCount: $('#cdk-results-count'), cdkPageInfo: $('#cdk-page-info'), cdkPrevPage: $('#cdk-prev-page'), cdkNextPage: $('#cdk-next-page'),
  adminCdkCreate: $('#admin-cdk-create'), adminCdkResult: $('#admin-cdk-result'), adminCdkCode: $('#admin-cdk-code'), adminCdkCopy: $('#admin-cdk-copy'), adminCdkStatus: $('#admin-cdk-status'), adminCdkState: $('#admin-cdk-state'), adminCdkCaption: $('#admin-cdk-caption'), adminCdkHint: $('#admin-cdk-hint'),
  issuedEmpty: $('#issued-empty'), issuedBundles: $('#issued-bundles'), copyAllBundles: $('#copy-all-bundles'),
  promoTotal: $('#promo-total'), promoAvailable: $('#promo-available'), promoAssigned: $('#promo-assigned'), promoSold: $('#promo-sold'), promoForm: $('#promo-import-form'), promoBatch: $('#promo-batch'), promoText: $('#promo-text'), promoFile: $('#promo-file'), promoFileLabel: $('#promo-file-label'), clearPromoFile: $('#clear-promo-file'), promoImportButton: $('#promo-import-button'), promoImportStatus: $('#promo-import-status'), promoTableBody: $('#promo-table-body'), promoResultsCount: $('#promo-results-count'), promoPageSize: $('#promo-page-size'), promoPageInfo: $('#promo-page-info'), promoPrevPage: $('#promo-prev-page'), promoNextPage: $('#promo-next-page'),
  proxySingleForm: $('#proxy-single-form'), proxyCountry: $('#proxy-country'), proxyUrl: $('#proxy-url'), proxySaveButton: $('#proxy-save-button'), proxySingleStatus: $('#proxy-single-status'), proxyBatchForm: $('#proxy-batch-form'), proxyBatch: $('#proxy-batch'), proxyBatchButton: $('#proxy-batch-button'), proxyBatchStatus: $('#proxy-batch-status'), proxyGrid: $('#proxy-grid'), proxyResultsCount: $('#proxy-results-count'),
};

const VIEW_META = {
  overview: ['Dashboard', '运营概览', '掌握授权、库存与代理健康状态。'],
  cdks: ['Access control', 'CDK 管理', '生成、交付并追踪客户与管理员授权。'],
  promos: ['Inventory', '优惠码库存', '导入、分配并维护全球通用优惠码。'],
  proxies: ['Routing', '国家代理', '配置国家出口并快速定位异常线路。'],
};
const ERROR_MESSAGES = {
  admin_unauthorized: '管理员密码错误，请重新输入。', admin_not_configured: '后台密码尚未配置。', cdk_service_not_configured: 'CDK 服务尚未配置。', cdk_database_error: 'CDK 数据库操作失败。',
  promo_service_not_configured: '优惠码加密服务尚未配置。', promo_database_error: '优惠码数据库操作失败。', invalid_promo_import: '导入内容无效或数量超过限制。', no_valid_promo_codes: '没有识别到有效的优惠码或 chatgpt.com/p 链接。', promo_inventory_insufficient: '优惠码库存不足，请先导入后再生成 CDK。', promo_not_found: '优惠码不存在或已删除。',
  invalid_cdk_count: 'CDK 生成数量必须为 1–50。', cdk_not_found_or_revoked: 'CDK 不存在或已停用。', cdk_not_found: 'CDK 不存在或已删除。',
  proxy_service_not_configured: '代理加密服务尚未配置。', proxy_database_error: '代理数据库操作失败。', invalid_proxy_import: '代理导入格式无效。', invalid_proxy_url: '代理 URL 格式不正确。', unsupported_proxy_protocol: '仅支持 HTTP / HTTPS 代理。', unsupported_country: '国家代码不受支持。', proxy_not_found: '该国家没有已导入的代理。', relay_not_configured: 'Relay 尚未配置。', relay_probe_unreachable: 'Relay 无法连接。', relay_probe_timeout: '代理测试超时。', proxy_test_failed: '代理测试失败。',
};
const STATE_LABELS = { pending: '待激活', active: '有效', exhausted: '已耗尽', expired: '已过期', revoked: '已停用', available: '可用', assigned: '已分配', sold: '已使用', healthy: '健康', failed: '异常', untested: '未测试' };

const state = { token: '', config: null, cdks: { records: [], stats: {} }, promos: { records: [], stats: {}, pagination: {} }, proxies: [], issued: [], fileCodes: [], cdkFilter: 'all', cdkSearch: '', cdkPage: 1, cdkPageSize: 20, promoFilter: 'all', promoPage: 1, promoPageSize: 20, proxyFilter: 'all' };

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}
// Windows 无法渲染旗帜 emoji，代理卡片统一使用本地 SVG 国旗图片，失败时回退 emoji。
function flagImage(country) {
  const image = node('img', 'flag-img');
  image.src = `/flags/${country.code.toLowerCase()}.svg`;
  image.alt = `${country.name}国旗`;
  image.loading = 'lazy';
  image.addEventListener('error', () => image.replaceWith(node('span', 'flag-emoji', country.flag || '🌐')), { once: true });
  return image;
}
function setStatus(element, message = '', type = '') { element.textContent = message; element.className = 'status' + (element === elements.globalStatus ? ' global-status' : '') + (type ? ' ' + type : ''); }
function errorMessage(data, fallback = '操作失败，请稍后重试。') { return ERROR_MESSAGES[data?.error] || data?.reason || data?.message || fallback; }
function formatDate(value, fallback = '长期') { if (!value) return fallback; const date = new Date(value); return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function setButtonLoading(button, loading, loadingText, idleText) { button.disabled = loading; button.textContent = loading ? loadingText : idleText; }

async function adminFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({ error: 'invalid_json' }));
  if (!response.ok) {
    const error = new Error(errorMessage(data)); error.data = data; error.status = response.status;
    if (response.status === 401 && path !== '/api/admin/session') setTimeout(showLogin, 0);
    throw error;
  }
  return data;
}

async function loadAllData() {
  const promoUrl = `/api/admin/promos?limit=${state.promoPageSize}&page=${state.promoPage}&state=${state.promoFilter}`;
  const [config, cdks, promos, proxies] = await Promise.all([
    fetch('/api/config').then((response) => response.json()), adminFetch('/api/admin/cdks?limit=500'), adminFetch(promoUrl), adminFetch('/api/admin/proxies'),
  ]);
  state.config = config; state.cdks = cdks; state.promos = promos; state.proxies = proxies.records || [];
  populateCountrySelects(); renderAll();
}

async function loadPromoPage(page) {
  state.promoPage = Math.max(1, Number(page) || 1);
  const result = await adminFetch(`/api/admin/promos?limit=${state.promoPageSize}&page=${state.promoPage}&state=${state.promoFilter}`);
  const totalPages = Number(result.pagination?.totalPages || 1);
  if (state.promoPage > totalPages) {
    state.promoPage = totalPages;
    return loadPromoPage(totalPages);
  }
  state.promos = result;
  renderPromos(); renderOverview(); renderServiceState();
}

function populateSelect(select) {
  const current = select.value;
  select.replaceChildren();
  (state.config?.countries || []).forEach((country) => {
    const option = node('option', '', `${country.flag} ${country.name} · ${country.code}`);
    option.value = country.code; select.append(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}
function populateCountrySelects() { populateSelect(elements.proxyCountry); }

function renderAll() { reconcileIssuedBundles(); renderOverview(); renderCdks(); renderPromos(); renderProxies(); renderServiceState(); renderIssued(); }
function renderServiceState() {
  const ready = Boolean(state.config?.cdkServiceReady && state.config?.promoServiceReady && state.config?.proxyAdminReady);
  elements.serviceDot.classList.toggle('healthy', ready); elements.serviceTitle.textContent = ready ? '核心服务正常' : '部分服务待配置';
  elements.serviceDetail.textContent = `${state.proxies.length} 个代理 · ${state.promos.stats.available || 0} 条库存`;
}

function renderOverview() {
  const cdkStats = state.cdks.stats || {}; const promoStats = state.promos.stats || {};
  elements.overviewCdkActive.textContent = Number(cdkStats.active || 0) + Number(cdkStats.pending || 0); elements.overviewCdkTotal.textContent = `共 ${cdkStats.total ?? 0} 个授权`;
  elements.overviewPromoAvailable.textContent = promoStats.available ?? 0; elements.overviewPromoTotal.textContent = `总库存 ${promoStats.total ?? 0}`;
  elements.overviewPromoAssigned.textContent = promoStats.assigned ?? 0; elements.overviewProxyReady.textContent = state.proxies.length; elements.overviewProxyTotal.textContent = `共 ${state.config?.countries?.length || 0} 个国家`;
  elements.navCdkCount.textContent = cdkStats.total ?? 0; elements.navPromoCount.textContent = promoStats.available ?? 0; elements.navProxyCount.textContent = state.proxies.length;
  elements.inventoryList.replaceChildren();
  const available = Number(promoStats.available || 0);
  if (!available) elements.inventoryList.append(node('div', 'inventory-empty', '当前没有可用优惠码，请尽快导入。'));
  else {
    const item = node('div', 'inventory-item'); item.append(node('span', '', '🌐'));
    const copy = node('span'); copy.append(node('b', '', '全球统一库存'), node('small', '', '所有国家的客户 CDK 共用')); item.append(copy, node('strong', '', String(available))); elements.inventoryList.append(item);
  }
  updateInventoryHint();
}

function stateBadge(value) { return node('span', `state-badge state-${value}`, STATE_LABELS[value] || value); }
function emptyRow(body, columns, text) { body.replaceChildren(); const row = node('tr'); const cell = node('td', 'table-empty', text); cell.colSpan = columns; row.append(cell); body.append(row); }
function tableCell(content, className = '') { const cell = node('td', className); if (content instanceof Node) cell.append(content); else cell.textContent = String(content ?? ''); return cell; }
function visibleCode(value, locked = false, lockedLabel = '历史脱敏') {
  const wrap = node('div', 'visible-code'); const code = node('code', locked ? 'legacy-code' : '', value || '—'); wrap.append(code);
  if (value && !locked) { const copy = node('button', '', '复制'); copy.type = 'button'; copy.addEventListener('click', () => copyText(value, copy)); wrap.append(copy); }
  else if (locked) wrap.append(node('small', '', lockedLabel));
  return wrap;
}

function activeAdminCdk() {
  return (state.cdks.records || []).find((record) => record.kind === 'admin' && record.state === 'active') || null;
}

function renderCurrentAdminCdk(preferredCode = '') {
  const record = activeAdminCdk();
  const revealedCode = preferredCode || (record && !record.legacyCode ? record.code : '');
  const mode = revealedCode ? 'ready' : (record ? 'legacy' : 'empty');
  const content = {
    ready: {
      state: '可复制', caption: '当前有效的管理员 CDK', code: revealedCode,
      hint: '已使用 AES-GCM 加密保存。刷新或重新登录后台后，仍可查看和复制。',
    },
    legacy: {
      state: '历史脱敏', caption: '升级前生成的管理员 CDK', code: record?.maskedCode || record?.code || '••••-••••-••••-••••',
      hint: '这条历史 CDK 只保存了不可逆哈希，技术上无法恢复原文。重新生成后，新 CDK 会在这里长期可见并支持复制。',
    },
    empty: {
      state: '未生成', caption: '当前没有有效的管理员 CDK', code: '尚未生成',
      hint: '生成后会立即显示完整 CDK，并以密文保存，之后刷新页面也能继续复制。',
    },
  }[mode];

  elements.adminCdkResult.dataset.mode = mode;
  elements.adminCdkState.className = `admin-access-state admin-access-${mode}`;
  elements.adminCdkState.textContent = content.state;
  elements.adminCdkCaption.textContent = content.caption;
  elements.adminCdkCode.textContent = content.code;
  elements.adminCdkHint.textContent = content.hint;
  elements.adminCdkCopy.disabled = mode !== 'ready';
  elements.adminCdkCopy.title = mode === 'ready' ? '复制完整管理员 CDK' : content.hint;
  elements.adminCdkCreate.textContent = record || preferredCode ? '重新生成管理员通用 CDK' : '生成管理员通用 CDK';
}

function renderCdks() {
  renderCurrentAdminCdk();
  elements.cdkTableBody.replaceChildren();
  let records = state.cdks.records || [];
  if (state.cdkFilter === 'active') records = records.filter((record) => ['pending', 'active'].includes(record.state));
  if (state.cdkFilter === 'inactive') records = records.filter((record) => !['pending', 'active'].includes(record.state));
  const query = state.cdkSearch.trim().toLowerCase();
  if (query) records = records.filter((record) => [record.code, record.maskedCode, record.label, record.promoCode, record.kind, record.state].some((value) => String(value || '').toLowerCase().includes(query)));
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / state.cdkPageSize));
  state.cdkPage = Math.min(Math.max(1, state.cdkPage), totalPages);
  const pageStart = (state.cdkPage - 1) * state.cdkPageSize;
  records = records.slice(pageStart, pageStart + state.cdkPageSize);
  elements.cdkResultsCount.textContent = query || state.cdkFilter !== 'all' ? `筛选到 ${total} 条记录` : `共 ${total} 条记录`;
  elements.cdkPageInfo.textContent = `第 ${state.cdkPage} / ${totalPages} 页`;
  elements.cdkPrevPage.disabled = state.cdkPage <= 1;
  elements.cdkNextPage.disabled = state.cdkPage >= totalPages;
  if (!records.length) { emptyRow(elements.cdkTableBody, 8, '暂无符合条件的 CDK'); return; }
  records.forEach((record) => {
    const row = node('tr'); const code = visibleCode(record.code || record.maskedCode, Boolean(record.legacyCode)); const promoLocked = Boolean(record.promoLocked || String(record.promoCode || '').includes('•')); const promo = visibleCode(record.promoCode || '', promoLocked, record.promoSold ? '已使用 · 禁止再次发放' : (record.promoDeleted ? '已删除' : '无法解密')); const type = node('span', `cdk-kind cdk-kind-${record.kind}`, record.kind === 'admin' ? '管理员通用' : '客户'); const progress = node('div', 'progress');
    if (record.unlimited) progress.append(node('small', '', `无限次 · 已用 ${record.useCount} 次`));
    else if (record.repeatable) progress.append(node('small', '', `${record.state === 'pending' ? '激活后' : '有效期内'}可重复 · 已成功 ${record.useCount} 次`));
    else { const bar = node('span'); const fill = node('i'); fill.style.width = `${Math.min(100, Math.round((record.useCount / Math.max(1, record.maxUses)) * 100))}%`; bar.append(fill); progress.append(bar, node('small', '', `${record.useCount}/${record.maxUses}`)); }
    const lifecycle = record.unlimited
      ? '长期有效'
      : (record.state === 'pending' ? `激活截止 ${formatDate(record.activationDeadline || record.expiresAt)}` : `有效至 ${formatDate(record.expiresAt)}`);
    const actions = node('div', 'table-actions');
    const revoke = node('button', 'table-action table-action-neutral', record.state === 'revoked' ? '已停用' : '停用'); revoke.type = 'button'; revoke.disabled = record.state === 'revoked'; revoke.addEventListener('click', () => revokeCdk(record));
    const remove = node('button', 'table-action table-action-danger', '删除'); remove.type = 'button'; remove.addEventListener('click', () => deleteCdk(record)); actions.append(revoke, remove);
    row.append(tableCell(code), tableCell(type), tableCell(record.label || '—'), tableCell(promo), tableCell(progress), tableCell(lifecycle), tableCell(stateBadge(record.state)), tableCell(actions)); elements.cdkTableBody.append(row);
  });
}

function updateInventoryHint() {
  const available = Number(state.promos.stats?.available || 0);
  elements.cdkInventoryHint.textContent = String(available); elements.cdkInventoryHint.style.color = available ? '' : '#bc3d3d';
}

function deliveryText(bundle) { return `自助提链：${location.origin}/\nCDK：${bundle.code}\n优惠码：${bundle.promoCode}`; }
function promoSuffix(value) { return String(value || '').replace(/^•+/, '').slice(-6); }
function forgetIssuedPromo(record) { const suffix = promoSuffix(record?.maskedCode || record?.code); if (!suffix) return; state.issued = state.issued.filter((bundle) => promoSuffix(bundle.promoCode) !== suffix); renderIssued(); }
function reconcileIssuedBundles() { const lockedSuffixes = new Set((state.cdks.records || []).filter((record) => record.promoLocked).map((record) => promoSuffix(record.promoCode)).filter(Boolean)); if (!lockedSuffixes.size) return; state.issued = state.issued.filter((bundle) => !lockedSuffixes.has(promoSuffix(bundle.promoCode))); }
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); if (button) { const before = button.textContent; button.textContent = '已复制'; setTimeout(() => { button.textContent = before; }, 1300); } }
  catch { const area = node('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
}
function renderIssued() {
  elements.issuedBundles.replaceChildren(); elements.issuedEmpty.hidden = state.issued.length > 0; elements.copyAllBundles.hidden = state.issued.length === 0;
  state.issued.forEach((bundle) => { const card = node('article', 'bundle-card'); const pre = node('pre', '', deliveryText(bundle)); const button = node('button', '', '复制'); button.type = 'button'; button.addEventListener('click', () => copyText(deliveryText(bundle), button)); card.append(pre, button); elements.issuedBundles.append(card); });
}

function renderPromos() {
  const stats = state.promos.stats || {}; elements.promoTotal.textContent = stats.total ?? 0; elements.promoAvailable.textContent = stats.available ?? 0; elements.promoAssigned.textContent = stats.assigned ?? 0; elements.promoSold.textContent = stats.sold ?? 0;
  const records = state.promos.records || []; const pagination = state.promos.pagination || {};
  const page = Number(pagination.page || state.promoPage); const totalPages = Number(pagination.totalPages || 1); const total = Number(pagination.total || 0); state.promoPage = page;
  elements.promoResultsCount.textContent = state.promoFilter === 'all' ? `共 ${total} 条记录` : `当前状态共 ${total} 条`;
  elements.promoPageSize.value = String(state.promoPageSize);
  elements.promoPageInfo.textContent = `第 ${page} / ${totalPages} 页`; elements.promoPrevPage.disabled = page <= 1; elements.promoNextPage.disabled = page >= totalPages;
  elements.promoTableBody.replaceChildren(); if (!records.length) { emptyRow(elements.promoTableBody, 7, '暂无符合条件的优惠码'); return; }
  records.forEach((record) => { const row = node('tr'); const sold = record.state === 'sold'; const code = visibleCode(record.code || record.maskedCode, sold || String(record.code || '').includes('•'), sold ? '已使用 · 禁止再次发放' : '无法解密'); const actions = node('div', 'table-actions'); const markSold = node('button', 'table-action table-action-neutral', sold ? '已使用' : '标记已使用'); markSold.type = 'button'; markSold.disabled = sold; if (!sold) markSold.addEventListener('click', () => markPromoSold(record)); const remove = node('button', 'table-action table-action-danger', '删除'); remove.type = 'button'; remove.addEventListener('click', () => deletePromo(record)); actions.append(markSold, remove);
    row.append(tableCell(code), tableCell(record.batchName || '—'), tableCell(formatDate(record.importedAt, '—')), tableCell(record.assignedCdk || '—'), tableCell(formatDate(record.autoDeleteAt, '—')), tableCell(stateBadge(record.state)), tableCell(actions)); elements.promoTableBody.append(row); });
}

function renderProxies() {
  elements.proxyGrid.replaceChildren();
  let countries = (state.config?.countries || []).map((country) => ({ country, record: state.proxies.find((proxy) => proxy.country === country.code) }));
  if (state.proxyFilter === 'configured') countries = countries.filter(({ record }) => Boolean(record));
  if (state.proxyFilter === 'healthy') countries = countries.filter(({ record }) => record?.testStatus === 'healthy');
  if (state.proxyFilter === 'attention') countries = countries.filter(({ record }) => !record || ['failed', 'untested'].includes(record.testStatus || 'untested'));
  const configured = state.proxies.length;
  const total = state.config?.countries?.length || 0;
  elements.proxyResultsCount.textContent = `显示 ${countries.length} 个国家 · 已配置 ${configured}/${total}`;
  if (!countries.length) {
    const empty = node('div', 'proxy-empty'); empty.append(node('b', '', '当前筛选下没有国家'), node('p', '', '切换筛选条件查看其他代理线路。')); elements.proxyGrid.append(empty); return;
  }
  countries.forEach(({ country, record }) => {
    const card = node('article', 'proxy-card' + (record ? '' : ' proxy-unconfigured')); const head = node('div', 'proxy-card-head'); const countryBlock = node('div', 'proxy-country'); countryBlock.append(flagImage(country)); const copy = node('div'); copy.append(node('b', '', `${country.name} · ${country.code}`), node('small', '', country.currency)); countryBlock.append(copy); head.append(countryBlock, stateBadge(record?.testStatus || 'untested'));
    card.append(head, node('div', 'proxy-url', record?.displayUrl || '尚未导入代理'));
    const meta = node('div', 'proxy-meta'); meta.append(node('span', '', record?.exitIp ? `出口 ${record.exitIp}` : '无出口记录'), node('span', '', record?.latencyMs != null ? `${record.latencyMs} ms` : '—')); card.append(meta);
    const actions = node('div', 'proxy-actions'); const test = node('button', '', record ? '测试代理' : '前往导入'); test.type = 'button'; test.addEventListener('click', () => record ? testProxy(country.code, test) : focusProxyCountry(country.code)); const remove = node('button', '', '×'); remove.type = 'button'; remove.disabled = !record; remove.title = '删除代理'; if (record) remove.addEventListener('click', () => deleteProxy(country.code)); actions.append(test, remove); card.append(actions); elements.proxyGrid.append(card);
  });
}

function navigate(view) {
  if (!VIEW_META[view]) return; $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('[data-view-panel]').forEach((panel) => { const active = panel.dataset.viewPanel === view; panel.hidden = !active; panel.classList.toggle('active', active); });
  [elements.pageEyebrow.textContent, elements.pageTitle.textContent, elements.pageDescription.textContent] = VIEW_META[view];
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  closeSidebar(); window.scrollTo({ top: 0, behavior: 'auto' });
}
function openSidebar() { elements.sidebar.classList.add('open'); elements.backdrop.hidden = false; }
function closeSidebar() { elements.sidebar.classList.remove('open'); elements.backdrop.hidden = true; }
function showAdmin() { elements.loadingView.hidden = true; elements.loginView.hidden = true; elements.app.hidden = false; }
function showLogin() { state.token = ''; elements.adminToken.value = ''; elements.loadingView.hidden = true; elements.app.hidden = true; elements.loginView.hidden = false; closeSidebar(); setStatus(elements.globalStatus); setTimeout(() => elements.adminToken.focus(), 50); }
async function logout() { await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {}); showLogin(); }

async function restoreAdminSession() {
  try {
    await adminFetch('/api/admin/session');
    await loadAllData();
    showAdmin();
    navigate(VIEW_META[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');
    return true;
  } catch {
    showLogin();
    return false;
  }
}

elements.loginForm.addEventListener('submit', async (event) => { event.preventDefault(); const token = elements.adminToken.value; if (!token) { setStatus(elements.loginStatus, '请输入管理员密码。', 'error'); return; } state.token = token; setButtonLoading(elements.loginButton, true, '正在登录…', '进入管理后台'); setStatus(elements.loginStatus, '正在校验并创建安全登录会话…', 'info'); try { await adminFetch('/api/admin/session', { method: 'POST', body: '{}' }); state.token = ''; await loadAllData(); elements.adminToken.value = ''; showAdmin(); setStatus(elements.loginStatus); navigate(VIEW_META[location.hash.slice(1)] ? location.hash.slice(1) : 'overview'); } catch (error) { state.token = ''; setStatus(elements.loginStatus, error.message, 'error'); } finally { setButtonLoading(elements.loginButton, false, '正在登录…', '进入管理后台'); } });
elements.logoutButton.addEventListener('click', logout); elements.menuButton.addEventListener('click', openSidebar); elements.backdrop.addEventListener('click', closeSidebar);
$$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view))); $$('[data-open-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.openView)));
elements.refreshButton.addEventListener('click', async () => { setButtonLoading(elements.refreshButton, true, '刷新中…', '刷新数据'); setStatus(elements.globalStatus, '正在刷新全部数据…', 'info'); try { await loadAllData(); setStatus(elements.globalStatus, '数据已刷新。', 'success'); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } finally { setButtonLoading(elements.refreshButton, false, '刷新中…', '刷新数据'); } });

elements.cdkForm.addEventListener('submit', async (event) => { event.preventDefault(); setButtonLoading(elements.cdkCreateButton, true, '正在生成…', '生成并分配优惠码'); setStatus(elements.cdkCreateStatus, '正在原子分配优惠码并生成 CDK…', 'info'); try { const result = await adminFetch('/api/admin/cdks', { method: 'POST', body: JSON.stringify({ label: elements.cdkLabel.value.trim(), count: Number(elements.cdkCount.value) }) }); state.issued = result.codes || []; state.cdkPage = 1; renderIssued(); setStatus(elements.cdkCreateStatus, `已生成 ${state.issued.length} 个 CDK：24 小时内激活，激活后 24 小时可重复提链；首次成功使用已绑定优惠码后，两者结束时间将自动对齐。`, 'success'); await loadAllData(); } catch (error) { const data = error.data; const suffix = data?.error === 'promo_inventory_insufficient' ? `（需要 ${data.required}，当前 ${data.available}）` : ''; setStatus(elements.cdkCreateStatus, error.message + suffix, 'error'); } finally { setButtonLoading(elements.cdkCreateButton, false, '正在生成…', '生成并分配优惠码'); } });
elements.adminCdkCreate.addEventListener('click', async () => {
  const existing = activeAdminCdk();
  if (existing && !confirm('重新生成会立即停用当前管理员 CDK。确定继续吗？')) return;
  let generatedCode = '';
  setButtonLoading(elements.adminCdkCreate, true, '正在生成并加密…', existing ? '重新生成管理员通用 CDK' : '生成管理员通用 CDK');
  elements.adminCdkState.className = 'admin-access-state state-loading'; elements.adminCdkState.textContent = '生成中';
  setStatus(elements.adminCdkStatus, '正在生成新的管理员通用 CDK…', 'info');
  try {
    const result = await adminFetch('/api/admin/cdks/universal', { method: 'POST', body: '{}' });
    generatedCode = result.code?.code || '';
    if (!generatedCode) throw new Error('管理员 CDK 已生成，但服务端没有返回可复制内容。');
    renderCurrentAdminCdk(generatedCode);
    setStatus(elements.adminCdkStatus, '新管理员 CDK 已生成并加密保存，旧管理员 CDK 已自动停用。', 'success');
    try { await loadAllData(); }
    catch { renderCurrentAdminCdk(generatedCode); setStatus(elements.adminCdkStatus, '新管理员 CDK 已生成，但列表刷新失败，请先复制当前显示的 CDK。', 'error'); }
  } catch (error) {
    renderCurrentAdminCdk(generatedCode);
    setStatus(elements.adminCdkStatus, error.message, 'error');
  } finally {
    elements.adminCdkCreate.disabled = false;
    renderCurrentAdminCdk(generatedCode);
  }
});
elements.adminCdkCopy.addEventListener('click', () => { if (!elements.adminCdkCopy.disabled) copyText(elements.adminCdkCode.textContent, elements.adminCdkCopy); });
elements.copyAllBundles.addEventListener('click', () => copyText(state.issued.map(deliveryText).join('\n\n'), elements.copyAllBundles));
$$('[data-cdk-filter]').forEach((button) => button.addEventListener('click', () => { state.cdkFilter = button.dataset.cdkFilter; state.cdkPage = 1; $$('[data-cdk-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderCdks(); }));
elements.cdkSearch.addEventListener('input', () => { state.cdkSearch = elements.cdkSearch.value; state.cdkPage = 1; renderCdks(); });
elements.cdkPageSize.addEventListener('change', () => { state.cdkPageSize = Number(elements.cdkPageSize.value) || 20; state.cdkPage = 1; renderCdks(); });
elements.cdkPrevPage.addEventListener('click', () => { state.cdkPage = Math.max(1, state.cdkPage - 1); renderCdks(); });
elements.cdkNextPage.addEventListener('click', () => { state.cdkPage += 1; renderCdks(); });
async function revokeCdk(record) { if (!confirm(`确定停用 ${record.code || record.maskedCode} 吗？此操作不会回收已分配的优惠码。`)) return; try { await adminFetch(`/api/admin/cdks/${record.id}`, { method: 'DELETE' }); await loadAllData(); setStatus(elements.globalStatus, 'CDK 已停用。', 'success'); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } }
async function deleteCdk(record) { if (!confirm(`确定删除 ${record.code || record.maskedCode} 吗？删除后会立即失效并从后台列表消失，已分配优惠码不会回收。`)) return; try { await adminFetch(`/api/admin/cdks/${record.id}/delete`, { method: 'DELETE' }); await loadAllData(); setStatus(elements.globalStatus, 'CDK 已删除。', 'success'); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } }

function splitTextCodes(text) { return String(text || '').split(/[\r\n,;\t]+/).map((value) => value.trim()).filter(Boolean); }
async function codesFromFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (['txt', 'csv'].includes(extension)) return splitTextCodes(await file.text());
  if (!window.XLSX) throw new Error('Excel 解析组件加载失败，请检查网络后重试，或另存为 CSV。');
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false }); const values = [];
  workbook.SheetNames.forEach((name) => { const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' }); rows.forEach((row) => row.forEach((cell) => { const value = String(cell ?? '').trim(); if (value) values.push(value); })); }); return values;
}
elements.promoFile.addEventListener('change', async () => { const file = elements.promoFile.files?.[0]; state.fileCodes = []; if (!file) return; elements.promoFileLabel.textContent = `正在读取 ${file.name}…`; try { state.fileCodes = await codesFromFile(file); elements.promoFileLabel.textContent = `${file.name} · 识别到 ${state.fileCodes.length} 个非空单元格`; elements.clearPromoFile.hidden = false; setStatus(elements.promoImportStatus, '文件读取完成，点击“导入优惠码”写入库存。', 'success'); } catch (error) { elements.promoFile.value = ''; elements.promoFileLabel.textContent = '将读取所有非空单元格'; setStatus(elements.promoImportStatus, error.message, 'error'); } });
elements.clearPromoFile.addEventListener('click', () => { elements.promoFile.value = ''; state.fileCodes = []; elements.clearPromoFile.hidden = true; elements.promoFileLabel.textContent = '将读取所有非空单元格'; });
elements.promoForm.addEventListener('submit', async (event) => { event.preventDefault(); const codes = [...splitTextCodes(elements.promoText.value), ...state.fileCodes]; if (!codes.length) { setStatus(elements.promoImportStatus, '请粘贴优惠码或选择文件。', 'error'); return; } setButtonLoading(elements.promoImportButton, true, '正在导入…', '导入优惠码'); setStatus(elements.promoImportStatus, `正在校验并加密 ${codes.length} 条数据…`, 'info'); try { const result = await adminFetch('/api/admin/promos', { method: 'POST', body: JSON.stringify({ batchName: elements.promoBatch.value.trim(), codes }) }); setStatus(elements.promoImportStatus, `导入完成：新增 ${result.importedCount}，重复 ${result.duplicateCount}，无效 ${result.invalidCount}。`, 'success'); elements.promoText.value = ''; elements.clearPromoFile.click(); state.promoPage = 1; await loadAllData(); } catch (error) { setStatus(elements.promoImportStatus, error.message, 'error'); } finally { setButtonLoading(elements.promoImportButton, false, '正在导入…', '导入优惠码'); } });
$$('[data-promo-filter]').forEach((button) => button.addEventListener('click', async () => { state.promoFilter = button.dataset.promoFilter; $$('[data-promo-filter]').forEach((item) => item.classList.toggle('active', item === button)); try { await loadPromoPage(1); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } }));
elements.promoPrevPage.addEventListener('click', () => loadPromoPage(state.promoPage - 1).catch((error) => setStatus(elements.globalStatus, error.message, 'error')));
elements.promoNextPage.addEventListener('click', () => loadPromoPage(state.promoPage + 1).catch((error) => setStatus(elements.globalStatus, error.message, 'error')));
elements.promoPageSize.addEventListener('change', () => { state.promoPageSize = Number(elements.promoPageSize.value) || 20; loadPromoPage(1).catch((error) => setStatus(elements.globalStatus, error.message, 'error')); });
async function markPromoSold(record) { if (!confirm(`确定将优惠码 ${record.code || record.maskedCode} 标记为已使用吗？标记后管理员无法再次复制发放，但已绑定客户在 CDK 有效期内仍可重复提链。`)) return; try { const result = await adminFetch(`/api/admin/promos/${record.id}/sold`, { method: 'POST' }); forgetIssuedPromo(record); await loadPromoPage(state.promoPage); setStatus(elements.globalStatus, `已标记为已使用；绑定客户仍可重复提链，后台记录将于 ${formatDate(result.autoDeleteAt)} 清理。`, 'success'); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } }
async function deletePromo(record) { const detail = record.state === 'sold' ? '这会取消等待中的自动清理并立即删除。' : (record.assignedCdk ? `当前绑定 CDK ${record.assignedCdk}，删除不会解除或回收该 CDK。` : '删除后工作台将不再接受此优惠码。'); if (!confirm(`确定删除优惠码 ${record.code || record.maskedCode} 吗？\n${detail}`)) return; try { await adminFetch(`/api/admin/promos/${record.id}`, { method: 'DELETE' }); forgetIssuedPromo(record); await loadPromoPage(state.promoPage); setStatus(elements.globalStatus, '优惠码已从后台库存删除。', 'success'); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } }

function parseProxyBatch(value) { const text = String(value || '').trim(); if (!text) throw new Error('请粘贴代理配置。'); if (text.startsWith('{')) { const parsed = JSON.parse(text); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('JSON 必须是国家到代理 URL 的对象。'); return parsed; } const routes = {}; text.split(/\r?\n/).forEach((line) => { const trimmed = line.trim(); if (!trimmed) return; const index = trimmed.indexOf('='); if (index < 2) throw new Error(`无法解析：${trimmed}`); routes[trimmed.slice(0, index).trim().toUpperCase()] = trimmed.slice(index + 1).trim(); }); return routes; }
elements.proxySingleForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!elements.proxyUrl.value.trim()) { setStatus(elements.proxySingleStatus, '请输入代理 URL。', 'error'); return; } setButtonLoading(elements.proxySaveButton, true, '正在保存…', '保存并加密'); try { await adminFetch('/api/admin/proxies', { method: 'POST', body: JSON.stringify({ country: elements.proxyCountry.value, proxyUrl: elements.proxyUrl.value.trim() }) }); elements.proxyUrl.value = ''; setStatus(elements.proxySingleStatus, '代理已加密保存。', 'success'); await loadAllData(); } catch (error) { setStatus(elements.proxySingleStatus, error.message, 'error'); } finally { setButtonLoading(elements.proxySaveButton, false, '正在保存…', '保存并加密'); } });
elements.proxyBatchForm.addEventListener('submit', async (event) => { event.preventDefault(); setButtonLoading(elements.proxyBatchButton, true, '正在保存…', '批量保存'); try { const routes = parseProxyBatch(elements.proxyBatch.value); const result = await adminFetch('/api/admin/proxies', { method: 'POST', body: JSON.stringify({ routes }) }); elements.proxyBatch.value = ''; setStatus(elements.proxyBatchStatus, `已保存 ${result.savedCountries.length} 个国家代理。`, 'success'); await loadAllData(); } catch (error) { setStatus(elements.proxyBatchStatus, error.message, 'error'); } finally { setButtonLoading(elements.proxyBatchButton, false, '正在保存…', '批量保存'); } });
$$('[data-proxy-filter]').forEach((button) => button.addEventListener('click', () => { state.proxyFilter = button.dataset.proxyFilter; $$('[data-proxy-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderProxies(); }));
function focusProxyCountry(code) { elements.proxyCountry.value = code; elements.proxyUrl.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
async function testProxy(code, button) { setButtonLoading(button, true, '测试中…', '测试代理'); try { const result = await adminFetch(`/api/admin/proxies/${code}/test`, { method: 'POST' }); setStatus(elements.globalStatus, `${code} 代理正常：出口 ${result.exitIp}，延迟 ${result.latencyMs} ms。`, 'success'); await loadAllData(); } catch (error) { setStatus(elements.globalStatus, `${code}：${error.message}`, 'error'); await loadAllData().catch(() => {}); } finally { if (document.body.contains(button)) setButtonLoading(button, false, '测试中…', '测试代理'); } }
async function deleteProxy(code) { if (!confirm(`确定删除 ${code} 国家代理吗？删除后该国家无法提链。`)) return; try { await adminFetch(`/api/admin/proxies/${code}`, { method: 'DELETE' }); await loadAllData(); setStatus(elements.globalStatus, `${code} 代理已删除。`, 'success'); } catch (error) { setStatus(elements.globalStatus, error.message, 'error'); } }

renderIssued(); restoreAdminSession();
