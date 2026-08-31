import { decryptValue } from './encrypted-values.js';

const MAX_PROMO_LENGTH = 240;
const MAX_IMPORT_SIZE = 1_000;
const GLOBAL_PROMO_SCOPE = 'GLOBAL';
const PROMO_AUTO_DELETE_DELAY_MS = 24 * 60 * 60 * 1_000;

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
  return Boolean(env?.DB && env?.PROMO_ENCRYPTION_KEY);
}

export function normalizePromoCode(value) {
  let raw = String(value || '').trim();
  if (!raw || raw.length > MAX_PROMO_LENGTH) return '';

  if (/^(?:www\.)?chatgpt\.com\//i.test(raw)) raw = 'https://' + raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
      if (!['http:', 'https:'].includes(url.protocol) || hostname !== 'chatgpt.com') return '';
      const match = /^\/p\/([A-Za-z0-9_-]{6,160})\/?$/.exec(url.pathname);
      return match ? match[1].toUpperCase() : '';
    } catch {
      return '';
    }
  }

  const pathMatch = /^\/?p\/([A-Za-z0-9_-]{6,160})\/?$/i.exec(raw);
  if (pathMatch) return pathMatch[1].toUpperCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,159}$/.test(raw)) return '';
  return raw.toUpperCase();
}

export async function hashPromoCode(value, secret) {
  const normalized = normalizePromoCode(value);
  if (!normalized || !secret) return '';
  const bytes = new TextEncoder().encode(String(secret) + ':promo:' + normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptPromoCode(value, secret, scope) {
  const key = await deriveEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode('promo:' + scope);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(value)
  );
  return 'v1.' + bytesToBase64(iv) + '.' + bytesToBase64(new Uint8Array(encrypted));
}

async function decryptPromoCode(encryptedValue, secret, scope) {
  const [version, ivValue, ciphertextValue] = String(encryptedValue || '').split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue) throw new Error('invalid encrypted promo code');
  const key = await deriveEncryptionKey(secret);
  const additionalData = new TextEncoder().encode('promo:' + scope);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivValue), additionalData },
    key,
    base64ToBytes(ciphertextValue)
  );
  return new TextDecoder().decode(decrypted);
}

function maskedPromo(row) {
  return '••••••' + row.code_suffix;
}

function entriesFromInput(input) {
  if (Array.isArray(input?.codes)) return input.codes;
  if (typeof input?.text === 'string') return input.text.split(/[\r\n,;\t]+/);
  return [];
}

