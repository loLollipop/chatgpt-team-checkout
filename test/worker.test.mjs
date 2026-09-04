import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker from '../src/worker.js';

const cdkExpiryMigration = await readFile(new URL('../migrations/0007_align_customer_cdk_expiry.sql', import.meta.url), 'utf8');
const externalPromoReleaseMigration = await readFile(new URL('../migrations/0009_release_external_cdk_promos.sql', import.meta.url), 'utf8');

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
    if (this.query.includes('SELECT COUNT(*) AS available') && this.query.includes('FROM promo_codes p')) {
      const available = this.database.promoRows.filter((row) =>
        !row.deleted_at &&
        !row.auto_delete_at &&
        !this.database.assignmentRows.some((assignment) => assignment.promo_code_id === row.id)
      ).length;
      return { available };
    }
    if (this.query.includes('SUM(CASE WHEN a.cdk_id IS NULL') && this.query.includes('FROM promo_codes p')) {
      const countryFiltered = this.query.includes('WHERE p.country = ?1');
      const country = countryFiltered ? this.values[0] : '';
      const rows = this.database.promoRows.filter((row) => !row.deleted_at && (!country || row.country === country));
      const assigned = rows.filter((row) => !row.auto_delete_at && this.database.assignmentRows.some((assignment) => assignment.promo_code_id === row.id)).length;
      const available = rows.filter((row) => !row.auto_delete_at && !this.database.assignmentRows.some((assignment) => assignment.promo_code_id === row.id)).length;
      const sold = rows.filter((row) => row.auto_delete_at).length;
      return { total: rows.length, available, assigned, sold };
    }
    if (this.query.includes('SELECT COUNT(*) AS total') && this.query.includes('FROM promo_codes p')) {
      const rows = this.database.promoRows.filter((row) => {
        if (row.deleted_at) return false;
        const assigned = this.database.assignmentRows.some((assignment) => assignment.promo_code_id === row.id);
        if (this.query.includes('p.auto_delete_at IS NOT NULL')) return Boolean(row.auto_delete_at);
        if (this.query.includes('a.cdk_id IS NULL')) return !assigned && !row.auto_delete_at;
        if (this.query.includes('a.cdk_id IS NOT NULL')) return assigned && !row.auto_delete_at;
        return true;
      });
      return { total: rows.length };
    }
    if (this.query.includes('JOIN cdk_promo_assignments a ON a.cdk_id = c.id') && this.query.includes('WHERE c.code_hash = ?1')) {
      const cdk = this.database.rows.find((row) => row.code_hash === this.values[0]);
      const assignment = cdk && this.database.assignmentRows.find((row) => row.cdk_id === cdk.id);
      const promo = assignment && this.database.promoRows.find((row) => row.id === assignment.promo_code_id);
      return cdk && promo ? { cdk_id: cdk.id, encrypted_code: promo.encrypted_code, code_suffix: promo.code_suffix, country: promo.country } : null;
    }
    if (this.query.startsWith('SELECT p.id, EXISTS') && this.query.includes('FROM promo_codes p')) {
      const [codeHash, cdkId] = this.values;
      const promo = this.database.promoRows.find((row) => row.code_hash === codeHash && !row.deleted_at);
      if (!promo) return null;
      const assignedToCdk = this.database.assignmentRows.some((assignment) =>
        assignment.promo_code_id === promo.id && assignment.cdk_id === Number(cdkId)
      );
      return { id: promo.id, assigned_to_cdk: assignedToCdk ? 1 : 0 };
    }
    if (this.query.startsWith('SELECT id FROM promo_codes') && this.query.includes('WHERE code_hash = ?1')) {
      return this.database.promoRows.find((row) => row.code_hash === this.values[0] && !row.deleted_at) || null;
    }
    if (this.query.startsWith('SELECT redeemed_at, auto_delete_at FROM promo_codes')) {
      return this.database.promoRows.find((row) => row.id === Number(this.values[0])) || null;
    }
    if (this.query.includes('FROM proxy_routes WHERE country = ?1')) {
      return this.database.proxyRows.find((row) => row.country === this.values[0]) || null;
    }
    if (this.query.includes('WHERE code_hash = ?1')) {
      return this.database.rows.find((row) => row.code_hash === this.values[0] && (!this.query.includes('deleted_at IS NULL') || !row.deleted_at)) || null;
    }
    if (this.query.includes('WHERE id = ?1')) {
      return this.database.rows.find((row) => row.id === Number(this.values[0]) && (!this.query.includes('deleted_at IS NULL') || !row.deleted_at)) || null;
    }
    return null;
  }

  async all() {
    if (this.query.includes('FROM cdk_checkout_audits h')) {
      const limit = Number(this.values[0]) || 200;
      const recentIds = new Set(this.database.rows
        .filter((row) => !row.deleted_at)
        .sort((left, right) => right.id - left.id)
        .slice(0, limit)
        .map((row) => row.id));
      return {
        results: [...this.database.auditRows]
          .filter((row) => recentIds.has(row.cdk_id))
          .sort((left, right) => right.id - left.id),
      };
    }
    if (this.query.includes('FROM promo_codes p') && this.query.includes('ORDER BY p.id DESC')) {
      const limit = Number(this.values[0]) || 20;
      const offset = Number(this.values[1]) || 0;
      const rows = this.database.promoRows
        .filter((row) => {
          if (row.deleted_at) return false;
          const assigned = this.database.assignmentRows.some((assignment) => assignment.promo_code_id === row.id);
          if (this.query.includes('p.auto_delete_at IS NOT NULL')) return Boolean(row.auto_delete_at);
          if (this.query.includes('a.cdk_id IS NULL')) return !assigned && !row.auto_delete_at;
          if (this.query.includes('a.cdk_id IS NOT NULL')) return assigned && !row.auto_delete_at;
          return true;
        })
        .sort((left, right) => right.id - left.id)
        .slice(offset, offset + limit)
        .map((row) => {
          const assignment = this.database.assignmentRows.find((item) => item.promo_code_id === row.id);
          const cdk = assignment && this.database.rows.find((item) => item.id === assignment.cdk_id);
          return { ...row, cdk_id: assignment?.cdk_id ?? null, assigned_at: assignment?.assigned_at ?? null, cdk_suffix: cdk?.code_suffix ?? null, cdk_encrypted_code: cdk?.encrypted_code ?? null, cdk_kind: cdk?.kind ?? null, cdk_deleted_at: cdk?.deleted_at ?? null };
        });
      return { results: rows };
    }
    if (this.query.includes('FROM proxy_routes ORDER BY country ASC')) {
      return { results: [...this.database.proxyRows].sort((left, right) => left.country.localeCompare(right.country)) };
    }
    if (!this.query.includes('FROM cdks c') || !this.query.includes('ORDER BY c.id DESC')) return { results: [] };
    const limit = Number(this.values[0]) || 200;
    return {
      results: [...this.database.rows].filter((row) => !this.query.includes('c.deleted_at IS NULL') || !row.deleted_at).sort((left, right) => right.id - left.id).slice(0, limit).map((row) => {
        const assignment = this.database.assignmentRows.find((item) => item.cdk_id === row.id);
        const promo = assignment && this.database.promoRows.find((item) => item.id === assignment.promo_code_id);
        return { ...row, promo_scope: promo?.country ?? null, promo_suffix: promo?.code_suffix ?? null, promo_encrypted_code: promo?.encrypted_code ?? null, promo_auto_delete_at: promo?.auto_delete_at ?? null, promo_deleted_at: promo?.deleted_at ?? null };
      }),
    };
  }

  async run() {
    if (this.query.startsWith('UPDATE cdks SET expires_at = COALESCE')) {
      const targetId = this.query.includes('AND id = ?1') ? Number(this.values[0]) : null;
      let changes = 0;
      this.database.rows.forEach((row) => {
        if (
          row.kind !== 'standard' ||
          row.max_uses !== 2_147_483_647 ||
          !row.activated_at ||
          row.deleted_at ||
          row.revoked_at ||
          row.external_mode_at ||
          (targetId && row.id !== targetId)
        ) return;
        const assignment = this.database.assignmentRows.find((item) => item.cdk_id === row.id);
        const promo = assignment && this.database.promoRows.find((item) => item.id === assignment.promo_code_id);
        const desiredExpiry = promo?.auto_delete_at || new Date(
          new Date(row.activated_at).getTime() + 24 * 60 * 60 * 1_000
        ).toISOString();
        if (row.expires_at === desiredExpiry) return;
        row.expires_at = desiredExpiry;
        changes += 1;
      });
      return { meta: { changes } };
    }

    if (this.query.startsWith('DELETE FROM cdk_promo_assignments')) {
      if (this.query.includes('WHERE cdk_id = ?1')) {
        const cdkId = Number(this.values[0]);
        const before = this.database.assignmentRows.length;
        this.database.assignmentRows = this.database.assignmentRows.filter((row) => row.cdk_id !== cdkId);
        return { meta: { changes: before - this.database.assignmentRows.length } };
      }
      const [codeHash] = this.values;
      const promo = this.database.promoRows.find((row) => row.code_hash === codeHash && row.deleted_at);
      if (!promo) return { meta: { changes: 0 } };
      const before = this.database.assignmentRows.length;
      this.database.assignmentRows = this.database.assignmentRows.filter((row) => row.promo_code_id !== promo.id);
      return { meta: { changes: before - this.database.assignmentRows.length } };
    }

    if (this.query.startsWith('INSERT INTO promo_codes')) {
      const [codeHash, encryptedCode, codeSuffix, country, batchName, importedAt] = this.values;
      const existing = this.database.promoRows.find((row) => row.code_hash === codeHash);
      if (existing) {
        if (!existing.deleted_at) return { meta: { changes: 0 } };
        Object.assign(existing, {
          encrypted_code: encryptedCode,
          code_suffix: codeSuffix,
          country,
          batch_name: batchName,
          imported_at: importedAt,
          redeemed_at: null,
          auto_delete_at: null,
          deleted_at: null,
        });
        return { meta: { changes: 1 } };
      }
      const id = this.database.nextPromoId++;
      this.database.promoRows.push({ id, code_hash: codeHash, encrypted_code: encryptedCode, code_suffix: codeSuffix, country, batch_name: batchName, imported_at: importedAt, redeemed_at: null, auto_delete_at: null, deleted_at: null });
      return { meta: { changes: 1, last_row_id: id } };
    }

    if (this.query.startsWith('INSERT INTO cdk_promo_assignments')) {
      const [codeHash, assignedAt] = this.values;
      const cdk = this.database.rows.find((row) => row.code_hash === codeHash);
      const promo = this.database.promoRows
        .filter((row) => !row.deleted_at && !row.auto_delete_at && !this.database.assignmentRows.some((assignment) => assignment.promo_code_id === row.id))
        .sort((left, right) => left.id - right.id)[0];
      if (!cdk || !promo || this.database.assignmentRows.some((row) => row.cdk_id === cdk.id)) return { meta: { changes: 0 } };
      this.database.assignmentRows.push({ cdk_id: cdk.id, promo_code_id: promo.id, assigned_at: assignedAt });
      return { meta: { changes: 1 } };
    }

    if (this.query.includes('SET redeemed_at = COALESCE')) {
      const [redeemedAt, autoDeleteAt, id] = this.values;
      const promo = this.database.promoRows.find((row) => row.id === Number(id) && !row.deleted_at);
      if (!promo) return { meta: { changes: 0 } };
      promo.redeemed_at ||= redeemedAt;
      promo.auto_delete_at ||= autoDeleteAt;
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('UPDATE cdks SET expires_at = CASE')) {
      const [promoId] = this.values;
      const promo = this.database.promoRows.find((row) => row.id === Number(promoId));
      const assignment = this.database.assignmentRows.find((row) => row.promo_code_id === Number(promoId));
      const cdk = assignment && this.database.rows.find((row) => row.id === assignment.cdk_id && row.kind === 'standard' && row.activated_at && !row.deleted_at && !row.revoked_at);
      if (!promo?.auto_delete_at || !cdk) return { meta: { changes: 0 } };
      cdk.expires_at = cdk.external_mode_at && cdk.expires_at < promo.auto_delete_at
        ? cdk.expires_at
        : promo.auto_delete_at;
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('UPDATE cdks SET max_uses = 2147483647, use_count = use_count + 1, external_use_count')) {
      const [now, externalExpiresAt, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id));
      const active = row && row.kind === 'standard' && row.activated_at &&
        !row.deleted_at && !row.revoked_at && row.expires_at > now &&
        Number(row.external_use_count || 0) < 3;
      if (!active) return { meta: { changes: 0 } };
      row.max_uses = 2_147_483_647;
      row.use_count += 1;
      row.external_use_count = Number(row.external_use_count || 0) + 1;
      if (!row.external_mode_at) {
        row.external_mode_at = now;
        if (externalExpiresAt < row.expires_at) row.expires_at = externalExpiresAt;
      }
      row.last_used_at = now;
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('INSERT INTO cdk_checkout_audits')) {
      const [cdkId, encryptedPromoCode, promoCodeSuffix, promoSource, createdAt] = this.values;
      const cdk = this.database.rows.find((row) => row.id === Number(cdkId));
      if (!cdk || cdk.last_used_at !== createdAt || !cdk.external_mode_at) return { meta: { changes: 0 } };
      const id = this.database.nextAuditId++;
      this.database.auditRows.push({
        id,
        cdk_id: Number(cdkId),
        encrypted_promo_code: encryptedPromoCode,
        promo_code_suffix: promoCodeSuffix,
        promo_source: promoSource,
        created_at: createdAt,
      });
      return { meta: { changes: 1, last_row_id: id } };
    }

    if (this.query.startsWith('UPDATE promo_codes SET deleted_at') && this.query.includes('auto_delete_at = NULL')) {
      const [deletedAt, id] = this.values;
      const promo = this.database.promoRows.find((row) => row.id === Number(id) && !row.deleted_at);
      if (!promo) return { meta: { changes: 0 } };
      promo.deleted_at = deletedAt;
      promo.auto_delete_at = null;
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('UPDATE promo_codes SET deleted_at') && this.query.includes('auto_delete_at <= ?1')) {
      const [deletedAt] = this.values;
      const rows = this.database.promoRows.filter((row) => !row.deleted_at && row.auto_delete_at && row.auto_delete_at <= deletedAt);
      rows.forEach((row) => { row.deleted_at = deletedAt; });
      return { meta: { changes: rows.length } };
    }

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
      const admin = this.query.includes("'admin'");
      const [codeHash, codeSuffix, label, createdAt, standardExpiryOrEncrypted, standardEncrypted] = this.values;
      const expiresAt = admin ? null : standardExpiryOrEncrypted;
      const encryptedCode = admin ? standardExpiryOrEncrypted : standardEncrypted;
      const id = this.database.nextId++;
      this.database.rows.push({
        id,
        code_hash: codeHash,
        code_suffix: codeSuffix,
        label,
        kind: admin ? 'admin' : 'standard',
        max_uses: admin ? 1 : 2_147_483_647,
        use_count: 0,
        created_at: createdAt,
        activated_at: null,
        expires_at: expiresAt,
        encrypted_code: encryptedCode,
        revoked_at: null,
        deleted_at: null,
        last_used_at: null,
        external_mode_at: null,
        external_use_count: 0,
      });
      return { meta: { changes: 1, last_row_id: id } };
    }

    if (this.query.includes('SET activated_at = ?1') && this.query.includes('expires_at = MIN')) {
      const [activatedAt, expiresAt, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id));
      const activatable = row && row.kind === 'standard' && !row.activated_at && !row.deleted_at && !row.revoked_at && row.expires_at > activatedAt;
      if (!activatable) return { meta: { changes: 0 } };
      const assignment = this.database.assignmentRows.find((item) => item.cdk_id === row.id);
      const promo = assignment && this.database.promoRows.find((item) => item.id === assignment.promo_code_id);
      row.activated_at = activatedAt;
      row.expires_at = promo?.auto_delete_at && promo.auto_delete_at < expiresAt ? promo.auto_delete_at : expiresAt;
      return { meta: { changes: 1 } };
    }

    if (this.query.includes('SET use_count = use_count + 1')) {
      const [now, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id));
      const active = row && row.kind === 'standard' && row.activated_at && !row.deleted_at && !row.revoked_at && row.expires_at > now && (row.max_uses === 2_147_483_647 || row.use_count < row.max_uses);
      if (!active) return { meta: { changes: 0 } };
      row.use_count += 1;
      row.last_used_at = now;
      return { meta: { changes: 1 } };
    }

    if (this.query.includes('SET last_used_at = ?1') && this.query.includes("kind = 'admin'")) {
      const [now, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id) && item.kind === 'admin' && !item.revoked_at && !item.deleted_at);
      if (!row) return { meta: { changes: 0 } };
      row.last_used_at = now;
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith('UPDATE cdks SET deleted_at = ?1')) {
      const [deletedAt, id] = this.values;
      const row = this.database.rows.find((item) => item.id === Number(id) && !item.deleted_at);
      if (!row) return { meta: { changes: 0 } };
      row.deleted_at = deletedAt;
      row.revoked_at ||= deletedAt;
      return { meta: { changes: 1 } };
    }

    if (this.query.includes('SET revoked_at = ?1')) {
      const [revokedAt, id] = this.values;
      if (this.query.includes("WHERE kind = 'admin'")) {
        const rows = this.database.rows.filter((item) => item.kind === 'admin' && !item.revoked_at);
        rows.forEach((row) => { row.revoked_at = revokedAt; });
        return { meta: { changes: rows.length } };
      }
      const row = this.database.rows.find((item) => item.id === Number(id) && !item.revoked_at && !item.deleted_at);
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
    this.promoRows = [];
    this.assignmentRows = [];
    this.auditRows = [];
    this.nextId = 1;
    this.nextPromoId = 1;
    this.nextAuditId = 1;
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
    PROMO_ENCRYPTION_KEY: 'test-promo-encryption-secret-value',
    CDK_HASH_PEPPER: 'test-cdk-pepper-value',
    ADMIN_TOKEN: 'test-admin-token-value',
    DB: new MemoryD1(),
  };
}

