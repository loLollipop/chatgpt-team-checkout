import { decryptPromoForAdmin, assignedPromoForCdkHash, availablePromoCount } from './promo-codes.js';
import { decryptValue, encryptValue } from './encrypted-values.js';

const CDK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CDK_GROUPS = 4;
const CDK_GROUP_LENGTH = 4;
const MAX_BATCH_SIZE = 50;
const STANDARD_CDK_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STANDARD_CDK_ACTIVE_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const EXTERNAL_PROMO_CDK_LIFETIME_MS = 3 * 60 * 60 * 1_000;
const EXTERNAL_PROMO_CDK_MAX_USES = 3;
// 兼容初始表的 CHECK (max_uses > 0)；对外仍以 repeatable=true / maxUses=null 表示不限次数。
const STANDARD_CDK_REPEATABLE_SENTINEL = 2_147_483_647;
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
  if (!row.activated_at) return 'pending';
  if (Number(row.external_use_count || 0) >= EXTERNAL_PROMO_CDK_MAX_USES) return 'exhausted';
  if (Number(row.max_uses) > 0 && Number(row.use_count) >= Number(row.max_uses)) return 'exhausted';
  return 'active';
}

function publicRecord(row, now = new Date(), revealedCode = '', revealedPromo = '') {
  const kind = rowKind(row);
  const maxUses = Number(row.max_uses);
  const useCount = Number(row.use_count);
  const unlimited = kind === CDK_KIND_ADMIN;
  const repeatable = kind === CDK_KIND_STANDARD && maxUses === STANDARD_CDK_REPEATABLE_SENTINEL;
  const promoSold = Boolean(row.promo_auto_delete_at);
  const promoDeleted = Boolean(row.promo_deleted_at);
  const promoLocked = promoSold || promoDeleted;
  const externalMode = kind === CDK_KIND_STANDARD && Boolean(row.external_mode_at);
  const externalUseCount = Number(row.external_use_count || 0);
  return {
    id: Number(row.id),
    maskedCode: '••••-••••-••••-' + row.code_suffix,
    code: revealedCode || '••••-••••-••••-' + row.code_suffix,
    legacyCode: !revealedCode,
    label: row.label || '',
    kind,
    unlimited,
    repeatable,
    externalMode,
    externalModeAt: externalMode ? row.external_mode_at : '',
    externalUseCount,
    externalUseLimit: externalMode ? EXTERNAL_PROMO_CDK_MAX_USES : null,
    maxUses: unlimited || repeatable ? null : maxUses,
    useCount,
    remainingUses: unlimited || repeatable ? null : Math.max(0, maxUses - useCount),
    createdAt: row.created_at,
    activatedAt: kind === CDK_KIND_STANDARD ? (row.activated_at || '') : '',
    activationDeadline: kind === CDK_KIND_STANDARD && !row.activated_at ? (row.expires_at || '') : '',
    expiresAt: unlimited ? '' : (row.expires_at || ''),
    revokedAt: row.revoked_at || '',
    lastUsedAt: row.last_used_at || '',
    promoCode: promoLocked
      ? (row.promo_suffix ? '••••••' + row.promo_suffix : '')
      : (revealedPromo || (row.promo_suffix ? '••••••' + row.promo_suffix : '')),
    promoLocked,
    promoSold,
    promoDeleted,
    checkoutAudits: Array.isArray(row.checkout_audits) ? row.checkout_audits : [],
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
    repeatable: record.repeatable,
    externalMode: record.externalMode,
    externalUseCount: record.externalUseCount,
    externalUseLimit: record.externalUseLimit,
    maxUses: record.maxUses,
    useCount: record.useCount,
    remainingUses: record.remainingUses,
    activatedAt: record.activatedAt,
    activationDeadline: record.activationDeadline,
    expiresAt: record.expiresAt,
  };
}

const CDK_SELECT_COLUMNS = `id, code_suffix, label, kind, max_uses, use_count,
  created_at, activated_at, expires_at, revoked_at, deleted_at, last_used_at,
  external_mode_at, external_use_count`;

