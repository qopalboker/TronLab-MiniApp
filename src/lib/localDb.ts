import type { LocalStats, MatchRecord } from '../types';
import { isEncryptedWalletRecord, isVaultCheckRecord, type EncryptedWalletRecord, type VaultCheckRecord } from './vaultCrypto';
import { deduplicateWalletBatch } from './walletBatch';
import { chooseAddressScanMode, hasSafeUnmatchedPurgeAnchor, isWalletInMatchSnapshot, type WalletMatchSnapshot } from './walletAddressMatching';
import {
  advanceGenerationCheckpoint,
  GENERATION_CHECKPOINT_KEY,
  isGenerationCheckpoint,
  markCheckpointInterrupted,
  markCheckpointPaused,
  startOrResumeCheckpoint,
  type GenerationCheckpoint,
} from './generationCheckpoint';
import {
  addWalletUsageStatsDelta,
  createInitialWalletUsageStats,
  isWalletUsageStats,
  WALLET_USAGE_STATS_KEY,
  type WalletUsageStats,
  type WalletUsageStatsDelta,
} from './walletUsageStats';
import {
  createEmptyTxtImportHistory,
  isTxtImportHistory,
  registerTxtImport as registerTxtImportInHistory,
  setTxtImportStatus as setTxtImportStatusInHistory,
  TXT_IMPORT_HISTORY_KEY,
  type NewTxtImportRecord,
  type TxtImportHistory,
  type TxtImportRecord,
  type TxtImportStatus,
} from './txtImportHistory';

const DB_NAME = 'tron-wallet-lab-v2';
const DB_VERSION = 3;
const TARGETS = 'targets';
const MATCHES = 'matches';
const WALLETS = 'wallets';
const VAULT_META = 'vaultMeta';

let databasePromise: Promise<IDBDatabase> | null = null;
let databaseScope = 'local-preview';

/** Namespace local data by the current Telegram user (partition only, not server authentication). */
export function configureDatabaseScope(scope: string): void {
  const nextScope = scope || 'local-preview';
  if (databasePromise && databaseScope !== nextScope) throw new Error('Database scope cannot change after IndexedDB has been opened.');
  databaseScope = nextScope;
}

function normalizeDatabaseError(error: unknown, fallback: string): Error {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  if (name === 'QuotaExceededError') {
    return new Error('فضای ذخیره‌سازی دستگاه کافی نیست؛ عملیات جدید متوقف شد و داده‌های ثبت‌شده قبلی حفظ شدند. مقداری فضا خالی کن و دوباره تلاش کن.');
  }
  if (name === 'AbortError') {
    return new Error('تراکنش دیتابیس کامل نشد؛ تغییرات این مرحله ثبت نشدند. وضعیت ذخیره‌شده قبلی حفظ شد.');
  }
  if (name === 'InvalidStateError' || name === 'NotFoundError') {
    return new Error('اتصال یا ساختار دیتابیس در دسترس نیست؛ برنامه را ببند و دوباره باز کن. هیچ بازیابی یا حذف خودکاری انجام نشد.');
  }
  if (name === 'VersionError' || name === 'ConstraintError') {
    return new Error('ساختار دیتابیس با این نسخه سازگار نیست؛ برای جلوگیری از آسیب به داده‌ها عملیات متوقف شد.');
  }
  if (name === 'SecurityError') {
    return new Error('مرورگر اجازه دسترسی امن به دیتابیس محلی را نداد.');
  }
  return new Error(fallback);
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(normalizeDatabaseError(request.error, 'خواندن داده محلی ناموفق بود.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(normalizeDatabaseError(transaction.error, 'تراکنش دیتابیس ناموفق بود.'));
    transaction.onabort = () => reject(normalizeDatabaseError(transaction.error, 'تراکنش دیتابیس لغو شد.'));
  });
}

/** Queue an aggregate telemetry update inside an existing wallets + vaultMeta transaction. */
function queueWalletUsageStatsDelta(
  transaction: IDBTransaction,
  delta: WalletUsageStatsDelta,
  baselineWalletCountAdjustment = 0,
): Promise<WalletUsageStats> {
  const metadata = transaction.objectStore(VAULT_META);
  const walletCountRequest = transaction.objectStore(WALLETS).count();
  const statsRequest = metadata.get(WALLET_USAGE_STATS_KEY);

  return new Promise((resolve, reject) => {
    let walletCount: number | null = null;
    let storedStats: unknown;
    let statsLoaded = false;
    let completed = false;

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
      reject(new Error(message));
    };

    const apply = () => {
      if (completed || walletCount === null || !statsLoaded) return;
      try {
        const baselineCount = walletCount + baselineWalletCountAdjustment;
        if (!Number.isSafeInteger(baselineCount) || baselineCount < 0) {
          fail('تعداد پایه کیف‌پول‌ها برای ثبت آمار معتبر نیست.');
          return;
        }
        const current = storedStats === undefined
          ? createInitialWalletUsageStats(baselineCount)
          : storedStats;
        if (!isWalletUsageStats(current)) {
          fail('ساختار آمار ذخیره‌شده خراب یا ناسازگار است؛ دسته جدید ثبت نشد.');
          return;
        }
        const next = addWalletUsageStatsDelta(current, delta);
        const putRequest = metadata.put(next);
        putRequest.onerror = () => fail('ثبت آمار تجمیعی ناموفق بود؛ تراکنش جاری لغو شد.');
        putRequest.onsuccess = () => {
          if (completed) return;
          completed = true;
          resolve(next);
        };
      } catch (error) {
        fail(error instanceof Error ? error.message : 'به‌روزرسانی آمار تجمیعی ناموفق بود.');
      }
    };

    walletCountRequest.onerror = () => fail('خواندن تعداد کیف‌پول‌ها برای ثبت آمار ناموفق بود.');
    walletCountRequest.onsuccess = () => {
      walletCount = walletCountRequest.result;
      apply();
    };
    statsRequest.onerror = () => fail('خواندن آمار ذخیره‌شده ناموفق بود.');
    statsRequest.onsuccess = () => {
      storedStats = statsRequest.result;
      statsLoaded = true;
      apply();
    };
  });
}

export function openLocalDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB در این محیط در دسترس نیست.'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let wasBlocked = false;
    const request = indexedDB.open(`${DB_NAME}:${encodeURIComponent(databaseScope)}`, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TARGETS)) {
        database.createObjectStore(TARGETS, { keyPath: 'address' });
      }
      if (!database.objectStoreNames.contains(MATCHES)) {
        const matches = database.createObjectStore(MATCHES, { keyPath: 'id' });
        matches.createIndex('byMatchedAt', 'matchedAt', { unique: false });
        matches.createIndex('byGroup', 'group', { unique: false });
      }
      const wallets = database.objectStoreNames.contains(WALLETS)
        ? request.transaction!.objectStore(WALLETS)
        : database.createObjectStore(WALLETS, { keyPath: 'id' });
      if (!wallets.indexNames.contains('byCreatedAt')) {
        wallets.createIndex('byCreatedAt', 'createdAt', { unique: false });
      }
      // Non-unique for compatibility with existing records; writes enforce uniqueness
      // transactionally so older databases with accidental duplicates still upgrade.
      if (!wallets.indexNames.contains('byAddress')) {
        wallets.createIndex('byAddress', 'address', { unique: false });
      }
      if (!database.objectStoreNames.contains(VAULT_META)) {
        database.createObjectStore(VAULT_META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (wasBlocked) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      database.onclose = () => {
        const currentPromise = databasePromise;
        if (currentPromise) {
          void currentPromise.then((currentDatabase) => {
            if (currentDatabase === database) databasePromise = null;
          }).catch(() => { /* a rejected open promise is already cleared by onerror */ });
        }
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(normalizeDatabaseError(request.error, 'بازکردن دیتابیس محلی ناموفق بود.'));
    };
    request.onblocked = () => {
      wasBlocked = true;
      databasePromise = null;
      reject(new Error('دیتابیس توسط نسخه دیگری از برنامه باز مانده است. همه نسخه‌های قدیمی برنامه را ببند و دوباره تلاش کن.'));
    };
  });
  return databasePromise;
}