test('CDK expiry migration aligns existing customer records to 24 hours or promo cleanup', () => {
  assert.match(cdkExpiryMigration, /activated_at, '\+24 hours'/);
  assert.match(cdkExpiryMigration, /p\.auto_delete_at/);
  assert.match(cdkExpiryMigration, /max_uses = 2147483647/);
});

test('external promo release migration also frees assignments held by existing restricted CDKs', () => {
  assert.match(externalPromoReleaseMigration, /DELETE FROM cdk_promo_assignments/);
  assert.match(externalPromoReleaseMigration, /external_mode_at IS NOT NULL/);
});

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
  const count = Number(overrides.count || 1);
  const promoResponse = await adminRequest(env, '/api/admin/promos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchName: 'test inventory',
      codes: Array.from({ length: count }, (_, index) =>
        `https://chatgpt.com/p/TEST${String(env.DB.nextPromoId + index).padStart(12, '0')}`
      ),
    }),
  });
  assert.equal(promoResponse.status, 201);
  const response = await adminRequest(env, '/api/admin/cdks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1, label: 'test', ...overrides }),
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

function responseCookie(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('config endpoint exposes readiness but never relay credentials', async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request('https://checkout.example/api/config'), env);
  const text = await response.text();
  const data = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(data.countries.length, 9);
  assert.deepEqual(data.seatTypes, [
    { code: 'default', name: '标准席位' },
    { code: 'prolite', name: '高级席位' },
  ]);
  assert.deepEqual(data.billingPeriods, ['month', 'year']);
  assert.deepEqual(data.pricing, {
    sourceUrl: 'https://chatgpt.com/pricing/',
    standard: { monthUsd: 25, yearUsd: 240 },
    prolite: { monthUsd: 125, yearUsd: 1200 },
    promoDiscountUsd: 25,
    promoBillingPeriods: ['month'],
    promoSeatTypes: ['default'],
  });
  assert.equal(data.cdkRequired, true);
  assert.equal(data.cdkServiceReady, true);
  assert.equal(data.countries.find((country) => country.code === 'US').proxyConfigured, true);
  assert.equal(data.countries.find((country) => country.code === 'JP').proxyConfigured, false);
  assert.equal(data.countries.find((country) => country.code === 'CL').currency, 'CLP');
  assert.equal(data.countries.find((country) => country.code === 'CL').localMonthlyAmount, 21600);
  assert.equal(data.countries.find((country) => country.code === 'CL').usdPrice, '23.35');
  assert.equal(text.includes(relayUrl), false);
  assert.equal(text.includes(relayToken), false);
  assert.equal(text.includes(env.CDK_HASH_PEPPER), false);
});

