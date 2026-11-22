import { describe, expect, it } from 'vitest';
import { deduplicateWalletBatch } from '../src/lib/walletBatch';

describe('wallet batch deduplication', () => {
  it('keeps the first record for each exact address and preserves input order', () => {
    const first = { id: '1', address: 'TONE' };
    const duplicate = { id: '2', address: 'TONE' };
    const second = { id: '3', address: 'TTWO' };
    const result = deduplicateWalletBatch([first, duplicate, second]);
    expect(result.uniqueRecords).toEqual([first, second]);
    expect(result.duplicates).toBe(1);
  });

  it('treats different address casing as distinct, removes only exact duplicates, and does not mutate input', () => {
    const input = [
      { id: '1', address: 'TAbc' },
      { id: '2', address: 'Tabc' },
      { id: '3', address: 'tabc' },
      { id: '4', address: 'TAbc' },
    ];
    const snapshot = input.map((record) => ({ ...record }));
    const result = deduplicateWalletBatch(input);
    expect(result.uniqueRecords).toEqual([input[0], input[1], input[2]]);
    expect(result.duplicates).toBe(1);
    expect(input).toEqual(snapshot);
  });

  it('handles an empty batch', () => {
    expect(deduplicateWalletBatch([])).toEqual({ uniqueRecords: [], duplicates: 0 });
  });
});
