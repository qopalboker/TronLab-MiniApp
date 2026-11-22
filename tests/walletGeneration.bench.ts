import { bench, describe } from 'vitest';
import { generateTronPrivateKeyWalletBatch } from '../src/lib/tronPrivateKey';

/** Measures raw-key throughput without using matching or external services. */
describe('TRON raw private-key generation benchmark', () => {
  bench('generate one TRON wallet', () => {
    const wallets = generateTronPrivateKeyWalletBatch(1);
    if (wallets.length !== 1) throw new Error('benchmark setup invalid');
  });

  bench('generate one 2,048-wallet batch', () => {
    const wallets = generateTronPrivateKeyWalletBatch(2_048);
    if (wallets.length !== 2_048) throw new Error('benchmark setup invalid');
  });
});
