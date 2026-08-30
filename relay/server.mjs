import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { ProxyAgent, request } from 'undici';

const PORT = Number(process.env.PORT || 8790);
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_COUNTRIES = new Set(['US', 'EG', 'GB', 'PH', 'JP', 'TH', 'IN', 'SE']);
const ALLOWED_TARGETS = new Set([
  'https://chatgpt.com/backend-api/payments/checkout',
  'https://api.openai.com/backend-api/payments/checkout',
]);
const ALLOWED_TARGET_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'origin',
  'referer',
  'oai-account-id',
  'oai-account-domain',
  'oai-language',
  'oai-client-version',
  'oai-device-id',
  'oai-user-id',
]);

if (!RELAY_TOKEN) throw new Error('RELAY_TOKEN is required');

function parseCountryProxies() {
  let parsed;
  try {
    parsed = JSON.parse(process.env.COUNTRY_UPSTREAM_PROXIES || '{}');
  } catch {
    throw new Error('COUNTRY_UPSTREAM_PROXIES must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('COUNTRY_UPSTREAM_PROXIES must be a JSON object');
  }

  const routes = new Map();
  for (const country of ALLOWED_COUNTRIES) {
    const rawUrl = parsed[country];
    if (rawUrl == null) continue;
    if (typeof rawUrl !== 'string') throw new Error(country + ' proxy URL must be a string');
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(country + ' proxy must use http:// or https://');
    }
    const username = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    const token = username
      ? 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
      : '';
    url.username = '';
    url.password = '';
    routes.set(country, { uri: url.toString(), token });
  }
  return routes;
}

const proxyRoutes = parseCountryProxies();
const proxyAgents = new Map();

function getProxyAgent(country) {
  const route = proxyRoutes.get(country);
  if (!route) return null;
  const cacheKey = route.uri + '|' + route.token;
  if (!proxyAgents.has(cacheKey)) {
    proxyAgents.set(cacheKey, new ProxyAgent({ uri: route.uri, token: route.token || undefined }));
  }
  return proxyAgents.get(cacheKey);
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function hasValidToken(requestToken) {
  const expected = Buffer.from('Bearer ' + RELAY_TOKEN);
  const received = Buffer.from(requestToken || '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readUpstreamBody(body) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('upstream_response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sanitizeTargetHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (!ALLOWED_TARGET_HEADERS.has(normalizedName) || typeof value !== 'string') continue;
    sanitized[normalizedName] = value;
  }
  return sanitized.authorization ? sanitized : null;
}

async function handleForward(incoming, outgoing) {
  if (!hasValidToken(incoming.headers.authorization)) {
    jsonResponse(outgoing, 401, { ok: false, error: 'relay_unauthorized' });
    return;
  }

  const country = String(incoming.headers['x-relay-country'] || '').toUpperCase();
  if (!ALLOWED_COUNTRIES.has(country)) {
    jsonResponse(outgoing, 400, { ok: false, error: 'unsupported_country' });
    return;
  }
  const dispatcher = getProxyAgent(country);
  if (!dispatcher) {
    jsonResponse(outgoing, 503, { ok: false, error: 'country_proxy_not_configured', country });
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(await readRequestBody(incoming));
  } catch (error) {
    const status = error.message === 'request_too_large' ? 413 : 400;
    jsonResponse(outgoing, status, { ok: false, error: error.message === 'request_too_large' ? error.message : 'invalid_json' });
    return;
  }

  const target = typeof envelope.target === 'string' ? envelope.target : '';
  const targetHeaders = sanitizeTargetHeaders(envelope.headers);
  if (!ALLOWED_TARGETS.has(target) || envelope.method !== 'POST' || typeof envelope.body !== 'string' || !targetHeaders) {
    jsonResponse(outgoing, 400, { ok: false, error: 'invalid_forward_request' });
    return;
  }

  try {
    const upstream = await request(target, {
      method: 'POST',
      headers: targetHeaders,
      body: envelope.body,
      dispatcher,
      maxRedirections: 0,
      headersTimeout: 25_000,
      bodyTimeout: 25_000,
    });
    const responseBody = await readUpstreamBody(upstream.body);
    outgoing.writeHead(upstream.statusCode, {
      'content-type': String(upstream.headers['content-type'] || 'application/json; charset=utf-8'),
      'cache-control': 'no-store',
    });
    outgoing.end(responseBody);
  } catch (error) {
    const errorCode = error.message === 'upstream_response_too_large' ? error.message : 'proxy_request_failed';
    jsonResponse(outgoing, 502, { ok: false, error: errorCode });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') {
    jsonResponse(response, 200, { ok: true, configuredProxyCount: proxyRoutes.size });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/forward') {
    await handleForward(request, response);
    return;
  }
  jsonResponse(response, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write('Checkout relay listening on port ' + PORT + '\n');
});

async function shutdown() {
  server.close();
  await Promise.all(Array.from(proxyAgents.values(), (agent) => agent.close()));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
