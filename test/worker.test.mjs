import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';

class MemoryStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.query.includes('FROM proxy_routes WHERE country = ?1')) {
      return this.database.proxyRows.find((row) => row.country === this.values[0]) || null;
    }
    if (this.query.includes('WHERE code_hash = ?1')) {
      return this.database.rows.find((row) => row.code_hash === this.values[0]) || null;
    }
    if (this.query.includes('WHERE id = ?1')) {
      return this.database.rows.find((row) => row.id === Number(this.values[0])) || null;
    }
    return null;
  }

  async all() {
    if (this.query.includes('FROM proxy_routes ORDER BY country ASC')) {
      return { results: [...this.database.proxyRows].sort((left, right) => left.country.localeCompare(right.country)) };
    }
    if (!this.query.includes('FROM cdks ORDER BY id DESC')) return { results: [] };
    const limit = Number(this.values[0]) || 200;
    return { results: [...this.database.rows].sort((left, right) => right.id - left.id).slice(0, limit) };
  }

  async run() {
    if (this.query.startsWith('INSERT INTO proxy_routes')) {
      const [country, encryptedUrl, displayUrl, protocol, host, port, maskedUsername, updatedAt] = this.values;
      const existing = this.database.proxyRows.find((row) => row.country === country);
      const values = {
        country,
        encrypted_url: encryptedUrl,
        display_url: displayUrl,
        protocol,
        host,
        port,
        masked_username: maskedUsername,
        updated_at: updatedAt,
        last_tested_at: null,
        last_test_status: 'untested',
        last_exit_ip: null,
        last_latency_ms: null,
        last_error: null,
      };
      if (existing) Object.assign(existing, values);
      else this.database.proxyRows.push(values);
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('DELETE FROM proxy_routes')) {
      const index = this.database.proxyRows.findIndex((row) => row.country === this.values[0]);
      if (index < 0) return { meta: { changes: 0 } };
      this.database.proxyRows.splice(index, 1);
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('UPDATE proxy_routes')) {
      const [testedAt, status, exitIp, latencyMs, lastError, country] = this.values;
      const row = this.database.proxyRows.find((item) => item.country === country);
      if (!row) return { meta: { changes: 0 } };
      row.last_tested_at = testedAt;
      row.last_test_status = status;
      row.last_exit_ip = exitIp;
      row.last_latency_ms = latencyMs;
      row.last_error = lastError;
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('INSERT INTO cdks')) {
      const [codeHash, codeSuffix, label, maxUses, createdAt, expiresAt] = this.values;
      const id = this.database.nextId++;
      this.database.rows.push({
        id,
        code_hash: codeHash,
        code_suffix: codeSuffix,
        label,
        max_uses: maxUses,
        use_count: 0,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
        last_used_at: null,
      });
      return { meta: { changes: 1, last_row_id: id } };
    }

    if (this.query.includes('SET use_count = use_count + 1')) {
      const [now, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id));
      const active = row && !row.revoked_at && (!row.expires_at || row.expires_at > now) && row.use_count < row.max_uses;
      if (!active) return { meta: { changes: 0 } };
      row.use_count += 1;
      row.last_used_at = now;
      return { meta: { changes: 1 } };
    }

    if (this.query.includes('SET revoked_at = ?1')) {
      const [revokedAt, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id) && !item.revoked_at);
      if (!row) return { meta: { changes: 0 } };
      row.revoked_at = revokedAt;
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }
}

class MemoryD1 {
  constructor() {
    this.rows = [];
    this.proxyRows = [];
    this.nextId = 1;
  }

  prepare(query) {
    return new MemoryStatement(this, query);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const relayUrl = 'https://relay.example.com/forward';
const relayToken = 'relay-secret-value';

function createEnv(proxyCountries = ['US']) {
  const proxyConfig = {};
  proxyCountries.forEach((country) => {
    proxyConfig[country] = { url: relayUrl, token: relayToken };
  });
  return {
    COUNTRY_PROXY_CONFIG: JSON.stringify(proxyConfig),
    RELAY_CONFIG: JSON.stringify({ url: relayUrl, token: relayToken }),
    PROXY_ENCRYPTION_KEY: 'test-proxy-encryption-secret-value',
    CDK_HASH_PEPPER: 'test-cdk-pepper-value',
    ADMIN_TOKEN: 'test-admin-token-value',
    DB: new MemoryD1(),
  };
}

async function adminRequest(env, path, options = {}) {
  return worker.fetch(new Request('https://checkout.example' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + env.ADMIN_TOKEN,
      ...(options.headers || {}),
    },
  }), env);
}

