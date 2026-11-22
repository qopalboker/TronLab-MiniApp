import { bench, describe } from 'vitest';
import { deriveTronAddressesFromMnemonic } from '../src/lib/seedDerivation';

// Public BIP39 test vector only; never use this phrase to hold funds.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('TRON HD derivation benchmark', () => {
  bench('derive 100 public addresses from a test mnemonic', async () => {
    const rows = await deriveTronAddressesFromMnemonic(TEST_MNEMONIC, 0, 100);
    if (rows.length !== 100) throw new Error('benchmark setup invalid');
  });
});
