import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Credential encryption (contract §8, reliability mechanism 6).
 *
 * The master keys live OUTSIDE the database (a root-only file on the server today, a key service later). Each sealed value is encrypted
 * with AES-256-GCM under a key derived (HKDF-SHA256) from one master key, the tenant and the purpose, and the tenant and purpose are also
 * bound as associated data. So a sealed value copied into another restaurant's row, or used for another connector, does not open.
 *
 * Stored format (versioned, so an older and a newer library both know what they are looking at):
 *   vcs1.<keyId>.<iv base64url>.<tag base64url>.<ciphertext base64url>
 *
 * Rotation: add a new master key and make it current; old values still open with their key id; `needsRotation` tells which rows to
 * re-seal. Rolling the library back keeps working as long as the keyring still holds the old key ids — never delete a key id that sealed
 * values still use.
 */
export const SEALED_PREFIX = 'vcs1';

export interface Keyring {
  current: string;
  keys: Record<string, Buffer>;
}

const KEY_ID_RE = /^[a-z0-9]{1,16}$/;

/**
 * Reads a keyring from text like `k2:BASE64;k1:BASE64` (the FIRST entry is the current key). Every key must be 32 bytes.
 * Typically the content of a root-only file such as /etc/<product>/integration-keys.
 */
export function parseKeyring(text: string): Keyring {
  const entries = text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('integration keyring is empty');
  const keys: Record<string, Buffer> = {};
  let current = '';
  for (const entry of entries) {
    const idx = entry.indexOf(':');
    const id = entry.slice(0, idx).trim();
    const key = Buffer.from(entry.slice(idx + 1).trim(), 'base64');
    if (idx <= 0 || !KEY_ID_RE.test(id)) throw new Error('integration keyring: bad key id');
    if (key.length !== 32) throw new Error(`integration keyring: key ${id} must be 32 bytes`);
    if (keys[id]) throw new Error(`integration keyring: duplicate key id ${id}`);
    keys[id] = key;
    if (!current) current = id;
  }
  return { current, keys };
}

/** A new random master key in keyring text form, for setup scripts. */
export function newKeyringEntry(id: string): string {
  if (!KEY_ID_RE.test(id)) throw new Error('bad key id');
  return `${id}:${randomBytes(32).toString('base64')}`;
}

function deriveKey(master: Buffer, tenant: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(tenant, 'utf8'), Buffer.from(`vc-cred:${purpose}`, 'utf8'), 32));
}

const aad = (tenant: string, purpose: string) => Buffer.from(`${tenant}|${purpose}`, 'utf8');

export function sealCredentials(keyring: Keyring, tenant: string, purpose: string, value: unknown): string {
  if (!tenant || !purpose) throw new Error('sealCredentials needs a tenant and a purpose');
  const master = keyring.keys[keyring.current];
  if (!master) throw new Error('integration keyring has no current key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(master, tenant, purpose), iv);
  cipher.setAAD(aad(tenant, purpose));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEALED_PREFIX, keyring.current, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export class SealedValueError extends Error {
  constructor(readonly code: 'format' | 'unknown_key' | 'tampered') {
    super(`sealed credentials cannot be opened (${code})`);
    this.name = 'SealedValueError';
  }
}

export function openCredentials<T = unknown>(keyring: Keyring, tenant: string, purpose: string, sealed: string): T {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== SEALED_PREFIX) throw new SealedValueError('format');
  const [, keyId, ivText, tagText, ctText] = parts as [string, string, string, string, string];
  const master = keyring.keys[keyId];
  if (!master) throw new SealedValueError('unknown_key');
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(master, tenant, purpose), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(aad(tenant, purpose));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctText, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    throw new SealedValueError('tampered');
  }
}

/** True when the value was sealed with an older master key and should be re-sealed with the current one. */
export function needsRotation(keyring: Keyring, sealed: string): boolean {
  const keyId = sealed.split('.')[1];
  return keyId !== keyring.current;
}

/**
 * A copy of an object safe to log or show: every field named in `secretKeys` (and anything that looks like a secret by name) becomes
 * "••••" plus its last 4 characters, so the owner can recognise WHICH key is stored without it ever being readable.
 */
export function maskSecrets(value: Record<string, unknown>, secretKeys: readonly string[] = []): Record<string, unknown> {
  const looksSecret = /secret|token|key|password|hmac/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if ((secretKeys.includes(k) || looksSecret.test(k)) && typeof v === 'string') {
      out[k] = v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
