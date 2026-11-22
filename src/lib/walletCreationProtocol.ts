import type { Bip39WordCount } from './seedDerivation';

export type CreatedWallet =
  | {
      format: 'mnemonic';
      mnemonic: string;
      wordCount: Bip39WordCount;
      address: string;
      derivationPath: string;
    }
  | {
      format: 'private-key';
      privateKey: string;
      wordCount: 0;
      address: string;
      derivationPath: 'private-key';
    };

export type ValidatedWallet =
  | {
      format: 'mnemonic';
      valid: boolean;
      wordCount: number;
      address?: string;
      derivationPath?: string;
      message?: string;
    }
  | {
      format: 'private-key';
      valid: boolean;
      wordCount: 0;
      address?: string;
      derivationPath?: 'private-key';
      message?: string;
    };

export type WalletCreationRequest =
  | { id: string; type: 'generate-private-key-batch'; count: number }
  | { id: string; type: 'benchmark-private-key-batch'; count: number }
  | { id: string; type: 'validate'; mnemonic: string }
  | { id: string; type: 'validate-private-key'; privateKey: string };

export type WalletCreationResponse =
  | { id: string; type: 'generated-batch'; wallets: Extract<CreatedWallet, { format: 'private-key' }>[]; metrics?: { workerDurationMs: number } }
  | { id: string; type: 'benchmark-batch-complete'; count: number; metrics: { workerDurationMs: number } }
  | ({ id: string; type: 'validated' } & ValidatedWallet)
  | { id: string; type: 'error'; message: string };