export async function synchronizeCustomerCdkExpiry(env, idValue = null) {
  if (!env?.DB) return unavailableResult();
  const hasId = idValue != null;
  const id = hasId ? Number(idValue) : null;
  if (hasId && (!Number.isInteger(id) || id <= 0)) {
    return { ok: false, error: 'invalid_cdk_id' };
  }

  const idClause = hasId ? ' AND id = ?1' : '';
  const statement = env.DB.prepare(
    `UPDATE cdks
     SET expires_at = COALESCE(
       (
         SELECT p.auto_delete_at
         FROM cdk_promo_assignments a
         JOIN promo_codes p ON p.id = a.promo_code_id
         WHERE a.cdk_id = cdks.id AND p.auto_delete_at IS NOT NULL
         LIMIT 1
       ),
       strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+24 hours')
     )
     WHERE kind = 'standard'
       AND max_uses = 2147483647
       AND activated_at IS NOT NULL
       AND deleted_at IS NULL
       AND revoked_at IS NULL
       AND external_mode_at IS NULL
       AND expires_at IS NOT COALESCE(
         (
           SELECT p.auto_delete_at
           FROM cdk_promo_assignments a
           JOIN promo_codes p ON p.id = a.promo_code_id
           WHERE a.cdk_id = cdks.id AND p.auto_delete_at IS NOT NULL
           LIMIT 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+24 hours')
       )
       ${idClause}`
  );
  const result = await (hasId ? statement.bind(id) : statement).run();
  return { ok: true, updatedCount: Number(result?.meta?.changes || 0) };
}

async function verifyCdkRow(row, env, options = {}, now = new Date()) {
  const current = resultFromRecord(row, now);
  if (!current.ok || !options.consume) return current;

  const nowIso = now.toISOString();
  if (current.unlimited) {
    const update = await env.DB.prepare(
      `UPDATE cdks SET last_used_at = ?1
       WHERE id = ?2 AND kind = 'admin' AND revoked_at IS NULL AND deleted_at IS NULL`
    ).bind(nowIso, row.id).run();
    if (Number(update?.meta?.changes || 0) === 1) return current;
  } else {
    const update = await env.DB.prepare(
      `UPDATE cdks
       SET use_count = use_count + 1, last_used_at = ?1
       WHERE id = ?2
         AND kind = 'standard'
         AND activated_at IS NOT NULL
         AND deleted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > ?1
         AND (max_uses = 2147483647 OR use_count < max_uses)`
    ).bind(nowIso, row.id).run();
    if (Number(update?.meta?.changes || 0) === 1) {
      const useCount = current.useCount + 1;
      return {
        ...current,
        useCount,
        remainingUses: current.repeatable ? null : Math.max(0, current.maxUses - useCount),
      };
    }
  }

  const latest = await env.DB.prepare(
    `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
     WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`
  ).bind(row.id).first();
  return resultFromRecord(latest, new Date());
}

export async function verifyCdk(value, env, options = {}) {
  if (!databaseReady(env)) return unavailableResult();
  const normalized = normalizeCdk(value);
  if (!normalized) return { ok: false, error: 'cdk_invalid_format' };
  const codeHash = await hashCdk(normalized, env.CDK_HASH_PEPPER);
  const now = new Date();
  const nowIso = now.toISOString();
  let row = await env.DB.prepare(
    `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
     WHERE code_hash = ?1 AND deleted_at IS NULL LIMIT 1`
  ).bind(codeHash).first();
  if (row && rowKind(row) === CDK_KIND_STANDARD && row.activated_at) {
    await synchronizeCustomerCdkExpiry(env, row.id);
    row = await env.DB.prepare(
      `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
       WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`
    ).bind(row.id).first();
  }
  if (row && rowKind(row) === CDK_KIND_STANDARD && recordState(row, now) === 'pending') {
    const activatedUntil = new Date(now.getTime() + STANDARD_CDK_ACTIVE_LIFETIME_MS).toISOString();
    await env.DB.prepare(
      `UPDATE cdks
       SET activated_at = ?1,
           expires_at = MIN(
             ?2,
             COALESCE(
               (
                 SELECT p.auto_delete_at
                 FROM cdk_promo_assignments a
                 JOIN promo_codes p ON p.id = a.promo_code_id
                 WHERE a.cdk_id = ?3 AND p.auto_delete_at IS NOT NULL
                 LIMIT 1
               ),
               ?2
             )
           )
       WHERE id = ?3
         AND kind = 'standard'
         AND activated_at IS NULL
         AND deleted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > ?1`
    ).bind(nowIso, activatedUntil, row.id).run();
    row = await env.DB.prepare(
      `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
       WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`
    ).bind(row.id).first();
  }

  return verifyCdkRow(row, env, options, now);
}