/** Add targets with a unique key. Duplicate key errors are handled without aborting the batch. */
export async function addTargetBatch(addresses: string[]): Promise<{ inserted: number; duplicates: number }> {
  if (addresses.length === 0) return { inserted: 0, duplicates: 0 };
  const database = await openLocalDatabase();
  const transaction = database.transaction(TARGETS, 'readwrite');
  const store = transaction.objectStore(TARGETS);
  let inserted = 0;
  let duplicates = 0;
  for (const address of addresses) {
    const request = store.add({ address, addedAt: new Date().toISOString() });
    request.onsuccess = () => { inserted += 1; };
    request.onerror = (event) => {
      event.preventDefault();
      event.stopPropagation();
      duplicates += 1;
    };
  }
  await transactionDone(transaction);
  return { inserted, duplicates };
}

export async function getLocalStats(): Promise<LocalStats> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([TARGETS, MATCHES], 'readonly');
  const done = transactionDone(transaction);
  const targets = requestValue(transaction.objectStore(TARGETS).count());
  const matches = requestValue(transaction.objectStore(MATCHES).count());
  const [targetCount, matchCount] = await Promise.all([targets, matches, done]);
  return { targetCount, matchCount };
}

export async function getTargetCount(): Promise<number> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(TARGETS, 'readonly');
  const done = transactionDone(transaction);
  const [count] = await Promise.all([requestValue(transaction.objectStore(TARGETS).count()), done]);
  return count;
}

/** Exact-confirm a group of possible matches with one IndexedDB transaction. */
export async function findExistingTargets(addresses: string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const database = await openLocalDatabase();
  const transaction = database.transaction(TARGETS, 'readonly');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(TARGETS);
  const checks = addresses.map((address) => requestValue(store.getKey(address)));
  const [keys] = await Promise.all([Promise.all(checks), done]);
  const found = new Set<string>();
  for (let index = 0; index < addresses.length; index += 1) {
    if (keys[index] !== undefined) found.add(addresses[index]);
  }
  return found;
}

export async function saveMatchBatch(matches: MatchRecord[]): Promise<void> {
  if (matches.length === 0) return;
  const database = await openLocalDatabase();
  const transaction = database.transaction(MATCHES, 'readwrite');
  const store = transaction.objectStore(MATCHES);
  for (const match of matches) store.put(match);
  await transactionDone(transaction);
}

export async function listMatches(limit = 500): Promise<MatchRecord[]> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(MATCHES, 'readonly');
  const done = transactionDone(transaction);
  const index = transaction.objectStore(MATCHES).index('byMatchedAt');
  const rows: MatchRecord[] = [];
  const cursorDone = new Promise<void>((resolve, reject) => {
    const request = index.openCursor(null, 'prev');
    request.onerror = () => reject(request.error || new Error('خواندن نتایج ناموفق بود.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        resolve();
        return;
      }
      rows.push(cursor.value as MatchRecord);
      cursor.continue();
    };
  });
  await Promise.all([cursorDone, done]);
  return rows;
}


export async function getAllMatches(): Promise<MatchRecord[]> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(MATCHES, 'readonly');
  const done = transactionDone(transaction);
  const [rows] = await Promise.all([requestValue(transaction.objectStore(MATCHES).getAll()) as Promise<MatchRecord[]>, done]);
  return rows.sort((left, right) => left.matchedAt.localeCompare(right.matchedAt));
}

export async function clearMatchResults(): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(MATCHES, 'readwrite');
  transaction.objectStore(MATCHES).clear();
  await transactionDone(transaction);
}

export async function clearTargetAddresses(): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([TARGETS, MATCHES], 'readwrite');
  transaction.objectStore(TARGETS).clear();
  transaction.objectStore(MATCHES).clear();
  await transactionDone(transaction);
}

export async function forEachTarget(callback: (address: string) => void): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(TARGETS, 'readonly');
  const done = transactionDone(transaction);
  const cursorDone = new Promise<void>((resolve, reject) => {
    const request = transaction.objectStore(TARGETS).openCursor();
    request.onerror = () => reject(request.error || new Error('خواندن فهرست آدرس‌ها ناموفق بود.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      callback((cursor.value as { address: string }).address);
      cursor.continue();
    };
  });
  await Promise.all([cursorDone, done]);
}


export interface WalletSummary {
  id: string;
  address: string;
  createdAt: string;
}

export interface WalletPageData {
  total: number;
  rows: WalletSummary[];
}

/** Initializes aggregate-only telemetry for legacy vaults without changing the DB schema. */
export async function getOrInitializeWalletUsageStats(): Promise<WalletUsageStats> {
  const database = await openLocalDatabase();
  // Fast path for established vaults: do not count every wallet on each entry
  // when aggregate telemetry has already been initialized.
  {
    const readTransaction = database.transaction(VAULT_META, 'readonly');
    const readDone = transactionDone(readTransaction);
    const [storedStats] = await Promise.all([
      requestValue(readTransaction.objectStore(VAULT_META).get(WALLET_USAGE_STATS_KEY)) as Promise<unknown>,
      readDone,
    ]);
    if (storedStats !== undefined) {
      if (!isWalletUsageStats(storedStats)) {
        throw new Error('ساختار آمار ذخیره‌شده خراب است؛ اطلاعات اصلی خزانه تغییر نکرد.');
      }
      return storedStats;
    }
  }

  // First run / legacy vault: initialize once using the actual current count.
  // The write transaction rechecks metadata to remain safe if another tab
  // initialized the aggregate between the fast read and this transaction.
  const transaction = database.transaction([WALLETS, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const walletCountRequest = transaction.objectStore(WALLETS).count();
  const metadata = transaction.objectStore(VAULT_META);
  const statsRequest = metadata.get(WALLET_USAGE_STATS_KEY);
  let result: WalletUsageStats | null = null;
  let walletCount: number | null = null;
  let rawStats: unknown;
  let statsLoaded = false;
  let countLoaded = false;
  let failed = false;

  const finish = () => {
    if (failed || !statsLoaded || !countLoaded || result) return;
    try {
      if (rawStats === undefined) {
        result = createInitialWalletUsageStats(walletCount!);
        metadata.put(result);
      } else if (isWalletUsageStats(rawStats)) {
        result = rawStats;
      } else {
        failed = true;
        try { transaction.abort(); } catch { /* transaction may already be closing */ }
      }
    } catch {
      failed = true;
      try { transaction.abort(); } catch { /* transaction may already be closing */ }
    }
  };

  walletCountRequest.onsuccess = () => { walletCount = walletCountRequest.result; countLoaded = true; finish(); };
  walletCountRequest.onerror = () => { failed = true; try { transaction.abort(); } catch { /* ignored */ } };
  statsRequest.onsuccess = () => { rawStats = statsRequest.result; statsLoaded = true; finish(); };
  statsRequest.onerror = () => { failed = true; try { transaction.abort(); } catch { /* ignored */ } };

  try {
    await done;
  } catch (error) {
    if (failed && !result) throw new Error('آمار ذخیره‌شده خراب است یا مقداردهی اولیه آن ناموفق بود؛ اطلاعات اصلی خزانه تغییر نکرد.');
    throw error;
  }
  if (!result) throw new Error('مقداردهی اولیه آمار خزانه ناموفق بود.');
  return result;
}

/** Update aggregate counters only; no address, file line, or failed result is persisted. */
export async function recordWalletUsageStats(delta: WalletUsageStatsDelta): Promise<WalletUsageStats> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const metadata = transaction.objectStore(VAULT_META);
  const request = metadata.get(WALLET_USAGE_STATS_KEY);
  let result: WalletUsageStats | null = null;
  let updateFailure: Error | null = null;
  request.onerror = () => { updateFailure = new Error('خواندن آمار تجمیعی ناموفق بود.'); };
  request.onsuccess = () => {
    try {
      const current = request.result === undefined
        ? createInitialWalletUsageStats(0)
        : request.result;
      if (!isWalletUsageStats(current)) throw new Error('ساختار آمار ذخیره‌شده خراب یا ناسازگار است.');
      result = addWalletUsageStatsDelta(current, delta);
      metadata.put(result);
    } catch (error) {
      updateFailure = error instanceof Error ? error : new Error('ثبت آمار تجمیعی ناموفق بود.');
      try { transaction.abort(); } catch { /* transaction may already be closing */ }
    }
  };
  try {
    await done;
  } catch (error) {
    if (updateFailure) throw updateFailure;
    throw error;
  }
  if (!result) throw new Error('ثبت آمار تجمیعی ناموفق بود.');
  return result;
}

/** Load only file metadata and SHA-256 fingerprints; TXT contents are never persisted. */
export async function getTxtImportHistory(): Promise<TxtImportHistory> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readonly');
  const done = transactionDone(transaction);
  const [raw] = await Promise.all([
    requestValue(transaction.objectStore(VAULT_META).get(TXT_IMPORT_HISTORY_KEY)) as Promise<unknown>,
    done,
  ]);
  if (raw === undefined) return createEmptyTxtImportHistory();
  if (!isTxtImportHistory(raw)) throw new Error('تاریخچه فایل TXT خراب یا ناسازگار است؛ برای جلوگیری از اجرای دوباره فایل، ورودی جدید پذیرفته نشد.');
  return raw;
}

