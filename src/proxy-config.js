const MAX_PROXY_URL_LENGTH = 2_048;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveEncryptionKey(secret) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function serviceReady(env) {
  return Boolean(env?.DB && env?.PROXY_ENCRYPTION_KEY);
}

export function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_PROXY_URL_LENGTH || /\s/.test(raw)) {
    return { ok: false, error: 'invalid_proxy_url' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid_proxy_url' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return { ok: false, error: 'unsupported_proxy_protocol' };
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, error: 'invalid_proxy_url' };
  }

  let decodedUsername = '';
  try {
    decodedUsername = decodeURIComponent(url.username || '');
    decodeURIComponent(url.password || '');
  } catch {
    return { ok: false, error: 'invalid_proxy_url' };
  }
  if (url.password && !url.username) return { ok: false, error: 'invalid_proxy_url' };
  const maskedUsername = decodedUsername
    ? decodedUsername.slice(0, Math.min(2, decodedUsername.length)) + '***'
    : '';
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const port = url.port || defaultPort;
  const displayUrl = url.protocol + '//' + (maskedUsername ? maskedUsername + '@' : '') + url.hostname + ':' + port;

  return {
    ok: true,
    normalizedUrl: url.toString(),
    protocol: url.protocol.slice(0, -1),
    host: url.hostname,
    port,
    maskedUsername,
    displayUrl,
  };
}

async function encryptProxyUrl(proxyUrl, secret, country) {
  const key = await deriveEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(country);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(proxyUrl)
  );
  return 'v1.' + bytesToBase64(iv) + '.' + bytesToBase64(new Uint8Array(encrypted));
}

async function decryptProxyUrl(encryptedValue, secret, country) {
  const [version, ivValue, ciphertextValue] = String(encryptedValue || '').split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue) throw new Error('invalid encrypted proxy');
  const key = await deriveEncryptionKey(secret);
  const additionalData = new TextEncoder().encode(country);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivValue), additionalData },
    key,
    base64ToBytes(ciphertextValue)
  );
  return new TextDecoder().decode(decrypted);
}

function publicProxyRecord(row) {
  return {
    country: row.country,
    configured: true,
    displayUrl: row.display_url,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    maskedUsername: row.masked_username || '',
    updatedAt: row.updated_at,
    lastTestedAt: row.last_tested_at || '',
    testStatus: row.last_test_status || 'untested',
    exitIp: row.last_exit_ip || '',
    latencyMs: row.last_latency_ms == null ? null : Number(row.last_latency_ms),
    lastError: row.last_error || '',
  };
}

function unavailableResult() {
  return { ok: false, error: 'proxy_service_not_configured' };
}

function entriesFromInput(input) {
  if (input?.country && input?.proxyUrl) return [[input.country, input.proxyUrl]];
  if (input?.routes && typeof input.routes === 'object' && !Array.isArray(input.routes)) {
    return Object.entries(input.routes);
  }
  return [];
}

