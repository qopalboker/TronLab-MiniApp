import { describe, expect, it } from 'vitest';
import { generateAndMatchBatch, createMatcherFromTargets, runGenerateMatchLoop } from '../src/lib/generateAndMatch';
import { buildTargetAddressSetFromText } from '../src/lib/targetAddressSet';
import { deriveTronAddressFromPrivateKey, generateTronPrivateKeyWalletBatch } from '../src/lib/tronPrivateKey';
import { BloomFilter } from '../src/lib/bloomFilter';

describe('generate-and-match pipeline', () => {
  it('discards non-matching wallets and never returns their private keys in the match list', async () => {
    const targets = await buildTargetAddressSetFromText(
      'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC\nTUnrelatedInvalid\n',
      { useBloom: true },
    );
    expect(targets.summary.validUnique).toBe(1);

    const matcher = createMatcherFromTargets(targets);
    // Generate a batch; probability of hitting the known address is negligible.
    const result = generateAndMatchBatch(64, matcher);
    expect(result.generated).toBe(64);
    expect(result.matched.length + result.discarded).toBe(64);
    // All non-matches wiped
    for (const m of result.matched) {
      expect(m.privateKey).toMatch(/^[0-9a-f]{64}$/);
      expect(targets.has(m.address)).toBe(true);
    }
  });

  it('exact-matches a known private-key address when it is in the target set', async () => {
    // private key 1 → TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC
    const knownAddress = deriveTronAddressFromPrivateKey(`${'0'.repeat(63)}1`);
    const targets = await buildTargetAddressSetFromText(knownAddress + '\n');
    const matcher = createMatcherFromTargets(targets);

    // Force a single wallet by generating and manually deciding via matcher
    // using the known key path: generate random batch then inject known key via decide on a synthetic list.
    const synthetic = [
      {
        privateKey: `${'0'.repeat(63)}1`,
        address: knownAddress,
        derivationPath: 'private-key' as const,
      },
    ];
    const decisions = matcher.decide(synthetic);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].matched).toBe(true);
  });

  it('Bloom prefilter never produces false negatives for members', async () => {
    const wallets = generateTronPrivateKeyWalletBatch(32);
    const addresses = wallets.map((w) => w.address).join('\n');
    const targets = await buildTargetAddressSetFromText(addresses);
    expect(targets.bloom).not.toBeNull();
    for (const w of wallets) {
      expect(targets.bloom!.mayContain(w.address)).toBe(true);
      expect(targets.has(w.address)).toBe(true);
    }
    // Wipe
    for (const w of wallets) {
      w.privateKey = '';
      w.address = '';
    }
  });

  it('runGenerateMatchLoop respects cancellation and does not call onBatch after stop', async () => {
    const targets = await buildTargetAddressSetFromText('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC\n');
    const matcher = createMatcherFromTargets(targets);
    let batches = 0;
    let continueFlag = true;

    const summary = await runGenerateMatchLoop({
      batchSize: 16,
      matcher,
      shouldContinue: () => continueFlag,
      maxGenerated: 10_000,
      onBatch: async () => {
        batches += 1;
        if (batches >= 2) continueFlag = false;
      },
    });

    expect(batches).toBe(2);
    expect(summary.cancelled).toBe(true);
    expect(summary.totalGenerated).toBe(32);
    expect(summary.totalMatched + summary.totalDiscarded).toBe(32);
  });

  it('empty target set discards every generated wallet', async () => {
    const targets = await buildTargetAddressSetFromText('');
    const matcher = createMatcherFromTargets(targets);
    const result = generateAndMatchBatch(8, matcher);
    expect(result.matched).toHaveLength(0);
    expect(result.discarded).toBe(8);
  });
});

describe('BloomFilter export/import', () => {
  it('round-trips bits without false negatives', () => {
    const filter = new BloomFilter(100);
    const values = ['TAddrOne', 'TAddrTwo', 'TAddrThree'];
    for (const v of values) filter.add(v);

    const restored = BloomFilter.fromBits(filter.exportBits(), filter.getBitCount(), filter.getHashCount());
    for (const v of values) {
      expect(restored.mayContain(v)).toBe(true);
    }
  });
});
