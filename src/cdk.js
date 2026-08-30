import { decryptPromoForAdmin, assignedPromoForCdkHash, availablePromoCount } from './promo-codes.js';
import { decryptValue, encryptValue } from './encrypted-values.js';

const CDK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CDK_GROUPS = 4;
const CDK_GROUP_LENGTH = 4;
const MAX_BATCH_SIZE = 50;
const STANDARD_CDK_MAX_USES = 1;
const STANDARD_CDK_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CDK_KIND_STANDARD = 'standard';
const CDK_KIND_ADMIN = 'admin';

export function normalizeCdk(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== CDK_GROUPS * CDK_GROUP_LENGTH) return '';
  const groups = [];
  for (let index = 0; index < compact.length; index += CDK_GROUP_LENGTH) {
    groups.push(compact.slice(index, index + CDK_GROUP_LENGTH));
  }
  return groups.join('-');
}

export async function hashCdk(value, pepper) {
  const normalized = normalizeCdk(value);
  if (!normalized || !pepper) return '';
  const bytes = new TextEncoder().encode(String(pepper) + ':' + normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomCdk() {
  const values = new Uint8Array(CDK_GROUPS * CDK_GROUP_LENGTH);
  crypto.getRandomValues(values);
  let compact = '';
  for (const value of values) compact += CDK_ALPHABET[value % CDK_ALPHABET.length];
  return normalizeCdk(compact);
}

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number(value == null || value === '' ? fallback : value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function databaseReady(env) {
  return Boolean(env?.DB && env?.CDK_HASH_PEPPER);
}

function visualEncryptionReady(env) {
  return Boolean(databaseReady(env) && env?.PROMO_ENCRYPTION_KEY);
}

function rowKind(row) {
  return row?.kind === CDK_KIND_ADMIN ? CDK_KIND_ADMIN : CDK_KIND_STANDARD;
}

function recordState(row, now = new Date()) {
  if (row.revoked_at) return 'revoked';
  if (rowKind(row) === CDK_KIND_ADMIN) return 'active';
  if (row.expires_at && new Date(row.expires_at) <= now) return 'expired';
  if (Number(row.use_count) >= Number(row.max_uses)) return 'exhausted';
  return 'active';
}

function publicRecord(row, now = new Date(), revealedCode = '', revealedPromo = '') {
  const kind = rowKind(row);
  const maxUses = Number(row.max_uses);
  const useCount = Number(row.use_count);
  const unlimited = kind === CDK_KIND_ADMIN;
  return {
    id: Number(row.id),
    maskedCode: '••••-••••-••••-' + row.code_suffix,
    code: revealedCode || '••••-••••-••••-' + row.code_suffix,
    legacyCode: !revealedCode,
    label: row.label || '',
    kind,
    unlimited,
    maxUses: unlimited ? null : maxUses,
    useCount,
    remainingUses: unlimited ? null : Math.max(0, maxUses - useCount),
    createdAt: row.created_at,
    expiresAt: unlimited ? '' : (row.expires_at || ''),
    revokedAt: row.revoked_at || '',
    lastUsedAt: row.last_used_at || '',
    promoCode: revealedPromo || (row.promo_suffix ? '••••••' + row.promo_suffix : ''),
    state: recordState(row, now),
  };
}

function unavailableResult() {
  return { ok: false, error: 'cdk_service_not_configured' };
}

function resultFromRecord(row, now = new Date()) {
  if (!row) return { ok: false, error: 'cdk_invalid' };
  const state = recordState(row, now);
  if (state !== 'active') return { ok: false, error: 'cdk_' + state };
  const record = publicRecord(row, now);
  return {
    ok: true,
    id: record.id,
    label: record.label,
    kind: record.kind,
    unlimited: record.unlimited,
    maxUses: record.maxUses,
    useCount: record.useCount,
    remainingUses: record.remainingUses,
    expiresAt: record.expiresAt,
  };
}

const CDK_SELECT_COLUMNS = `id, code_suffix, label, kind, max_uses, use_count,
  created_at, expires_at, revoked_at, last_used_at`;

export async function verifyCdk(value, env, options = {}) {
  if (!databaseReady(env)) return unavailableResult();
  const normalized = normalizeCdk(value);
  if (!normalized) return { ok: false, error: 'cdk_invalid_format' };
  const codeHash = await hashCdk(normalized, env.CDK_HASH_PEPPER);
  const now = new Date();
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `SELECT ${CDK_SELECT_COLUMNS} FROM cdks WHERE code_hash = ?1 LIMIT 1`
  ).bind(codeHash).first();
  const current = resultFromRecord(row, now);
  if (!current.ok || !options.consume) return current;

  if (current.unlimited) {
    const update = await env.DB.prepare(
      `UPDATE cdks SET last_used_at = ?1
       WHERE id = ?2 AND kind = 'admin' AND revoked_at IS NULL`
    ).bind(nowIso, row.id).run();
    if (Number(update?.meta?.changes || 0) === 1) return current;
  } else {
    const update = await env.DB.prepare(
      `UPDATE cdks
       SET use_count = use_count + 1, last_used_at = ?1
       WHERE id = ?2
         AND kind = 'standard'
         AND revoked_at IS NULL
         AND expires_at > ?1
         AND use_count < max_uses`
    ).bind(nowIso, row.id).run();
    if (Number(update?.meta?.changes || 0) === 1) {
      return { ...current, useCount: current.useCount + 1, remainingUses: 0 };
    }
  }

  const latest = await env.DB.prepare(
    `SELECT ${CDK_SELECT_COLUMNS} FROM cdks WHERE id = ?1 LIMIT 1`
  ).bind(row.id).first();
  return resultFromRecord(latest, new Date());
}

export async function createCdks(input, env) {
  if (!visualEncryptionReady(env)) return unavailableResult();
  const count = parsePositiveInteger(input?.count, 1, MAX_BATCH_SIZE);
  if (count == null) return { ok: false, error: 'invalid_cdk_count', max: MAX_BATCH_SIZE };

  const inventory = await availablePromoCount(env);
  if (!inventory.ok) return inventory;
  if (inventory.available < count) {
    return { ok: false, error: 'promo_inventory_insufficient', available: inventory.available, required: count };
  }

  const label = String(input?.label || '').trim().slice(0, 80);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(new Date(createdAt).getTime() + STANDARD_CDK_LIFETIME_MS).toISOString();
  const generated = [];
  const statements = [];

  for (let index = 0; index < count; index += 1) {
    const code = randomCdk();
    const codeHash = await hashCdk(code, env.CDK_HASH_PEPPER);
    const encryptedCode = await encryptValue(code, env.PROMO_ENCRYPTION_KEY, 'cdk:' + CDK_KIND_STANDARD);
    generated.push({ code, codeHash, encryptedCode });
    statements.push(
      env.DB.prepare(
        `INSERT INTO cdks
         (code_hash, code_suffix, label, kind, max_uses, use_count, created_at, expires_at, encrypted_code)
         VALUES (?1, ?2, ?3, 'standard', 1, 0, ?4, ?5, ?6)`
      ).bind(codeHash, code.slice(-4), label, createdAt, expiresAt, encryptedCode)
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO cdk_promo_assignments (cdk_id, promo_code_id, assigned_at)
         VALUES (
           (SELECT id FROM cdks WHERE code_hash = ?1 LIMIT 1),
           (
             SELECT p.id FROM promo_codes p
             WHERE p.deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM cdk_promo_assignments a WHERE a.promo_code_id = p.id
               )
             ORDER BY p.id ASC LIMIT 1
           ),
           ?2
         )`
      ).bind(codeHash, createdAt)
    );
  }

  const insertResults = await env.DB.batch(statements);
  const assignments = await Promise.all(generated.map((item) => assignedPromoForCdkHash(item.codeHash, env)));
  const failedAssignment = assignments.find((assignment) => !assignment.ok);
  if (failedAssignment) return failedAssignment;
  return {
    ok: true,
    codes: generated.map((item, index) => ({
      id: Number(insertResults[index * 2]?.meta?.last_row_id || assignments[index].cdkId || 0),
      code: item.code,
      label,
      kind: CDK_KIND_STANDARD,
      unlimited: false,
      maxUses: STANDARD_CDK_MAX_USES,
      expiresAt,
      promoCode: assignments[index].promoCode,
    })),
  };
}

export async function createAdminCdk(input, env) {
  if (!visualEncryptionReady(env)) return unavailableResult();
  const code = randomCdk();
  const codeHash = await hashCdk(code, env.CDK_HASH_PEPPER);
  const encryptedCode = await encryptValue(code, env.PROMO_ENCRYPTION_KEY, 'cdk:' + CDK_KIND_ADMIN);
  const label = String(input?.label || '管理员通用 CDK').trim().slice(0, 80) || '管理员通用 CDK';
  const createdAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cdks SET revoked_at = ?1 WHERE kind = 'admin' AND revoked_at IS NULL`
    ).bind(createdAt),
    env.DB.prepare(
      `INSERT INTO cdks
       (code_hash, code_suffix, label, kind, max_uses, use_count, created_at, expires_at, encrypted_code)
       VALUES (?1, ?2, ?3, 'admin', 1, 0, ?4, NULL, ?5)`
    ).bind(codeHash, code.slice(-4), label, createdAt, encryptedCode),
  ]);
  return {
    ok: true,
    code: {
      id: Number(results[1]?.meta?.last_row_id || 0),
      code,
      label,
      kind: CDK_KIND_ADMIN,
      unlimited: true,
      maxUses: null,
      expiresAt: '',
      promoCode: '',
    },
  };
}

