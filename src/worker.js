import {
  createAdminCdk,
  createCdks,
  deleteCdk,
  listCdks,
  recordRestrictedCheckoutSuccess,
  revokeCdk,
  synchronizeCustomerCdkExpiry,
  verifyCdk,
  verifyCdkId,
} from './cdk.js';
import {
  deleteProxyRoute,
  getProxyRoute,
  listProxyRoutes,
  recordProxyTest,
  saveProxyRoutes,
} from './proxy-config.js';
import {
  cleanupExpiredPromoCodes,
  deletePromoCode,
  importPromoCodes,
  listPromoCodes,
  markPromoForAutoDelete,
  normalizePromoCode,
  resolvePromoCodeRegistration,
} from './promo-codes.js';

// ChatGPT Team 支付长链生成器 - Cloudflare Worker
// 前端静态资源 + 国家配置 + 按国家转发 checkout 请求。

const CHECKOUT_PATH = '/backend-api/payments/checkout';
const CHECKOUT_ORIGINS = ['https://chatgpt.com', 'https://api.openai.com'];
const DEFAULT_COUNTRY = 'US';
const MIN_SEATS = 2;
const MAX_SEATS = 999;
const REQUEST_TIMEOUT_MS = 25_000;
const EXCHANGE_RATE_TIMEOUT_MS = 6_000;
const EXCHANGE_RATE_CACHE_MS = 30 * 60 * 1000;
const EXCHANGE_RATE_FALLBACK_CACHE_MS = 5 * 60 * 1000;
const EXCHANGE_RATE_URL = 'https://open.er-api.com/v6/latest/USD';

const SEAT_TYPES = [
  { code: 'default', name: '标准席位' },
  { code: 'prolite', name: '高级席位' },
];
const DEFAULT_SEAT_TYPE = 'default';
const SEAT_TYPE_BY_CODE = Object.fromEntries(SEAT_TYPES.map((seatType) => [seatType.code, seatType]));
const BILLING_PERIODS = ['month', 'year'];
const DEFAULT_BILLING_PERIOD = 'month';
const BUSINESS_PRICING = {
  sourceUrl: 'https://chatgpt.com/pricing/',
  standard: { monthUsd: 25, yearUsd: 240 },
  prolite: { monthUsd: 125, yearUsd: 1200 },
  promoDiscountUsd: 25,
  promoBillingPeriods: ['month'],
  promoSeatTypes: ['default'],
};
const ADMIN_SESSION_COOKIE = 'team_admin_session';
const CDK_SESSION_COOKIE = 'team_cdk_session';
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ADMIN_CDK_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

// 这里是前后端共用的唯一国家清单。代理地址不放在代码中，而由 Worker secret 配置。
const COUNTRIES = [
  { code: 'US', name: '美国', currency: 'USD', localMonthlyAmount: 25, localPrice: '$25', usdPrice: '25.00', flag: '🇺🇸', pinyin: 'meiguo' },
  { code: 'EG', name: '埃及', currency: 'EGP', localMonthlyAmount: 1150, localPrice: 'E£1,150', usdPrice: '22.88', flag: '🇪🇬', pinyin: 'aiji' },
  { code: 'GB', name: '英国', currency: 'GBP', localMonthlyAmount: 18, localPrice: '£18', usdPrice: '23.91', flag: '🇬🇧', pinyin: 'yingguo' },
  { code: 'CL', name: '智利', currency: 'CLP', localMonthlyAmount: 21600, localPrice: '$21,600', usdPrice: '23.35', flag: '🇨🇱', pinyin: 'zhili' },
  { code: 'PH', name: '菲律宾', currency: 'PHP', localMonthlyAmount: 1450, localPrice: '₱1,450', usdPrice: '23.29', flag: '🇵🇭', pinyin: 'feilvbin' },
  { code: 'JP', name: '日本', currency: 'JPY', localMonthlyAmount: 3850, localPrice: '¥3,850', usdPrice: '26.18', flag: '🇯🇵', pinyin: 'riben' },
  { code: 'TH', name: '泰国', currency: 'THB', localMonthlyAmount: 780, localPrice: '฿780', usdPrice: '24.18', flag: '🇹🇭', pinyin: 'taiguo' },
  { code: 'IN', name: '印度', currency: 'INR', localMonthlyAmount: 2250, localPrice: '₹2,250', usdPrice: '25.71', flag: '🇮🇳', pinyin: 'yindu' },
  { code: 'SE', name: '瑞典', currency: 'SEK', localMonthlyAmount: 220, localPrice: 'kr220', usdPrice: '23.10', flag: '🇸🇪', pinyin: 'ruidian' },
];
const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map((country) => [country.code, country]));
let exchangeRateCache = { expiresAt: 0, payload: null };

// 简易内存限速：每个 IP 60 秒最多 20 次（边缘实例足够个人/小团队）。
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateBucket = new Map();
const CDK_VERIFY_RATE_LIMIT_MAX = 12;
const cdkVerifyRateBucket = new Map();

function applyRateLimit(ip) {
  const now = Date.now();
  const slot = rateBucket.get(ip);
  if (!slot || slot.resetAt <= now) {
    rateBucket.set(ip, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 1 });
    return { ok: true };
  }
  if (slot.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfterSec: Math.ceil((slot.resetAt - now) / 1000) };
  }
  slot.count += 1;
  return { ok: true };
}

function applyCdkVerifyRateLimit(ip) {
  const now = Date.now();
  const slot = cdkVerifyRateBucket.get(ip);
  if (!slot || slot.resetAt <= now) {
    cdkVerifyRateBucket.set(ip, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 1 });
    return { ok: true };
  }
  if (slot.count >= CDK_VERIFY_RATE_LIMIT_MAX) {
    return { ok: false, retryAfterSec: Math.ceil((slot.resetAt - now) / 1000) };
  }
  slot.count += 1;
  return { ok: true };
}

function requestIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '0.0.0.0'
  );
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}, env = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env),
      ...extraHeaders,
    },
  });
}

function fallbackExchangeRates() {
  return Object.fromEntries(COUNTRIES.map((country) => [
    country.currency,
    country.localMonthlyAmount / Number(country.usdPrice),
  ]));
}

function supportedExchangeRates(rawRates) {
  const currencies = new Set(COUNTRIES.map((country) => country.currency));
  const rates = {};
  for (const currency of currencies) {
    const value = Number(rawRates?.[currency]);
    if (!Number.isFinite(value) || value <= 0) return null;
    rates[currency] = value;
  }
  return rates;
}

async function liveExchangeRatePayload() {
  const now = Date.now();
  if (exchangeRateCache.payload && exchangeRateCache.expiresAt > now) {
    return { ...exchangeRateCache.payload, cached: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_RATE_TIMEOUT_MS);
  try {
    const response = await fetch(EXCHANGE_RATE_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cf: { cacheEverything: true, cacheTtl: Math.floor(EXCHANGE_RATE_CACHE_MS / 1000) },
    });
    if (!response.ok) throw new Error(`exchange_rate_http_${response.status}`);
    const data = await response.json();
    const rates = data?.result === 'success' ? supportedExchangeRates(data.rates) : null;
    if (!rates) throw new Error('exchange_rate_payload_invalid');

    const payload = {
      ok: true,
      base: 'USD',
      rates,
      live: true,
      cached: false,
      source: 'ExchangeRate-API',
      updatedAt: Number(data.time_last_update_unix)
        ? new Date(Number(data.time_last_update_unix) * 1000).toISOString()
        : new Date(now).toISOString(),
    };
    exchangeRateCache = { payload, expiresAt: now + EXCHANGE_RATE_CACHE_MS };
    return payload;
  } catch {
    const payload = {
      ok: true,
      base: 'USD',
      rates: fallbackExchangeRates(),
      live: false,
      cached: false,
      source: '内置参考汇率',
      updatedAt: null,
    };
    exchangeRateCache = { payload, expiresAt: now + EXCHANGE_RATE_FALLBACK_CACHE_MS };
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeRateResponse(env) {
  const payload = await liveExchangeRatePayload();
  return jsonResponse(
    payload,
    200,
    { 'Cache-Control': payload.live ? 'public, max-age=300, s-maxage=1800' : 'no-store' },
    env
  );
}

function constantTimeEqual(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionSignature(encodedPayload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
  return base64UrlEncode(new Uint8Array(signature));
}

async function createSignedSession(type, values, secret, expiresAtMs) {
  const payload = { type, ...values, exp: Math.floor(expiresAtMs / 1000) };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return encoded + '.' + await sessionSignature(encoded, secret);
}

async function verifySignedSession(value, type, secret) {
  try {
    const [encoded, receivedSignature, extra] = String(value || '').split('.');
    if (!encoded || !receivedSignature || extra) return null;
    const expectedSignature = await sessionSignature(encoded, secret);
    if (!constantTimeEqual(receivedSignature, expectedSignature)) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
    if (payload?.type !== type || !Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requestCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function sessionCookie(request, name, value, expiresAtMs) {
  const maxAge = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie(request, name) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function adminBearerAuthorization(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, error: 'admin_not_configured', status: 503 };
  const authorization = request.headers.get('authorization') || '';
  const received = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
  if (!received || !constantTimeEqual(received, env.ADMIN_TOKEN)) {
    return { ok: false, error: 'admin_unauthorized', status: 401 };
  }
  return { ok: true };
}

async function adminAuthorization(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, error: 'admin_not_configured', status: 503 };
  const bearer = adminBearerAuthorization(request, env);
  if (bearer.ok) return bearer;
  const session = await verifySignedSession(
    requestCookie(request, ADMIN_SESSION_COOKIE),
    'admin',
    env.ADMIN_TOKEN
  );
  return session
    ? { ok: true, session }
    : { ok: false, error: 'admin_unauthorized', status: 401 };
}

async function cdkSessionAuthorization(request, env, options = {}) {
  if (!env.CDK_HASH_PEPPER) return { ok: false, error: 'cdk_service_not_configured' };
  const session = await verifySignedSession(
    requestCookie(request, CDK_SESSION_COOKIE),
    'cdk',
    env.CDK_HASH_PEPPER
  );
  if (!session || !Number.isInteger(Number(session.cdkId))) return { ok: false, error: 'cdk_invalid' };
  return safeCdkOperation(() => verifyCdkId(Number(session.cdkId), env, options));
}

function cdkFailureStatus(error) {
  if (['cdk_service_not_configured', 'cdk_database_error'].includes(error)) return 503;
  if (error === 'cdk_invalid_format') return 400;
  if (error === 'cdk_invalid') return 401;
  return 403;
}

function cdkFailureResponse(result, env) {
  return jsonResponse({ ok: false, error: result.error }, cdkFailureStatus(result.error), {}, env);
}

async function safeCdkOperation(operation) {
  try {
    return await operation();
  } catch {
    return { ok: false, error: 'cdk_database_error' };
  }
}

async function safePromoOperation(operation) {
  try {
    return await operation();
  } catch {
    return { ok: false, error: 'promo_database_error' };
  }
}

function promoFailureStatus(error) {
  if (['promo_service_not_configured', 'promo_database_error'].includes(error)) return 503;
  if (error === 'promo_inventory_insufficient') return 409;
  if (error === 'promo_not_registered') return 403;
  if (error === 'promo_not_found') return 404;
  return 400;
}

function promoFailureResponse(result, env) {
  return jsonResponse(result, promoFailureStatus(result.error), { 'Cache-Control': 'no-store' }, env);
}

function decodeJwtPayload(token) {
  // 不验签，只读取生成 checkout 请求需要的 claims。
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function extractAccessToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^bearer\s+/i.test(trimmed)) trimmed = trimmed.replace(/^bearer\s+/i, '');
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed);
      return value.accessToken || value.access_token || '';
    } catch {
      return '';
    }
  }
  return trimmed.replace(/\s+/g, '');
}

function buildTeamPayload({
  promoCode,
  country,
  currency,
  workspaceName,
  seatDefault,
  seatProlite,
  billingPeriod,
}) {
  const trimmedPromo = String(promoCode || '').trim();
  const seatQuantity = seatDefault + seatProlite;
  const payload = {
    plan_name: 'chatgptteamplan',
    team_plan_data: {
      workspace_name: workspaceName,
      price_interval: billingPeriod,
      seat_quantity: seatQuantity,
      seat_quantities: [
        { seat_type: 'default', quantity: seatDefault },
        { seat_type: 'prolite', quantity: seatProlite },
      ],
    },
    billing_details: { country, currency },
    cancel_url: trimmedPromo
      ? 'https://chatgpt.com/?promoCode=' + encodeURIComponent(trimmedPromo)
      : 'https://chatgpt.com/',
    checkout_ui_mode: 'hosted',
  };
  if (trimmedPromo) payload.promo_code = trimmedPromo;
  return payload;
}

function buildCheckoutHeaders({ accessToken, accountId, userId, deviceId }) {
  const headers = {
    Authorization: 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: CHECKOUT_ORIGINS[0],
    Referer: CHECKOUT_ORIGINS[0] + '/',
    'oai-account-id': accountId || '00000000-0000-0000-0000-000000000000',
    'oai-account-domain': 'shared',
    'oai-language': 'en-US',
    'oai-client-version': 'v0.0.0',
    'oai-device-id': deviceId || 'produced',
  };
  if (userId) headers['oai-user-id'] = userId;
  return headers;
}

function allowDirectCheckout(env) {
  return String(env.ALLOW_DIRECT_CHECKOUT || '').toLowerCase() === 'true';
}

function validateRelayRoute(entry) {
  const route = typeof entry === 'string' ? { url: entry, token: '' } : entry;
  if (!route || typeof route !== 'object' || typeof route.url !== 'string') return null;
  try {
    const url = new URL(route.url);
    const isLocalRelay =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !isLocalRelay) || url.username || url.password) return null;
    return {
      url: url.toString(),
      token: typeof route.token === 'string' ? route.token : '',
    };
  } catch {
    return null;
  }
}

