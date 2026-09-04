import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminHtml = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
const adminScript = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
const adminStyles = await readFile(new URL('../public/admin.css', import.meta.url), 'utf8');
const customerScript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('admin refresh waits for session restoration before revealing login or dashboard', () => {
  assert.match(adminHtml, /id="admin-loading"/);
  assert.match(adminHtml, /id="login-view" class="login-view" hidden/);
  assert.match(adminHtml, /id="admin-app" class="admin-app" hidden/);
  assert.match(adminScript, /function showAdmin\(\).*elements\.loadingView\.hidden = true/);
  assert.match(adminScript, /function showLogin\(\).*elements\.loadingView\.hidden = true/);
  assert.match(adminScript, /await loadAllData\(\);\s*showAdmin\(\);/);
});

test('promo inventory statistics use a compact four-column desktop grid', () => {
  assert.match(adminStyles, /\.compact-stats\s*\{[^}]*grid-template-columns:\s*repeat\(4,/);
  assert.match(adminStyles, /\.compact-stats \.stat-card\s*\{[^}]*min-height:\s*100px/);
});

test('admin data workspaces provide search, filtering and pagination controls', () => {
  assert.match(adminHtml, /id="cdk-search"/);
  assert.match(adminHtml, /id="cdk-page-size"/);
  assert.match(adminHtml, /id="cdk-prev-page"/);
  assert.match(adminHtml, /id="promo-page-size"/);
  assert.match(adminHtml, /data-proxy-filter="attention"/);
  assert.match(adminScript, /state\.cdkSearch\.trim\(\)\.toLowerCase\(\)/);
  assert.match(adminScript, /Math\.ceil\(total \/ state\.cdkPageSize\)/);
  assert.match(adminScript, /state\.promoPageSize = Number/);
});

test('admin navigation survives refresh through the current URL hash', () => {
  assert.match(adminScript, /history\.replaceState\(null, '', `#\$\{view\}`\)/);
  assert.match(adminScript, /VIEW_META\[location\.hash\.slice\(1\)\]/);
});

test('admin describes the synchronized 24-hour customer lifecycle', () => {
  assert.match(adminHtml, /分配优惠码 24 小时/);
  assert.match(adminHtml, /客户自有码默认 3 小时 \/ 3 次/);
  assert.match(adminHtml, /自动释放原分配码/);
});

test('admin exposes customer checkout auditing without adding it to the customer workbench', () => {
  assert.match(adminHtml, /<th>提链审计<\/th>/);
  assert.match(adminScript, /record\.checkoutAudits/);
  assert.match(adminScript, /仅 CDK.*record\.externalUseCount/);
  assert.match(adminStyles, /\.checkout-audit-list/);
  assert.doesNotMatch(customerScript, /已成功.*useCount/);
  assert.match(customerScript, /授权有效 · 可继续使用/);
});

test('admin can recharge customer-only CDK usage without exposing the control to customers', () => {
  assert.match(adminScript, /充值次数/);
  assert.match(adminScript, /\/api\/admin\/cdks\/\$\{record\.id\}\/recharge/);
  assert.match(adminStyles, /\.table-action-credit/);
  assert.doesNotMatch(customerScript, /\/recharge/);
});
