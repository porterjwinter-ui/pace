// End-to-end encryption. Nothing leaves the browser unencrypted.
//
// Password --PBKDF2-SHA256 (600k)--> key-encryption key (KEK)
// KEK wraps a random AES-256-GCM data key (DEK). The DEK encrypts the vault.
// Changing the password only re-wraps the DEK.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = crypto.subtle;

export const KDF_ITERATIONS = 600_000;
const FORMAT_VERSION = 1;

export const b64 = {
  encode(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(s);
  },
  decode(str) {
    const bin = atob(str.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function sha256Hex(text) {
  const digest = await subtle.digest('SHA-256', te.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Opaque, stable folder id for a username. Usernames never appear in the repo. */
export async function userIdFor(username) {
  return (await sha256Hex('pace/user/v1:' + username.trim().toLowerCase())).slice(0, 32);
}

async function deriveKek(password, salt, iterations) {
  const base = await subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function wrapWith(password, dek) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await deriveKek(password, salt, KDF_ITERATIONS);
  const wrapped = new Uint8Array(await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv }));
  return {
    v: FORMAT_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: b64.encode(salt) },
    key: { iv: b64.encode(iv), wrapped: b64.encode(wrapped) },
  };
}

/** New account: returns the public-safe account record and the unlocked data key. */
export async function createAccountKeys(password) {
  const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const account = await wrapWith(password, dek);
  account.created = new Date().toISOString();
  return { account, dek };
}

/** Throws Error('WRONG_PASSWORD') if the password can't unwrap the key. */
export async function unlockAccount(account, password) {
  const salt = b64.decode(account.kdf.salt);
  const kek = await deriveKek(password, salt, account.kdf.iterations);
  try {
    return await subtle.unwrapKey(
      'raw',
      b64.decode(account.key.wrapped),
      kek,
      { name: 'AES-GCM', iv: b64.decode(account.key.iv) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new Error('WRONG_PASSWORD');
  }
}

export async function rewrapAccount(account, dek, newPassword) {
  return { ...account, ...(await wrapWith(newPassword, dek)), changed: new Date().toISOString() };
}

/** Non-extractable copy for "keep me signed in" (stored as a CryptoKey in IndexedDB; raw bytes are never exposed). */
export async function lockedCopy(dek) {
  const raw = await subtle.exportKey('raw', dek);
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return { data: bytes, z: 0 };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { data: new Uint8Array(await new Response(stream).arrayBuffer()), z: 1 };
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encrypt any JSON value. Output: base64( version | flags | iv(12) | ciphertext ).
 * `context` is bound as AES-GCM additional data so a blob can't be swapped between users/files.
 */
export async function encryptJSON(key, value, context = '') {
  const { data, z } = await gzip(te.encode(JSON.stringify(value)));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(context) }, key, data));
  const out = new Uint8Array(2 + 12 + ct.length);
  out[0] = FORMAT_VERSION;
  out[1] = z;
  out.set(iv, 2);
  out.set(ct, 14);
  return b64.encode(out);
}

export async function decryptJSON(key, blob, context = '') {
  const bytes = b64.decode(blob);
  if (bytes[0] !== FORMAT_VERSION) throw new Error('Unsupported data format');
  const iv = bytes.subarray(2, 14);
  let data;
  try {
    data = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(context) }, key, bytes.subarray(14)));
  } catch {
    throw new Error('DECRYPT_FAILED');
  }
  if (bytes[1] === 1) data = await gunzip(data);
  return JSON.parse(td.decode(data));
}

export async function encryptText(key, text, context = '') {
  return encryptJSON(key, { t: text }, context);
}
export async function decryptText(key, blob, context = '') {
  return (await decryptJSON(key, blob, context)).t;
}
