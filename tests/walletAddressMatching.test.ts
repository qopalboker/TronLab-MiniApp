import { describe, expect, it } from 'vitest';
import { chooseAddressScanMode, ExactAddressLineTracker, hasSafeUnmatchedPurgeAnchor, isWalletInMatchSnapshot, type WalletMatchSnapshot } from '../src/lib/walletAddressMatching';

describe('exact TXT address matching input validation', () => {
  it('accepts valid public TRON addresses and trims surrounding whitespace', () => {
    const tracker = new ExactAddressLineTracker();
    expect(tracker.classify('  TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC  ')).toEqual({
      status: 'valid',
      address: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
    });
  });

  it('removes only exact duplicate lines and preserves Base58 case sensitivity', () => {
    const tracker = new ExactAddressLineTracker();
    const address = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
    expect(tracker.classify(address).status).toBe('valid');
    expect(tracker.classify(address).status).toBe('duplicate');
    expect(tracker.classify(address.toLowerCase()).status).toBe('invalid');
  });

  it('counts one pasted public address as exactly one valid unique target for the current run', () => {
    const userSample = new ExactAddressLineTracker();
    expect(userSample.classify('TKmcNSZb989HXSVjfZSqryqeSkD9GPKcz2').status).toBe('valid');
    const tracker = new ExactAddressLineTracker();
    const result = tracker.classify('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC');
    expect(result.status).toBe('valid');
    expect(tracker.addresses.size).toBe(1);
  });

  it('exposes only unique, validated addresses as a case-sensitive in-memory lookup set', () => {
    const tracker = new ExactAddressLineTracker();
    const first = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
    const second = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
    tracker.classify(first);
    tracker.classify(first);
    tracker.classify('not-an-address');
    tracker.classify(second);

    expect(tracker.addresses.size).toBe(2);
    expect(tracker.addresses.has(first)).toBe(true);
    expect(tracker.addresses.has(second)).toBe(true);
    expect(tracker.addresses.has(first.toLowerCase())).toBe(false);
  });

  it('recognizes BOM, blank lines and malformed/checksum-invalid values', () => {
    const tracker = new ExactAddressLineTracker();
    expect(tracker.classify('\uFEFF   ').status).toBe('blank');
    expect(tracker.classify('not-a-tron-address').status).toBe('invalid');
    expect(tracker.classify('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HA').status).toBe('invalid');
  });
});


describe('address matching snapshot isolation', () => {
  const snapshot: WalletMatchSnapshot = {
    newestCreatedAt: '2026-11-22T07:00:00.000Z',
    newestCreatedAtWalletIds: new Set(['wallet-at-boundary']),
  };

  it('includes wallets committed before the snapshot boundary', () => {
    expect(isWalletInMatchSnapshot({
      id: 'older-wallet',
      createdAt: '2026-11-22T06:59:59.999Z',
    }, snapshot)).toBe(true);
  });

  it('includes only the wallet IDs that existed at the exact millisecond boundary', () => {
    expect(isWalletInMatchSnapshot({
      id: 'wallet-at-boundary',
      createdAt: '2026-11-22T07:00:00.000Z',
    }, snapshot)).toBe(true);
    expect(isWalletInMatchSnapshot({
      id: 'concurrently-created-wallet',
      createdAt: '2026-11-22T07:00:00.000Z',
    }, snapshot)).toBe(false);
  });

  it('excludes wallets created after the snapshot', () => {
    expect(isWalletInMatchSnapshot({
      id: 'new-wallet',
      createdAt: '2026-11-22T07:00:00.001Z',
    }, snapshot)).toBe(false);
  });

  it('matches nothing when the vault was empty at snapshot time', () => {
    expect(isWalletInMatchSnapshot({
      id: 'new-wallet',
      createdAt: '2026-11-22T07:00:00.001Z',
    }, { newestCreatedAt: null, newestCreatedAtWalletIds: new Set() })).toBe(false);
  });
});


describe('unmatched purge safety anchor', () => {
  const snapshot: WalletMatchSnapshot = {
    newestCreatedAt: '2026-11-22T07:00:00.000Z',
    newestCreatedAtWalletIds: new Set(['wallet-at-boundary']),
  };

  it('allows a purge only when at least one matched wallet will be retained', () => {
    expect(hasSafeUnmatchedPurgeAnchor(snapshot, new Set(['wallet-at-boundary']))).toBe(true);
  });

  it('blocks a purge that would delete the entire snapshot when no address matched', () => {
    expect(hasSafeUnmatchedPurgeAnchor(snapshot, new Set())).toBe(false);
  });

  it('blocks a purge when the snapshot is empty even if an ID is supplied', () => {
    expect(hasSafeUnmatchedPurgeAnchor({ newestCreatedAt: null, newestCreatedAtWalletIds: new Set() }, new Set(['wallet']))).toBe(false);
  });
});


describe('adaptive watch-only address lookup strategy', () => {
  it('uses direct index lookups for a small TXT against a large vault', () => {
    expect(chooseAddressScanMode(375, 104_448)).toBe('direct-lookups');
  });

  it('uses a single index cursor for a large target set', () => {
    expect(chooseAddressScanMode(20_000, 104_448)).toBe('index-scan');
  });

  it('handles small vaults and empty vaults safely', () => {
    expect(chooseAddressScanMode(200, 1_000)).toBe('direct-lookups');
    expect(chooseAddressScanMode(1, 0)).toBe('index-scan');
  });
});