/**
 * RELAY_CONFIG 是后台动态代理共用的 HTTPS Relay：
 * { "url": "https://relay.example.com/forward", "token": "..." }
 */
function readCommonRelayConfiguration(env) {
  if (!env.RELAY_CONFIG) return { route: null, parseError: false };
  try {
    const route = validateRelayRoute(JSON.parse(env.RELAY_CONFIG));
    return { route, parseError: !route };
  } catch {
    return { route: null, parseError: true };
  }
}

/**
 * COUNTRY_PROXY_CONFIG 是仅存放于 Worker 后台的 JSON secret：
 * { "US": { "url": "https://us-relay.example.com/forward", "token": "..." } }
 *
 * url 必须是 HTTPS 转发网关。普通 IP:PORT HTTP/SOCKS 代理无法被 Workers fetch 直接使用，
 * 需要由这个网关封装；网关请求/响应协议见 README。
 */
function readProxyConfiguration(env) {
  const result = { routes: new Map(), invalidCountries: new Set(), parseError: false };
  const raw = env.COUNTRY_PROXY_CONFIG;
  if (!raw) return result;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    result.parseError = true;
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.parseError = true;
    return result;
  }

  for (const country of COUNTRIES) {
    const entry = parsed[country.code];
    if (entry == null) continue;
    const route = validateRelayRoute(entry);
    if (!route) {
      result.invalidCountries.add(country.code);
      continue;
    }
    result.routes.set(country.code, route);
  }
  return result;
}

async function safeProxyOperation(operation) {
  try {
    return await operation();
  } catch {
    return { ok: false, error: 'proxy_database_error' };
  }
}

function proxyFailureStatus(error) {
  if (['proxy_service_not_configured', 'proxy_database_error', 'proxy_not_configured'].includes(error)) return 503;
  if (error === 'relay_not_configured') return 503;
  if (['relay_config_invalid', 'proxy_config_invalid'].includes(error)) return 500;
  if (error === 'proxy_not_found') return 404;
  if (error === 'proxy_decryption_failed') return 500;
  return 400;
}

function proxyFailureResponse(result, env) {
  return jsonResponse({ ok: false, error: result.error, country: result.country }, proxyFailureStatus(result.error), {}, env);
}

async function configuredDynamicProxyCountries(env) {
  const result = await safeProxyOperation(() => listProxyRoutes(env));
  // 后台动态代理是可选升级；未设置加密密钥时继续使用旧版环境变量路由。
  if (!result.ok && result.error === 'proxy_service_not_configured') {
    return { countries: new Set(), error: '' };
  }
  if (!result.ok) return { countries: new Set(), error: result.error };
  return { countries: new Set(result.records.map((record) => record.country)), error: '' };
}