async function issueCdk(env, overrides = {}) {
  const response = await adminRequest(env, '/api/admin/cdks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1, maxUses: 3, expiresDays: 30, label: 'test', ...overrides }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).codes[0];
}

async function saveProxy(env, country, proxyUrl) {
  return adminRequest(env, '/api/admin/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country, proxyUrl }),
  });
}

test('config endpoint exposes readiness but never relay credentials', async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request('https://checkout.example/api/config'), env);
  const text = await response.text();
  const data = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(data.countries.length, 8);
  assert.equal(data.cdkRequired, true);
  assert.equal(data.cdkServiceReady, true);
  assert.equal(data.countries.find((country) => country.code === 'US').proxyConfigured, true);
  assert.equal(data.countries.find((country) => country.code === 'JP').proxyConfigured, false);
  assert.equal(text.includes(relayUrl), false);
  assert.equal(text.includes(relayToken), false);
  assert.equal(text.includes(env.CDK_HASH_PEPPER), false);
});

test('admin API requires its bearer token', async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request('https://checkout.example/api/admin/cdks'), env);
  const data = await response.json();

  assert.equal(response.status, 401);
  assert.equal(data.error, 'admin_unauthorized');
});

test('admin imports encrypted proxies and only lists masked metadata', async () => {
  const env = createEnv([]);
  const proxyUrl = 'http://alice:very-secret-password@proxy.example.com:8080';
  const saveResponse = await saveProxy(env, 'US', proxyUrl);
  const saveText = await saveResponse.text();

  assert.equal(saveResponse.status, 201);
  assert.equal(saveText.includes(proxyUrl), false);
  assert.equal(env.DB.proxyRows.length, 1);
  assert.equal(env.DB.proxyRows[0].encrypted_url.includes(proxyUrl), false);
  assert.equal(env.DB.proxyRows[0].encrypted_url.includes('very-secret-password'), false);
  assert.match(env.DB.proxyRows[0].encrypted_url, /^v1\./);

  const listResponse = await adminRequest(env, '/api/admin/proxies');
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(listResponse.status, 200);
  assert.equal(list.records[0].displayUrl, 'http://al***@proxy.example.com:8080');
  assert.equal(listText.includes('alice'), false);
  assert.equal(listText.includes('very-secret-password'), false);
  assert.equal('encrypted_url' in list.records[0], false);
});

test('admin batch import saves multiple country routes atomically', async () => {
  const env = createEnv([]);
  const response = await adminRequest(env, '/api/admin/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routes: {
        US: 'http://user:pass@us.proxy.example:8080',
        JP: 'https://user:pass@jp.proxy.example:8443',
      },
    }),
  });
  const data = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(data.savedCountries, ['US', 'JP']);
  assert.equal(env.DB.proxyRows.length, 2);
  assert.equal(env.DB.proxyRows.every((row) => row.encrypted_url.startsWith('v1.')), true);
});

test('admin can issue, list and revoke a CDK without persisting plaintext', async () => {
  const env = createEnv();
  const issued = await issueCdk(env, { maxUses: 5, label: '客户 A' });
  assert.match(issued.code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);

  const listResponse = await adminRequest(env, '/api/admin/cdks?limit=20');
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].maskedCode.endsWith(issued.code.slice(-4)), true);
  assert.equal(list.records[0].label, '客户 A');
  assert.equal(listText.includes(issued.code), false);

  const revokeResponse = await adminRequest(env, '/api/admin/cdks/' + issued.id, { method: 'DELETE' });
  assert.equal(revokeResponse.status, 200);

  const verifyResponse = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code }),
  }), env);
  assert.equal(verifyResponse.status, 403);
  assert.equal((await verifyResponse.json()).error, 'cdk_revoked');
});

test('CDK verification does not consume a use', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const response = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code.toLowerCase().replaceAll('-', ' ') }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.remainingUses, 3);
  assert.equal(env.DB.rows[0].use_count, 0);
  assert.equal('code' in data, false);
});

