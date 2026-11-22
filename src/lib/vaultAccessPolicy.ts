export interface VaultAccessPolicyInput {
  managerPresent: boolean;
  supported: boolean;
  available: boolean;
  deviceId: string | null | undefined;
  tokenSaved: boolean;
  walletCount: number;
  hasKeyCheck: boolean;
}

/**
 * Fail closed whenever encrypted wallets exist without their biometric token
 * or key-check. A stale key-check alone does not lock an empty vault: it can be
 * safely replaced after a fresh biometric enrollment because no wallet data
 * depends on the old key.
 */
export function shouldBlockVaultAccess(input: VaultAccessPolicyInput): boolean {
  if (!input.managerPresent || !input.supported || !input.available || !input.deviceId) return true;
  if (!Number.isSafeInteger(input.walletCount) || input.walletCount < 0) return true;
  if (!input.tokenSaved && input.walletCount > 0) return true;
  if (input.tokenSaved && input.walletCount > 0 && !input.hasKeyCheck) return true;
  return false;
}
