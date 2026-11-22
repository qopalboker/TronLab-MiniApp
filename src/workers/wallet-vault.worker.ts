import { deriveTronAddressFromPrivateKey, generateTronPrivateKeyWalletBatch } from '../lib/tronPrivateKey';
import { configureDatabaseScope, getEncryptedWalletRecord, openLocalDatabase, saveEncryptedWalletBatch } from '../lib/localDb';
import { decryptWalletPrivateKey, encryptWalletBatch } from '../lib/vaultCrypto';
import { generateAndMatchBatch, createMatcherFromTargets } from '../lib/generateAndMatch';
import { BloomFilter } from '../lib/bloomFilter';
import type { BuiltTargetAddressSet } from '../lib/targetAddressSet';

interface InitMessage { id: string; type: 'init-vault'; key: CryptoKey; scope: string }
interface GenerateMessage { id: string; type: 'generate-and-store-batch'; count: number }
/**
 * Targeted generation: only exact matches against the provided address list are
 * encrypted and persisted. Non-matching private keys are wiped inside generateAndMatchBatch.
 * Intended for moderate target sets transferred via structured clone.
 */
interface GenerateMatchMessage {
  id: string;
  type: 'generate-match-and-store-batch';
  count: number;
  /** Exact, validated TRON addresses. Empty array means match-nothing (all discarded). */
  targetAddresses: string[];
  /** Optional precomputed Bloom bits for large sets; if omitted a local Bloom is built. */
  bloomBits?: ArrayBuffer;
  bloomBitCount?: number;
  bloomHashCount?: number;
}
interface DecryptMessage { id: string; type: 'decrypt-wallet'; walletId: string }
type Request = InitMessage | GenerateMessage | GenerateMatchMessage | DecryptMessage;

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

let vaultKey: CryptoKey | null = null;
let databaseScope = '';
let initialized = false;

function respond(message: Record<string, unknown>): void {
  workerScope.postMessage(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return 'فضای ذخیره‌سازی دستگاه کافی نیست؛ تولید متوقف شد و رکوردهای قبلی حفظ شدند.';
  }
  return error instanceof Error ? error.message : 'عملیات امن Worker ناموفق بود.';
}

async function initialize(request: InitMessage): Promise<void> {
  if (!request.scope || !request.key || request.key.extractable) throw new Error('کلید یا محدوده دیتابیس امن معتبر نیست.');
  configureDatabaseScope(request.scope);
  await openLocalDatabase();
  databaseScope = request.scope;
  vaultKey = request.key;
  initialized = true;
  respond({ id: request.id, type: 'ready' });
}

async function generateAndStore(request: GenerateMessage): Promise<void> {
  if (!initialized || !vaultKey) throw new Error('Worker هنوز با کلید امن راه‌اندازی نشده است.');
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 2048) throw new Error('اندازه دسته تولید خارج از محدوده مجاز است.');

  const startedAt = performance.now();
  const wallets = generateTronPrivateKeyWalletBatch(request.count);
  try {
    const encryptedRecords = await encryptWalletBatch(vaultKey, databaseScope, wallets);
    const saveResult = await saveEncryptedWalletBatch(encryptedRecords);
    const durationMs = performance.now() - startedAt;
    for (const wallet of wallets) {
      wallet.privateKey = '';
      wallet.address = '';
    }
    wallets.length = 0;
    encryptedRecords.length = 0;
    respond({ id: request.id, type: 'batch-saved', count: saveResult.inserted, duplicates: saveResult.duplicates, durationMs });
  } catch (error) {
    for (const wallet of wallets) {
      wallet.privateKey = '';
      wallet.address = '';
    }
    wallets.length = 0;
    throw error;
  }
}

function buildMatcherFromMessage(request: GenerateMatchMessage) {
  const exact = new Set(request.targetAddresses);
  let bloom: BloomFilter | null = null;

  if (request.bloomBits && request.bloomBitCount && request.bloomHashCount) {
    try {
      bloom = BloomFilter.fromBits(
        new Uint8Array(request.bloomBits),
        request.bloomBitCount,
        request.bloomHashCount,
      );
    } catch {
      bloom = null;
    }
  }

  if (!bloom && exact.size > 0) {
    bloom = new BloomFilter(exact.size);
    for (const address of exact) bloom.add(address);
  }

  const targets: BuiltTargetAddressSet = {
    size: exact.size,
    has: (address: string) => exact.has(address),
    bloom,
    exact,
    summary: {
      totalLines: exact.size,
      blankLines: 0,
      validUnique: exact.size,
      invalid: 0,
      duplicates: 0,
      bloomBytes: bloom?.byteLength ?? 0,
    },
  };
  return createMatcherFromTargets(targets);
}

async function generateMatchAndStore(request: GenerateMatchMessage): Promise<void> {
  if (!initialized || !vaultKey) throw new Error('Worker هنوز با کلید امن راه‌اندازی نشده است.');
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 2048) {
    throw new Error('اندازه دسته تولید خارج از محدوده مجاز است.');
  }
  if (!Array.isArray(request.targetAddresses)) {
    throw new Error('لیست آدرس‌های هدف نامعتبر است.');
  }

  const matcher = buildMatcherFromMessage(request);
  const result = generateAndMatchBatch(request.count, matcher);

  try {
    if (result.matched.length === 0) {
      respond({
        id: request.id,
        type: 'batch-saved',
        count: 0,
        duplicates: 0,
        durationMs: result.durationMs,
        generated: result.generated,
        matched: 0,
        discarded: result.discarded,
      });
      return;
    }

    const encryptedRecords = await encryptWalletBatch(vaultKey!, databaseScope, result.matched);
    const saveResult = await saveEncryptedWalletBatch(encryptedRecords);
    encryptedRecords.length = 0;

    respond({
      id: request.id,
      type: 'batch-saved',
      count: saveResult.inserted,
      duplicates: saveResult.duplicates,
      durationMs: result.durationMs,
      generated: result.generated,
      matched: result.matched.length,
      discarded: result.discarded,
    });
  } finally {
    for (const wallet of result.matched) {
      wallet.privateKey = '';
      wallet.address = '';
    }
    result.matched.length = 0;
  }
}

async function decryptWallet(request: DecryptMessage): Promise<void> {
  if (!initialized || !vaultKey) throw new Error('Worker هنوز با کلید امن راه‌اندازی نشده است.');
  const record = await getEncryptedWalletRecord(request.walletId);
  if (!record) throw new Error('رکورد کیف‌پول در دیتابیس پیدا نشد.');
  let privateKey = await decryptWalletPrivateKey(vaultKey, databaseScope, record);
  try {
    const derivedAddress = deriveTronAddressFromPrivateKey(privateKey);
    if (derivedAddress !== record.address) throw new Error('اعتبارسنجی آدرس پس از رمزگشایی ناموفق بود.');
    respond({
      id: request.id,
      type: 'decrypted-wallet',
      wallet: { id: record.id, address: record.address, privateKey, createdAt: record.createdAt },
    });
  } finally {
    // Best-effort release; immutable JS strings cannot be reliably zeroized.
    privateKey = '';
  }
}

workerScope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === 'init-vault') await initialize(request);
      else if (request.type === 'generate-and-store-batch') await generateAndStore(request);
      else if (request.type === 'generate-match-and-store-batch') await generateMatchAndStore(request);
      else await decryptWallet(request);
    } catch (error) {
      respond({ id: request.id, type: 'error', message: errorMessage(error) });
    }
  })();
};

export {};
