/**
 * Generate → Bloom prefilter → exact match → keep only hits.
 * Non-matching private keys are wiped and never passed to storage.
 * This module is pure domain logic; workers and UI call it.
 */

import { generateTronPrivateKeyWalletBatch } from './tronPrivateKey';
import type { GeneratedPrivateKeyWallet, MatchDecision, Matcher, ProgressReporter } from './domain';
import { createBloomExactMatcher, type BuiltTargetAddressSet } from './targetAddressSet';

export interface GenerateAndMatchBatchResult {
  generated: number;
  matched: GeneratedPrivateKeyWallet[];
  discarded: number;
  durationMs: number;
}

/**
 * Generate a batch, filter against targets, wipe non-matching keys in place.
 * Returns only exact matches. Callers must persist matches transactionally.
 */
export function generateAndMatchBatch(
  count: number,
  matcher: Matcher,
): GenerateAndMatchBatchResult {
  const startedAt = performance.now();
  const wallets = generateTronPrivateKeyWalletBatch(count);
  const decisions: MatchDecision[] = matcher.decide(wallets);

  const matched: GeneratedPrivateKeyWallet[] = [];
  let discarded = 0;

  for (const decision of decisions) {
    if (decision.matched) {
      matched.push(decision.wallet);
    } else {
      discarded += 1;
      // Best-effort wipe before GC.
      decision.wallet.privateKey = '';
      decision.wallet.address = '';
    }
  }

  // Clear the source array references so non-matches are not retained.
  wallets.length = 0;

  return {
    generated: count,
    matched,
    discarded,
    durationMs: performance.now() - startedAt,
  };
}

export function createMatcherFromTargets(targets: BuiltTargetAddressSet): Matcher {
  return createBloomExactMatcher(targets);
}

export interface RunGenerateMatchLoopOptions {
  batchSize: number;
  matcher: Matcher;
  /** Return false to stop the loop (cancellation). */
  shouldContinue: () => boolean;
  onBatch: (result: GenerateAndMatchBatchResult) => void | Promise<void>;
  reporter?: ProgressReporter;
  /** Soft limit on total generated addresses for a single run (0 = unlimited). */
  maxGenerated?: number;
}

/**
 * Deterministic generate-and-match loop used by workers and tests.
 * Cancellation is cooperative: after the current batch finishes, shouldContinue
 * is checked before the next batch starts. No partial batch is left half-persisted
 * if onBatch is transactional.
 */
export async function runGenerateMatchLoop(options: RunGenerateMatchLoopOptions): Promise<{
  totalGenerated: number;
  totalMatched: number;
  totalDiscarded: number;
  cancelled: boolean;
}> {
  let totalGenerated = 0;
  let totalMatched = 0;
  let totalDiscarded = 0;
  const maxGenerated = options.maxGenerated && options.maxGenerated > 0 ? options.maxGenerated : Number.POSITIVE_INFINITY;

  while (options.shouldContinue() && totalGenerated < maxGenerated) {
    const remaining = maxGenerated - totalGenerated;
    const count = Math.min(options.batchSize, remaining);
    if (count < 1) break;

    const result = generateAndMatchBatch(count, options.matcher);
    totalGenerated += result.generated;
    totalMatched += result.matched.length;
    totalDiscarded += result.discarded;

    options.reporter?.onBatchProcessed({
      generated: result.generated,
      matched: result.matched.length,
      discarded: result.discarded,
      durationMs: result.durationMs,
    });

    await options.onBatch(result);

    // Wipe matched keys from the result after the consumer has had a chance to persist.
    for (const wallet of result.matched) {
      wallet.privateKey = '';
      wallet.address = '';
    }
    result.matched.length = 0;
  }

  const cancelled = !options.shouldContinue();
  return { totalGenerated, totalMatched, totalDiscarded, cancelled };
}
