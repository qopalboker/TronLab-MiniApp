
const TOKEN_PREFIX = 'TRONLAB_VAULT_V1:';
const VAULT_CHECK_TEXT = 'TRON-LAB-VAULT-CHECK-V1';
const VAULT_CHECK_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
/** Bounds in-flight AES-GCM operations per Worker to avoid large promise/ciphertext spikes on mobile. */
export const MAX_CONCURRENT_WALLET_ENCRYPTIONS = 64;

export class InvalidVaultTokenError extends Error {
  constructor(message = 'توکن امن دیتابیس معتبر نیست.') {
    super(message);
    this.name = 'InvalidVaultTokenError';
  }
}

export class VaultTokenScopeError extends Error {
  constructor() {
    super('کلید امن متعلق به حساب تلگرام دیگری است.');
    this.name = 'VaultTokenScopeError';
  }
}

export interface EncryptedWalletRecord {
  id: string;
  address: string;
  createdAt: string;
  version: 1;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

export interface VaultCheckRecord {
  key: 'key-check';
  version: 1;
  deviceId: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

function hasBufferLength(value: unknown, minimum: number, maximum?: number): value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) return false;
  return value.byteLength >= minimum && (maximum === undefined || value.byteLength <= maximum);
}

/** Validate IndexedDB records before handing their bytes to Web Crypto. */
export function isEncryptedWalletRecord(value: unknown): value is EncryptedWalletRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<EncryptedWalletRecord>;
  return typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.address === 'string'
    && record.address.length > 0
    && typeof record.createdAt === 'string'
    && Number.isFinite(Date.parse(record.createdAt))
    && record.version === 1
    && hasBufferLength(record.iv, AES_GCM_IV_BYTES, AES_GCM_IV_BYTES)
    && hasBufferLength(record.ciphertext, 16);
}

/** Validate the key-check metadata shape without exposing or logging its bytes. */
export function isVaultCheckRecord(value: unknown): value is VaultCheckRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<VaultCheckRecord>;
  return record.key === 'key-check'
    && record.version === VAULT_CHECK_VERSION
    && typeof record.deviceId === 'string'
    && record.deviceId.length > 0
    && hasBufferLength(record.iv, AES_GCM_IV_BYTES, AES_GCM_IV_BYTES)
    && hasBufferLength(record.ciphertext, 16);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function walletAad(scope: string, id: string, address: string, createdAt: string): Uint8Array {
  return encodeText(`tron-lab:wallet:v1:${scope}:${id}:${address}:${createdAt}`);
}

function checkAad(scope: string, deviceId: string): Uint8Array {
  return encodeText(`tron-lab:vault-check:v${VAULT_CHECK_VERSION}:${scope}:${deviceId}`);
}

export function createVaultToken(scope: string): string {
  if (!scope) throw new Error('شناسه حساب تلگرام برای ساخت کلید امن الزامی است.');
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error('Web Crypto در این محیط در دسترس نیست؛ Mini App باید داخل Telegram و روی HTTPS اجرا شود.');
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  try { return `${TOKEN_PREFIX}${encodeURIComponent(scope)}:${toBase64Url(secret)}`; }
  finally { secret.fill(0); }
}