export async function verifyCdkId(idValue, env, options = {}) {
  if (!databaseReady(env)) return unavailableResult();
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'cdk_invalid' };
  await synchronizeCustomerCdkExpiry(env, id);
  const row = await env.DB.prepare(
    `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
     WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`
  ).bind(id).first();
  return verifyCdkRow(row, env, options, new Date());
}

export async function recordRestrictedCheckoutSuccess(input, env, nowValue = new Date()) {
  if (!visualEncryptionReady(env)) return unavailableResult();
  const id = Number(input?.cdkId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'cdk_invalid' };
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'invalid_cdk_timestamp' };
  const promoCode = String(input?.promoCode || '').trim();
  const promoSource = ['registered', 'external', 'none'].includes(input?.promoSource)
    ? input.promoSource
    : 'none';
  const encryptedPromoCode = promoCode
    ? await encryptValue(promoCode, env.PROMO_ENCRYPTION_KEY, `cdk-checkout-promo:${id}`)
    : null;
  const nowIso = now.toISOString();
  const externalExpiresAt = new Date(now.getTime() + EXTERNAL_PROMO_CDK_LIFETIME_MS).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cdks
       SET max_uses = 2147483647,
           use_count = use_count + 1,
           external_use_count = external_use_count + 1,
           external_mode_at = COALESCE(external_mode_at, ?1),
           expires_at = CASE
             WHEN external_mode_at IS NULL THEN MIN(expires_at, ?2)
             ELSE expires_at
           END,
           last_used_at = ?1
       WHERE id = ?3
         AND kind = 'standard'
         AND activated_at IS NOT NULL
         AND deleted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > ?1
         AND external_use_count < 3`
    ).bind(nowIso, externalExpiresAt, id),
    env.DB.prepare(
      `INSERT INTO cdk_checkout_audits
       (cdk_id, encrypted_promo_code, promo_code_suffix, promo_source, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE changes() = 1
         AND EXISTS (
         SELECT 1 FROM cdks
         WHERE id = ?1 AND last_used_at = ?5 AND external_mode_at IS NOT NULL
       )`
    ).bind(id, encryptedPromoCode, promoCode.slice(-6), promoSource, nowIso),
    env.DB.prepare(
      `DELETE FROM cdk_promo_assignments WHERE cdk_id = ?1`
    ).bind(id),
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    const latest = await env.DB.prepare(
      `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
       WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`
    ).bind(id).first();
    return resultFromRecord(latest, new Date());
  }

  const latest = await env.DB.prepare(
    `SELECT ${CDK_SELECT_COLUMNS} FROM cdks
     WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`
  ).bind(id).first();
  const record = publicRecord(latest, now);
  return {
    ok: true,
    id: record.id,
    label: record.label,
    kind: record.kind,
    unlimited: record.unlimited,
    repeatable: record.repeatable,
    maxUses: record.maxUses,
    useCount: record.useCount,
    remainingUses: record.remainingUses,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    sessionActive: record.state === 'active',
  };
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
  const expiresAt = new Date(new Date(createdAt).getTime() + STANDARD_CDK_ACTIVATION_WINDOW_MS).toISOString();
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
         VALUES (?1, ?2, ?3, 'standard', 2147483647, 0, ?4, ?5, ?6)`
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
               AND p.auto_delete_at IS NULL
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
      repeatable: true,
      maxUses: null,
      activationDeadline: expiresAt,
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
      repeatable: false,
      maxUses: null,
      expiresAt: '',
      promoCode: '',
    },
  };
}

