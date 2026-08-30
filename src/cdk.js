import { assignedPromoForCdkHash, availablePromoCount } from './promo-codes.js';

const CDK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CDK_GROUPS = 4;
const CDK_GROUP_LENGTH = 4;
const MAX_BATCH_SIZE = 50;
const MAX_CDK_USES = 100_000;
const MAX_EXPIRY_DAYS = 3_650;

export function normalizeCdk(value) {
  const compact = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
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

function parseExpiryDays(value) {
  const parsed = Number(value == null || value === '' ? 30 : value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_EXPIRY_DAYS ? parsed : null;
}

function databaseReady(env) {
  return Boolean(env?.DB && env?.CDK_HASH_PEPPER);
}

function recordState(row, now = new Date()) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at) <= now) return 'expired';
  if (Number(row.use_count) >= Number(row.max_uses)) return 'exhausted';
  return 'active';
}

function publicRecord(row, now = new Date()) {
  const maxUses = Number(row.max_uses);
  const useCount = Number(row.use_count);
  return {
    id: Number(row.id),
    maskedCode: '••••-••••-••••-' + row.code_suffix,
    label: row.label || '',
    maxUses,
    useCount,
    remainingUses: Math.max(0, maxUses - useCount),
    createdAt: row.created_at,
    expiresAt: row.expires_at || '',
    revokedAt: row.revoked_at || '',
    lastUsedAt: row.last_used_at || '',
    promoCountry: row.promo_country || '',
    promoCode: row.promo_suffix ? 'chatgpt.com/p/••••••' + row.promo_suffix : '',
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
    maxUses: record.maxUses,
    useCount: record.useCount,
    remainingUses: record.remainingUses,
    expiresAt: record.expiresAt,
  };
}

export async function verifyCdk(value, env, options = {}) {
  if (!databaseReady(env)) return unavailableResult();
  const normalized = normalizeCdk(value);
  if (!normalized) return { ok: false, error: 'cdk_invalid_format' };
  const codeHash = await hashCdk(normalized, env.CDK_HASH_PEPPER);
  const now = new Date();
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `SELECT id, code_suffix, label, max_uses, use_count, created_at, expires_at, revoked_at, last_used_at
     FROM cdks WHERE code_hash = ?1 LIMIT 1`
  ).bind(codeHash).first();
  const current = resultFromRecord(row, now);
  if (!current.ok || !options.consume) return current;

  const update = await env.DB.prepare(
    `UPDATE cdks
     SET use_count = use_count + 1, last_used_at = ?1
     WHERE id = ?2
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?1)
       AND use_count < max_uses`
  ).bind(nowIso, row.id).run();
  if (Number(update?.meta?.changes || 0) !== 1) {
    const latest = await env.DB.prepare(
      `SELECT id, code_suffix, label, max_uses, use_count, created_at, expires_at, revoked_at, last_used_at
       FROM cdks WHERE id = ?1 LIMIT 1`
    ).bind(row.id).first();
    return resultFromRecord(latest, new Date());
  }

  return {
    ...current,
    useCount: current.useCount + 1,
    remainingUses: Math.max(0, current.remainingUses - 1),
  };
}

export async function createCdks(input, env) {
  if (!databaseReady(env)) return unavailableResult();
  const count = parsePositiveInteger(input?.count, 1, MAX_BATCH_SIZE);
  const maxUses = parsePositiveInteger(input?.maxUses, 10, MAX_CDK_USES);
  const expiresDays = parseExpiryDays(input?.expiresDays);
  if (count == null) return { ok: false, error: 'invalid_cdk_count', max: MAX_BATCH_SIZE };
  if (maxUses == null) return { ok: false, error: 'invalid_cdk_max_uses', max: MAX_CDK_USES };
  if (expiresDays == null) return { ok: false, error: 'invalid_cdk_expiry_days', max: MAX_EXPIRY_DAYS };

  const promoCountry = String(input?.promoCountry || 'GB').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(promoCountry)) return { ok: false, error: 'invalid_promo_country' };
  const inventory = await availablePromoCount(promoCountry, env);
  if (!inventory.ok) return inventory;
  if (inventory.available < count) {
    return {
      ok: false,
      error: 'promo_inventory_insufficient',
      country: promoCountry,
      available: inventory.available,
      required: count,
    };
  }

  const label = String(input?.label || '').trim().slice(0, 80);
  const createdAt = new Date().toISOString();
  const expiresAt = expiresDays === 0
    ? null
    : new Date(Date.now() + expiresDays * 86_400_000).toISOString();
  const generated = [];
  const statements = [];

  for (let index = 0; index < count; index += 1) {
    const code = randomCdk();
    const codeHash = await hashCdk(code, env.CDK_HASH_PEPPER);
    generated.push({ code, codeHash });
    statements.push(
      env.DB.prepare(
        `INSERT INTO cdks
         (code_hash, code_suffix, label, max_uses, use_count, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`
      ).bind(codeHash, code.slice(-4), label, maxUses, createdAt, expiresAt)
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO cdk_promo_assignments (cdk_id, promo_code_id, assigned_at)
         VALUES (
           (SELECT id FROM cdks WHERE code_hash = ?1 LIMIT 1),
           (
             SELECT p.id FROM promo_codes p
             WHERE p.country = ?2 AND p.deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM cdk_promo_assignments a WHERE a.promo_code_id = p.id
               )
             ORDER BY p.id ASC LIMIT 1
           ),
           ?3
         )`
      ).bind(codeHash, promoCountry, createdAt)
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
      maxUses,
      expiresAt: expiresAt || '',
      promoCode: assignments[index].promoCode,
      promoCountry: assignments[index].country,
    })),
  };
}

export async function listCdks(env, limitValue = 200) {
  if (!databaseReady(env)) return unavailableResult();
  const limit = parsePositiveInteger(limitValue, 200, 500) || 200;
  const result = await env.DB.prepare(
    `SELECT c.id, c.code_suffix, c.label, c.max_uses, c.use_count, c.created_at, c.expires_at,
            c.revoked_at, c.last_used_at, p.country AS promo_country, p.code_suffix AS promo_suffix
     FROM cdks c
     LEFT JOIN cdk_promo_assignments a ON a.cdk_id = c.id
     LEFT JOIN promo_codes p ON p.id = a.promo_code_id
     ORDER BY c.id DESC LIMIT ?1`
  ).bind(limit).all();
  const now = new Date();
  const records = (result?.results || []).map((row) => publicRecord(row, now));
  return {
    ok: true,
    records,
    stats: records.reduce(
      (stats, record) => {
        stats.total += 1;
        stats[record.state] += 1;
        return stats;
      },
      { total: 0, active: 0, exhausted: 0, expired: 0, revoked: 0 }
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