export async function importVaultKeyFromToken(token: string, scope: string): Promise<CryptoKey> {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) throw new InvalidVaultTokenError();
  const payload = token.slice(TOKEN_PREFIX.length);
  const separator = payload.indexOf(':');
  let tokenScope = '';
  try { tokenScope = separator > 0 ? decodeURIComponent(payload.slice(0, separator)) : ''; }
  catch { throw new InvalidVaultTokenError('ساختار توکن امن دریافتی از تلگرام قابل خواندن نیست.'); }
  if (separator < 1 || tokenScope !== scope) throw new VaultTokenScopeError();
  let raw: Uint8Array;
  try { raw = fromBase64Url(payload.slice(separator + 1)); }
  catch { throw new InvalidVaultTokenError('بخش رمزگذاری‌شده توکن امن خراب یا ناقص است.'); }
  if (raw.byteLength !== 32) throw new InvalidVaultTokenError('طول کلید امن دیتابیس معتبر نیست.');
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export async function createVaultCheck(key: CryptoKey, scope: string, deviceId: string): Promise<VaultCheckRecord> {
  if (!scope || !deviceId) throw new Error('حساب تلگرام و شناسه دستگاه برای ساخت بررسی امنیتی الزامی هستند.');
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: checkAad(scope, deviceId), tagLength: 128 },
    key,
    encodeText(VAULT_CHECK_TEXT),
  );
  return {
    key: 'key-check',
    version: VAULT_CHECK_VERSION,
    deviceId,
    iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
    ciphertext,
  };
}

export async function verifyVaultCheck(key: CryptoKey, scope: string, deviceId: string, record: VaultCheckRecord): Promise<boolean> {
  if (!scope || !deviceId || !isVaultCheckRecord(record) || record.deviceId !== deviceId) return false;
  try {
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: checkAad(scope, deviceId), tagLength: 128 },
      key,
      record.ciphertext,
    ));
    try {
      return new TextDecoder().decode(plaintext) === VAULT_CHECK_TEXT;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return false;
  }
}

async function encryptWalletRecord(
  key: CryptoKey,
  scope: string,
  wallet: { privateKey: string; address: string; derivationPath: 'private-key' },
): Promise<EncryptedWalletRecord> {
  if (!/^[0-9a-f]{64}$/i.test(wallet.privateKey) || !wallet.address) {
    throw new Error('ورودی کیف‌پول برای رمزگذاری معتبر نیست.');
  }
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const plaintext = encodeText(wallet.privateKey);
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: walletAad(scope, id, wallet.address, createdAt), tagLength: 128 },
      key,
      plaintext,
    );
  } finally {
    plaintext.fill(0);
  }
  return {
    id,
    address: wallet.address,
    createdAt,
    version: 1,
    iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
    ciphertext,
  };
}

/**
 * Encrypts in bounded parallel waves. The output order remains identical to the
 * input order, while each Worker keeps at most 64 AES-GCM operations in flight.
 */
export async function encryptWalletBatch(
  key: CryptoKey,
  scope: string,
  wallets: Array<{ privateKey: string; address: string; derivationPath: 'private-key' }>,
): Promise<EncryptedWalletRecord[]> {
  if (wallets.length === 0) return [];

  const encrypted = new Array<EncryptedWalletRecord>(wallets.length);
  let nextIndex = 0;
  let hasFailed = false;
  let failure: unknown;

  const runWorker = async (): Promise<void> => {
    while (!hasFailed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= wallets.length) return;
      try {
        encrypted[index] = await encryptWalletRecord(key, scope, wallets[index]);
      } catch (error) {
        if (!hasFailed) {
          hasFailed = true;
          failure = error;
        }
        return;
      }
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_WALLET_ENCRYPTIONS, wallets.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (hasFailed) throw failure;
  return encrypted;
}

export async function decryptWalletPrivateKey(key: CryptoKey, scope: string, record: EncryptedWalletRecord): Promise<string> {
  if (!isEncryptedWalletRecord(record)) {
    throw new Error('ساختار رکورد رمزگذاری‌شده ناقص یا ناسازگار است؛ داده اصلی تغییر داده نشد.');
  }
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: record.iv,
      additionalData: walletAad(scope, record.id, record.address, record.createdAt),
      tagLength: 128,
    },
    key,
    record.ciphertext,
  ));
  try {
    const privateKey = new TextDecoder().decode(plaintext);
    if (!/^[0-9a-f]{64}$/i.test(privateKey)) throw new Error('محتوای کلید خصوصی رمزگشایی‌شده معتبر نیست.');
    return privateKey;
  } finally {
    plaintext.fill(0);
  }
}
