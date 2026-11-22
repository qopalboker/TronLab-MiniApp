# Testing Guide — TRON Lab MiniApp

## Commands

```bash
# Typecheck
npm run check

# Unit + integration tests
npm test

# Benchmarks (Vitest bench)
npm run benchmark
npm run benchmark:wallet

# Full gate used by CI
npm run validate
```

## Layout

| Path | Purpose |
|------|---------|
| `tests/*.test.ts` | Unit and integration tests |
| `tests/*.bench.ts` | Performance budgets |
| `src/lib/generateAndMatch.ts` | Generate → Bloom → exact → keep-only-matches |
| `src/lib/targetAddressSet.ts` | TXT parse + Bloom target set builder |
| `src/lib/runtimeConfig.ts` | Worker/batch/Bloom/feature flags |
| `src/lib/domain.ts` | Interface contracts for future backends |

## Adding a test

1. Prefer pure domain functions under `src/lib/` so tests need no IndexedDB or Telegram.
2. Never log or snapshot private keys. Assert on addresses or boolean outcomes only.
3. For crypto vectors use the known secp256k1 scalar `1` → `TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC`.
4. Name files `*.test.ts` or `*.bench.ts`; Vitest discovers them under `tests/`.

## Critical invariants protected by tests

- Bloom filter: no false negatives for members; bounded memory.
- Generate-and-match: non-matches are discarded and keys wiped before return.
- Cancellation: cooperative after the current batch; no half-persisted batch when `onBatch` is transactional.
- Address derivation: fixed test vectors must not regress.
- Runtime config: worker and batch sizes are hard-capped.

## Performance budgets (indicative)

Recorded on developer hardware; adjust per target device in `BENCHMARK_GUIDE.fa.md`.

- Single-worker private-key generation: ≥ 2 000 addresses/s (noble-js).
- 3-worker pool raw generation: ≥ 5 000 addresses/s before encrypt/IDB.
- TXT parse + Bloom build for 100 k addresses: < 2 s, Bloom < 2 MiB at 0.1% FPR.
- UI main-thread block during a batch handoff: < 16 ms average.

## CI checklist

- [ ] `npm run check` (tsc)
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Optional: `npm run benchmark` on a reference machine and compare to budgets
