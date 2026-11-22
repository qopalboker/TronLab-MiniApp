import { describe, expect, it } from 'vitest';
import {
  createTronAddressDeriver,
  deriveTronAddressesFromMnemonic,
  isValidEnglishBip39Mnemonic,
} from '../src/lib/seedDerivation';
import { deriveTronAddressFromPrivateKey, generateTronPrivateKeyWallet, generateTronPrivateKeyWalletBatch } from '../src/lib/tronPrivateKey';
import { isValidTronAddress } from '../src/lib/tronAddress';
import { wordlist } from '@scure/bip39/wordlists/english';

const BIP39_VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('BIP39 and TRON derivation', () => {
  it('loads the pinned English BIP39 wordlist', () => {
    expect(wordlist).toHaveLength(2048);
    expect(wordlist[0]).toBe('abandon');
    expect(wordlist[2047]).toBe('zoo');
  });

  it('rejects invalid BIP39 word counts and checksums', () => {
    expect(isValidEnglishBip39Mnemonic('abandon '.repeat(13).trim())).toBe(false);
  });

  it('derives deterministic valid TRON addresses on the standard path', async () => {
    expect(isValidEnglishBip39Mnemonic(BIP39_VECTOR)).toBe(true);
    const first = await deriveTronAddressesFromMnemonic(BIP39_VECTOR, 0, 3);
    const second = await deriveTronAddressesFromMnemonic(BIP39_VECTOR, 0, 3);
    expect(first.map((item) => item.address)).toEqual(second.map((item) => item.address));
    expect(first.every((item) => isValidTronAddress(item.address))).toBe(true);
    expect(first.map((item) => item.addressIndex)).toEqual([0, 1, 2]);
    expect(first[0].derivationPath).toBe("m/44'/195'/0'/0/0");
    expect(first[0].address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });

  it('supports incremental derivation and disposal', async () => {
    const deriver = await createTronAddressDeriver(BIP39_VECTOR);
    const first = deriver.deriveAt(0);
    expect(isValidTronAddress(first.address)).toBe(true);
    deriver.dispose();
    expect(() => deriver.deriveAt(1)).toThrow();
  });

  it('supports the legacy account-index derivation path', async () => {
    const legacy = await deriveTronAddressesFromMnemonic(BIP39_VECTOR, 1, 1, 0, 0, '', 'legacy-account-index');
    expect(legacy[0].derivationPath).toBe("m/44'/195'/1'/0/0");
    expect(isValidTronAddress(legacy[0].address)).toBe(true);
  });


  it('derives the known TRON address from raw private key 1', () => {
    const privateKeyOne = `${'0'.repeat(63)}1`;
    expect(deriveTronAddressFromPrivateKey(privateKeyOne)).toBe('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC');
    expect(() => deriveTronAddressFromPrivateKey('0'.repeat(64))).toThrow();
    expect(() => deriveTronAddressFromPrivateKey('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')).toThrow();
    expect(() => deriveTronAddressFromPrivateKey('not-a-private-key')).toThrow();
  });

  it('generates an independent wallet with a valid random private key', () => {
    const wallet = generateTronPrivateKeyWallet();
    expect(wallet.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(wallet.derivationPath).toBe('private-key');
    expect(isValidTronAddress(wallet.address)).toBe(true);
    expect(deriveTronAddressFromPrivateKey(wallet.privateKey)).toBe(wallet.address);
  });

  it('generates a batch of unique private-key wallets with matching TRON addresses', () => {
    const wallets = generateTronPrivateKeyWalletBatch(32);
    expect(wallets).toHaveLength(32);
    expect(new Set(wallets.map((wallet) => wallet.privateKey)).size).toBe(32);
    expect(wallets.every((wallet) => deriveTronAddressFromPrivateKey(wallet.privateKey) === wallet.address)).toBe(true);
    expect(wallets.every((wallet) => isValidTronAddress(wallet.address))).toBe(true);
    expect(() => generateTronPrivateKeyWalletBatch(2_049)).toThrow();
  });

  it('rejects invalid checksum phrases', async () => {
    const invalid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    expect(isValidEnglishBip39Mnemonic(invalid)).toBe(false);
    await expect(deriveTronAddressesFromMnemonic(invalid, 0, 1)).rejects.toThrow();
  });
});
