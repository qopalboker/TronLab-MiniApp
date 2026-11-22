import { describe, expect, it } from 'vitest';
import {
  addWalletUsageStatsDelta,
  createInitialWalletUsageStats,
  isWalletUsageStats,
} from '../src/lib/walletUsageStats';

describe('persistent wallet usage statistics', () => {
  it('seeds legacy vaults from current inventory without inventing historical checks or deletions', () => {
    const stats = createInitialWalletUsageStats(18, '2026-11-22T08:00:00.000Z');
    expect(stats).toMatchObject({ generatedCount: 18, successfulWalletCount: 18, checkedAddressCount: 0, matchedAddressCount: 0, unmatchedAddressCount: 0, deletedWalletCount: 0, notStoredCount: 0 });
    expect(isWalletUsageStats(stats)).toBe(true);
  });

  it('accumulates generated, successfully stored, rejected and deleted wallet counts', () => {
    const initial = createInitialWalletUsageStats(10, '2026-11-22T08:00:00.000Z');
    const next = addWalletUsageStatsDelta(initial, {
      generatedCount: 100,
      successfulWalletCount: 98,
      notStoredCount: 2,
      deletedWalletCount: 3,
    }, '2026-11-22T08:01:00.000Z');
    expect(next).toMatchObject({ generatedCount: 110, successfulWalletCount: 108, notStoredCount: 2, deletedWalletCount: 3 });
    expect(next.updatedAt).toBe('2026-11-22T08:01:00.000Z');
  });

  it('keeps TXT dashboard counts cumulative while each run has its own input summary', () => {
    const initial = createInitialWalletUsageStats(0, '2026-11-22T08:00:00.000Z');
    const firstRun = addWalletUsageStatsDelta(initial, {
      checkedAddressCount: 375,
      matchedAddressCount: 0,
      unmatchedAddressCount: 375,
    }, '2026-11-22T08:01:00.000Z');
    const secondRun = addWalletUsageStatsDelta(firstRun, {
      checkedAddressCount: 375,
      matchedAddressCount: 0,
      unmatchedAddressCount: 375,
    }, '2026-11-22T08:02:00.000Z');

    expect(firstRun.checkedAddressCount).toBe(375);
    expect(secondRun.checkedAddressCount).toBe(750);
    expect(secondRun.unmatchedAddressCount).toBe(750);
  });

  it('counts checked public addresses and successful address matches without storing non-match rows', () => {
    const initial = createInitialWalletUsageStats(0, '2026-11-22T08:00:00.000Z');
    const next = addWalletUsageStatsDelta(initial, { checkedAddressCount: 256, matchedAddressCount: 4, unmatchedAddressCount: 252 });
    expect(next.checkedAddressCount).toBe(256);
    expect(next.matchedAddressCount).toBe(4);
    expect(next.unmatchedAddressCount).toBe(252);
    expect(next).not.toHaveProperty('unmatchedAddresses');
    expect(isWalletUsageStats({ ...next, unmatchedAddresses: ['not-stored'] })).toBe(false);
    expect(isWalletUsageStats({ ...next, rawInputLines: ['TUnknownAddress'] })).toBe(false);
  });

  it('rejects malformed persisted counters and inconsistent totals', () => {
    const initial = createInitialWalletUsageStats(10);
    expect(isWalletUsageStats({ ...initial, generatedCount: -1 })).toBe(false);
    expect(isWalletUsageStats({ ...initial, successfulWalletCount: 11 })).toBe(false);
    // A single deletion is valid when the vault has ten successfully stored wallets.
    expect(isWalletUsageStats({ ...initial, deletedWalletCount: 1 })).toBe(true);
    // The persisted deletion total must never exceed the number of successful stores.
    expect(isWalletUsageStats({ ...initial, deletedWalletCount: 11 })).toBe(false);
    expect(isWalletUsageStats({ ...initial, successfulWalletCount: 8, notStoredCount: 3 })).toBe(false);
    expect(isWalletUsageStats({ ...initial, matchedAddressCount: 1 })).toBe(false);
    expect(() => addWalletUsageStatsDelta(initial, { matchedAddressCount: 1 })).toThrow();
    expect(() => addWalletUsageStatsDelta(initial, { checkedAddressCount: 1, unmatchedAddressCount: 0 })).toThrow();
    expect(() => addWalletUsageStatsDelta({ ...initial, generatedCount: Number.MAX_SAFE_INTEGER }, { generatedCount: 1 })).toThrow();
  });
});