export async function listCdks(env, limitValue = 200) {
  if (!visualEncryptionReady(env)) return unavailableResult();
  const limit = parsePositiveInteger(limitValue, 200, 500) || 200;
  const result = await env.DB.prepare(
    `SELECT c.id, c.code_suffix, c.encrypted_code, c.label, c.kind, c.max_uses, c.use_count, c.created_at,
            c.expires_at, c.revoked_at, c.last_used_at, p.code_suffix AS promo_suffix,
            p.encrypted_code AS promo_encrypted_code, p.country AS promo_scope
     FROM cdks c
     LEFT JOIN cdk_promo_assignments a ON a.cdk_id = c.id
     LEFT JOIN promo_codes p ON p.id = a.promo_code_id
     ORDER BY c.id DESC LIMIT ?1`
  ).bind(limit).all();
  const now = new Date();
  const records = await Promise.all((result?.results || []).map(async (row) => {
    let revealedCode = '';
    if (row.encrypted_code) {
      try {
        revealedCode = normalizeCdk(await decryptValue(
          row.encrypted_code,
          env.PROMO_ENCRYPTION_KEY,
          'cdk:' + rowKind(row)
        ));
      } catch {
        revealedCode = '';
      }
    }
    const revealedPromo = await decryptPromoForAdmin(
      row.promo_encrypted_code,
      row.promo_scope,
      env
    );
    return publicRecord(row, now, revealedCode, revealedPromo);
  }));
  return {
    ok: true,
    records,
    stats: records.reduce(
      (stats, record) => {
        stats.total += 1;
        stats[record.state] += 1;
        stats[record.kind] += 1;
        return stats;
      },
      { total: 0, active: 0, exhausted: 0, expired: 0, revoked: 0, standard: 0, admin: 0 }
    ),
  };
}

export async function revokeCdk(idValue, env) {
  if (!databaseReady(env)) return unavailableResult();
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_cdk_id' };
  const revokedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE cdks SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`
  ).bind(revokedAt, id).run();
  if (Number(result?.meta?.changes || 0) !== 1) return { ok: false, error: 'cdk_not_found_or_revoked' };
  return { ok: true, id, revokedAt };
}
