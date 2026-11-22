export const WALLET_USAGE_STATS_KEY = 'wallet-usage-stats-v1' as const;

export interface WalletUsageStats {
  key: typeof WALLET_USAGE_STATS_KEY;
  version: 1;
  generatedCount: number;
  checkedAddressCount: number;
  matchedAddressCount: number;
  unmatchedAddressCount: number;
  deletedWalletCount: number;
  successfulWalletCount: number;
  notStoredCount: number;
  failedOperationCount: number;
  updatedAt: string;
}

export interface WalletUsageStatsDelta {
  generatedCount?: number;
  checkedAddressCount?: number;
  matchedAddressCount?: number;
  unmatchedAddressCount?: number;
  deletedWalletCount?: number;
  successfulWalletCount?: number;
  notStoredCount?: number;
  failedOperationCount?: number;
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function isWalletUsageStats(value: unknown): value is WalletUsageStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowedKeys = new Set([
    'key', 'version', 'generatedCount', 'checkedAddressCount', 'matchedAddressCount',
    'unmatchedAddressCount', 'deletedWalletCount', 'successfulWalletCount',
    'notStoredCount', 'failedOperationCount', 'updatedAt',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const stats = value as Partial<WalletUsageStats>;
  return stats.key === WALLET_USAGE_STATS_KEY
    && stats.version === 1
    && isCounter(stats.generatedCount)
    && isCounter(stats.checkedAddressCount)
    && isCounter(stats.matchedAddressCount)
    && isCounter(stats.unmatchedAddressCount)
    && isCounter(stats.deletedWalletCount)
    && isCounter(stats.successfulWalletCount)
    && isCounter(stats.notStoredCount)
    && isCounter(stats.failedOperationCount)
    && stats.successfulWalletCount <= stats.generatedCount
    && stats.notStoredCount <= stats.generatedCount
    && Number.isSafeInteger(stats.successfulWalletCount + stats.notStoredCount)
    && stats.successfulWalletCount + stats.notStoredCount <= stats.generatedCount
    && stats.deletedWalletCount <= stats.successfulWalletCount
    && Number.isSafeInteger(stats.matchedAddressCount + stats.unmatchedAddressCount)
    && stats.matchedAddressCount + stats.unmatchedAddressCount === stats.checkedAddressCount
    && isTimestamp(stats.updatedAt);
}

/**
 * Older vaults have no historical telemetry. Seed a transparent baseline from
 * the current inventory; lifetime deletions and past TXT checks cannot be
 * reconstructed, so those counters intentionally start at zero.
 */
export function createInitialWalletUsageStats(existingWalletCount: number, now = new Date().toISOString()): WalletUsageStats {
  if (!isCounter(existingWalletCount) || !isTimestamp(now)) {
    throw new Error('مقدار اولیه آمار خزانه معتبر نیست.');
  }
  return {
    key: WALLET_USAGE_STATS_KEY,
    version: 1,
    generatedCount: existingWalletCount,
    checkedAddressCount: 0,
    matchedAddressCount: 0,
    unmatchedAddressCount: 0,
    deletedWalletCount: 0,
    successfulWalletCount: existingWalletCount,
    notStoredCount: 0,
    failedOperationCount: 0,
    updatedAt: now,
  };
}

function addCounter(current: number, delta: number | undefined): number {
  const increment = delta ?? 0;
  if (!isCounter(increment) || current > Number.MAX_SAFE_INTEGER - increment) {
    throw new Error('شمارنده آمار به مقدار نامعتبر یا بیش از محدوده امن رسیده است.');
  }
  return current + increment;
}

export function addWalletUsageStatsDelta(
  current: WalletUsageStats,
  delta: WalletUsageStatsDelta,
  now = new Date().toISOString(),
): WalletUsageStats {
  if (!isWalletUsageStats(current)) throw new Error('ساختار آمار ذخیره‌شده خراب یا ناسازگار است.');
  if (!isTimestamp(now)) throw new Error('زمان ثبت آمار معتبر نیست.');

  const next: WalletUsageStats = {
    ...current,
    generatedCount: addCounter(current.generatedCount, delta.generatedCount),
    checkedAddressCount: addCounter(current.checkedAddressCount, delta.checkedAddressCount),
    matchedAddressCount: addCounter(current.matchedAddressCount, delta.matchedAddressCount),
    unmatchedAddressCount: addCounter(current.unmatchedAddressCount, delta.unmatchedAddressCount),
    deletedWalletCount: addCounter(current.deletedWalletCount, delta.deletedWalletCount),
    successfulWalletCount: addCounter(current.successfulWalletCount, delta.successfulWalletCount),
    notStoredCount: addCounter(current.notStoredCount, delta.notStoredCount),
    failedOperationCount: addCounter(current.failedOperationCount, delta.failedOperationCount),
    updatedAt: now,
  };

  if (next.successfulWalletCount > next.generatedCount
    || next.notStoredCount > next.generatedCount
    || next.successfulWalletCount + next.notStoredCount > next.generatedCount
    || next.deletedWalletCount > next.successfulWalletCount
    || next.matchedAddressCount + next.unmatchedAddressCount !== next.checkedAddressCount) {
    throw new Error('رابطه شمارنده‌های آمار معتبر نیست؛ تغییرات ثبت نشد.');
  }
  return next;
}