export async function saveProxyRoutes(input, env, supportedCountries) {
  if (!serviceReady(env)) return unavailableResult();
  const supported = new Set(supportedCountries);
  const entries = entriesFromInput(input);
  if (!entries.length || entries.length > supported.size) return { ok: false, error: 'invalid_proxy_import' };

  const prepared = [];
  const seenCountries = new Set();
  for (const [countryValue, proxyUrlValue] of entries) {
    const country = String(countryValue || '').toUpperCase();
    if (!supported.has(country)) return { ok: false, error: 'unsupported_country', country };
    if (seenCountries.has(country)) return { ok: false, error: 'invalid_proxy_import', country };
    seenCountries.add(country);
    const proxy = normalizeProxyUrl(proxyUrlValue);
    if (!proxy.ok) return { ...proxy, country };
    prepared.push({
      country,
      proxy,
      encryptedUrl: await encryptProxyUrl(proxy.normalizedUrl, env.PROXY_ENCRYPTION_KEY, country),
    });
  }

  const updatedAt = new Date().toISOString();
  const statements = prepared.map((item) => env.DB.prepare(
    `INSERT INTO proxy_routes
     (country, encrypted_url, display_url, protocol, host, port, masked_username, updated_at,
      last_tested_at, last_test_status, last_exit_ip, last_latency_ms, last_error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 'untested', NULL, NULL, NULL)
     ON CONFLICT(country) DO UPDATE SET
       encrypted_url = excluded.encrypted_url,
       display_url = excluded.display_url,
       protocol = excluded.protocol,
       host = excluded.host,
       port = excluded.port,
       masked_username = excluded.masked_username,
       updated_at = excluded.updated_at,
       last_tested_at = NULL,
       last_test_status = 'untested',
       last_exit_ip = NULL,
       last_latency_ms = NULL,
       last_error = NULL`
  ).bind(
    item.country,
    item.encryptedUrl,
    item.proxy.displayUrl,
    item.proxy.protocol,
    item.proxy.host,
    item.proxy.port,
    item.proxy.maskedUsername,
    updatedAt
  ));
  await env.DB.batch(statements);
  return { ok: true, savedCountries: prepared.map((item) => item.country) };
}

export async function listProxyRoutes(env) {
  if (!serviceReady(env)) return unavailableResult();
  const result = await env.DB.prepare(
    `SELECT country, display_url, protocol, host, port, masked_username, updated_at,
            last_tested_at, last_test_status, last_exit_ip, last_latency_ms, last_error
     FROM proxy_routes ORDER BY country ASC`
  ).all();
  return { ok: true, records: (result?.results || []).map(publicProxyRecord) };
}

export async function getProxyRoute(countryValue, env) {
  if (!serviceReady(env)) return unavailableResult();
  const country = String(countryValue || '').toUpperCase();
  const row = await env.DB.prepare(
    `SELECT country, encrypted_url, display_url, protocol, host, port, masked_username, updated_at,
            last_tested_at, last_test_status, last_exit_ip, last_latency_ms, last_error
     FROM proxy_routes WHERE country = ?1 LIMIT 1`
  ).bind(country).first();
  if (!row) return { ok: true, configured: false, country };
  try {
    const proxyUrl = await decryptProxyUrl(row.encrypted_url, env.PROXY_ENCRYPTION_KEY, country);
    return { ok: true, configured: true, proxyUrl, record: publicProxyRecord(row) };
  } catch {
    return { ok: false, error: 'proxy_decryption_failed', country };
  }
}

export async function deleteProxyRoute(countryValue, env) {
  if (!serviceReady(env)) return unavailableResult();
  const country = String(countryValue || '').toUpperCase();
  const result = await env.DB.prepare('DELETE FROM proxy_routes WHERE country = ?1').bind(country).run();
  if (Number(result?.meta?.changes || 0) !== 1) return { ok: false, error: 'proxy_not_found', country };
  return { ok: true, country };
}

export async function recordProxyTest(countryValue, testResult, env) {
  if (!serviceReady(env)) return unavailableResult();
  const country = String(countryValue || '').toUpperCase();
  const testedAt = new Date().toISOString();
  const status = testResult.ok ? 'healthy' : 'failed';
  const result = await env.DB.prepare(
    `UPDATE proxy_routes
     SET last_tested_at = ?1, last_test_status = ?2, last_exit_ip = ?3,
         last_latency_ms = ?4, last_error = ?5
     WHERE country = ?6`
  ).bind(
    testedAt,
    status,
    testResult.exitIp || null,
    Number.isFinite(testResult.latencyMs) ? Math.round(testResult.latencyMs) : null,
    testResult.error ? String(testResult.error).slice(0, 160) : null,
    country
  ).run();
  if (Number(result?.meta?.changes || 0) !== 1) return { ok: false, error: 'proxy_not_found', country };
  return { ok: true, country, testedAt, testStatus: status };
}
