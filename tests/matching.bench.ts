import { bench, describe } from 'vitest';
import { BloomFilter } from '../src/lib/bloomFilter';

const targets = Array.from({ length: 100_000 }, (_, index) => `T${index.toString(36).padStart(33, '0')}`);
const targetSet = new Set(targets);
const candidates = Array.from({ length: 10_000 }, (_, index) => targets[(index * 97) % targets.length]);

const bloom = new BloomFilter(targets.length);
for (const target of targets) bloom.add(target);

describe('local matching primitives', () => {
  bench('exact Set lookup for 10k addresses against 100k targets', () => {
    let matches = 0;
    for (const candidate of candidates) if (targetSet.has(candidate)) matches += 1;
    if (matches !== candidates.length) throw new Error('benchmark setup invalid');
  });

  bench('Bloom prefilter + exact Set confirmation for 10k addresses', () => {
    let matches = 0;
    for (const candidate of candidates) if (bloom.mayContain(candidate) && targetSet.has(candidate)) matches += 1;
    if (matches !== candidates.length) throw new Error('benchmark setup invalid');
  });
});