async function configurationResponse(env) {
  const legacyProxyConfig = readProxyConfiguration(env);
  const commonRelay = readCommonRelayConfiguration(env);
  const dynamic = await configuredDynamicProxyCountries(env);
  const directAllowed = allowDirectCheckout(env);
  const isConfigured = (code) =>
    legacyProxyConfig.routes.has(code) ||
    Boolean(dynamic.countries.has(code) && (commonRelay.route || legacyProxyConfig.routes.has(code)));
  const firstConfigured = COUNTRIES.find((country) => isConfigured(country.code));
  return jsonResponse(
    {
      ok: true,
      defaultCountry: firstConfigured?.code || DEFAULT_COUNTRY,
      minSeats: MIN_SEATS,
      defaultSeatType: DEFAULT_SEAT_TYPE,
      seatTypes: SEAT_TYPES,
      defaultBillingPeriod: DEFAULT_BILLING_PERIOD,
      billingPeriods: BILLING_PERIODS,
      pricing: BUSINESS_PRICING,
      proxyRequired: !directAllowed,
      configValid: !legacyProxyConfig.parseError && !commonRelay.parseError && !dynamic.error,
      cdkRequired: true,
      cdkServiceReady: Boolean(env.DB && env.CDK_HASH_PEPPER),
      promoServiceReady: Boolean(env.DB && env.PROMO_ENCRYPTION_KEY),
      proxyAdminReady: Boolean(
        env.DB && env.PROXY_ENCRYPTION_KEY && (commonRelay.route || legacyProxyConfig.routes.size)
      ),
      countries: COUNTRIES.map((country) => ({
        ...country,
        proxyConfigured: isConfigured(country.code),
        proxyConfigInvalid: legacyProxyConfig.invalidCountries.has(country.code),
      })),
    },
    200,
    { 'Cache-Control': 'no-store' },
    env
  );
}

async function handleCdkVerify(request, env) {
  const limited = applyCdkVerifyRateLimit(requestIp(request));
  if (!limited.ok) {
    return jsonResponse(
      { ok: false, error: 'cdk_verify_rate_limited', retryAfterSec: limited.retryAfterSec },
      429,
      { 'Retry-After': String(limited.retryAfterSec) },
      env
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400, {}, env);
  }
  const result = await safeCdkOperation(() => verifyCdk(body.cdk, env));
  if (!result.ok) return cdkFailureResponse(result, env);
  const expiresAtMs = result.unlimited
    ? Date.now() + ADMIN_CDK_SESSION_TTL_MS
    : new Date(result.expiresAt).getTime();
  const session = await createSignedSession(
    'cdk',
    { cdkId: result.id },
    env.CDK_HASH_PEPPER,
    expiresAtMs
  );
  return jsonResponse(
    {
      ok: true,
      label: result.label,
      kind: result.kind,
      unlimited: result.unlimited,
      repeatable: result.repeatable,
      maxUses: result.maxUses,
      useCount: result.useCount,
      remainingUses: result.remainingUses,
      activatedAt: result.activatedAt,
      expiresAt: result.expiresAt,
    },
    200,
    {
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(request, CDK_SESSION_COOKIE, session, expiresAtMs),
    },
    env
  );
}

async function handleCdkSession(request, env) {
  if (request.method === 'DELETE') {
    return jsonResponse(
      { ok: true },
      200,
      { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie(request, CDK_SESSION_COOKIE) },
      env
    );
  }
  if (request.method !== 'GET') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
  const result = await cdkSessionAuthorization(request, env);
  if (!result.ok) {
    return jsonResponse(
      { ok: false, error: result.error },
      cdkFailureStatus(result.error),
      { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie(request, CDK_SESSION_COOKIE) },
      env
    );
  }
  return jsonResponse(
    {
      ok: true,
      label: result.label,
      kind: result.kind,
      unlimited: result.unlimited,
      repeatable: result.repeatable,
      maxUses: result.maxUses,
      useCount: result.useCount,
      remainingUses: result.remainingUses,
      activatedAt: result.activatedAt,
      expiresAt: result.expiresAt,
    },
    200,
    { 'Cache-Control': 'no-store' },
    env
  );
}

async function handleAdminSession(request, env) {
  if (request.method === 'GET') {
    const authorization = await adminAuthorization(request, env);
    if (!authorization.ok) return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
    return jsonResponse({ ok: true }, 200, { 'Cache-Control': 'no-store' }, env);
  }
  if (request.method === 'POST') {
    const authorization = adminBearerAuthorization(request, env);
    if (!authorization.ok) return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
    const expiresAtMs = Date.now() + ADMIN_SESSION_TTL_MS;
    const session = await createSignedSession('admin', {}, env.ADMIN_TOKEN, expiresAtMs);
    return jsonResponse(
      { ok: true, expiresAt: new Date(expiresAtMs).toISOString() },
      200,
      {
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(request, ADMIN_SESSION_COOKIE, session, expiresAtMs),
      },
      env
    );
  }
  if (request.method === 'DELETE') {
    return jsonResponse(
      { ok: true },
      200,
      { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie(request, ADMIN_SESSION_COOKIE) },
      env
    );
  }
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
}

async function handleAdminUniversalCdk(request, env) {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400, {}, env);
  }
  const result = await safeCdkOperation(() => createAdminCdk(body, env));
  if (!result.ok) return cdkFailureResponse(result, env);
  return jsonResponse(result, 201, { 'Cache-Control': 'no-store' }, env);
}

async function handleAdminCdks(request, env) {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse(
      { ok: false, error: authorization.error },
      authorization.status,
      authorization.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="CDK Admin"' } : {},
      env
    );
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const result = await safeCdkOperation(() => listCdks(env, url.searchParams.get('limit') || 200));
    if (!result.ok) return cdkFailureResponse(result, env);
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400, {}, env);
    }
    const result = await safeCdkOperation(() => createCdks(body, env));
    if (!result.ok) {
      const status = result.error.startsWith('promo_')
        ? promoFailureStatus(result.error)
        : (['cdk_service_not_configured', 'cdk_database_error'].includes(result.error) ? 503 : 400);
      return jsonResponse(result, status, {}, env);
    }
    return jsonResponse(result, 201, { 'Cache-Control': 'no-store' }, env);
  }

  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
}

