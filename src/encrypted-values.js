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

export async function encryptValue(value, secret, scope) {
  if (!value || !secret || !scope) throw new Error('invalid encrypted value input');
  const key = await deriveEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode('encrypted-value:' + scope);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(String(value))
  );
  return 'v1.' + bytesToBase64(iv) + '.' + bytesToBase64(new Uint8Array(encrypted));
}

export async function decryptValue(encryptedValue, secret, scope) {
  const [version, ivValue, ciphertextValue] = String(encryptedValue || '').split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue || !secret || !scope) {
    throw new Error('invalid encrypted value');
  }
  const key = await deriveEncryptionKey(secret);
  const additionalData = new TextEncoder().encode('encrypted-value:' + scope);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivValue), additionalData },
    key,
    base64ToBytes(ciphertextValue)
  );
  return new TextDecoder().decode(decrypted);
}