export async function importPromoCodes(input, env) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const batchName = String(input?.batchName || '').trim().slice(0, 80) || '全球优惠码';
  const sourceEntries = entriesFromInput(input);
  if (!sourceEntries.length || sourceEntries.length > MAX_IMPORT_SIZE) {
    return { ok: false, error: 'invalid_promo_import', max: MAX_IMPORT_SIZE };
  }

  const uniqueValues = [];
  const seen = new Set();
  let invalidCount = 0;
  for (const entry of sourceEntries) {
    const normalized = normalizePromoCode(entry);
    if (!normalized) {
      if (String(entry || '').trim()) invalidCount += 1;
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueValues.push(normalized);
  }
  if (!uniqueValues.length) return { ok: false, error: 'no_valid_promo_codes', invalidCount };

  const importedAt = new Date().toISOString();
  const prepared = await Promise.all(uniqueValues.map(async (value) => ({
    hash: await hashPromoCode(value, env.PROMO_ENCRYPTION_KEY),
    encrypted: await encryptPromoCode(value, env.PROMO_ENCRYPTION_KEY, GLOBAL_PROMO_SCOPE),
    suffix: value.slice(-6),
  })));
  const statements = prepared.map((item) => env.DB.prepare(
    `INSERT OR IGNORE INTO promo_codes
     (code_hash, encrypted_code, code_suffix, country, batch_name, imported_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
  ).bind(item.hash, item.encrypted, item.suffix, GLOBAL_PROMO_SCOPE, batchName, importedAt));
  const results = await env.DB.batch(statements);
  const importedCount = results.reduce(
    (count, result) => count + (Number(result?.meta?.changes || 0) === 1 ? 1 : 0),
    0
  );
  return {
    ok: true,
    scope: 'global',
    batchName,
    receivedCount: sourceEntries.length,
    validCount: prepared.length,
    importedCount,
    duplicateCount: prepared.length - importedCount,
    invalidCount,
  };
}

export async function decryptPromoForAdmin(encryptedCode, scope, env) {
  if (!encryptedCode || !scope || !env?.PROMO_ENCRYPTION_KEY) return '';
  try {
    return normalizePromoCode(await decryptPromoCode(encryptedCode, env.PROMO_ENCRYPTION_KEY, scope));
  } catch {
    return '';
  }
}

async function decryptCdkForAdmin(row, env) {
  if (row.cdk_deleted_at || !row.cdk_encrypted_code || !row.cdk_kind || !env?.PROMO_ENCRYPTION_KEY) return '';
  try {
    const code = await decryptValue(
      row.cdk_encrypted_code,
      env.PROMO_ENCRYPTION_KEY,
      'cdk:' + row.cdk_kind
    );
    return /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(code) ? code : '';
  } catch {
    return '';
  }
}

function publicPromoRecord(row, code, cdkCode) {
  const assigned = row.cdk_id != null;
  const sold = Boolean(row.auto_delete_at);
  return {
    id: Number(row.id),
    maskedCode: maskedPromo(row),
    code: sold ? maskedPromo(row) : (code || maskedPromo(row)),
    batchName: row.batch_name || '',
    importedAt: row.imported_at,
    state: sold ? 'sold' : (assigned ? 'assigned' : 'available'),
    assignedAt: row.assigned_at || '',
    assignedCdkId: assigned ? Number(row.cdk_id) : null,
    assignedCdk: assigned ? (cdkCode || '••••-••••-••••-' + row.cdk_suffix) : '',
    redeemedAt: row.redeemed_at || '',
    autoDeleteAt: row.auto_delete_at || '',
  };
}

export async function listPromoCodes(env, options = {}) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const limitValue = Number(options.limit || 20);
  const limit = Number.isInteger(limitValue) && limitValue > 0 && limitValue <= 100 ? limitValue : 20;
  const pageValue = Number(options.page || 1);
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const requestedState = options.state === 'scheduled' ? 'sold' : options.state;
  const state = ['available', 'assigned', 'sold'].includes(requestedState) ? requestedState : 'all';
  const stateCondition = state === 'available'
    ? ' AND a.cdk_id IS NULL AND p.auto_delete_at IS NULL'
    : (state === 'assigned'
        ? ' AND a.cdk_id IS NOT NULL AND p.auto_delete_at IS NULL'
        : (state === 'sold' ? ' AND p.auto_delete_at IS NOT NULL' : ''));
  const offset = (page - 1) * limit;
  const result = await env.DB.prepare(
    `SELECT p.id, p.encrypted_code, p.code_suffix, p.country, p.batch_name, p.imported_at,
            p.redeemed_at, p.auto_delete_at,
            a.cdk_id, a.assigned_at, c.code_suffix AS cdk_suffix,
            c.encrypted_code AS cdk_encrypted_code, c.kind AS cdk_kind,
            c.deleted_at AS cdk_deleted_at
     FROM promo_codes p
     LEFT JOIN cdk_promo_assignments a ON a.promo_code_id = p.id
     LEFT JOIN cdks c ON c.id = a.cdk_id
     WHERE p.deleted_at IS NULL${stateCondition}
     ORDER BY p.id DESC LIMIT ?1 OFFSET ?2`
  ).bind(limit, offset).all();
  const records = await Promise.all((result?.results || []).map(async (row) => publicPromoRecord(
    row,
    await decryptPromoForAdmin(row.encrypted_code, row.country, env),
    await decryptCdkForAdmin(row, env)
  )));
  const statsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.cdk_id IS NULL AND p.auto_delete_at IS NULL THEN 1 ELSE 0 END) AS available,
            SUM(CASE WHEN a.cdk_id IS NOT NULL AND p.auto_delete_at IS NULL THEN 1 ELSE 0 END) AS assigned,
            SUM(CASE WHEN p.auto_delete_at IS NOT NULL THEN 1 ELSE 0 END) AS sold
     FROM promo_codes p
     LEFT JOIN cdk_promo_assignments a ON a.promo_code_id = p.id
     WHERE p.deleted_at IS NULL`
  ).first();
  const filteredRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM promo_codes p
     LEFT JOIN cdk_promo_assignments a ON a.promo_code_id = p.id
     WHERE p.deleted_at IS NULL${stateCondition}`
  ).first();
  const filteredTotal = Number(filteredRow?.total || 0);
  return {
    ok: true,
    scope: 'global',
    records,
    stats: {
      total: Number(statsRow?.total || 0),
      available: Number(statsRow?.available || 0),
      assigned: Number(statsRow?.assigned || 0),
      sold: Number(statsRow?.sold || 0),
    },
    pagination: {
      page,
      limit,
      total: filteredTotal,
      totalPages: Math.max(1, Math.ceil(filteredTotal / limit)),
      state,
    },
  };
}

export async function availablePromoCount(env) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS available
     FROM promo_codes p
     WHERE p.deleted_at IS NULL
       AND p.auto_delete_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM cdk_promo_assignments a WHERE a.promo_code_id = p.id
       )`
  ).first();
  return { ok: true, scope: 'global', available: Number(row?.available || 0) };
}

