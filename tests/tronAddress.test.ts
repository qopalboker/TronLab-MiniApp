import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { isValidTronAddress, tronAddressFromPublicKey } from '../src/lib/tronAddress';
import { deriveTronAddressFromPrivateKey } from '../src/lib/tronPrivateKey';

describe('TRON address validation', () => {
  it('derives the known address for private key 1', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    const address = tronAddressFromPublicKey(publicKey);
    expect(address).toBe('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC');
    expect(isValidTronAddress(address)).toBe(true);
    privateKey.fill(0);
    publicKey.fill(0);
  });

  it('derives the known test address through the direct-private-key production path', () => {
    expect(deriveTronAddressFromPrivateKey(`${'0'.repeat(63)}1`)).toBe('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC');
  });

  it('rejects a checksum-tampered address', () => {
    expect(isValidTronAddress('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HA')).toBe(false);
  });

  it('rejects non-TRON and malformed strings', () => {
    expect(isValidTronAddress('not-an-address')).toBe(false);
    expect(isValidTronAddress('')).toBe(false);
  });
});