/** Register a file fingerprint once. Exact re-uploads are reported without starting another automatic run. */
export async function registerTxtImportFile(input: NewTxtImportRecord): Promise<{ record: TxtImportRecord; duplicate: boolean }> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const metadata = transaction.objectStore(VAULT_META);
  const request = metadata.get(TXT_IMPORT_HISTORY_KEY);
  let result: { record: TxtImportRecord; duplicate: boolean } | null = null;
  let updateFailure: Error | null = null;
  request.onerror = () => { updateFailure = new Error('خواندن تاریخچه فایل‌های TXT ناموفق بود.'); };
  request.onsuccess = () => {
    try {
      const raw = request.result;
      const current = raw === undefined ? createEmptyTxtImportHistory() : raw;
      if (!isTxtImportHistory(current)) throw new Error('تاریخچه فایل TXT خراب یا ناسازگار است؛ هیچ سابقه‌ای بازنویسی نشد.');
      const next = registerTxtImportInHistory(current, input);
      result = { record: next.record, duplicate: next.duplicate };
      if (!next.duplicate) metadata.put(next.history);
    } catch (error) {
      updateFailure = error instanceof Error ? error : new Error('ثبت اثرانگشت فایل TXT ناموفق بود.');
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
    }
  };
  try {
    await done;
  } catch (error) {
    if (updateFailure) throw updateFailure;
    throw error;
  }
  if (!result) throw new Error('ثبت سابقه فایل TXT انجام نشد.');
  return result;
}

/** Persist only the current processing state for a known file fingerprint. */
export async function updateTxtImportFileStatus(sha256: string, status: TxtImportStatus): Promise<TxtImportRecord> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const metadata = transaction.objectStore(VAULT_META);
  const request = metadata.get(TXT_IMPORT_HISTORY_KEY);
  let result: TxtImportRecord | null = null;
  let updateFailure: Error | null = null;
  request.onerror = () => { updateFailure = new Error('خواندن تاریخچه فایل TXT برای ثبت وضعیت ناموفق بود.'); };
  request.onsuccess = () => {
    try {
      const raw = request.result;
      if (!isTxtImportHistory(raw)) throw new Error('تاریخچه فایل TXT موجود نیست یا ساختار آن معتبر نیست.');
      const next = setTxtImportStatusInHistory(raw, sha256, status);
      if (!next.record) throw new Error('سابقه این فایل TXT پیدا نشد؛ وضعیت پردازش ذخیره نشد.');
      result = next.record;
      metadata.put(next.history);
    } catch (error) {
      updateFailure = error instanceof Error ? error : new Error('ثبت وضعیت فایل TXT ناموفق بود.');
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
    }
  };
  try {
    await done;
  } catch (error) {
    if (updateFailure) throw updateFailure;
    throw error;
  }
  if (!result) throw new Error('به‌روزرسانی وضعیت فایل TXT انجام نشد.');
  return result;
}

export interface VaultState {
  walletCount: number;
  hasKeyCheck: boolean;
}

export async function getVaultState(): Promise<VaultState> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([WALLETS, VAULT_META], 'readonly');
  const done = transactionDone(transaction);
  const walletCountPromise = requestValue(transaction.objectStore(WALLETS).count());
  const keyCheckPromise = requestValue(transaction.objectStore(VAULT_META).get('key-check'));
  const [walletCount, keyCheck] = await Promise.all([walletCountPromise, keyCheckPromise, done]);
  return { walletCount, hasKeyCheck: Boolean(keyCheck) };
}

export interface WalletBatchSaveResult {
  inserted: number;
  duplicates: number;
}


/**
 * Saves a batch and advances its checkpoint in the same strict transaction.
 * A crash can therefore never advance the checkpoint without committing the
 * corresponding wallet records, or commit only part of a batch.
 */
