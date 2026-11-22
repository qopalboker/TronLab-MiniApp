import { describe, expect, it } from 'vitest';
import { PRIVATE_KEY_BATCH_SIZE, MAX_PRIVATE_KEY_BATCH_SIZE } from '../src/lib/walletGeneration';

describe('direct private-key generation configuration', () => {
  it('uses the maximum safe Web Crypto entropy batch without imposing a session cap', () => {
    expect(PRIVATE_KEY_BATCH_SIZE).toBe(2_048);
    expect(PRIVATE_KEY_BATCH_SIZE).toBe(MAX_PRIVATE_KEY_BATCH_SIZE);
  });
});
