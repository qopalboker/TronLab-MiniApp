import { BloomFilter } from './bloomFilter';
import { ExactAddressLineTracker } from './walletAddressMatching';
import { iterateTextLines } from './addressText';
import type { TargetAddressSet } from './domain';
import {
  DEFAULT_BLOOM_FALSE_POSITIVE_RATE,
  MAX_BLOOM_BYTES,
  MAX_TXT_TARGET_ADDRESSES,
  MAX_TXT_FILE_BYTES,
} from './runtimeConfig';

export interface BuildTargetSetOptions {
  falsePositiveRate?: number;
  maxAddresses?: number;
  maxFileBytes?: number;
  maxBloomBytes?: number;
  /** When false, skip Bloom allocation (exact Set only). Useful for tiny fixtures. */
  useBloom?: boolean;
}

export interface TargetSetBuildSummary {
  totalLines: number;
  blankLines: number;
  validUnique: number;
  invalid: number;
  duplicates: number;
  bloomBytes: number;
}

export interface BuiltTargetAddressSet extends TargetAddressSet {
  readonly exact: ReadonlySet<string>;
  readonly summary: TargetSetBuildSummary;
}

/**
 * Builds a memory-bounded target set from a TXT string or File.
 * - Normalizes and validates once via ExactAddressLineTracker.
 * - Constructs a Bloom filter sized for the unique count (no false negatives).
 * - Enforces hard limits so a malicious or accidental huge file cannot OOM the tab.
 */
export async function buildTargetAddressSetFromText(
  text: string,
  options: BuildTargetSetOptions = {},
): Promise<BuiltTargetAddressSet> {
  const maxAddresses = options.maxAddresses ?? MAX_TXT_TARGET_ADDRESSES;
  const maxFileBytes = options.maxFileBytes ?? MAX_TXT_FILE_BYTES;
  const maxBloomBytes = options.maxBloomBytes ?? MAX_BLOOM_BYTES;
  const fpr = options.falsePositiveRate ?? DEFAULT_BLOOM_FALSE_POSITIVE_RATE;
  const useBloom = options.useBloom !== false;

  // Approximate byte length for UTF-8 text without allocating a second copy.
  if (typeof TextEncoder !== 'undefined') {
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > maxFileBytes) {
      throw new Error(`فایل TXT از سقف ${maxFileBytes} بایت بزرگ‌تر است.`);
    }
  } else if (text.length > maxFileBytes) {
    throw new Error(`فایل TXT از سقف ${maxFileBytes} بایت بزرگ‌تر است.`);
  }

  const tracker = new ExactAddressLineTracker();
  let totalLines = 0;
  let blankLines = 0;
  let invalid = 0;
  let duplicates = 0;

  for (const line of iterateTextLines(text)) {
    totalLines += 1;
    const { status } = tracker.classify(line);
    if (status === 'blank') blankLines += 1;
    else if (status === 'invalid') invalid += 1;
    else if (status === 'duplicate') duplicates += 1;
    if (tracker.addresses.size > maxAddresses) {
      throw new Error(`تعداد آدرس‌های هدف از سقف ${maxAddresses} بیشتر است.`);
    }
  }

  const exact = tracker.addresses;
  const validUnique = exact.size;

  let bloom: BloomFilter | null = null;
  let bloomBytes = 0;
  if (useBloom && validUnique > 0) {
    const estimated = BloomFilter.estimateByteLength(validUnique, fpr);
    if (estimated > maxBloomBytes) {
      throw new Error(
        `فیلتر بلوم برای ${validUnique} آدرس به حدود ${estimated} بایت نیاز دارد که از سقف ${maxBloomBytes} بیشتر است.`,
      );
    }
    bloom = new BloomFilter(validUnique, fpr);
    for (const address of exact) bloom.add(address);
    bloomBytes = bloom.byteLength;
  }

  return {
    size: validUnique,
    has: (address: string) => exact.has(address),
    bloom,
    exact,
    summary: {
      totalLines,
      blankLines,
      validUnique,
      invalid,
      duplicates,
      bloomBytes,
    },
  };
}

export async function buildTargetAddressSetFromFile(
  file: File,
  options: BuildTargetSetOptions = {},
): Promise<BuiltTargetAddressSet> {
  const maxFileBytes = options.maxFileBytes ?? MAX_TXT_FILE_BYTES;
  if (file.size > maxFileBytes) {
    throw new Error(`فایل TXT از سقف ${maxFileBytes} بایت بزرگ‌تر است.`);
  }
  const text = await file.text();
  return buildTargetAddressSetFromText(text, options);
}

/**
 * Matcher that uses Bloom as a prefilter then exact Set membership.
 * Guarantees: no false negatives; false positives only cost an exact lookup.
 */
export function createBloomExactMatcher(targets: TargetAddressSet) {
  return {
    decide(
      wallets: readonly { privateKey: string; address: string; derivationPath: 'private-key' }[],
    ): { wallet: (typeof wallets)[number]; matched: boolean }[] {
      return wallets.map((wallet) => {
        if (targets.bloom && !targets.bloom.mayContain(wallet.address)) {
          return { wallet, matched: false };
        }
        return { wallet, matched: targets.has(wallet.address) };
      });
    },
  };
}