export async function saveEncryptedWalletBatch(records: EncryptedWalletRecord[]): Promise<WalletBatchSaveResult> {
  if (records.length === 0) return { inserted: 0, duplicates: 0 };
  const database = await openLocalDatabase();
  const transaction = database.transaction([WALLETS, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const store = transaction.objectStore(WALLETS);
  const addressIndex = store.index('byAddress');
  const metaStore = transaction.objectStore(VAULT_META);
  let inserted = 0;
  let duplicates = 0;
  let checkpointFailure: Error | null = null;
  let batchFinalized = false;

  const abortForCheckpoint = (message: string) => {
    checkpointFailure = new Error(message);
    try { transaction.abort(); } catch { /* it may already have aborted */ }
  };

  // Validate every record before it enters the transaction. Invalid encrypted bytes
  // are never persisted and the transaction is aborted as one atomic operation.
  if (records.some((record) => !isEncryptedWalletRecord(record))) {
    abortForCheckpoint('ساختار یکی از رکوردهای رمزگذاری‌شده معتبر نیست؛ هیچ رکوردی از این دسته ذخیره نشد.');
  }

  const deduplicated = checkpointFailure
    ? { uniqueRecords: [] as EncryptedWalletRecord[], duplicates: 0 }
    : deduplicateWalletBatch(records);
  duplicates = deduplicated.duplicates;
  const uniqueRecords = deduplicated.uniqueRecords;

  const finishBatch = () => {
    if (batchFinalized || checkpointFailure) return;
    batchFinalized = true;
    const checkpointRequest = metaStore.get(GENERATION_CHECKPOINT_KEY);
    checkpointRequest.onerror = () => abortForCheckpoint('خواندن نقطه بازیابی ناموفق بود؛ دسته فعلی ذخیره نشد.');
    checkpointRequest.onsuccess = () => {
      const checkpoint = checkpointRequest.result as unknown;
      if (!isGenerationCheckpoint(checkpoint)) {
        abortForCheckpoint('نقطه بازیابی وجود ندارد یا ساختار آن خراب است؛ برای حفظ هماهنگی دیتابیس، این دسته ذخیره نشد.');
        return;
      }
      if (checkpoint.status !== 'running') {
        abortForCheckpoint('نقطه بازیابی در وضعیت اجرای فعال نیست؛ دسته جدید ذخیره نشد.');
        return;
      }
      try {
        const nextCheckpoint = advanceGenerationCheckpoint(checkpoint, inserted, duplicates, new Date().toISOString());
        metaStore.put(nextCheckpoint);
      } catch {
        abortForCheckpoint('به‌روزرسانی نقطه بازیابی معتبر نبود؛ هیچ تغییری از این دسته ثبت نشد.');
      }
    };

    // The aggregate counters are committed atomically with the wallet batch and checkpoint.
    // walletCount is read after inserts, so subtract inserted to seed legacy telemetry correctly.
    void queueWalletUsageStatsDelta(transaction, {
      generatedCount: records.length,
      successfulWalletCount: inserted,
      notStoredCount: records.length - inserted,
    }, -inserted).catch((error) => {
      abortForCheckpoint(error instanceof Error ? error.message : 'ثبت آمار دسته ناموفق بود؛ دسته ذخیره نشد.');
    });
  };

  if (!checkpointFailure) {
    let pendingLookups = uniqueRecords.length;
    const candidates: EncryptedWalletRecord[] = [];
    if (pendingLookups === 0) {
      finishBatch();
    } else {
      for (const record of uniqueRecords) {
        const lookup = addressIndex.getKey(record.address);
        lookup.onerror = () => abortForCheckpoint('بررسی تکراری‌بودن آدرس ناموفق بود؛ دسته فعلی ذخیره نشد.');
        lookup.onsuccess = () => {
          if (checkpointFailure) return;
          if (lookup.result !== undefined) duplicates += 1;
          else candidates.push(record);
          pendingLookups -= 1;
          if (pendingLookups !== 0) return;

          if (candidates.length === 0) {
            finishBatch();
            return;
          }
          let completedAdds = 0;
          for (const candidate of candidates) {
            const addRequest = store.add(candidate);
            addRequest.onsuccess = () => {
              inserted += 1;
              completedAdds += 1;
              if (completedAdds === candidates.length) finishBatch();
            };
            addRequest.onerror = () => {
              const storageError = normalizeDatabaseError(addRequest.error, 'ثبت یکی از رکوردهای این دسته ناموفق بود؛ تمام تغییرات دسته لغو شد.');
              abortForCheckpoint(storageError.message);
            };
          }
        };
      }
    }
  }

  try {
    await done;
  } catch (error) {
    if (checkpointFailure) throw checkpointFailure;
    throw error;
  }
  return { inserted, duplicates };
}

export interface VaultDatabaseHealth {
  healthy: boolean;
  schemaVersion: number;
  walletCount: number;
  issues: string[];
}

/**
 * Read-only structural audit. It never decrypts wallet data, repairs records,
 * recreates key material, or deletes anything.
 */
export async function inspectVaultDatabaseHealth(): Promise<VaultDatabaseHealth> {
  const database = await openLocalDatabase();
  const issues: string[] = [];
  const requiredStores = [TARGETS, MATCHES, WALLETS, VAULT_META];
  const missingStores = requiredStores.filter((name) => !database.objectStoreNames.contains(name));
  if (missingStores.length > 0) {
    return {
      healthy: false,
      schemaVersion: database.version,
      walletCount: 0,
      issues: [`مخزن‌های ضروری دیتابیس موجود نیستند: ${missingStores.join(', ')}.`],
    };
  }

  const transaction = database.transaction([WALLETS, MATCHES, VAULT_META, TARGETS], 'readonly');
  const done = transactionDone(transaction);
  const wallets = transaction.objectStore(WALLETS);
  const matches = transaction.objectStore(MATCHES);
  const metadata = transaction.objectStore(VAULT_META);
  if (wallets.keyPath !== 'id') issues.push('کلید اصلی مخزن کیف‌پول‌ها با ساختار مورد انتظار سازگار نیست.');
  if (matches.keyPath !== 'id') issues.push('کلید اصلی مخزن نتایج با ساختار مورد انتظار سازگار نیست.');
  if (transaction.objectStore(TARGETS).keyPath !== 'address') issues.push('کلید اصلی فهرست آدرس‌ها با ساختار مورد انتظار سازگار نیست.');
  if (metadata.keyPath !== 'key') issues.push('کلید اصلی مخزن متادیتای خزانه با ساختار مورد انتظار سازگار نیست.');
  const hasMatchedAtIndex = matches.indexNames.contains('byMatchedAt');
  const hasGroupIndex = matches.indexNames.contains('byGroup');
  if (!hasMatchedAtIndex) issues.push('شاخص زمان نتایج (byMatchedAt) وجود ندارد.');
  if (!hasGroupIndex) issues.push('شاخص گروه نتایج (byGroup) وجود ندارد.');
  const hasAddressIndex = wallets.indexNames.contains('byAddress');
  const hasCreatedAtIndex = wallets.indexNames.contains('byCreatedAt');
  if (!hasAddressIndex) issues.push('شاخص آدرس کیف‌پول‌ها (byAddress) وجود ندارد.');
  if (!hasCreatedAtIndex) issues.push('شاخص تاریخ ساخت کیف‌پول‌ها (byCreatedAt) وجود ندارد.');

  const walletCountRequest = requestValue(wallets.count());
  const addressCountRequest = hasAddressIndex ? requestValue(wallets.index('byAddress').count()) : Promise.resolve(null);
  const createdAtCountRequest = hasCreatedAtIndex ? requestValue(wallets.index('byCreatedAt').count()) : Promise.resolve(null);
  const keyCheckRequest = requestValue(metadata.get('key-check')) as Promise<unknown>;
  const checkpointRequest = requestValue(metadata.get(GENERATION_CHECKPOINT_KEY)) as Promise<unknown>;
  const [walletCount, addressCount, createdAtCount, keyCheck, checkpoint] = await Promise.all([
    walletCountRequest, addressCountRequest, createdAtCountRequest, keyCheckRequest, checkpointRequest, done,
  ]);

  if (hasAddressIndex && addressCount !== walletCount) {
    issues.push('تعداد ورودی‌های شاخص آدرس با تعداد رکوردهای کیف‌پول برابر نیست؛ احتمال رکورد ناقص وجود دارد.');
  }
  if (hasCreatedAtIndex && createdAtCount !== walletCount) {
    issues.push('تعداد ورودی‌های شاخص تاریخ با تعداد رکوردهای کیف‌پول برابر نیست؛ احتمال رکورد ناقص وجود دارد.');
  }
  if (walletCount > 0 && !isVaultCheckRecord(keyCheck)) {
    issues.push('رکورد بررسی کلید امن وجود ندارد یا ساختار آن معتبر نیست.');
  } else if (keyCheck !== undefined && !isVaultCheckRecord(keyCheck)) {
    issues.push('رکورد متادیتای بررسی کلید خراب است؛ پس از احراز هویت و فقط در خزانه خالی قابل جایگزینی است.');
  }
  if (checkpoint !== undefined && !isGenerationCheckpoint(checkpoint)) {
    issues.push('ساختار نقطه بازیابی تولید خراب یا ناسازگار است.');
  }

  return { healthy: issues.length === 0, schemaVersion: database.version, walletCount, issues };
}

export async function getGenerationCheckpoint(): Promise<GenerationCheckpoint | null> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readonly');
  const done = transactionDone(transaction);
  const [record] = await Promise.all([
    requestValue(transaction.objectStore(VAULT_META).get(GENERATION_CHECKPOINT_KEY)) as Promise<unknown>,
    done,
  ]);
  if (record === undefined) return null;
  if (!isGenerationCheckpoint(record)) throw new Error('نقطه بازیابی ذخیره‌شده خراب یا ناسازگار است؛ برای جلوگیری از بازنویسی، تولید متوقف شد.');
  return record;
}

/** Mark an uncleanly-terminated run as interrupted when the user returns. */
export async function recoverGenerationCheckpoint(): Promise<GenerationCheckpoint | null> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readwrite', { durability: 'strict' });
  const store = transaction.objectStore(VAULT_META);
  const request = store.get(GENERATION_CHECKPOINT_KEY);
  let result: GenerationCheckpoint | null = null;
  request.onsuccess = () => {
    const checkpoint = request.result as unknown;
    if (checkpoint === undefined) return;
    if (!isGenerationCheckpoint(checkpoint)) {
      try { transaction.abort(); } catch { /* transaction may already be closing */ }
      return;
    }
    result = markCheckpointInterrupted(checkpoint, new Date().toISOString());
    if (result !== checkpoint) store.put(result);
  };
  try {
    await transactionDone(transaction);
  } catch (error) {
    if (!result) throw new Error('نقطه بازیابی قبلی خراب یا ناسازگار است؛ برای جلوگیری از بازنویسی، تولید متوقف شد.');
    throw error;
  }
  return result;
}

/** Start a new run or resume the previous run without resetting its durable count. */
export async function beginGenerationCheckpoint(): Promise<GenerationCheckpoint> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readwrite', { durability: 'strict' });
  const store = transaction.objectStore(VAULT_META);
  const request = store.get(GENERATION_CHECKPOINT_KEY);
  let result: GenerationCheckpoint | null = null;
  request.onsuccess = () => {
    const rawExisting = request.result as unknown;
    const existing = rawExisting === undefined ? null : rawExisting;
    if (existing !== null && !isGenerationCheckpoint(existing)) {
      try { transaction.abort(); } catch { /* transaction may already be closing */ }
      return;
    }
    const now = new Date().toISOString();
    result = startOrResumeCheckpoint(existing, now, crypto.randomUUID());
    store.put(result);
  };
  try {
    await transactionDone(transaction);
  } catch (error) {
    if (!result) throw new Error('نقطه بازیابی قبلی معتبر نبود؛ داده‌های موجود بازنویسی نشدند.');
    throw error;
  }
  if (!result) throw new Error('ذخیره نقطه بازیابی تولید ناموفق بود.');
  return result;
}

