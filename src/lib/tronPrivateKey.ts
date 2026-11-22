import { secp256k1 } from '@noble/curves/secp256k1';
import { tronAddressFromPublicKey } from './tronAddress';
import { MAX_PRIVATE_KEY_BATCH_SIZE } from './walletConstants';

const SECP256K1_ORDER_BYTES = new Uint8Array([
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
  0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
  0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
]);

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function isValidPrivateKeyBytes(bytes: Uint8Array): boolean {
  if (bytes.length !== SECP256K1_ORDER_BYTES.length) return false;

  let nonZero = false;
  for (const byte of bytes) {
    if (byte !== 0) nonZero = true;
  }
  if (!nonZero) return false;

  // Unsigned big-endian lexicographic comparison is equivalent to scalar < n.
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] < SECP256K1_ORDER_BYTES[index]) return true;
    if (bytes[index] > SECP256K1_ORDER_BYTES[index]) return false;
  }

  // The curve order itself is invalid (the comparison was equal).
  return false;
}

/**
 * Creates standalone TRON wallets from uniformly random secp256k1 private keys.
 * Entropy for the whole batch is fetched in one CSPRNG call, then invalid curve
 * scalars are rejection-sampled individually. Private byte buffers are wiped best-effort.
 */
export function generateTronPrivateKeyWalletBatch(count: number): Array<{
  privateKey: string;
  address: string;
  derivationPath: 'private-key';
}> {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PRIVATE_KEY_BATCH_SIZE) {
    throw new Error(`تعداد کلیدهای هر دسته باید بین ۱ تا ${MAX_PRIVATE_KEY_BATCH_SIZE} باشد.`);
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('مولد تصادفی رمزنگاری‌شده در این محیط در دسترس نیست؛ برنامه را از HTTPS اجرا کن.');
  }

  const entropy = new Uint8Array(count * 32);
  const wallets: Array<{ privateKey: string; address: string; derivationPath: 'private-key' }> = [];
  try {
    globalThis.crypto.getRandomValues(entropy);
    for (let index = 0; index < count; index += 1) {
      const privateKeyBytes = entropy.slice(index * 32, (index + 1) * 32);
      let publicKey: Uint8Array | null = null;
      try {
        let attempts = 0;
        while (!isValidPrivateKeyBytes(privateKeyBytes)) {
          globalThis.crypto.getRandomValues(privateKeyBytes);
          attempts += 1;
          if (attempts > 16) throw new Error('تولید کلید خصوصی تصادفی ناموفق بود.');
        }

        const privateKey = bytesToHex(privateKeyBytes);
        const generatedPublicKey = secp256k1.getPublicKey(privateKeyBytes, false);
        publicKey = generatedPublicKey;
        wallets.push({
          privateKey,
          address: tronAddressFromPublicKey(generatedPublicKey),
          derivationPath: 'private-key',
        });
      } finally {
        privateKeyBytes.fill(0);
        publicKey?.fill(0);
      }
    }
    return wallets;
  } finally {
    entropy.fill(0);
  }
}

/** Creates a single standalone TRON wallet using the same batch-safe generator. */
export function generateTronPrivateKeyWallet(): {
  privateKey: string;
  address: string;
  derivationPath: 'private-key';
} {
  return generateTronPrivateKeyWalletBatch(1)[0];
}

/** Validate a 32-byte hex private key and derive its corresponding TRON address. */
export function deriveTronAddressFromPrivateKey(privateKeyInput: string): string {
  const normalized = privateKeyInput.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('کلید خصوصی باید دقیقاً ۳۲ بایت هگزادسیمال (۶۴ نویسه) باشد.');
  }

  const privateKeyBytes = new Uint8Array(32);
  for (let index = 0; index < privateKeyBytes.length; index += 1) {
    privateKeyBytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  if (!isValidPrivateKeyBytes(privateKeyBytes)) {
    privateKeyBytes.fill(0);
    throw new Error('مقدار کلید خصوصی خارج از محدوده معتبر secp256k1 است.');
  }

  let publicKey: Uint8Array | null = null;
  try {
    const derivedPublicKey = secp256k1.getPublicKey(privateKeyBytes, false);
    publicKey = derivedPublicKey;
    return tronAddressFromPublicKey(derivedPublicKey);
  } finally {
    privateKeyBytes.fill(0);
    publicKey?.fill(0);
  }
}
