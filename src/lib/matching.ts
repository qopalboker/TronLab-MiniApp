import type { DerivedAddress } from './seedDerivation';

/**
 * A Bloom filter is only a fast pre-filter. This function accepts matches only
 * when the exact IndexedDB lookup also confirms the full address string.
 */
export function selectExactAddressMatches<T extends DerivedAddress>(
  derived: readonly T[],
  exactStoredAddresses: ReadonlySet<string>,
): T[] {
  return derived.filter((item) => exactStoredAddresses.has(item.address));
}