export async function pauseGenerationCheckpoint(): Promise<GenerationCheckpoint | null> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readwrite', { durability: 'strict' });
  const store = transaction.objectStore(VAULT_META);
  const request = store.get(GENERATION_CHECKPOINT_KEY);
  let result: GenerationCheckpoint | null = null;
  let checkpointFailure = false;
  request.onerror = () => { checkpointFailure = true; };
  request.onsuccess = () => {
    const checkpoint = request.result as unknown;
    if (checkpoint === undefined) return;
    if (!isGenerationCheckpoint(checkpoint)) {
      checkpointFailure = true;
      try { transaction.abort(); } catch { /* transaction may already be closing */ }
      return;
    }
    result = markCheckpointPaused(checkpoint, new Date().toISOString());
    if (result !== checkpoint) store.put(result);
  };
  try {
    await transactionDone(transaction);
  } catch (error) {
    if (checkpointFailure) throw new Error('نقطه بازیابی خراب است؛ وضعیت آن بازنویسی نشد.');
    throw error;
  }
  return result;
}

export async function countEncryptedWallets(): Promise<number> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(WALLETS, 'readonly');
  const done = transactionDone(transaction);
  const [count] = await Promise.all([requestValue(transaction.objectStore(WALLETS).count()), done]);
  return count;
}

export type WalletAddressScanMode = 'direct-lookups' | 'index-scan';

export interface WalletAddressScanProgress {
  scannedCount: number;
  totalCount: number;
  matchedAddressCount: number;
  matchedWalletCount: number;
  mode: WalletAddressScanMode;
}

export interface WalletAddressScanResult {
  snapshot: WalletMatchSnapshot;
  scannedCount: number;
  /** Number of wallet records in the vault, not the progress denominator. */
  totalCount: number;
  /** Number of TXT targets or index entries processed, depending on mode. */
  progressTotalCount: number;
  mode: WalletAddressScanMode;
  matchedAddressCount: number;
  matchedWalletCount: number;
  cancelled: boolean;
}

export interface WalletAddressScanOptions {
  onMatches?: (matches: WalletSummary[]) => void;
  onProgress?: (progress: WalletAddressScanProgress) => void;
  shouldCancel?: () => boolean;
}

const ADDRESS_SCAN_PROGRESS_INTERVAL = 256;
const ADDRESS_SCAN_MATCH_BATCH_SIZE = 256;
const ADDRESS_SCAN_LOOKUP_CHUNK_SIZE = 128;

/**
 * Read-only watch-only matching. TXT addresses are checked against the local
 * byAddress index without decrypting private keys or changing wallet records.
 * Small target sets use point lookups in one readonly transaction; large sets
 * use one index cursor pass. This avoids scanning a large vault for a tiny TXT.
 */