test('Relay country allowlist stays aligned with checkout countries', async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request('https://checkout.example/api/config'), env);
  const data = await response.json();
  const relaySource = await readFile(new URL('../relay/server.mjs', import.meta.url), 'utf8');
  const allowlistSource = /const ALLOWED_COUNTRIES = new Set\(\[([^\]]+)\]\)/.exec(relaySource)?.[1] || '';
  const relayCountries = [...allowlistSource.matchAll(/'([A-Z]{2})'/g)].map((match) => match[1]);

  assert.deepEqual(relayCountries, data.countries.map((country) => country.code));
});

test('exchange-rate endpoint returns only supported live USD rates', async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://open.er-api.com/v6/latest/USD');
    return new Response(JSON.stringify({
      result: 'success',
      time_last_update_unix: 1_788_134_400,
      rates: {
        USD: 1,
        EGP: 50.5,
        GBP: 0.75,
        CLP: 925,
        PHP: 58.2,
        JPY: 147.1,
        THB: 32.4,
        INR: 87.7,
        SEK: 9.45,
        EUR: 0.86,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await worker.fetch(new Request('https://checkout.example/api/exchange-rates'), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.live, true);
    assert.equal(data.base, 'USD');
    assert.equal(data.source, 'ExchangeRate-API');
    assert.equal(data.rates.CLP, 925);
    assert.equal(data.rates.EUR, undefined);
    assert.equal(Object.keys(data.rates).length, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin API requires its bearer token', async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request('https://checkout.example/api/admin/cdks'), env);
  const data = await response.json();

  assert.equal(response.status, 401);
  assert.equal(data.error, 'admin_unauthorized');
});

test('admin login creates a persistent HttpOnly session cookie accepted after refresh', async () => {
  const env = createEnv();
  const loginResponse = await worker.fetch(new Request('https://checkout.example/api/admin/session', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN },
  }), env);
  const cookie = responseCookie(loginResponse);
  assert.equal(loginResponse.status, 200);
  assert.match(cookie, /^team_admin_session=/);
  assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/);
  assert.match(loginResponse.headers.get('set-cookie'), /SameSite=Strict/);

  const sessionResponse = await worker.fetch(new Request('https://checkout.example/api/admin/session', {
    headers: { Cookie: cookie },
  }), env);
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).ok, true);

  const protectedResponse = await worker.fetch(new Request('https://checkout.example/api/admin/cdks', {
    headers: { Cookie: cookie },
  }), env);
  assert.equal(protectedResponse.status, 200);

  const logoutResponse = await worker.fetch(new Request('https://checkout.example/api/admin/session', {
    method: 'DELETE',
    headers: { Cookie: cookie },
  }), env);
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
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
        CL: 'https://user:pass@cl.proxy.example:8443',
      },
    }),
  });
  const data = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(data.savedCountries, ['US', 'CL']);
  assert.equal(env.DB.proxyRows.length, 2);
  assert.equal(env.DB.proxyRows.every((row) => row.encrypted_url.startsWith('v1.')), true);
});

