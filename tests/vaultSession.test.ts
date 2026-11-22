import { describe, expect, it } from 'vitest';
import {
  getVaultSessionRemainingMs,
  isVaultSessionExpired,
  VAULT_SESSION_IDLE_TIMEOUT_MS,
} from '../src/lib/vaultSession';

describe('15-minute vault session idle timeout', () => {
  it('remains unlocked just before the idle deadline', () => {
    const lastActivityAt = 10_000;
    const now = lastActivityAt + VAULT_SESSION_IDLE_TIMEOUT_MS - 1;
    expect(isVaultSessionExpired(lastActivityAt, now)).toBe(false);
    expect(getVaultSessionRemainingMs(lastActivityAt, now)).toBe(1);
  });

  it('expires exactly at 15 minutes without activity', () => {
    const lastActivityAt = 10_000;
    const now = lastActivityAt + VAULT_SESSION_IDLE_TIMEOUT_MS;
    expect(isVaultSessionExpired(lastActivityAt, now)).toBe(true);
    expect(getVaultSessionRemainingMs(lastActivityAt, now)).toBe(0);
  });

  it('allows a fresh 15-minute period after recorded activity', () => {
    const lastActivityAt = 25_000;
    expect(isVaultSessionExpired(lastActivityAt, lastActivityAt + 60_000)).toBe(false);
    expect(getVaultSessionRemainingMs(lastActivityAt, lastActivityAt + 60_000)).toBe(
      VAULT_SESSION_IDLE_TIMEOUT_MS - 60_000,
    );
  });

  it('fails closed for invalid or backwards monotonic timestamps', () => {
    expect(isVaultSessionExpired(Number.NaN, 10_000)).toBe(true);
    expect(isVaultSessionExpired(10_000, Number.POSITIVE_INFINITY)).toBe(true);
    expect(isVaultSessionExpired(10_001, 10_000)).toBe(true);
    expect(getVaultSessionRemainingMs(-1, 10_000)).toBe(0);
  });
});