export async function scanStoredWalletsByAddressSet(
  targetAddresses: ReadonlySet<string>,
  options: WalletAddressScanOptions = {},
): Promise<WalletAddressScanResult> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(WALLETS, 'readonly');
  const store = transaction.objectStore(WALLETS);
  const addressIndex = store.index('byAddress');
  const createdAtIndex = store.index('byCreatedAt');
  const done = transactionDone(transaction);

  let totalCount = 0;
  let indexEntryCount = 0;
  let snapshot: WalletMatchSnapshot = { newestCreatedAt: null, newestCreatedAtWalletIds: new Set<string>() };
  let scannedCount = 0;
  let progressTotalCount = 0;
  let mode: WalletAddressScanMode = 'index-scan';
  let matchedAddressCount = 0;
  let matchedWalletCount = 0;
  let cancelled = false;
  let failure: Error | null = null;
  const foundAddresses = new Set<string>();
  let pendingMatches: WalletSummary[] = [];

  const scanPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let storeCountReady = false;
    let indexCountReady = false;
    let snapshotReady = false;

    const fail = (error: unknown, fallback: string) => {
      if (failure || settled) return;
      failure = error instanceof Error ? error : new Error(fallback);
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
      settled = true;
      reject(failure);
    };

    const flushMatches = (): boolean => {
      if (pendingMatches.length === 0) return true;
      const batch = pendingMatches;
      pendingMatches = [];
      try {
        options.onMatches?.(batch);
        return true;
      } catch (error) {
        fail(error, 'ارسال دسته نتایج تطبیق ناموفق بود.');
        return false;
      }
    };

    const reportProgress = (force = false) => {
      if (!force && scannedCount % ADDRESS_SCAN_PROGRESS_INTERVAL !== 0) return;
      try {
        options.onProgress?.({ scannedCount, totalCount: progressTotalCount, matchedAddressCount, matchedWalletCount, mode });
      } catch (error) {
        fail(error, 'گزارش پیشرفت تطبیق ناموفق بود.');
      }
    };

    const finish = () => {
      if (settled || failure) return;
      if (!flushMatches()) return;
      reportProgress(true);
      if (failure) return;
      settled = true;
      resolve();
    };

    const addMatchedRecord = (raw: unknown, primaryKey: IDBValidKey, expectedAddress: string): boolean => {
      if (!isEncryptedWalletRecord(raw) || raw.id !== String(primaryKey) || raw.address !== expectedAddress) {
        fail(new Error('ساختار رکورد منطبق با کلید شاخص آدرس سازگار نیست؛ نتیجه ناقص اعلام نشد.'), 'رکورد کیف‌پول منطبق معتبر نیست.');
        return false;
      }
      if (!isWalletInMatchSnapshot({ id: raw.id, createdAt: raw.createdAt }, snapshot)) return true;
      if (!foundAddresses.has(raw.address)) {
        foundAddresses.add(raw.address);
        matchedAddressCount += 1;
      }
      matchedWalletCount += 1;
      pendingMatches.push({ id: raw.id, address: raw.address, createdAt: raw.createdAt });
      if (pendingMatches.length >= ADDRESS_SCAN_MATCH_BATCH_SIZE && !flushMatches()) return false;
      return true;
    };

    const beginCursorScan = () => {
      if (settled || failure) return;
      mode = 'index-scan';
      progressTotalCount = totalCount;
      let request: IDBRequest<IDBCursor | null>;
      try {
        request = addressIndex.openKeyCursor();
      } catch (error) {
        fail(error, 'شاخص آدرس خزانه برای تطبیق در دسترس نیست.');
        return;
      }

      request.onerror = () => fail(request.error, 'پیمایش شاخص آدرس‌های خزانه ناموفق بود.');
      request.onsuccess = () => {
        if (settled || failure) return;
        if (options.shouldCancel?.()) {
          cancelled = true;
          finish();
          return;
        }

        const cursor = request.result;
        if (!cursor) {
          if (!cancelled && scannedCount !== indexEntryCount) {
            fail(new Error('تعداد رکوردهای پیمایش‌شده با تعداد ورودی‌های شاخص برابر نیست؛ نتیجه تطبیق ناقص اعلام نشد.'), 'شاخص آدرس ناقص یا ناسازگار است.');
            return;
          }
          finish();
          return;
        }

        if (typeof cursor.key !== 'string') {
          fail(new Error('کلید شاخص آدرس یک رکورد معتبر نیست؛ نتیجه تطبیق ناقص اعلام نشد.'), 'کلید شاخص آدرس معتبر نیست.');
          return;
        }

        const indexedAddress = cursor.key;
        const primaryKey = cursor.primaryKey;
        scannedCount += 1;

        const continueScan = () => {
          if (settled || failure) return;
          if (options.shouldCancel?.()) {
            cancelled = true;
            finish();
            return;
          }
          reportProgress();
          if (!failure) cursor.continue();
        };

        if (!targetAddresses.has(indexedAddress)) {
          continueScan();
          return;
        }

        const recordRequest = store.get(primaryKey);
        recordRequest.onerror = () => fail(recordRequest.error, 'خواندن رکورد کیف‌پول منطبق ناموفق بود.');
        recordRequest.onsuccess = () => {
          if (settled || failure) return;
          if (!addMatchedRecord(recordRequest.result, primaryKey, indexedAddress)) return;
          continueScan();
        };
      };
    };

    const beginDirectLookups = () => {
      if (settled || failure) return;
      mode = 'direct-lookups';
      const addresses = Array.from(targetAddresses);
      progressTotalCount = addresses.length;
      let offset = 0;

      const processNextChunk = () => {
        if (settled || failure) return;
        if (options.shouldCancel?.()) {
          cancelled = true;
          finish();
          return;
        }
        const chunk = addresses.slice(offset, offset + ADDRESS_SCAN_LOOKUP_CHUNK_SIZE);
        offset += chunk.length;
        if (chunk.length === 0) {
          if (!cancelled && scannedCount !== addresses.length) {
            fail(new Error('تعداد آدرس‌های بررسی‌شده با تعداد آدرس‌های هدف برابر نیست؛ نتیجه تطبیق ناقص اعلام نشد.'), 'بررسی همه آدرس‌های هدف کامل نشد.');
            return;
          }
          finish();
          return;
        }

        let remainingTargets = chunk.length;
        const completeTarget = () => {
          if (settled || failure) return;
          scannedCount += 1;
          reportProgress();
          if (failure) return;
          remainingTargets -= 1;
          if (remainingTargets === 0) {
            if (!flushMatches()) return;
            processNextChunk();
          }
        };

        for (const address of chunk) {
          if (settled || failure) return;
          if (options.shouldCancel?.()) {
            cancelled = true;
            finish();
            return;
          }
          const keysRequest = addressIndex.getAllKeys(address);
          keysRequest.onerror = () => fail(keysRequest.error, 'جست‌وجوی مستقیم آدرس در شاخص خزانه ناموفق بود.');
          keysRequest.onsuccess = () => {
            if (settled || failure) return;
            const primaryKeys = keysRequest.result;
            if (primaryKeys.length === 0) {
              completeTarget();
              return;
            }
            let remainingRecords = primaryKeys.length;
            const completeRecord = () => {
              if (settled || failure) return;
              remainingRecords -= 1;
              if (remainingRecords === 0) completeTarget();
            };
            for (const primaryKey of primaryKeys) {
              const recordRequest = store.get(primaryKey);
              recordRequest.onerror = () => fail(recordRequest.error, 'خواندن رکورد کیف‌پول منطبق ناموفق بود.');
              recordRequest.onsuccess = () => {
                if (settled || failure) return;
                if (!addMatchedRecord(recordRequest.result, primaryKey, address)) return;
                completeRecord();
              };
            }
          };
        }
      };

      processNextChunk();
    };

    const maybeBeginScan = () => {
      if (settled || failure || !storeCountReady || !indexCountReady || !snapshotReady) return;
      if (options.shouldCancel?.()) {
        cancelled = true;
        finish();
        return;
      }
      // Sparse target sets use index point-lookups; larger sets use one cursor pass.
      if (chooseAddressScanMode(targetAddresses.size, totalCount) === 'direct-lookups') beginDirectLookups();
      else beginCursorScan();
    };

    const countRequest = store.count();
    countRequest.onerror = () => fail(countRequest.error, 'شمارش کیف‌پول‌های خزانه برای تطبیق ناموفق بود.');
    countRequest.onsuccess = () => {
      totalCount = countRequest.result;
      storeCountReady = true;
      if (indexCountReady && indexEntryCount !== totalCount) {
        fail(new Error('تعداد ورودی‌های شاخص آدرس با تعداد کیف‌پول‌های خزانه برابر نیست؛ نتیجه تطبیق تأیید نشد.'), 'شاخص آدرس ناقص یا ناسازگار است.');
        return;
      }
      maybeBeginScan();
    };

    const indexCountRequest = addressIndex.count();
    indexCountRequest.onerror = () => fail(indexCountRequest.error, 'شمارش شاخص آدرس‌های خزانه ناموفق بود.');
    indexCountRequest.onsuccess = () => {
      indexEntryCount = indexCountRequest.result;
      indexCountReady = true;
      if (storeCountReady && indexEntryCount !== totalCount) {
        fail(new Error('تعداد ورودی‌های شاخص آدرس با تعداد کیف‌پول‌های خزانه برابر نیست؛ نتیجه تطبیق تأیید نشد.'), 'شاخص آدرس ناقص یا ناسازگار است.');
        return;
      }
      maybeBeginScan();
    };

    // Capture the latest-created boundary in the same readonly transaction as
    // all address queries, so results share one consistent database snapshot.
    const newestRequest = createdAtIndex.openCursor(null, 'prev');
    newestRequest.onerror = () => fail(newestRequest.error, 'ثبت مرز زمانی تطبیق ناموفق بود.');
    newestRequest.onsuccess = () => {
      if (settled || failure) return;
      const newestCursor = newestRequest.result;
      if (!newestCursor) {
        snapshot = { newestCreatedAt: null, newestCreatedAtWalletIds: new Set<string>() };
        snapshotReady = true;
        maybeBeginScan();
        return;
      }

      const newestRecord = newestCursor.value as unknown;
      if (!isEncryptedWalletRecord(newestRecord)) {
        fail(new Error('ساختار جدیدترین رکورد خزانه برای تعیین مرز تطبیق معتبر نیست.'), 'جدیدترین رکورد کیف‌پول معتبر نیست.');
        return;
      }

      const newestCreatedAt = newestRecord.createdAt;
      const boundaryIdsRequest = createdAtIndex.getAllKeys(IDBKeyRange.only(newestCreatedAt));
      boundaryIdsRequest.onerror = () => fail(boundaryIdsRequest.error, 'خواندن شناسه‌های مرزی تطبیق ناموفق بود.');
      boundaryIdsRequest.onsuccess = () => {
        snapshot = {
          newestCreatedAt,
          newestCreatedAtWalletIds: new Set(boundaryIdsRequest.result.map((id) => String(id))),
        };
        snapshotReady = true;
        maybeBeginScan();
      };
    };
  });

  try {
    await Promise.all([scanPromise, done]);
    if (!cancelled && indexEntryCount !== totalCount) {
      throw new Error('تعداد ورودی‌های شاخص آدرس با موجودی خزانه برابر نیست؛ نتیجه تطبیق تأیید نشد.');
    }
    return {
      snapshot,
      scannedCount,
      totalCount,
      progressTotalCount,
      mode,
      matchedAddressCount,
      matchedWalletCount,
      cancelled,
    };
  } catch (error) {
    if (failure) throw failure;
    throw error;
  }
}

export async function listEncryptedWalletPage(page: number, pageSize: number): Promise<WalletSummary[]> {
  const safePage = Math.max(0, Math.floor(page));
  const safeSize = Math.max(1, Math.min(500, Math.floor(pageSize)));
  const offset = safePage * safeSize;
  const database = await openLocalDatabase();
  const transaction = database.transaction(WALLETS, 'readonly');
  const done = transactionDone(transaction);
  const rows: WalletSummary[] = [];
  const cursorDone = new Promise<void>((resolve, reject) => {
    const request = transaction.objectStore(WALLETS).index('byCreatedAt').openCursor(null, 'prev');
    let skipped = 0;
    request.onerror = () => reject(request.error || new Error('خواندن فهرست کیف‌پول‌ها ناموفق بود.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      if (skipped < offset) {
        skipped += 1;
        cursor.continue();
        return;
      }
      if (rows.length >= safeSize) { resolve(); return; }
      const value = cursor.value as EncryptedWalletRecord;
      rows.push({ id: value.id, address: value.address, createdAt: value.createdAt });
      cursor.continue();
    };
  });
  await Promise.all([cursorDone, done]);
  return rows;
}

