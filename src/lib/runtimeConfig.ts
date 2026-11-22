/**
 * Runtime configuration and feature flags for generation, matching, and crypto.
 * Values are intentional defaults for production Telegram Mini App constraints.
 * Override via constructor options or tests; do not read from untrusted input.
 */

/** Safe upper bound on Web Workers; most mobile Telegram WebViews have 4–8 cores. */
export const DEFAULT_WORKER_COUNT = 3;
export const MAX_WORKER_COUNT = 8;

/** Batch size must stay within getRandomValues(65536) → 2048 × 32 bytes. */
export const DEFAULT_BATCH_SIZE = 1_024;
export const MAX_BATCH_SIZE = 2_048;

/** Bloom filter defaults: ~0.1% FPR, memory-bounded for large TXT sets. */
export const DEFAULT_BLOOM_FALSE_POSITIVE_RATE = 0.001;
export const MAX_TXT_TARGET_ADDRESSES = 5_000_000;
export const MAX_TXT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BLOOM_BYTES = 8 * 1024 * 1024;

export type CryptoBackend = 'noble-js';

export interface GenerationConfig {
  workerCount: number;
  batchSize: number;
  bloomFalsePositiveRate: number;
  maxTxtAddresses: number;
  maxTxtFileBytes: number;
  maxBloomBytes: number;
  cryptoBackend: CryptoBackend;
  /** When true, generation only persists exact matches against the loaded target set. */
  targetedMatchOnly: boolean;
}

export const DEFAULT_GENERATION_CONFIG: Readonly<GenerationConfig> = Object.freeze({
  workerCount: DEFAULT_WORKER_COUNT,
  batchSize: DEFAULT_BATCH_SIZE,
  bloomFalsePositiveRate: DEFAULT_BLOOM_FALSE_POSITIVE_RATE,
  maxTxtAddresses: MAX_TXT_TARGET_ADDRESSES,
  maxTxtFileBytes: MAX_TXT_FILE_BYTES,
  maxBloomBytes: MAX_BLOOM_BYTES,
  cryptoBackend: 'noble-js',
  targetedMatchOnly: false,
});

export function resolveWorkerCount(
  preferred: number = DEFAULT_WORKER_COUNT,
  hardwareConcurrency: number = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
): number {
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 4;
  const capped = Math.min(MAX_WORKER_COUNT, Math.max(1, Math.floor(cores)));
  const requested = Number.isSafeInteger(preferred) && preferred > 0 ? preferred : DEFAULT_WORKER_COUNT;
  return Math.min(capped, requested);
}

export function resolveBatchSize(preferred: number = DEFAULT_BATCH_SIZE): number {
  if (!Number.isSafeInteger(preferred) || preferred < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, preferred);
}

export function createGenerationConfig(overrides: Partial<GenerationConfig> = {}): GenerationConfig {
  const workerCount = resolveWorkerCount(overrides.workerCount ?? DEFAULT_WORKER_COUNT);
  const batchSize = resolveBatchSize(overrides.batchSize ?? DEFAULT_BATCH_SIZE);
  const bloomFalsePositiveRate =
    typeof overrides.bloomFalsePositiveRate === 'number' &&
    overrides.bloomFalsePositiveRate > 0 &&
    overrides.bloomFalsePositiveRate < 1
      ? overrides.bloomFalsePositiveRate
      : DEFAULT_BLOOM_FALSE_POSITIVE_RATE;

  return {
    workerCount,
    batchSize,
    bloomFalsePositiveRate,
    maxTxtAddresses: overrides.maxTxtAddresses ?? MAX_TXT_TARGET_ADDRESSES,
    maxTxtFileBytes: overrides.maxTxtFileBytes ?? MAX_TXT_FILE_BYTES,
    maxBloomBytes: overrides.maxBloomBytes ?? MAX_BLOOM_BYTES,
    cryptoBackend: overrides.cryptoBackend ?? 'noble-js',
    targetedMatchOnly: overrides.targetedMatchOnly === true,
  };
}