test('admin normalizes encrypted promo links and reveals only the extracted code', async () => {
  const env = createEnv();
  const promo = 'chatgpt.com/p/E3NW9QBJZXKNM9ZE';
  const importResponse = await adminRequest(env, '/api/admin/promos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchName: 'global-promo-code', codes: [promo, promo] }),
  });
  const imported = await importResponse.json();

  assert.equal(importResponse.status, 201);
  assert.equal(imported.importedCount, 1);
  assert.equal(imported.scope, 'global');
  assert.equal(env.DB.promoRows.length, 1);
  assert.equal(env.DB.promoRows[0].country, 'GLOBAL');
  assert.match(env.DB.promoRows[0].encrypted_code, /^v1\./);
  assert.equal(env.DB.promoRows[0].encrypted_code.includes('E3NW9QBJZXKNM9ZE'), false);

  const listResponse = await adminRequest(env, '/api/admin/promos');
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(list.stats.available, 1);
  assert.equal(list.records[0].maskedCode.endsWith('KNM9ZE'), true);
  assert.equal(list.records[0].code, 'E3NW9QBJZXKNM9ZE');
  assert.equal(listText.includes('chatgpt.com/p/'), false);
  assert.equal('encrypted_code' in list.records[0], false);
});

test('promo inventory paginates and filters without returning every record', async () => {
  const env = createEnv();
  const codes = Array.from({ length: 25 }, (_, index) => `PAGECODE${String(index + 1).padStart(8, '0')}`);
  const importResponse = await adminRequest(env, '/api/admin/promos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchName: 'pagination', codes }),
  });
  assert.equal(importResponse.status, 201);

  const secondPageResponse = await adminRequest(env, '/api/admin/promos?limit=10&page=2&state=available');
  const secondPage = await secondPageResponse.json();
  assert.equal(secondPageResponse.status, 200);
  assert.equal(secondPage.records.length, 10);
  assert.deepEqual(secondPage.pagination, { page: 2, limit: 10, total: 25, totalPages: 3, state: 'available' });
  assert.equal(secondPage.records.every((record) => record.state === 'available'), true);
});