/** Read the inventory count and one page in a single readonly transaction. */
export async function getEncryptedWalletPage(page: number, pageSize: number): Promise<WalletPageData> {
  const safePage = Math.max(0, Math.floor(page));
  const safeSize = Math.max(1, Math.min(500, Math.floor(pageSize)));
  const offset = safePage * safeSize;
  const database = await openLocalDatabase();
  const transaction = database.transaction(WALLETS, 'readonly');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(WALLETS);
  const countPromise = requestValue(store.count());
  const rows: WalletSummary[] = [];
  const cursorDone = new Promise<void>((resolve, reject) => {
    const request = store.index('byCreatedAt').openCursor(null, 'prev');
    let skipped = 0;
    request.onerror = () => reject(normalizeDatabaseError(request.error, 'خواندن صفحه کیف‌پول‌ها ناموفق بود.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      if (skipped < offset) {
        skipped += 1;
        cursor.continue();
        return;
      }
      if (rows.length >= safeSize) { resolve(); return; }
      const value = cursor.value as EncryptedWalletRecord;
      if (!isEncryptedWalletRecord(value)) {
        reject(new Error('ساختار یک رکورد کیف‌پول هنگام بارگذاری فهرست معتبر نیست.'));
        return;
      }
      rows.push({ id: value.id, address: value.address, createdAt: value.createdAt });
      cursor.continue();
    };
  });
  const [total] = await Promise.all([countPromise, cursorDone, done]);
  return { total, rows };
}

export async function getEncryptedWalletRecord(id: string): Promise<EncryptedWalletRecord | null> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(WALLETS, 'readonly');
  const done = transactionDone(transaction);
  const [record] = await Promise.all([
    requestValue(transaction.objectStore(WALLETS).get(id)) as Promise<unknown>,
    done,
  ]);
  if (record === undefined) return null;
  if (!isEncryptedWalletRecord(record)) throw new Error('ساختار رکورد کیف‌پول در دیتابیس معتبر نیست؛ داده ذخیره‌شده تغییر داده نشد.');
  return record;
}

