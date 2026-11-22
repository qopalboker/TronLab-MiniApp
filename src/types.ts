export type SeedGroup = 'weak' | 'strong';
export type DerivationScheme = 'bip44-address-index' | 'legacy-account-index';

export interface SeedInput {
  group: SeedGroup;
  label: string;
  mnemonic: string;
}

export interface MatchRecord {
  id: string;
  group: SeedGroup;
  seedLabel: string;
  addressIndex: number;
  address: string;
  derivationPath: string;
  matchedAt: string;
}

export interface LocalStats {
  targetCount: number;
  matchCount: number;
}

export interface ImportSummary {
  valid: number;
  invalid: number;
  duplicates: number;
  total: number;
}

export type WorkerRequest =
  | { type: 'init'; scope: string }
  | { type: 'import-text'; text: string }
  | { type: 'import-file'; file: File }
  | {
      type: 'match';
      seeds: SeedInput[];
      startIndex: number;
      accountIndex: number;
      changeIndex: number;
      derivationScheme: DerivationScheme;
      bip39Passphrase: string;
    }
  | { type: 'cancel' }
  | { type: 'get-results' }
  | { type: 'get-all-results' }
  | { type: 'clear-results' }
  | { type: 'clear-targets' };

export type WorkerResponse =
  | { type: 'ready'; stats: LocalStats }
  | { type: 'import-progress'; processedLines: number }
  | { type: 'import-complete'; summary: ImportSummary; stats: LocalStats }
  | { type: 'match-progress'; processed: number; matches: number; currentLabel: string }
  | { type: 'match-complete'; stats: LocalStats; cancelled: boolean; invalidSeeds: string[]; processed: number; matches: number }
  | { type: 'results'; results: MatchRecord[]; stats: LocalStats }
  | { type: 'all-results'; results: MatchRecord[] }
  | { type: 'cleared'; kind: 'targets' | 'results'; stats: LocalStats }
  | { type: 'error'; message: string };
