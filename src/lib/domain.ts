/**
 * Domain interfaces for key generation, address derivation, matching, storage,
 * and progress reporting. Concrete implementations live in sibling modules;
 * workers and UI depend only on these contracts so backends can be swapped.
 */

import type { BloomFilter } from './bloomFilter';

/** A freshly generated private-key wallet before any persistence decision. */
export interface GeneratedPrivateKeyWallet {
  privateKey: string;
  address: string;
  derivationPath: 'private-key';
}

export interface KeyGenerator {
  generateBatch(count: number): GeneratedPrivateKeyWallet[];
}

export interface AddressDeriver {
  deriveFromPrivateKey(privateKeyHex: string): string;
  isValidAddress(address: string): boolean;
}

export interface TargetAddressSet {
  readonly size: number;
  has(address: string): boolean;
  readonly bloom: BloomFilter | null;
}

export interface MatchDecision {
  wallet: GeneratedPrivateKeyWallet;
  matched: boolean;
}

export interface Matcher {
  /** Bloom-first then exact. Never returns a false negative. */
  decide(wallets: readonly GeneratedPrivateKeyWallet[]): MatchDecision[];
}

export interface MatchPersistResult {
  inserted: number;
  duplicates: number;
}

export interface MatchStorage {
  /** Persist only matching wallets. Must be transactional and idempotent by address. */
  saveMatches(wallets: readonly GeneratedPrivateKeyWallet[]): Promise<MatchPersistResult>;
}

export interface ProgressReporter {
  onBatchProcessed(stats: {
    generated: number;
    matched: number;
    discarded: number;
    durationMs: number;
  }): void;
  onStatus(status: string): void;
  onError(message: string): void;
}

/**
 * Future WebGPU path (not implemented): a compute shader could batch secp256k1
 * scalar multiplications and Keccak-256. The KeyGenerator interface is the
 * extension point; a WebGPUKeyGenerator would implement the same contract and
 * be selected via runtimeConfig.cryptoBackend when available and validated.
 */
export type FutureCryptoBackend = 'noble-js' | 'wasm-secp' | 'webgpu';