export async function assignedPromoForCdkHash(codeHash, env) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const row = await env.DB.prepare(
    `SELECT c.id AS cdk_id, p.encrypted_code, p.country
     FROM cdks c
     JOIN cdk_promo_assignments a ON a.cdk_id = c.id
     JOIN promo_codes p ON p.id = a.promo_code_id
     WHERE c.code_hash = ?1 LIMIT 1`
  ).bind(codeHash).first();
  if (!row) return { ok: false, error: 'promo_assignment_missing' };
  try {
    const decrypted = await decryptPromoCode(row.encrypted_code, env.PROMO_ENCRYPTION_KEY, row.country);
    const promoCode = normalizePromoCode(decrypted);
    if (!promoCode) return { ok: false, error: 'promo_decryption_failed' };
    return { ok: true, cdkId: Number(row.cdk_id), promoCode };
  } catch {
    return { ok: false, error: 'promo_decryption_failed' };
  }
}

export async function deletePromoCode(idValue, env) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_promo_id' };
  const deletedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE promo_codes
     SET deleted_at = ?1, auto_delete_at = NULL
     WHERE id = ?2 AND deleted_at IS NULL`
  ).bind(deletedAt, id).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    return { ok: false, error: 'promo_not_found' };
  }
  return { ok: true, id, deletedAt };
}

export async function validateRegisteredPromoCode(value, env) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const promoCode = normalizePromoCode(value);
  if (!promoCode) return { ok: false, error: 'invalid_promo_code' };
  const codeHash = await hashPromoCode(promoCode, env.PROMO_ENCRYPTION_KEY);
  const row = await env.DB.prepare(
    `SELECT id FROM promo_codes
     WHERE code_hash = ?1 AND deleted_at IS NULL LIMIT 1`
  ).bind(codeHash).first();
  if (!row) return { ok: false, error: 'promo_not_registered' };
  return { ok: true, promoId: Number(row.id), promoCode };
}

export async function markPromoForAutoDelete(idValue, env, nowValue = new Date()) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_promo_id' };
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'invalid_promo_timestamp' };
  const redeemedAt = now.toISOString();
  const autoDeleteAt = new Date(now.getTime() + PROMO_AUTO_DELETE_DELAY_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE promo_codes
     SET redeemed_at = COALESCE(redeemed_at, ?1),
         auto_delete_at = COALESCE(auto_delete_at, ?2)
     WHERE id = ?3 AND deleted_at IS NULL`
  ).bind(redeemedAt, autoDeleteAt, id).run();
  if (Number(result?.meta?.changes || 0) !== 1) return { ok: false, error: 'promo_not_found' };
  const row = await env.DB.prepare(
    `SELECT redeemed_at, auto_delete_at FROM promo_codes WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  return {
    ok: true,
    id,
    redeemedAt: row?.redeemed_at || redeemedAt,
    autoDeleteAt: row?.auto_delete_at || autoDeleteAt,
  };
}

export async function cleanupExpiredPromoCodes(env, nowValue = new Date()) {
  if (!serviceReady(env)) return { ok: false, error: 'promo_service_not_configured' };
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'invalid_promo_timestamp' };
  const deletedAt = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE promo_codes
     SET deleted_at = ?1
     WHERE deleted_at IS NULL
       AND auto_delete_at IS NOT NULL
       AND auto_delete_at <= ?1`
  ).bind(deletedAt).run();
  return { ok: true, deletedAt, deletedCount: Number(result?.meta?.changes || 0) };
}