export async function listCdks(env, limitValue = 200) {
  if (!visualEncryptionReady(env)) return unavailableResult();
  const limit = parsePositiveInteger(limitValue, 200, 500) || 200;
  await synchronizeCustomerCdkExpiry(env);
  const result = await env.DB.prepare(
    `SELECT c.id, c.code_suffix, c.encrypted_code, c.label, c.kind, c.max_uses, c.use_count, c.created_at,
            c.activated_at, c.expires_at, c.revoked_at, c.deleted_at, c.last_used_at,
            c.external_mode_at, c.external_use_count, p.code_suffix AS promo_suffix,
            p.encrypted_code AS promo_encrypted_code, p.country AS promo_scope,
            p.auto_delete_at AS promo_auto_delete_at, p.deleted_at AS promo_deleted_at
     FROM cdks c
     LEFT JOIN cdk_promo_assignments a ON a.cdk_id = c.id
     LEFT JOIN promo_codes p ON p.id = a.promo_code_id
     WHERE c.deleted_at IS NULL
     ORDER BY c.id DESC LIMIT ?1`
  ).bind(limit).all();
  const auditResult = await env.DB.prepare(
    `SELECT h.id, h.cdk_id, h.encrypted_promo_code, h.promo_code_suffix,
            h.promo_source, h.created_at
     FROM cdk_checkout_audits h
     JOIN (
       SELECT id FROM cdks WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?1
     ) recent ON recent.id = h.cdk_id
     ORDER BY h.id DESC`
  ).bind(limit).all();
  const auditsByCdk = new Map();
  for (const audit of auditResult?.results || []) {
    let promoCode = '';
    if (audit.encrypted_promo_code) {
      try {
        promoCode = await decryptValue(
          audit.encrypted_promo_code,
          env.PROMO_ENCRYPTION_KEY,
          `cdk-checkout-promo:${audit.cdk_id}`
        );
      } catch {
        promoCode = audit.promo_code_suffix ? `••••••${audit.promo_code_suffix}` : '';
      }
    }
    const records = auditsByCdk.get(Number(audit.cdk_id)) || [];
    records.push({
      id: Number(audit.id),
      promoCode,
      promoSource: audit.promo_source,
      createdAt: audit.created_at,
    });
    auditsByCdk.set(Number(audit.cdk_id), records);
  }
  const now = new Date();
  const records = await Promise.all((result?.results || []).map(async (row) => {
    row.checkout_audits = auditsByCdk.get(Number(row.id)) || [];
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
    const revealedPromo = row.promo_auto_delete_at || row.promo_deleted_at
      ? ''
      : await decryptPromoForAdmin(
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
      { total: 0, pending: 0, active: 0, exhausted: 0, expired: 0, revoked: 0, standard: 0, admin: 0 }
    ),
  };
}

export async function revokeCdk(idValue, env) {
  if (!databaseReady(env)) return unavailableResult();
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_cdk_id' };
  const revokedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE cdks SET revoked_at = ?1
     WHERE id = ?2 AND revoked_at IS NULL AND deleted_at IS NULL`
  ).bind(revokedAt, id).run();
  if (Number(result?.meta?.changes || 0) !== 1) return { ok: false, error: 'cdk_not_found_or_revoked' };
  return { ok: true, id, revokedAt };
}

export async function deleteCdk(idValue, env) {
  if (!databaseReady(env)) return unavailableResult();
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_cdk_id' };
  const deletedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE cdks
     SET deleted_at = ?1, revoked_at = COALESCE(revoked_at, ?1)
     WHERE id = ?2 AND deleted_at IS NULL`
  ).bind(deletedAt, id).run();
  if (Number(result?.meta?.changes || 0) !== 1) return { ok: false, error: 'cdk_not_found' };
  return { ok: true, id, deletedAt };
}