test('checkout consumes CDK once, uses selected relay and enforces server currency', async () => {
  const env = createEnv();
  delete env.RELAY_CONFIG;
  delete env.PROXY_ENCRYPTION_KEY;
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit = null;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ checkout_session_id: 'oaics_test_session' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const request = new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'a'.repeat(80),
        country: 'US',
        currency: 'EUR',
        workspaceName: 'testWorkspace',
        seatQuantity: 2,
        deviceId: 'test-device',
      }),
    });
    const response = await worker.fetch(request, env);
    const data = await response.json();
    const envelope = JSON.parse(capturedInit.body);
    const checkoutPayload = JSON.parse(envelope.body);

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.proxyUsed, true);
    assert.equal(data.currency, 'USD');
    assert.equal(data.cdkRemainingUses, 2);
    assert.equal(env.DB.rows[0].use_count, 1);
    assert.equal(capturedUrl, relayUrl);
    assert.equal(capturedInit.headers.Authorization, 'Bearer ' + relayToken);
    assert.equal(capturedInit.headers['X-Relay-Country'], 'US');
    assert.equal(envelope.target, 'https://chatgpt.com/backend-api/payments/checkout');
    assert.equal(envelope.headers.Authorization.startsWith('Bearer eyJ'), true);
    assert.equal('proxyUrl' in envelope, false);
    assert.deepEqual(checkoutPayload.billing_details, { country: 'US', currency: 'USD' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout prefers an admin-imported proxy and sends it only inside the Relay envelope', async () => {
  const env = createEnv(['US']);
  const dynamicProxyUrl = 'http://dynamic-user:dynamic-pass@us.proxy.example:9000';
  assert.equal((await saveProxy(env, 'US', dynamicProxyUrl)).status, 201);
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  let capturedInit;
  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ checkout_session_id: 'oaics_dynamic_proxy' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'b'.repeat(80),
        country: 'US',
        seatQuantity: 2,
      }),
    }), env);
    const data = await response.json();
    const envelope = JSON.parse(capturedInit.body);

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(envelope.proxyUrl, dynamicProxyUrl + '/');
    assert.equal(JSON.stringify(data).includes('dynamic-pass'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin can probe and delete an imported proxy', async () => {
  const env = createEnv([]);
  const proxyUrl = 'https://probe-user:probe-pass@jp.proxy.example:9443';
  assert.equal((await saveProxy(env, 'JP', proxyUrl)).status, 201);
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedEnvelope = null;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedEnvelope = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, exitIp: '203.0.113.42', latencyMs: 184 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const testResponse = await adminRequest(env, '/api/admin/proxies/JP/test', { method: 'POST' });
    const testData = await testResponse.json();
    assert.equal(testResponse.status, 200);
    assert.equal(capturedUrl, 'https://relay.example.com/probe');
    assert.equal(capturedEnvelope.proxyUrl, proxyUrl + '/');
    assert.equal(testData.exitIp, '203.0.113.42');
    assert.equal(env.DB.proxyRows[0].last_test_status, 'healthy');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const deleteResponse = await adminRequest(env, '/api/admin/proxies/JP', { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal(env.DB.proxyRows.length, 0);
});

test('admin preserves a safe Relay failure reason when a proxy probe fails', async () => {
  const env = createEnv([]);
  assert.equal((await saveProxy(env, 'US', 'http://user:pass@proxy.example:8080')).status, 201);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: 'proxy_probe_failed',
    reason: 'proxy_payment_required',
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const response = await adminRequest(env, '/api/admin/proxies/US/test', { method: 'POST' });
    const data = await response.json();
    assert.equal(response.status, 502);
    assert.equal(data.error, 'proxy_test_failed');
    assert.equal(data.reason, 'proxy_payment_required');
    assert.equal(env.DB.proxyRows[0].last_test_status, 'failed');
    assert.equal(env.DB.proxyRows[0].last_error, 'proxy_payment_required');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout fails closed when selected country has no proxy without consuming CDK', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const request = new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cdk: issued.code,
      accessToken: 'eyJ' + 'a'.repeat(80),
      country: 'JP',
      seatQuantity: 2,
    }),
  });
  const response = await worker.fetch(request, env);
  const data = await response.json();

  assert.equal(response.status, 503);
  assert.equal(data.error, 'proxy_not_configured');
  assert.equal(env.DB.rows[0].use_count, 0);
});

test('checkout rejects countries outside the visual allowlist', async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cdk: 'AAAA-BBBB-CCCC-DDDD',
      accessToken: 'eyJ' + 'a'.repeat(80),
      country: 'DE',
      seatQuantity: 2,
    }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.error, 'unsupported_country');
});
