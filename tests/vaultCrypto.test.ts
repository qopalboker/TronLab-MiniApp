import { describe, expect, it } from 'vitest';
import { createVaultCheck, createVaultToken, decryptWalletPrivateKey, encryptWalletBatch, importVaultKeyFromToken, verifyVaultCheck, MAX_CONCURRENT_WALLET_ENCRYPTIONS, isEncryptedWalletRecord, isVaultCheckRecord } from '../src/lib/vaultCrypto';
import type { CreatedWallet } from '../src/lib/walletCreationProtocol';

const sampleWallet: Extract<CreatedWallet, { format: 'private-key' }> = {
  format: 'private-key',
  privateKey: '0'.repeat(63) + '1',
  address: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
  wordCount: 0,
  derivationPath: 'private-key',
};

describe('encrypted wallet vault', () => {
  it('encrypts each private key with a separate AES-GCM IV and decrypts it', async () => {
    const token = createVaultToken('scope-a');
    const key = await importVaultKeyFromToken(token, 'scope-a');
    const [first, second] = await encryptWalletBatch(key, 'scope-a', [sampleWallet, sampleWallet]);
    const firstIvBytes = Array.from(new Uint8Array(first.iv));
    const secondIvBytes = Array.from(new Uint8Array(second.iv));
    const firstCiphertextBytes = Array.from(new Uint8Array(first.ciphertext));
    const secondCiphertextBytes = Array.from(new Uint8Array(second.ciphertext));

    expect(firstIvBytes).toHaveLength(12);
    expect(secondIvBytes).toHaveLength(12);
    // Compare byte content, not ArrayBuffer objects: some runtimes/reporters
    // do not implement deep equality for ArrayBuffer consistently.
    expect(firstIvBytes).not.toEqual(secondIvBytes);
    expect(firstCiphertextBytes).not.toEqual(secondCiphertextBytes);
    expect(await decryptWalletPrivateKey(key, 'scope-a', first)).toBe(sampleWallet.privateKey);
    await expect(decryptWalletPrivateKey(key, 'scope-b', first)).rejects.toBeDefined();
    await expect(decryptWalletPrivateKey(key, 'scope-a', { ...first, address: 'TChangedAddress' })).rejects.toBeDefined();
  });

  it('encrypts a large batch in input order using a bounded concurrency setting', async () => {
    const key = await importVaultKeyFromToken(createVaultToken('scope-batch'), 'scope-batch');
    const wallets = Array.from({ length: MAX_CONCURRENT_WALLET_ENCRYPTIONS + 9 }, (_, index) => ({
      ...sampleWallet,
      privateKey: (BigInt(index) + 1n).toString(16).padStart(64, '0'),
      address: sampleWallet.address,
    }));

    const records = await encryptWalletBatch(key, 'scope-batch', wallets);

    expect(records).toHaveLength(wallets.length);
    expect(new Set(records.map((record) => record.id)).size).toBe(wallets.length);
    expect(await decryptWalletPrivateKey(key, 'scope-batch', records[0])).toBe(wallets[0].privateKey);
    expect(await decryptWalletPrivateKey(key, 'scope-batch', records[MAX_CONCURRENT_WALLET_ENCRYPTIONS])).toBe(wallets[MAX_CONCURRENT_WALLET_ENCRYPTIONS].privateKey);
    expect(await decryptWalletPrivateKey(key, 'scope-batch', records.at(-1)!)).toBe(wallets.at(-1)!.privateKey);
    await expect(encryptWalletBatch(key, 'scope-batch', [])).resolves.toEqual([]);
  });

  it('rejects a different biometric key and a different device', async () => {
    const keyA = await importVaultKeyFromToken(createVaultToken('scope-a'), 'scope-a');
    const keyB = await importVaultKeyFromToken(createVaultToken('scope-a'), 'scope-a');
    const check = await createVaultCheck(keyA, 'scope-a', 'device-a');
    expect(await verifyVaultCheck(keyA, 'scope-a', 'device-a', check)).toBe(true);
    expect(await verifyVaultCheck(keyB, 'scope-a', 'device-a', check)).toBe(false);
    expect(await verifyVaultCheck(keyA, 'scope-a', 'device-b', check)).toBe(false);
  });

  it('rejects malformed tokens and tokens bound to a different Telegram account', async () => {
    await expect(importVaultKeyFromToken('invalid', 'scope-a')).rejects.toThrow('توکن امن دیتابیس معتبر نیست.');
    await expect(importVaultKeyFromToken(createVaultToken('scope-a'), 'scope-b')).rejects.toThrow('کلید امن متعلق به حساب تلگرام دیگری است.');
  });

  it('rejects malformed persisted encrypted-record metadata before decrypting', async () => {
    const key = await importVaultKeyFromToken(createVaultToken('scope-shape'), 'scope-shape');
    const [record] = await encryptWalletBatch(key, 'scope-shape', [sampleWallet]);
    expect(isEncryptedWalletRecord(record)).toBe(true);
    expect(isEncryptedWalletRecord({ ...record, iv: new ArrayBuffer(8) })).toBe(false);
    expect(isEncryptedWalletRecord({ ...record, ciphertext: new ArrayBuffer(8) })).toBe(false);
    expect(isEncryptedWalletRecord({ ...record, createdAt: 'invalid-date' })).toBe(false);
    await expect(decryptWalletPrivateKey(key, 'scope-shape', { ...record, iv: new ArrayBuffer(8) })).rejects.toThrow('ساختار رکورد رمزگذاری‌شده ناقص یا ناسازگار است');
    await expect(encryptWalletBatch(key, 'scope-shape', [{ ...sampleWallet, privateKey: 'not-a-private-key' }])).rejects.toThrow('ورودی کیف‌پول برای رمزگذاری معتبر نیست');
  });

  it('rejects malformed vault key-check metadata without attempting decryption', async () => {
    const key = await importVaultKeyFromToken(createVaultToken('scope-check'), 'scope-check');
    const validCheck = await createVaultCheck(key, 'scope-check', 'device-check');
    expect(isVaultCheckRecord(validCheck)).toBe(true);
    const malformed = { ...validCheck, iv: new ArrayBuffer(2) };
    expect(isVaultCheckRecord(malformed)).toBe(false);
    expect(await verifyVaultCheck(key, 'scope-check', 'device-check', malformed)).toBe(false);
  });

});
