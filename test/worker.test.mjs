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
    if (this.query.includes('WHERE code_hash = ?1')) {
      return this.database.rows.find((row) => row.code_hash === this.values[0]) || null;
    }
    if (this.query.includes('WHERE id = ?1')) {
      return this.database.rows.find((row) => row.id === Number(this.values[0])) || null;
    }
    return null;
  }

  async all() {
    if (!this.query.includes('FROM cdks ORDER BY id DESC')) return { results: [] };
    const limit = Number(this.values[0]) || 200;
    return { results: [...this.database.rows].sort((left, right) => right.id - left.id).slice(0, limit) };
  }

  async run() {
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
    assert.deepEqual(checkoutPayload.billing_details, { country: 'US', currency: 'USD' });
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