test('admin marks an assigned promo sold, hides its plaintext and scheduled cleanup removes it', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const promo = env.DB.promoRows[0];
  const soldResponse = await adminRequest(env, `/api/admin/promos/${promo.id}/sold`, { method: 'POST' });
  const sold = await soldResponse.json();

  assert.equal(soldResponse.status, 200);
  assert.equal(sold.sold, true);
  assert.ok(sold.autoDeleteAt);
  assert.equal(new Date(sold.autoDeleteAt) - new Date(sold.redeemedAt), 24 * 60 * 60 * 1_000);

  const repeatedResponse = await adminRequest(env, `/api/admin/promos/${promo.id}/sold`, { method: 'POST' });
  const repeated = await repeatedResponse.json();
  assert.equal(repeated.autoDeleteAt, sold.autoDeleteAt);

  const listResponse = await adminRequest(env, '/api/admin/promos?state=sold');
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(list.stats.sold, 1);
  assert.equal(list.stats.assigned, 0);
  assert.equal(list.records[0].state, 'sold');
  assert.equal(list.records[0].code.includes('•'), true);
  assert.equal(listText.includes(issued.promoCode), false);

  const cdkListResponse = await adminRequest(env, '/api/admin/cdks');
  const cdkListText = await cdkListResponse.text();
  const cdkList = JSON.parse(cdkListText);
  assert.equal(cdkList.records[0].promoLocked, true);
  assert.equal(cdkList.records[0].promoSold, true);
  assert.equal(cdkList.records[0].promoCode.includes('•'), true);
  assert.equal(cdkListText.includes(issued.promoCode), false);

  promo.auto_delete_at = new Date(Date.now() - 1_000).toISOString();
  await worker.scheduled({}, env, {});
  assert.ok(promo.deleted_at);
  const afterCleanup = await adminRequest(env, '/api/admin/promos');
  assert.equal((await afterCleanup.json()).records.length, 0);
});

test('admin can manually delete an assigned promo', async () => {
  const env = createEnv();
  await issueCdk(env);
  const response = await adminRequest(env, `/api/admin/promos/${env.DB.promoRows[0].id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.ok(env.DB.promoRows[0].deleted_at);
  assert.equal(env.DB.assignmentRows.length, 1);
  const listResponse = await adminRequest(env, '/api/admin/promos');
  assert.equal((await listResponse.json()).records.length, 0);
});

test('a manually deleted promo can be reimported as fresh inventory without a duplicate error', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const promo = env.DB.promoRows[0];
  const originalPromoId = promo.id;

  const deleteResponse = await adminRequest(env, `/api/admin/promos/${promo.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.ok(promo.deleted_at);
  assert.equal(env.DB.assignmentRows.length, 1);

  const reimportResponse = await adminRequest(env, '/api/admin/promos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchName: 'reimported', codes: [issued.promoCode] }),
  });
  const reimported = await reimportResponse.json();
  assert.equal(reimportResponse.status, 201);
  assert.equal(reimported.importedCount, 1);
  assert.equal(reimported.duplicateCount, 0);
  assert.equal(env.DB.promoRows.length, 1);
  assert.equal(env.DB.promoRows[0].id, originalPromoId);
  assert.equal(env.DB.promoRows[0].deleted_at, null);
  assert.equal(env.DB.promoRows[0].redeemed_at, null);
  assert.equal(env.DB.promoRows[0].auto_delete_at, null);
  assert.equal(env.DB.assignmentRows.length, 0);
  const listResponse = await adminRequest(env, '/api/admin/promos?state=available');
  assert.equal((await listResponse.json()).stats.available, 1);
});

test('CDK generation atomically assigns distinct global promo codes and exposes plaintext once', async () => {
  const env = createEnv();
  const promos = [
    'AAAAAAAAAAAAAAA1',
    'AAAAAAAAAAAAAAA2',
  ];
  const importResponse = await adminRequest(env, '/api/admin/promos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchName: 'assignment', codes: promos }),
  });
  assert.equal(importResponse.status, 201);

  const issueResponse = await adminRequest(env, '/api/admin/cdks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 2, maxUses: 99, expiresDays: 365 }),
  });
  const issueText = await issueResponse.text();
  const issued = JSON.parse(issueText);
  assert.equal(issueResponse.status, 201);
  assert.equal(new Set(issued.codes.map((record) => record.promoCode)).size, 2);
  assert.deepEqual(new Set(issued.codes.map((record) => record.promoCode)), new Set(promos));
  assert.equal(issued.codes.every((record) => record.maxUses === null && record.repeatable === true), true);
  assert.equal(issued.codes.every((record) => new Date(record.expiresAt) - new Date(env.DB.rows[0].created_at) === 24 * 60 * 60 * 1_000), true);
  assert.equal(env.DB.assignmentRows.length, 2);

  const listResponse = await adminRequest(env, '/api/admin/cdks?limit=20');
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(list.records.every((record) => record.kind === 'standard'), true);
  assert.equal(list.records.every((record) => record.maxUses === null && record.repeatable === true), true);
  assert.equal(list.records.every((record) => record.state === 'pending'), true);
  assert.equal(listText.includes('AAAAAAAAAAAAAAA1'), true);
  assert.equal(listText.includes('AAAAAAAAAAAAAAA2'), true);
  assert.equal(list.records.every((record) => record.legacyCode === false), true);
  assert.equal(env.DB.rows.every((record) => record.encrypted_code.startsWith('v1.')), true);
  assert.equal(env.DB.rows.some((record) => issued.codes.some((item) => record.encrypted_code.includes(item.code))), false);
});

test('CDK generation fails without partially creating records when promo inventory is insufficient', async () => {
  const env = createEnv();
  const response = await adminRequest(env, '/api/admin/cdks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 2 }),
  });
  const data = await response.json();

  assert.equal(response.status, 409);
  assert.equal(data.error, 'promo_inventory_insufficient');
  assert.equal(data.available, 0);
  assert.equal(env.DB.rows.length, 0);
  assert.equal(env.DB.assignmentRows.length, 0);
});

test('admin can visualize and revoke a CDK while D1 stores only ciphertext', async () => {
  const env = createEnv();
  const issued = await issueCdk(env, { label: '客户 A' });
  assert.match(issued.code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);

  const listResponse = await adminRequest(env, '/api/admin/cdks?limit=20');
  const listText = await listResponse.text();
  const list = JSON.parse(listText);
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].maskedCode.endsWith(issued.code.slice(-4)), true);
  assert.equal(list.records[0].label, '客户 A');
  assert.equal(list.records[0].code, issued.code);
  assert.equal(list.records[0].legacyCode, false);
  assert.equal(listText.includes(issued.code), true);
  assert.equal(env.DB.rows[0].encrypted_code.includes(issued.code), false);

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

test('admin can delete a CDK without releasing its assigned promo', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const deleteResponse = await adminRequest(env, `/api/admin/cdks/${issued.id}/delete`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.ok(env.DB.rows[0].deleted_at);
  assert.equal(env.DB.assignmentRows.length, 1);

  const listResponse = await adminRequest(env, '/api/admin/cdks');
  assert.equal((await listResponse.json()).records.length, 0);
  const verifyResponse = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdk: issued.code }),
  }), env);
  assert.equal(verifyResponse.status, 401);
  assert.equal((await verifyResponse.json()).error, 'cdk_invalid');
});