async function handleAdminPromos(request, env) {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    await safePromoOperation(() => cleanupExpiredPromoCodes(env));
    const result = await safePromoOperation(() => listPromoCodes(env, {
      limit: url.searchParams.get('limit') || 20,
      page: url.searchParams.get('page') || 1,
      state: url.searchParams.get('state') || 'all',
    }));
    if (!result.ok) return promoFailureResponse(result, env);
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400, {}, env);
    }
    const result = await safePromoOperation(() => importPromoCodes(body, env));
    if (!result.ok) return promoFailureResponse(result, env);
    return jsonResponse(result, 201, { 'Cache-Control': 'no-store' }, env);
  }

  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
}

async function handleAdminPromoItem(request, env, id, action = '') {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
  }
  if (action === 'sold' && request.method === 'POST') {
    const result = await safePromoOperation(() => markPromoForAutoDelete(id, env));
    if (!result.ok) return promoFailureResponse(result, env);
    return jsonResponse({ ...result, sold: true }, 200, { 'Cache-Control': 'no-store' }, env);
  }
  if (request.method !== 'DELETE' || action) {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
  }
  const result = await safePromoOperation(() => deletePromoCode(id, env));
  if (!result.ok) return promoFailureResponse(result, env);
  return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
}

async function handleAdminCdkItem(request, env, id, action = '') {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
  }
  if (request.method !== 'DELETE') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
  }
  const result = await safeCdkOperation(() => action === 'delete' ? deleteCdk(id, env) : revokeCdk(id, env));
  if (!result.ok) {
    const status = ['cdk_service_not_configured', 'cdk_database_error'].includes(result.error) ? 503 : 404;
    return jsonResponse(result, status, {}, env);
  }
  return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
}

function supportedCountryCodes() {
  return COUNTRIES.map((country) => country.code);
}

function validCountryCode(value) {
  const country = String(value || '').toUpperCase();
  return COUNTRY_BY_CODE[country] ? country : '';
}

async function handleAdminProxies(request, env) {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
  }

  if (request.method === 'GET') {
    const result = await safeProxyOperation(() => listProxyRoutes(env));
    if (!result.ok) return proxyFailureResponse(result, env);
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400, {}, env);
    }
    const result = await safeProxyOperation(() => saveProxyRoutes(body, env, supportedCountryCodes()));
    if (!result.ok) return proxyFailureResponse(result, env);
    return jsonResponse(result, 201, { 'Cache-Control': 'no-store' }, env);
  }

  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
}

async function dynamicProxyAndRelay(country, env) {
  const proxy = await safeProxyOperation(() => getProxyRoute(country, env));
  if (!proxy.ok) return proxy;
  if (!proxy.configured) return { ok: false, error: 'proxy_not_found', country };

  const commonRelay = readCommonRelayConfiguration(env);
  const legacyRelay = readProxyConfiguration(env);
  if (!commonRelay.route && legacyRelay.invalidCountries.has(country)) {
    return { ok: false, error: 'relay_config_invalid', country };
  }
  const relay = commonRelay.route || legacyRelay.routes.get(country) || null;
  if (!relay) {
    return {
      ok: false,
      error: commonRelay.parseError ? 'relay_config_invalid' : 'relay_not_configured',
      country,
    };
  }
  return { ok: true, proxy, relay };
}

function relayProbeUrl(forwardUrl) {
  const url = new URL(forwardUrl);
  url.pathname = url.pathname.endsWith('/forward')
    ? url.pathname.slice(0, -'/forward'.length) + '/probe'
    : url.pathname.replace(/\/$/, '') + '/probe';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function testDynamicProxy(country, env) {
  const resolved = await dynamicProxyAndRelay(country, env);
  if (!resolved.ok) return resolved;

  let testResult;
  try {
    const response = await requestWithTimeout(relayProbeUrl(resolved.relay.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Relay-Country': country,
        ...(resolved.relay.token ? { Authorization: 'Bearer ' + resolved.relay.token } : {}),
      },
      body: JSON.stringify({ country, proxyUrl: resolved.proxy.proxyUrl }),
      redirect: 'manual',
    });
    const data = await response.json().catch(() => ({}));
    const exitIp = typeof data.exitIp === 'string' ? data.exitIp.trim().slice(0, 80) : '';
    const latencyMs = Number(data.latencyMs);
    testResult = response.ok && data.ok && exitIp && Number.isFinite(latencyMs) && latencyMs >= 0
      ? {
          ok: true,
          exitIp,
          latencyMs,
        }
      : { ok: false, error: String(data.reason || data.error || 'relay_probe_failed').slice(0, 160) };
  } catch (error) {
    testResult = {
      ok: false,
      error: error?.name === 'AbortError' ? 'relay_probe_timeout' : 'relay_probe_unreachable',
    };
  }

  const recorded = await safeProxyOperation(() => recordProxyTest(country, testResult, env));
  if (!recorded.ok) return recorded;
  return testResult.ok
    ? {
        ok: true,
        country,
        exitIp: testResult.exitIp,
        latencyMs: testResult.latencyMs == null ? null : Math.round(testResult.latencyMs),
      }
    : { ok: false, error: 'proxy_test_failed', reason: testResult.error, country };
}

async function handleAdminProxyItem(request, env, countryValue, action) {
  const authorization = await adminAuthorization(request, env);
  if (!authorization.ok) {
    return jsonResponse({ ok: false, error: authorization.error }, authorization.status, {}, env);
  }
  const country = validCountryCode(countryValue);
  if (!country) return jsonResponse({ ok: false, error: 'unsupported_country' }, 400, {}, env);

  if (!action && request.method === 'DELETE') {
    const result = await safeProxyOperation(() => deleteProxyRoute(country, env));
    if (!result.ok) return proxyFailureResponse(result, env);
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
  }
  if (action === 'test' && request.method === 'POST') {
    const result = await testDynamicProxy(country, env);
    if (!result.ok) {
      const status = result.error === 'proxy_test_failed' ? 502 : proxyFailureStatus(result.error);
      return jsonResponse(result, status, { 'Cache-Control': 'no-store' }, env);
    }
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' }, env);
  }
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {}, env);
}

