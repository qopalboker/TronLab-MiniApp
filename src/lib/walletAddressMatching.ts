import { isValidTronAddress } from './tronAddress';

export type AddressLineStatus = 'blank' | 'invalid' | 'duplicate' | 'valid';

/** Tracks and validates exact public TRON address strings without case folding. */
export class ExactAddressLineTracker {
  private readonly seen = new Set<string>();

  /** Unique, validated, case-sensitive Base58 addresses for O(1) lookup. */
  get addresses(): ReadonlySet<string> {
    return this.seen;
  }

  classify(rawLine: string): { status: AddressLineStatus; address?: string } {
    const address = rawLine.replace(/^\uFEFF/, '').trim();
    if (!address) return { status: 'blank' };
    if (!isValidTronAddress(address)) return { status: 'invalid' };
    if (this.seen.has(address)) return { status: 'duplicate', address };
    this.seen.add(address);
    return { status: 'valid', address };
  }
}



/** Select the cheaper IndexedDB strategy for a target set and vault size. */
export function chooseAddressScanMode(targetCount: number, vaultCount: number): 'direct-lookups' | 'index-scan' {
  const safeTargetCount = Number.isSafeInteger(targetCount) ? Math.max(0, targetCount) : Number.MAX_SAFE_INTEGER;
  const safeVaultCount = Number.isSafeInteger(vaultCount) ? Math.max(0, vaultCount) : 0;
  const directLookupThreshold = Math.min(safeVaultCount, Math.max(256, Math.floor(safeVaultCount / 16)));
  return safeTargetCount <= directLookupThreshold ? 'direct-lookups' : 'index-scan';
}

export interface WalletMatchSnapshot {
  newestCreatedAt: string | null;
  newestCreatedAtWalletIds: ReadonlySet<string>;
}

/** A purge needs at least one retained wallet as an explicit safety anchor. */
export function hasSafeUnmatchedPurgeAnchor(
  snapshot: WalletMatchSnapshot,
  matchedIds: ReadonlySet<string>,
): boolean {
  return Boolean(snapshot.newestCreatedAt) && matchedIds.size > 0;
}

/**
 * Determines whether a stored wallet existed at the moment an address match run
 * began. The boundary IDs disambiguate records created in the same millisecond.
 */
export function isWalletInMatchSnapshot(
  wallet: { id: string; createdAt: string },
  snapshot: WalletMatchSnapshot,
): boolean {
  if (!snapshot.newestCreatedAt) return false;
  const walletTime = Date.parse(wallet.createdAt);
  const boundaryTime = Date.parse(snapshot.newestCreatedAt);
  if (!Number.isFinite(walletTime) || !Number.isFinite(boundaryTime)) return false;
  if (walletTime < boundaryTime) return true;
  return walletTime === boundaryTime && snapshot.newestCreatedAtWalletIds.has(wallet.id);
}