test('CDK verification activates a 24-hour repeatable window without consuming a use', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const response = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code.toLowerCase().replaceAll('-', ' ') }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.kind, 'standard');
  assert.equal(data.unlimited, false);
  assert.equal(data.repeatable, true);
  assert.equal(data.remainingUses, null);
  assert.equal(env.DB.rows[0].use_count, 0);
  assert.ok(env.DB.rows[0].activated_at);
  assert.equal(new Date(data.expiresAt) - new Date(data.activatedAt), 24 * 60 * 60 * 1_000);
  assert.equal('code' in data, false);
});

test('old active customer CDKs are repaired to the new 24-hour lifetime on verification', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code }),
  }), env);

  const activatedAt = new Date(Date.now() - 4 * 60 * 60 * 1_000).toISOString();
  env.DB.rows[0].activated_at = activatedAt;
  env.DB.rows[0].expires_at = new Date(Date.now() - 60 * 60 * 1_000).toISOString();

  const response = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.expiresAt, new Date(new Date(activatedAt).getTime() + 24 * 60 * 60 * 1_000).toISOString());
  assert.equal(env.DB.rows[0].expires_at, data.expiresAt);
});

test('admin CDK list aligns old customer CDKs with an assigned promo cleanup deadline', async () => {
  const env = createEnv();
  await issueCdk(env);
  env.DB.rows[0].activated_at = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  env.DB.rows[0].expires_at = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
  env.DB.promoRows[0].auto_delete_at = new Date(Date.now() + 20 * 60 * 60 * 1_000).toISOString();

  const response = await adminRequest(env, '/api/admin/cdks?limit=20');
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.records[0].expiresAt, env.DB.promoRows[0].auto_delete_at);
  assert.equal(env.DB.rows[0].expires_at, env.DB.promoRows[0].auto_delete_at);
});

test('a promo already on its 24-hour clock caps its linked CDK at the same expiry', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const soldResponse = await adminRequest(env, `/api/admin/promos/${env.DB.promoRows[0].id}/sold`, { method: 'POST' });
  const sold = await soldResponse.json();
  const verifyResponse = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code }),
  }), env);
  const verification = await verifyResponse.json();

  assert.equal(soldResponse.status, 200);
  assert.equal(verifyResponse.status, 200);
  assert.equal(verification.expiresAt, sold.autoDeleteAt);
  assert.equal(env.DB.rows[0].expires_at, sold.autoDeleteAt);
});

