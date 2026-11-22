import { describe, expect, it } from 'vitest';
import { deriveTronAddressesFromMnemonic } from '../src/lib/seedDerivation';
import { selectExactAddressMatches } from '../src/lib/matching';

const BIP39_VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('wallet generation and exact matching pipeline', () => {
  it('derives a TRON address from the supplied test seed and matches the imported TXT address', async () => {
    const generated = await deriveTronAddressesFromMnemonic(BIP39_VECTOR, 0, 3);
    const importedTxtAddresses = new Set([
      'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
      'TUnrelatedAddressNotActuallyValid',
    ]);

    const matches = selectExactAddressMatches(generated, importedTxtAddresses);

    expect(matches).toHaveLength(1);
    expect(matches[0].address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(matches[0].addressIndex).toBe(0);
  });

  it('rejects probable-only matches unless the exact full address exists', () => {
    const generated = [
      { address: 'TAddressOne', addressIndex: 0, derivationPath: "m/44'/195'/0'/0/0" },
      { address: 'TAddressTwo', addressIndex: 1, derivationPath: "m/44'/195'/0'/0/1" },
    ];
    const exactDbResults = new Set(['TAddressOne']);

    expect(selectExactAddressMatches(generated, exactDbResults).map((item) => item.address)).toEqual(['TAddressOne']);
  });
});
