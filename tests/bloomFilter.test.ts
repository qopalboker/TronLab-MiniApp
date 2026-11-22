import { describe, expect, it } from 'vitest';
import { BloomFilter } from '../src/lib/bloomFilter';

describe('BloomFilter', () => {
  it('never rejects values that were inserted', () => {
    const filter = new BloomFilter(10_000);
    const values = Array.from({ length: 10_000 }, (_, index) => `T-test-${index}`);
    for (const value of values) filter.add(value);
    expect(values.every((value) => filter.mayContain(value))).toBe(true);
  });

  it('uses bounded memory for an expected item count', () => {
    const filter = new BloomFilter(1_000_000);
    expect(filter.byteLength).toBeLessThan(2_000_000);
  });
});