test('an active CDK session survives refresh and can create checkout without resending plaintext CDK', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const verifyResponse = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: issued.code }),
  }), env);
  const cookie = responseCookie(verifyResponse);
  assert.equal(verifyResponse.status, 200);
  assert.match(cookie, /^team_cdk_session=/);
  assert.match(verifyResponse.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(cookie.includes(issued.code), false);

  const refreshedSession = await worker.fetch(new Request('https://checkout.example/api/cdk/session', {
    headers: { Cookie: cookie },
  }), env);
  const refreshed = await refreshedSession.json();
  assert.equal(refreshedSession.status, 200);
  assert.equal(refreshed.repeatable, true);
  assert.equal(refreshed.useCount, 0);

  const originalFetch = globalThis.fetch;
  let checkoutPayload;
  globalThis.fetch = async (_url, init) => {
    checkoutPayload = JSON.parse(JSON.parse(init.body).body);
    return new Response(JSON.stringify({ checkout_session_id: 'oaics_cookie_session' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const checkoutResponse = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        accessToken: 'eyJ' + 'a'.repeat(80),
        country: 'US',
        promoCode: issued.promoCode,
        seatDefault: 2,
        seatProlite: 0,
        billingPeriod: 'month',
      }),
    }), env);
    const checkout = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 200);
    assert.equal(checkout.cdkUseCount, 1);
    assert.equal(checkoutPayload.promo_code, issued.promoCode);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin universal CDK is reusable, consumes no promo and rotates the previous code', async () => {
  const env = createEnv();
  const firstResponse = await adminRequest(env, '/api/admin/cdks/universal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const first = (await firstResponse.json()).code;
  assert.equal(firstResponse.status, 201);
  assert.equal(first.kind, 'admin');
  assert.equal(first.unlimited, true);
  assert.equal(first.promoCode, '');
  assert.equal(env.DB.assignmentRows.length, 0);

  const originalFetch = globalThis.fetch;
  let checkoutCalls = 0;
  const checkoutPayloads = [];
  globalThis.fetch = async (_url, init) => {
    checkoutCalls += 1;
    const envelope = JSON.parse(init.body);
    checkoutPayloads.push(JSON.parse(envelope.body));
    return new Response(JSON.stringify({ checkout_session_id: `oaics_admin_${checkoutCalls}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cdk: first.code,
          accessToken: 'eyJ' + 'z'.repeat(80),
          country: 'US',
          promoCode: 'EXTERNALADMINPROMO9999',
          seatQuantity: 2,
        }),
      }), env);
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.cdkRemainingUses, null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(checkoutCalls, 2);
  assert.equal(checkoutPayloads.every((payload) => payload.promo_code === 'EXTERNALADMINPROMO9999'), true);
  assert.equal(env.DB.promoRows.length, 0);
  assert.equal(env.DB.rows[0].use_count, 0);
  assert.ok(env.DB.rows[0].last_used_at);

  const secondResponse = await adminRequest(env, '/api/admin/cdks/universal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const second = (await secondResponse.json()).code;
  assert.equal(secondResponse.status, 201);
  assert.notEqual(second.code, first.code);
  assert.ok(env.DB.rows[0].revoked_at);
  assert.equal(env.DB.rows[1].revoked_at, null);

  const oldVerify = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdk: first.code }),
  }), env);
  const newVerify = await worker.fetch(new Request('https://checkout.example/api/cdk/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdk: second.code }),
  }), env);
  assert.equal(oldVerify.status, 403);
  assert.equal((await oldVerify.json()).error, 'cdk_revoked');
  assert.equal(newVerify.status, 200);
  assert.equal((await newVerify.json()).unlimited, true);
});

test('checkout reuses a CDK for country changes, marks its registered promo sold and enforces currency', async () => {
  const env = createEnv(['US', 'JP']);
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
        promoCode: issued.promoCode,
        seatDefault: 5,
        seatProlite: 1,
        billingPeriod: 'month',
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
    assert.equal(data.cdkRemainingUses, null);
    assert.equal(data.cdkRepeatable, true);
    assert.equal(data.cdkUseCount, 1);
    assert.equal(data.promoCleanupScheduled, true);
    assert.equal(data.cdkExpiresAt, data.promoAutoDeleteAt);
    assert.equal(env.DB.rows[0].expires_at, env.DB.promoRows[0].auto_delete_at);
    assert.match(response.headers.get('set-cookie') || '', /^team_cdk_session=/);
    assert.equal(env.DB.rows[0].use_count, 1);
    assert.ok(env.DB.promoRows[0].redeemed_at);
    assert.ok(env.DB.promoRows[0].auto_delete_at);
    const firstAutoDeleteAt = env.DB.promoRows[0].auto_delete_at;
    assert.equal(capturedUrl, relayUrl);
    assert.equal(capturedInit.headers.Authorization, 'Bearer ' + relayToken);
    assert.equal(capturedInit.headers['X-Relay-Country'], 'US');
    assert.equal(envelope.target, 'https://chatgpt.com/backend-api/payments/checkout');
    assert.equal(envelope.headers.Authorization.startsWith('Bearer eyJ'), true);
    assert.equal('proxyUrl' in envelope, false);
    assert.deepEqual(checkoutPayload.billing_details, { country: 'US', currency: 'USD' });
    assert.equal(checkoutPayload.team_plan_data.seat_quantity, 6);
    assert.deepEqual(checkoutPayload.team_plan_data.seat_quantities, [
      { seat_type: 'default', quantity: 5 },
      { seat_type: 'prolite', quantity: 1 },
    ]);
    assert.equal(checkoutPayload.team_plan_data.price_interval, 'month');
    assert.equal(data.seatDefault, 5);
    assert.equal(data.seatProlite, 1);
    assert.equal(data.seatQuantity, 6);
    assert.equal(data.billingPeriod, 'month');

    const secondResponse = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'a'.repeat(80),
        country: 'JP',
        promoCode: issued.promoCode,
        seatDefault: 1,
        seatProlite: 1,
        billingPeriod: 'month',
      }),
    }), env);
    const secondData = await secondResponse.json();
    const secondCheckoutPayload = JSON.parse(JSON.parse(capturedInit.body).body);
    assert.equal(secondResponse.status, 200);
    assert.equal(secondData.country, 'JP');
    assert.equal(secondData.currency, 'JPY');
    assert.equal(secondData.cdkUseCount, 2);
    assert.equal(env.DB.rows[0].use_count, 2);
    assert.equal(env.DB.promoRows[0].auto_delete_at, firstAutoDeleteAt);
    assert.equal(secondData.cdkExpiresAt, firstAutoDeleteAt);
    assert.equal(secondCheckoutPayload.promo_code, issued.promoCode);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('customer CDK using an external promo is limited to three successful checkouts in three hours and audited for admin', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  let checkoutCalls = 0;
  globalThis.fetch = async () => {
    checkoutCalls += 1;
    return new Response(JSON.stringify({ checkout_session_id: `oaics_external_${checkoutCalls}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const request = () => worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.31' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'x'.repeat(80),
        country: 'US',
        promoCode: 'EXTERNALPROMO9999',
        seatQuantity: 2,
      }),
    }), env);

    const firstResponse = await request();
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.cdkUseCount, 1);
    assert.equal('externalMode' in first, false);
    assert.equal('externalUseCount' in first, false);
    assert.equal('checkoutAudits' in first, false);
    assert.equal(new Date(env.DB.rows[0].expires_at) - new Date(env.DB.rows[0].external_mode_at), 3 * 60 * 60 * 1_000);
    assert.equal(env.DB.assignmentRows.length, 0);
    assert.equal(env.DB.promoRows[0].auto_delete_at, null);

    const releasedInventoryResponse = await adminRequest(env, '/api/admin/promos?page=1&limit=20&state=available');
    const releasedInventory = await releasedInventoryResponse.json();
    assert.equal(releasedInventoryResponse.status, 200);
    assert.equal(releasedInventory.stats.available, 1);
    assert.equal(releasedInventory.stats.assigned, 0);
    assert.equal(releasedInventory.records[0].state, 'available');

    assert.equal((await request()).status, 200);
    const thirdResponse = await request();
    assert.equal(thirdResponse.status, 200);
    assert.match(thirdResponse.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal(env.DB.rows[0].external_use_count, 3);
    assert.equal(env.DB.rows[0].use_count, 3);
    assert.equal(env.DB.auditRows.length, 3);
    assert.equal(env.DB.auditRows.every((row) => row.promo_source === 'external'), true);
    assert.equal(env.DB.auditRows.some((row) => row.encrypted_promo_code.includes('EXTERNALPROMO9999')), false);

    const fourthResponse = await request();
    assert.equal(fourthResponse.status, 403);
    assert.equal((await fourthResponse.json()).error, 'cdk_exhausted');
    assert.equal(checkoutCalls, 3);

    const listResponse = await adminRequest(env, '/api/admin/cdks?limit=20');
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.records[0].externalMode, true);
    assert.equal(list.records[0].externalUseCount, 3);
    assert.equal(list.records[0].externalUseLimit, 3);
    assert.equal(list.records[0].promoCode, '');
    assert.equal(list.records[0].checkoutAudits.length, 3);
    assert.equal(list.records[0].checkoutAudits.every((audit) => audit.promoCode === 'EXTERNALPROMO9999'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed upstream checkout with an external promo does not start its restricted window or consume a use', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.32' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'f'.repeat(80),
        country: 'US',
        promoCode: 'EXTERNALFAILED9999',
        seatQuantity: 2,
      }),
    }), env);
    assert.equal(response.status, 502);
    assert.equal(env.DB.rows[0].external_mode_at, null);
    assert.equal(env.DB.rows[0].external_use_count, 0);
    assert.equal(env.DB.rows[0].use_count, 0);
    assert.equal(env.DB.auditRows.length, 0);
    assert.equal(env.DB.assignmentRows.length, 1);
    assert.equal(env.DB.assignmentRows[0].cdk_id, env.DB.rows[0].id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a registered promo not assigned to the customer CDK still switches modes and releases its original promo', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const customerPromo = 'CUSTOMEROWNPROMO9999';
  const importResponse = await adminRequest(env, '/api/admin/promos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchName: 'customer supplied', codes: [customerPromo] }),
  });
  assert.equal(importResponse.status, 201);
  assert.equal(env.DB.assignmentRows.length, 1);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ checkout_session_id: 'oaics_customer_own' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.33' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'r'.repeat(80),
        country: 'US',
        promoCode: customerPromo,
        seatQuantity: 2,
      }),
    }), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.promoCleanupScheduled, false);
    assert.equal(data.promoSold, false);
    assert.ok(env.DB.rows[0].external_mode_at);
    assert.equal(env.DB.rows[0].external_use_count, 1);
    assert.equal(env.DB.assignmentRows.length, 0);
    assert.equal(env.DB.promoRows.every((promo) => promo.auto_delete_at === null), true);
    assert.equal(env.DB.auditRows.length, 1);
    assert.equal(env.DB.auditRows[0].promo_source, 'registered');

    const inventoryResponse = await adminRequest(env, '/api/admin/promos?page=1&limit=20&state=available');
    const inventory = await inventoryResponse.json();
    assert.equal(inventory.stats.available, 2);
    assert.equal(inventory.stats.assigned, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a legacy one-use customer CDK upgrades to the three-use rule when it switches to customer-promo mode', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  env.DB.rows[0].max_uses = 1;
  const originalFetch = globalThis.fetch;
  let checkoutCalls = 0;
  globalThis.fetch = async () => {
    checkoutCalls += 1;
    return new Response(JSON.stringify({ checkout_session_id: `oaics_legacy_external_${checkoutCalls}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const request = () => worker.fetch(new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.34' },
    body: JSON.stringify({
      cdk: issued.code,
      accessToken: 'eyJ' + 'g'.repeat(80),
      country: 'US',
      promoCode: 'LEGACYCUSTOMERPROMO99',
      seatQuantity: 2,
    }),
  }), env);
  try {
    assert.equal((await request()).status, 200);
    assert.equal(env.DB.rows[0].max_uses, 2_147_483_647);
    assert.equal(env.DB.rows[0].external_use_count, 1);
    assert.equal(env.DB.assignmentRows.length, 0);
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 200);
    const exhausted = await request();
    assert.equal(exhausted.status, 403);
    assert.equal((await exhausted.json()).error, 'cdk_exhausted');
    assert.equal(checkoutCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy one-use CDKs keep their original exhaustion rule after migration', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  env.DB.rows[0].max_uses = 1;
  env.DB.rows[0].activated_at = env.DB.rows[0].created_at;
  env.DB.rows[0].expires_at = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const originalFetch = globalThis.fetch;
  let checkoutCalls = 0;
  globalThis.fetch = async () => {
    checkoutCalls += 1;
    return new Response(JSON.stringify({ checkout_session_id: `oaics_legacy_${checkoutCalls}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const request = () => worker.fetch(new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cdk: issued.code,
      accessToken: 'eyJ' + 'l'.repeat(80),
      country: 'US',
      promoCode: issued.promoCode,
      seatQuantity: 2,
    }),
  }), env);
  try {
    const first = await request();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).cdkRemainingUses, 0);
    const second = await request();
    assert.equal(second.status, 403);
    assert.equal((await second.json()).error, 'cdk_exhausted');
    assert.equal(checkoutCalls, 1);
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
        promoCode: issued.promoCode,
        seatQuantity: 2,
      }),
    }), env);
    const data = await response.json();
    const envelope = JSON.parse(capturedInit.body);
    const checkoutPayload = JSON.parse(envelope.body);

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(envelope.proxyUrl, dynamicProxyUrl + '/');
    assert.equal(checkoutPayload.team_plan_data.seat_quantity, 2);
    assert.deepEqual(checkoutPayload.team_plan_data.seat_quantities, [
      { seat_type: 'default', quantity: 2 },
      { seat_type: 'prolite', quantity: 0 },
    ]);
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