async function requestWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCheckoutProxy(country, env) {
  const legacy = readProxyConfiguration(env);
  const commonRelay = readCommonRelayConfiguration(env);
  const legacyRelay = legacy.routes.get(country) || null;
  const dynamic = await safeProxyOperation(() => getProxyRoute(country, env));

  if (dynamic.ok && dynamic.configured) {
    const relay = commonRelay.route || legacyRelay;
    if (!relay) {
      return {
        ok: false,
        error: commonRelay.parseError || legacy.invalidCountries.has(country)
          ? 'relay_config_invalid'
          : 'relay_not_configured',
        country,
      };
    }
    return { ok: true, route: { ...relay, proxyUrl: dynamic.proxyUrl }, source: 'admin' };
  }

  if (legacy.parseError || legacy.invalidCountries.has(country)) {
    return { ok: false, error: 'proxy_config_invalid', country };
  }
  if (legacyRelay) return { ok: true, route: legacyRelay, source: 'legacy' };
  if (!dynamic.ok && dynamic.error === 'proxy_database_error') return dynamic;
  if (!dynamic.ok && !['proxy_service_not_configured'].includes(dynamic.error)) return dynamic;
  if (allowDirectCheckout(env)) return { ok: true, route: null, source: 'direct' };
  return { ok: false, error: 'proxy_not_configured', country };
}

async function postCheckout(origin, payload, targetHeaders, proxyRoute, country) {
  const target = origin + CHECKOUT_PATH;
  const request = proxyRoute
    ? {
        url: proxyRoute.url,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Relay-Country': country,
            ...(proxyRoute.token ? { Authorization: 'Bearer ' + proxyRoute.token } : {}),
          },
          // 目标 Authorization 只存在于 HTTPS JSON 包体，网关鉴权使用外层 Authorization。
          body: JSON.stringify({
            target,
            method: 'POST',
            headers: targetHeaders,
            body: JSON.stringify(payload),
            ...(proxyRoute.proxyUrl ? { proxyUrl: proxyRoute.proxyUrl } : {}),
          }),
          redirect: 'manual',
        },
      }
    : {
        url: target,
        init: {
          method: 'POST',
          headers: targetHeaders,
          body: JSON.stringify(payload),
          redirect: 'manual',
        },
      };

  try {
    const response = await requestWithTimeout(request.url, request.init);
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 500) };
    }
    return { status: response.status, data, text, networkError: '' };
  } catch (error) {
    return {
      status: 0,
      data: {},
      text: '',
      networkError: error?.name === 'AbortError' ? 'request_timeout' : 'network_error',
    };
  }
}

function resolveCheckoutUrl(data) {
  if (typeof data?.url === 'string' && /^https:\/\//.test(data.url)) {
    return { url: data.url, sessionId: data.checkout_session_id || '' };
  }
  const sessionId = data?.checkout_session_id;
  if (typeof sessionId === 'string' && sessionId) {
    if (sessionId.startsWith('oaics_')) {
      return { url: 'https://chatgpt.com/checkout/openai_llc/' + sessionId, sessionId };
    }
    return { url: 'https://chatgpt.com/checkout/' + sessionId, sessionId };
  }
  return { url: '', sessionId: '' };
}

function describeError({ status, data, text, origin, networkError }) {
  if (networkError) return origin + ' -> ' + networkError;
  const detail =
    data?.detail ||
    data?.error?.message ||
    data?.error ||
    (typeof data === 'string' ? data : '') ||
    text ||
    'HTTP ' + status;
  const message = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return origin + ' -> ' + status + ': ' + message.slice(0, 800);
}