export async function deleteEncryptedWallet(id: string): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([WALLETS, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const store = transaction.objectStore(WALLETS);
  let deleted = false;
  let statsFailure: Error | null = null;
  const lookup = store.getKey(id);
  lookup.onerror = () => { try { transaction.abort(); } catch { /* transaction may already be closing */ } };
  lookup.onsuccess = () => {
    if (lookup.result === undefined) return;
    deleted = true;
    store.delete(id);
    void queueWalletUsageStatsDelta(transaction, { deletedWalletCount: 1 }, 1)
      .catch((error) => {
        statsFailure = error instanceof Error ? error : new Error('ثبت تعداد کیف‌پول حذف‌شده ناموفق بود.');
        try { transaction.abort(); } catch { /* transaction may already be aborting */ }
      });
  };
  try {
    await done;
  } catch (error) {
    if (statsFailure) throw statsFailure;
    throw error;
  }
  if (deleted && statsFailure) throw statsFailure;
}

export async function clearEncryptedWallets(): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([WALLETS, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const store = transaction.objectStore(WALLETS);
  let deletedCount = 0;
  let statsFailure: Error | null = null;
  const countRequest = store.count();
  countRequest.onerror = () => { try { transaction.abort(); } catch { /* transaction may already be closing */ } };
  countRequest.onsuccess = () => {
    deletedCount = countRequest.result;
    store.clear();
    // Clearing the vault also clears the run history so the next start is a fresh run.
    transaction.objectStore(VAULT_META).delete(GENERATION_CHECKPOINT_KEY);
    if (deletedCount > 0) {
      void queueWalletUsageStatsDelta(transaction, { deletedWalletCount: deletedCount }, deletedCount)
        .catch((error) => {
          statsFailure = error instanceof Error ? error : new Error('ثبت تعداد کیف‌پول‌های حذف‌شده ناموفق بود.');
          try { transaction.abort(); } catch { /* transaction may already be aborting */ }
        });
    }
  };
  try {
    await done;
  } catch (error) {
    if (statsFailure) throw statsFailure;
    throw error;
  }
}

/**
 * Destructive reset of all app working data in one strict transaction.
 * The biometric key-check is deliberately preserved so the user is not silently
 * enrolled with a different encryption key after clearing the wallet inventory.
 */
export type FullVaultClearPhase = 'counting' | 'clearing';

export async function clearAllLocalVaultData(
  onProgress?: (phase: FullVaultClearPhase) => void,
): Promise<{ deletedWalletCount: number }> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([WALLETS, TARGETS, MATCHES, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const walletStore = transaction.objectStore(WALLETS);
  const targetStore = transaction.objectStore(TARGETS);
  const matchStore = transaction.objectStore(MATCHES);
  const metadata = transaction.objectStore(VAULT_META);
  // Callers can show the user that the destructive operation has started before
  // IndexedDB reaches its count/clear requests. The transaction remains atomic.
  const walletCountRequest = walletStore.count();
  const keyCheckRequest = metadata.get('key-check');
  let deletedWalletCount = 0;
  let walletCountLoaded = false;
  let keyCheckLoaded = false;
  let keyCheck: unknown;
  let clearQueued = false;
  let clearFailure: Error | null = null;
  onProgress?.('counting');

  const queueClear = () => {
    if (clearQueued || !walletCountLoaded || !keyCheckLoaded) return;
    clearQueued = true;
    try {
      walletStore.clear();
      targetStore.clear();
      matchStore.clear();
      metadata.clear();
      // Preserve the existing encryption-key verifier; remove all other metadata
      // including stats, generation checkpoints and TXT upload fingerprints.
      if (keyCheck !== undefined) metadata.put(keyCheck);
    } catch (error) {
      clearFailure = error instanceof Error ? error : new Error('پاک‌سازی کامل داده‌های محلی ناموفق بود.');
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
    }
  };

  walletCountRequest.onerror = () => {
    clearFailure = new Error('خواندن تعداد کیف‌پول‌ها پیش از پاک‌سازی ناموفق بود.');
    try { transaction.abort(); } catch { /* transaction may already be aborting */ }
  };
  walletCountRequest.onsuccess = () => {
    deletedWalletCount = walletCountRequest.result;
    walletCountLoaded = true;
    onProgress?.('clearing');
    queueClear();
  };
  keyCheckRequest.onerror = () => {
    clearFailure = new Error('خواندن رکورد بررسی کلید امن پیش از پاک‌سازی ناموفق بود.');
    try { transaction.abort(); } catch { /* transaction may already be aborting */ }
  };
  keyCheckRequest.onsuccess = () => {
    keyCheck = keyCheckRequest.result;
    keyCheckLoaded = true;
    queueClear();
  };

  try {
    await done;
  } catch (error) {
    if (clearFailure) throw clearFailure;
    throw error;
  }
  return { deletedWalletCount };
}

const PURGE_SCAN_BATCH = 500;

export interface PurgeUnmatchedProgress {
  phase: 'scanning' | 'committing';
  scannedCount: number;
  scanTotal: number;
  /** Number of records successfully committed as deleted. */
  deletedCount: number;
  keptCount: number;
}

interface PurgeBatchResult {
  lastScannedId: string | null;
  scannedCount: number;
  reachedEnd: boolean;
  deletedCount: number;
  keptCount: number;
  scanTotal: number;
}

/**
 * Scans and deletes one bounded primary-key slice in the same IndexedDB
 * readwrite transaction. cursor.delete() makes the deletion part of that
 * transaction, so the progress count advances only after its commit succeeds.
 */
async function processPurgeBatch(
  lastScannedId: string | null,
  snapshot: WalletMatchSnapshot,
  matchedIds: ReadonlySet<string>,
): Promise<PurgeBatchResult> {
  const database = await openLocalDatabase();
  const transaction = database.transaction([WALLETS, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const store = transaction.objectStore(WALLETS);

  let nextLastScannedId = lastScannedId;
  let scannedCount = 0;
  let deletedCount = 0;
  let keptCount = 0;
  let reachedEnd = false;
  let scanTotal = 0;
  let failure: Error | null = null;
  let finalized = false;

  const abortBatch = (error: unknown, fallback: string) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(fallback);
    try { transaction.abort(); } catch { /* transaction may already be aborting */ }
  };

  const countRequest = store.count();
  countRequest.onerror = () => abortBatch(countRequest.error, 'شمارش رکوردهای خزانه برای پاک‌سازی ناموفق بود.');
  countRequest.onsuccess = () => { scanTotal = countRequest.result; };

  const finalizeBatch = () => {
    if (finalized || failure) return;
    finalized = true;
    if (deletedCount === 0) return;

    // The wallet count is read after cursor.delete() requests in this transaction.
    // Add the deleted amount only when initializing legacy telemetry from a
    // pre-existing vault with no stats record; existing stats are not rebased.
    void queueWalletUsageStatsDelta(
      transaction,
      { deletedWalletCount: deletedCount },
      deletedCount,
    ).catch((error) => abortBatch(error, 'ثبت آمار حذف دسته ناموفق بود؛ این دسته ثبت نشد.'));
  };

  const range = lastScannedId === null
    ? undefined
    : IDBKeyRange.lowerBound(lastScannedId, true);
  const cursorRequest = store.openCursor(range);
  cursorRequest.onerror = () => abortBatch(cursorRequest.error, 'پیمایش خزانه برای حذف بدون‌تطابق‌ها ناموفق بود.');
  cursorRequest.onsuccess = () => {
    if (failure || finalized) return;
    const cursor = cursorRequest.result;
    if (!cursor) {
      reachedEnd = true;
      finalizeBatch();
      return;
    }

    const value = cursor.value as unknown;
    if (!isEncryptedWalletRecord(value)) {
      abortBatch(new Error('ساختار یک رکورد کیف‌پول هنگام پاک‌سازی معتبر نیست؛ دسته فعلی حذف نشد.'), 'ساختار رکورد کیف‌پول معتبر نیست.');
      return;
    }

    // The wallet store is keyed by id. Refuse to continue if a corrupt record
    // disagrees with the actual IndexedDB primary key rather than skipping rows.
    if (String(cursor.primaryKey) !== value.id) {
      abortBatch(new Error('شناسه اصلی یک رکورد با شناسه داخلی آن یکسان نیست؛ برای حفظ خزانه پاک‌سازی متوقف شد.'), 'شناسه رکورد ناسازگار است.');
      return;
    }

    scannedCount += 1;
    nextLastScannedId = value.id;

    if (isWalletInMatchSnapshot({ id: value.id, createdAt: value.createdAt }, snapshot)) {
      if (matchedIds.has(value.id)) {
        keptCount += 1;
      } else {
        const deleteRequest = cursor.delete();
        deleteRequest.onerror = () => abortBatch(deleteRequest.error, 'حذف یک رکورد بدون‌تطابق ناموفق بود؛ دسته جاری لغو شد.');
        deletedCount += 1;
      }
    }

    if (scannedCount >= PURGE_SCAN_BATCH) {
      finalizeBatch();
      return;
    }
    cursor.continue();
  };

  try {
    await done;
  } catch (error) {
    if (failure) throw failure;
    throw error;
  }

  return {
    lastScannedId: nextLastScannedId,
    scannedCount,
    reachedEnd,
    deletedCount,
    keptCount,
    scanTotal,
  };
}

/**
 * Revalidate the purge's keep-set against IndexedDB before any destructive
 * transaction. Only primary keys are read; encrypted key material is untouched.
 */
async function hasPersistedMatchedWallet(matchedIds: ReadonlySet<string>): Promise<boolean> {
  const ids = Array.from(matchedIds);
  const lookupBatchSize = 256;
  for (let offset = 0; offset < ids.length; offset += lookupBatchSize) {
    const database = await openLocalDatabase();
    const transaction = database.transaction(WALLETS, 'readonly');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(WALLETS);
    const lookups = ids.slice(offset, offset + lookupBatchSize).map((id) => requestValue(store.getKey(id)));
    const [keys] = await Promise.all([Promise.all(lookups), done]);
    if (keys.some((key) => key !== undefined)) return true;
  }
  return false;
}

/**
 * Removes only non-matching records from an immutable match snapshot. Empty
 * match sets are rejected deliberately: a zero-match TXT file is commonly the
 * wrong list/scope, and must never silently turn this action into a full-vault
 * wipe. Use the separately confirmed full-clear action for intentional resets.
 */
export async function purgeUnmatchedWallets(
  snapshot: WalletMatchSnapshot,
  matchedIds: ReadonlySet<string>,
  onProgress?: (progress: PurgeUnmatchedProgress) => void,
): Promise<{ deletedCount: number; keptCount: number }> {
  if (!snapshot.newestCreatedAt) {
    return { deletedCount: 0, keptCount: 0 };
  }
  if (!hasSafeUnmatchedPurgeAnchor(snapshot, matchedIds)) {
    throw new Error('هیچ کیف‌پول منطبقی برای حفظ وجود ندارد؛ برای جلوگیری از حذف ناخواسته کل خزانه، حذف بدون‌تطابق‌ها انجام نشد. فایل TXT و حساب/خزانه انتخاب‌شده را بررسی کن.');
  }
  if (!await hasPersistedMatchedWallet(matchedIds)) {
    throw new Error('هیچ‌یک از کیف‌پول‌های منطبق هنوز در دیتابیس وجود ندارد؛ نتیجه تطبیق منقضی شده و برای جلوگیری از حذف کامل خزانه، پاک‌سازی متوقف شد. دوباره فایل TXT را تطبیق بده.');
  }

  let lastScannedId: string | null = null;
  let scannedCount = 0;
  let scanTotal = 0;
  let scanTotalLoaded = false;
  let deletedCount = 0;
  let keptCount = 0;
  let reachedEnd = false;

  onProgress?.({ phase: 'scanning', scannedCount, scanTotal, deletedCount, keptCount });

  try {
    while (!reachedEnd) {
      const batch = await processPurgeBatch(lastScannedId, snapshot, matchedIds);
      lastScannedId = batch.lastScannedId;
      scannedCount += batch.scannedCount;
      if (!scanTotalLoaded) {
        scanTotal = batch.scanTotal;
        scanTotalLoaded = true;
      }
      deletedCount += batch.deletedCount;
      keptCount += batch.keptCount;
      reachedEnd = batch.reachedEnd;

      // A batch's deleted count is reported only after the IndexedDB transaction
      // has completed successfully; no optimistic or uncommitted count is shown.
      onProgress?.({
        phase: batch.deletedCount > 0 ? 'committing' : 'scanning',
        scannedCount,
        scanTotal,
        deletedCount,
        keptCount,
      });

      if (batch.scannedCount === 0) reachedEnd = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'پاک‌سازی کیف‌پول‌های بدون تطابق ناموفق بود.';
    const partialNotice = deletedCount > 0
      ? ` تا پیش از خطا، ${deletedCount.toLocaleString('fa-IR')} کیف‌پول در تراکنش‌های قبلی حذف و ثبت شد.`
      : '';
    throw new Error(`${message}${partialNotice}`);
  }

  return { deletedCount, keptCount };
}

export async function readVaultKeyCheck(options: { allowMalformedWhenVaultEmpty?: boolean } = {}): Promise<VaultCheckRecord | null> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(VAULT_META, 'readonly');
  const done = transactionDone(transaction);
  const [record] = await Promise.all([
    requestValue(transaction.objectStore(VAULT_META).get('key-check')) as Promise<unknown>,
    done,
  ]);
  if (record === undefined) return null;
  if (!isVaultCheckRecord(record)) {
    if (options.allowMalformedWhenVaultEmpty) return null;
    throw new Error('ساختار رکورد بررسی کلید امن خراب است؛ هیچ کلید یا داده‌ای بازنویسی نشد.');
  }
  return record;
}

export async function writeVaultKeyCheck(record: VaultCheckRecord): Promise<void> {
  const database = await openLocalDatabase();
  // A key-check may only be created/replaced while the wallet store is empty.
  // Both the count and metadata write share one readwrite transaction so a
  // second tab cannot insert a wallet between the emptiness check and the put.
  const transaction = database.transaction([WALLETS, VAULT_META], 'readwrite', { durability: 'strict' });
  const done = transactionDone(transaction);
  const walletCountRequest = transaction.objectStore(WALLETS).count();
  let rejectedBecauseNotEmpty = false;
  walletCountRequest.onsuccess = () => {
    if (walletCountRequest.result !== 0) {
      rejectedBecauseNotEmpty = true;
      try { transaction.abort(); } catch { /* transaction may already be closing */ }
      return;
    }
    transaction.objectStore(VAULT_META).put(record);
  };
  try {
    await done;
  } catch (error) {
    if (rejectedBecauseNotEmpty) {
      throw new Error('رکورد بررسی کلید فقط زمانی قابل ایجاد یا جایگزینی است که هیچ کیف‌پول رمزگذاری‌شده‌ای در خزانه نباشد.');
    }
    throw error;
  }
}