test('checkout rejects unsupported seat types without consuming a CDK', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cdk: issued.code,
      accessToken: 'eyJ' + 'a'.repeat(80),
      country: 'US',
      seatQuantity: 2,
      seatType: 'enterprise',
    }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.error, 'invalid_seat_type');
  assert.deepEqual(data.supportedSeatTypes, ['default', 'prolite']);
  assert.equal(env.DB.rows[0].use_count, 0);
});

test('checkout requires standard and advanced seats to total at least two', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cdk: issued.code,
      accessToken: 'eyJ' + 'a'.repeat(80),
      country: 'US',
      seatDefault: 1,
      seatProlite: 0,
      billingPeriod: 'month',
    }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.error, 'invalid_seat_quantity');
  assert.equal(env.DB.rows[0].use_count, 0);
});

test('checkout rejects unsupported billing periods without consuming a CDK', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cdk: issued.code,
      accessToken: 'eyJ' + 'a'.repeat(80),
      country: 'US',
      seatDefault: 2,
      seatProlite: 0,
      billingPeriod: 'quarter',
    }),
  }), env);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.error, 'invalid_billing_period');
  assert.deepEqual(data.supportedBillingPeriods, ['month', 'year']);
  assert.equal(env.DB.rows[0].use_count, 0);
});

test('checkout rejects promo codes for annual billing before CDK consumption or upstream calls', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  let checkoutCalls = 0;
  globalThis.fetch = async () => {
    checkoutCalls += 1;
    return new Response('{}', { status: 500 });
  };
  try {
    const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'a'.repeat(80),
        country: 'US',
        promoCode: issued.promoCode,
        seatDefault: 2,
        seatProlite: 0,
        billingPeriod: 'year',
      }),
    }), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'promo_not_available_for_annual');
    assert.equal(env.DB.rows[0].use_count, 0);
    assert.equal(checkoutCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout rejects promo codes for advanced-only orders before CDK consumption or upstream calls', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  let checkoutCalls = 0;
  globalThis.fetch = async () => {
    checkoutCalls += 1;
    return new Response('{}', { status: 500 });
  };
  try {
    const response = await worker.fetch(new Request('https://checkout.example/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cdk: issued.code,
        accessToken: 'eyJ' + 'a'.repeat(80),
        country: 'US',
        promoCode: issued.promoCode,
        seatDefault: 0,
        seatProlite: 2,
        billingPeriod: 'month',
      }),
    }), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'promo_requires_standard_seat');
    assert.equal(env.DB.rows[0].use_count, 0);
    assert.equal(checkoutCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout keeps official annual billing payloads available when no promo code is used', async () => {
  const env = createEnv();
  const issued = await issueCdk(env);
  const originalFetch = globalThis.fetch;
  let checkoutPayload;
  globalThis.fetch = async (_url, init) => {
    const envelope = JSON.parse(init.body);
    checkoutPayload = JSON.parse(envelope.body);
    return new Response(JSON.stringify({ checkout_session_id: 'oaics_annual_mixed' }), {
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
        accessToken: 'eyJ' + 'a'.repeat(80),
        country: 'US',
        promoCode: '',
        seatDefault: 5,
        seatProlite: 1,
        billingPeriod: 'year',
      }),
    }), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.billingPeriod, 'year');
    assert.equal(data.promoSold, false);
    assert.equal(checkoutPayload.team_plan_data.price_interval, 'year');
    assert.equal(checkoutPayload.team_plan_data.seat_quantity, 6);
    assert.deepEqual(checkoutPayload.team_plan_data.seat_quantities, [
      { seat_type: 'default', quantity: 5 },
      { seat_type: 'prolite', quantity: 1 },
    ]);
    assert.equal('promo_code' in checkoutPayload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