async function handleTeamCheckout(request, env) {
  const limited = applyRateLimit(requestIp(request));
  if (!limited.ok) {
    return jsonResponse(
      { ok: false, error: 'rate_limited', retryAfterSec: limited.retryAfterSec },
      429,
      { 'Retry-After': String(limited.retryAfterSec) },
      env
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400, {}, env);
  }

  const accessToken = extractAccessToken(body.accessToken || '');
  if (!accessToken) return jsonResponse({ ok: false, error: 'missing_access_token' }, 400, {}, env);
  if (accessToken.length < 40) {
    return jsonResponse({ ok: false, error: 'access_token_too_short' }, 400, {}, env);
  }

  const countryCode = String(body.country || '').toUpperCase();
  const country = COUNTRY_BY_CODE[countryCode];
  if (!country) {
    return jsonResponse(
      { ok: false, error: 'unsupported_country', supportedCountries: COUNTRIES.map((item) => item.code) },
      400,
      {},
      env
    );
  }

  const usesTypedSeatCounts = body.seatDefault != null || body.seatProlite != null;
  let seatDefault;
  let seatProlite;
  if (usesTypedSeatCounts) {
    seatDefault = Number(body.seatDefault ?? 0);
    seatProlite = Number(body.seatProlite ?? 0);
  } else {
    const legacySeatTypeCode = String(body.seatType || DEFAULT_SEAT_TYPE).toLowerCase();
    const legacySeatType = SEAT_TYPE_BY_CODE[legacySeatTypeCode];
    if (!legacySeatType) {
      return jsonResponse(
        { ok: false, error: 'invalid_seat_type', supportedSeatTypes: SEAT_TYPES.map((item) => item.code) },
        400,
        {},
        env
      );
    }
    const legacyQuantity = Number(body.seatQuantity);
    seatDefault = legacySeatType.code === 'default' ? legacyQuantity : 0;
    seatProlite = legacySeatType.code === 'prolite' ? legacyQuantity : 0;
  }
  const seatQuantity = seatDefault + seatProlite;
  if (!Number.isInteger(seatQuantity) || seatQuantity < MIN_SEATS || seatQuantity > MAX_SEATS) {
    return jsonResponse(
      { ok: false, error: 'invalid_seat_quantity', min: MIN_SEATS, max: MAX_SEATS },
      400,
      {},
      env
    );
  }
  if (
    !Number.isInteger(seatDefault) || seatDefault < 0 || seatDefault > MAX_SEATS ||
    !Number.isInteger(seatProlite) || seatProlite < 0 || seatProlite > MAX_SEATS
  ) {
    return jsonResponse(
      { ok: false, error: 'invalid_seat_quantity', min: MIN_SEATS, max: MAX_SEATS },
      400,
      {},
      env
    );
  }

  const billingPeriod = String(body.billingPeriod || DEFAULT_BILLING_PERIOD).toLowerCase();
  if (!BILLING_PERIODS.includes(billingPeriod)) {
    return jsonResponse(
      { ok: false, error: 'invalid_billing_period', supportedBillingPeriods: BILLING_PERIODS },
      400,
      {},
      env
    );
  }

  const requestedPromo = String(body.promoCode || '').trim();
  if (requestedPromo && !BUSINESS_PRICING.promoBillingPeriods.includes(billingPeriod)) {
    return jsonResponse(
      { ok: false, error: 'promo_not_available_for_annual', supportedBillingPeriods: BUSINESS_PRICING.promoBillingPeriods },
      400,
      {},
      env
    );
  }
  if (requestedPromo && seatDefault < 1) {
    return jsonResponse(
      { ok: false, error: 'promo_requires_standard_seat', supportedSeatTypes: BUSINESS_PRICING.promoSeatTypes },
      400,
      {},
      env
    );
  }

  // 先校验 CDK 或已签名的 CDK 会话；优惠码来源只影响客户 CDK 的生命周期策略。
  const submittedCdk = String(body.cdk || '').trim();
  const cdkAuthorization = submittedCdk
    ? await safeCdkOperation(() => verifyCdk(submittedCdk, env))
    : await cdkSessionAuthorization(request, env);
  if (!cdkAuthorization.ok) return cdkFailureResponse(cdkAuthorization, env);

  let promoAuthorization = { ok: true, promoId: null, promoCode: '', registered: false };
  if (requestedPromo && cdkAuthorization.kind === 'admin') {
    const promoCode = normalizePromoCode(requestedPromo);
    promoAuthorization = promoCode
      ? { ok: true, promoId: null, promoCode, registered: false }
      : { ok: false, error: 'invalid_promo_code' };
  } else if (requestedPromo) {
    promoAuthorization = await safePromoOperation(() => resolvePromoCodeRegistration(requestedPromo, env));
  }
  if (!promoAuthorization.ok) return promoFailureResponse(promoAuthorization, env);
  const restrictedCustomerUsage = cdkAuthorization.kind === 'standard' && (
    cdkAuthorization.externalMode || Boolean(promoAuthorization.promoCode && !promoAuthorization.registered)
  );

  const proxyResolution = await resolveCheckoutProxy(countryCode, env);
  if (!proxyResolution.ok) return proxyFailureResponse(proxyResolution, env);
  const proxyRoute = proxyResolution.route;

  const workspaceName = String(body.workspaceName || 'myWorkspace').trim().slice(0, 80) || 'myWorkspace';
  const claims = decodeJwtPayload(accessToken);
  const auth = claims['https://api.openai.com/auth'] || {};
  const payload = buildTeamPayload({
    promoCode: promoAuthorization.promoCode,
    country: country.code,
    currency: country.currency,
    workspaceName,
    seatDefault,
    seatProlite,
    billingPeriod,
  });
  const headers = buildCheckoutHeaders({
    accessToken,
    accountId: auth.chatgpt_account_id || '',
    userId: auth.chatgpt_user_id || '',
    deviceId: String(body.deviceId || '').slice(0, 100),
  });

  const attempts = [];
  for (const origin of CHECKOUT_ORIGINS) {
    const result = await postCheckout(origin, payload, headers, proxyRoute, country.code);
    attempts.push({ origin, status: result.status, viaProxy: Boolean(proxyRoute) });

    if (result.status >= 200 && result.status < 300) {
      const { url, sessionId } = resolveCheckoutUrl(result.data);
      if (url) {
        const promoLifecycle = promoAuthorization.promoId
          ? await safePromoOperation(() => markPromoForAutoDelete(promoAuthorization.promoId, env))
          : { ok: true, autoDeleteAt: '' };
        // 优惠码首次售出会把已绑定客户 CDK 的结束时间同步为同一个 24 小时时刻。
        const cdkUsage = restrictedCustomerUsage
          ? await safeCdkOperation(() => recordRestrictedCheckoutSuccess({
              cdkId: cdkAuthorization.id,
              promoCode: promoAuthorization.promoCode,
              promoSource: promoAuthorization.promoCode
                ? (promoAuthorization.registered ? 'registered' : 'external')
                : 'none',
            }, env))
          : (submittedCdk
              ? await safeCdkOperation(() => verifyCdk(submittedCdk, env, { consume: true }))
              : await cdkSessionAuthorization(request, env, { consume: true }));
        if (!cdkUsage.ok) return cdkFailureResponse(cdkUsage, env);
        const usage = cdkUsage;
        const responseHeaders = {};
        if (usage.sessionActive === false) {
          responseHeaders['Set-Cookie'] = clearSessionCookie(request, CDK_SESSION_COOKIE);
        } else if (!usage.unlimited && usage.id && usage.expiresAt) {
          const refreshedExpiryMs = new Date(usage.expiresAt).getTime();
          if (Number.isFinite(refreshedExpiryMs) && refreshedExpiryMs > Date.now()) {
            const refreshedSession = await createSignedSession(
              'cdk',
              { cdkId: usage.id },
              env.CDK_HASH_PEPPER,
              refreshedExpiryMs
            );
            responseHeaders['Set-Cookie'] = sessionCookie(
              request,
              CDK_SESSION_COOKIE,
              refreshedSession,
              refreshedExpiryMs
            );
          }
        }
        return jsonResponse(
          {
            ok: true,
            url,
            sessionId,
            origin,
            country: country.code,
            currency: country.currency,
            workspaceName,
            seatQuantity,
            seatDefault,
            seatProlite,
            billingPeriod,
            promoCleanupScheduled: Boolean(promoAuthorization.promoId && promoLifecycle.ok),
            promoSold: Boolean(promoAuthorization.promoId && promoLifecycle.ok),
            promoAutoDeleteAt: promoLifecycle.ok ? (promoLifecycle.autoDeleteAt || '') : '',
            proxyUsed: Boolean(proxyRoute),
            cdkKind: usage.kind,
            cdkRepeatable: usage.repeatable,
            cdkUseCount: usage.useCount,
            cdkRemainingUses: usage.remainingUses,
            cdkExpiresAt: usage.expiresAt,
            attempts,
          },
          200,
          responseHeaders,
          env
        );
      }
      return jsonResponse(
        {
          ok: false,
          error: 'no_checkout_url',
          message: describeError({ ...result, origin }),
          attempts,
        },
        502,
        {},
        env
      );
    }

    // 明确的目标端 4xx 不回退；网络错误、超时和 5xx 才尝试备用源。
    if (result.status >= 400 && result.status < 500) {
      return jsonResponse(
        {
          ok: false,
          error: 'checkout_rejected',
          status: result.status,
          message: describeError({ ...result, origin }),
          attempts,
        },
        result.status,
        {},
        env
      );
    }
  }

  return jsonResponse(
    {
      ok: false,
      error: 'all_origins_failed',
      message: '两个 checkout 源都未成功，请检查该国家的转发网关和上游状态',
      attempts,
    },
    502,
    {},
    env
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      const proxyConfig = readProxyConfiguration(env);
      const commonRelay = readCommonRelayConfiguration(env);
      const dynamic = await configuredDynamicProxyCountries(env);
      return jsonResponse(
        {
          ok: true,
          service: 'chatgpt-team-checkout',
          configuredProxyCount: new Set([...proxyConfig.routes.keys(), ...dynamic.countries]).size,
          configValid: !proxyConfig.parseError && !commonRelay.parseError && !dynamic.error,
          cdkServiceReady: Boolean(env.DB && env.CDK_HASH_PEPPER),
          promoServiceReady: Boolean(env.DB && env.PROMO_ENCRYPTION_KEY),
          proxyAdminReady: Boolean(
            env.DB && env.PROXY_ENCRYPTION_KEY && (commonRelay.route || proxyConfig.routes.size)
          ),
          adminReady: Boolean(env.ADMIN_TOKEN),
        },
        200,
        { 'Cache-Control': 'no-store' },
        env
      );
    }
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return configurationResponse(env);
    }
    if (url.pathname === '/api/exchange-rates' && request.method === 'GET') {
      return exchangeRateResponse(env);
    }
    if (url.pathname === '/api/cdk/verify' && request.method === 'POST') {
      return handleCdkVerify(request, env);
    }
    if (url.pathname === '/api/cdk/session' && ['GET', 'DELETE'].includes(request.method)) {
      return handleCdkSession(request, env);
    }
    if (url.pathname === '/api/admin/session' && ['GET', 'POST', 'DELETE'].includes(request.method)) {
      return handleAdminSession(request, env);
    }
    if (url.pathname === '/api/admin/cdks' && ['GET', 'POST'].includes(request.method)) {
      return handleAdminCdks(request, env);
    }
    if (url.pathname === '/api/admin/cdks/universal') {
      return handleAdminUniversalCdk(request, env);
    }
    const adminCdkMatch = /^\/api\/admin\/cdks\/(\d+)(?:\/(delete))?$/.exec(url.pathname);
    if (adminCdkMatch) return handleAdminCdkItem(request, env, adminCdkMatch[1], adminCdkMatch[2] || '');
    if (url.pathname === '/api/admin/promos' && ['GET', 'POST'].includes(request.method)) {
      return handleAdminPromos(request, env);
    }
    const adminPromoMatch = /^\/api\/admin\/promos\/(\d+)(?:\/(sold))?$/.exec(url.pathname);
    if (adminPromoMatch) return handleAdminPromoItem(request, env, adminPromoMatch[1], adminPromoMatch[2] || '');
    if (url.pathname === '/api/admin/proxies' && ['GET', 'POST'].includes(request.method)) {
      return handleAdminProxies(request, env);
    }
    const adminProxyMatch = /^\/api\/admin\/proxies\/([A-Za-z]{2})(?:\/(test))?$/.exec(url.pathname);
    if (adminProxyMatch) {
      return handleAdminProxyItem(request, env, adminProxyMatch[1], adminProxyMatch[2] || '');
    }
    if (url.pathname === '/api/checkout/team' && request.method === 'POST') {
      return handleTeamCheckout(request, env);
    }

    if (['/admin', '/admin/'].includes(url.pathname) && env.ASSETS && request.method === 'GET') {
      const adminUrl = new URL('/admin.html', request.url);
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }

    if (env.ASSETS && request.method === 'GET') return env.ASSETS.fetch(request);
    return jsonResponse({ ok: false, error: 'not_found', path: url.pathname }, 404, {}, env);
  },
  async scheduled(_controller, env, ctx) {
    const maintenance = Promise.all([
      safeCdkOperation(() => synchronizeCustomerCdkExpiry(env)),
      safePromoOperation(() => cleanupExpiredPromoCodes(env)),
    ]);
    if (ctx?.waitUntil) ctx.waitUntil(maintenance);
    else await maintenance;
  },
};
