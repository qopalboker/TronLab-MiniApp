import { describe, expect, it } from 'vitest';
import { shouldBlockVaultAccess } from '../src/lib/vaultAccessPolicy';

const base = {
  managerPresent: true,
  supported: true,
  available: true,
  deviceId: 'device-1',
  tokenSaved: true,
  walletCount: 3,
  hasKeyCheck: true,
};

describe('vault access fail-closed policy', () => {
  it('allows fresh biometric enrollment for an empty vault with a stale key-check', () => {
    expect(shouldBlockVaultAccess({ ...base, tokenSaved: false, walletCount: 0, hasKeyCheck: true })).toBe(false);
  });

  it('blocks when encrypted wallets exist but the biometric token is missing', () => {
    expect(shouldBlockVaultAccess({ ...base, tokenSaved: false })).toBe(true);
  });

  it('blocks when encrypted wallets exist but key-check is missing', () => {
    expect(shouldBlockVaultAccess({ ...base, hasKeyCheck: false })).toBe(true);
  });

  it('blocks when biometric support or device binding is unavailable', () => {
    expect(shouldBlockVaultAccess({ ...base, available: false })).toBe(true);
    expect(shouldBlockVaultAccess({ ...base, deviceId: null })).toBe(true);
  });

  it('blocks malformed wallet counts', () => {
    expect(shouldBlockVaultAccess({ ...base, walletCount: -1 })).toBe(true);
    expect(shouldBlockVaultAccess({ ...base, walletCount: Number.NaN })).toBe(true);
  });
});
