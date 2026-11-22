import type { WalletSummary } from './localDb';

export interface AddressMatchSummary {
  totalLines: number;
  blankLines: number;
  validUnique: number;
  invalid: number;
  duplicates: number;
  matched: number;
}

/** Serializable snapshot boundary returned from the matching worker. */
export interface MatchSnapshotPayload {
  newestCreatedAt: string | null;
  newestCreatedAtWalletIds: string[];
}

export type AddressMatchPhase = 'parsing' | 'scanning-vault';

export interface WalletScanProgressPayload {
  scannedCount: number;
  totalCount: number;
  matchedWalletCount: number;
  scanMode?: 'direct-lookups' | 'index-scan';
}

export type AddressMatchingRequest =
  | { id: string; type: 'match-file'; scope: string; file: File }
  | { id: string; type: 'match-text'; scope: string; text: string }
  | { id: string; type: 'cancel' };

export type AddressMatchingResponse =
  | { id: string; type: 'match-progress'; summary: AddressMatchSummary; processedLines: number; phase?: AddressMatchPhase; walletScan?: WalletScanProgressPayload; usageDelta?: { checkedAddressCount: number; matchedAddressCount: number; unmatchedAddressCount: number } }
  | { id: string; type: 'match-batch'; matches: WalletSummary[] }
  | { id: string; type: 'match-complete'; summary: AddressMatchSummary; cancelled: boolean; snapshot: MatchSnapshotPayload | null }
  | { id: string; type: 'error'; message: string };
