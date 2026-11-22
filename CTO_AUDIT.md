# CTO Technical Audit — TRON Lab v2.8.7

**Date:** 2026-11-22  
**Scope:** Architecture correctness vs intended generate→match→save-only flow, performance, security, and implementation plan.

---

## 1. Audit summary

### Current architecture (as shipped)

| Layer | Responsibility |
|-------|----------------|
| Telegram BiometricManager | Sole unlock path; AES-256 vault key in biometric token |
| `WalletVaultPool` + 3× `wallet-vault.worker` | Generate random secp256k1 keys, encrypt, persist **all** wallets |
| IndexedDB (`localDb`) | Encrypted private keys + plaintext address index `byAddress`, checkpoints |
| `AddressMatchPanel` + `address-matching.worker` | **Watch-only**: parse TXT targets, scan **stored** vault by address index |
| Bloom filter module | Present and tested; used as prefilter infrastructure, not on the generate path |

**Data flow today**

```
Start → Worker pool generates N keys → encrypt all → IDB save all
         ↘ later: upload TXT → scan vault index → report matches (no decrypt)
```

This is a **secure bulk generator + encrypted vault + separate watch-only matcher**. It is **not** a generate-and-filter pipeline that only keeps hits.

### Intended flow (product goal from brief)

```
Start → generate keys → check each address against TXT target set
      → on exact match: encrypt + save
      → otherwise: wipe key, discard
```

### Gap

The Start button starts **unconditional** generation into the vault. Matching is a second, independent tool against already-stored wallets. Non-matching private keys **are** persisted (encrypted). That is the opposite of the brief’s “save only on exact match / otherwise discard.”

### What already exists and is solid

- Worker pool with typed protocol, graceful stop, checkpointed batches
- Transactional `saveEncryptedWalletBatch` + address index + duplicate rejection
- Stream TXT parsing, ExactAddressLineTracker, BloomFilter (no false negatives)
- Biometric fail-closed vault, non-extractable CryptoKey, key-check
- Extensive unit tests and benches for crypto, Bloom, checkpoints, vault crypto
- Schema versioning and health inspection

### Bottlenecks

1. **Persistence of non-matches** — encrypt + IDB write dominate cost; storing everything is wasteful for a target-hunt use case.
2. **Matching path** — correct but only useful after the vault is already large; does not reduce generation cost.
3. **Crypto** — `@noble/curves` + `@noble/hashes` (pure JS). Fast enough for mobile; WASM would help further but is secondary to “don’t store misses.”
4. **Main-thread / worker messaging** — batch size 1024 amortizes well; already tuned.

### Security / memory / UI risks

- Private keys never leave the device; wiped best-effort after encrypt. Good.
- Strings in JS cannot be securely zeroized; accepted limitation, documented.
- Large TXT files: 16 MiB and address-count caps exist; Bloom size is bounded.
- Concurrent generation + matching is gated in UI to protect IDB snapshot integrity.
- QuotaExceeded stops generation without corrupting prior commits.

---

## 2. Assumptions

1. User-owned / authorized address lists only; no feature for attacking third-party wallets.
2. Existing vault users must not lose data; targeted mode is additive, not a silent default change.
3. Telegram Mini App remains the only supported host (biometric required).
4. Moderate target sets (up to hundreds of thousands of addresses) fit in worker structured-clone budgets; multi-million sets stay main-thread + Bloom-transfer.
5. “Pause/resume” continues to mean checkpoint + cooperative stop after the current batch.

---

## 3. Implementation plan (prioritized)

| Priority | Item | Impact | Effort | Status |
|----------|------|--------|--------|--------|
| P0 | Document mismatch; keep vault path intact | Clarity | S | Done (this doc) |
| P0 | Domain pipeline `generateAndMatch` + target set builder | Correctness | M | Done |
| P0 | Bloom export/import; worker message `generate-match-and-store-batch` | Enables save-only-matches | M | Done |
| P0 | Runtime config / feature flags | Operability | S | Done |
| P0 | Unit tests for pipeline, targets, config | Safety | M | Done |
| P1 | Wire UI “Targeted generation” mode (TXT required, Start uses match path) | Product alignment | M | Scaffold only |
| P1 | Pool API to dispatch match-batches with shared target set | Throughput | M | Next |
| P2 | WASM secp256k1 / Keccak backend behind `cryptoBackend` flag | +20–50% gen rate | L | Documented |
| P2 | WebGPU path (interface reserved in `domain.ts`) | Future | XL | Not started |
| P3 | Property/fuzz tests expansion | Hardening | M | Partial |

---

## 4. Code changes (this delivery)

**Added**

- `src/lib/runtimeConfig.ts` — worker/batch/Bloom/feature flags
- `src/lib/domain.ts` — KeyGenerator, Matcher, MatchStorage, ProgressReporter contracts + WebGPU note
- `src/lib/targetAddressSet.ts` — stream-friendly TXT → exact Set + Bloom with hard limits
- `src/lib/generateAndMatch.ts` — generate → Bloom → exact → return matches only; cooperative loop
- `tests/generateAndMatch.test.ts`, `tests/targetAddressSet.test.ts`, `tests/runtimeConfig.test.ts`
- `TESTING.md`, `CTO_AUDIT.md`

**Modified**

- `src/lib/bloomFilter.ts` — `exportBits` / `fromBits` / getters for worker transfer
- `src/workers/wallet-vault.worker.ts` — new `generate-match-and-store-batch` path; non-matches never encrypted

**Intentionally not rewritten**

- Full UI Start-button rewire (would break current “fill vault then match” users without a clear mode switch)
- WASM crypto (noble is correct and already fast; abstraction is ready)
- WebGPU
- Replacing the watch-only matcher (still valuable for auditing an existing vault)

---

## 5. Tests added

- Pipeline: discard non-matches, exact hit on known vector, Bloom no false negatives, cancellation, empty target set
- Target set: line classes, size limits, Bloom on/off
- Config: worker/batch caps, override merge
- Bloom round-trip via `fromBits`

Existing suites (address derivation, vault crypto, checkpoints, biometric policy) remain the regression net for the vault path.

---

## 6. Benchmark results

Could not execute Vitest in this sandbox (npm install instability). Expected after `npm install && npm run benchmark`:

- `generateAndMatchBatch(1024)` should be within a few percent of raw `generateTronPrivateKeyWalletBatch(1024)` when the target set is empty or tiny (Bloom reject is cheap).
- With a large Bloom, exact-match path cost is dominated by generation, not lookup.

Re-run on device per `BENCHMARK_GUIDE.fa.md` and record numbers in CI artifacts.

---

## 7. Acceptance criteria checklist

| Task | Criterion | Met? |
|------|-----------|------|
| 1. Generation-and-match pipeline | Domain path generates → filters → persists only matches; non-matches wiped | Yes (lib + worker message) |
| 1. Start/stop deterministic | Cooperative cancel after batch; existing checkpoint rules unchanged | Yes for new loop; UI mode pending |
| 2. Worker pool | Existing pool kept; new message type for match-batches | Yes |
| 3. Faster crypto | Abstraction + noble retained; WASM/WebGPU reserved | Partial (abstraction only) |
| 4. Faster TXT matching | Stream parse, one-shot normalize, Bloom + exact, size limits | Yes (`targetAddressSet`) |
| 5. Persistence | Only matches encrypted; IDB index + transactional save reused | Yes on match path |
| 6. Config / interfaces / benches | Flags, domain interfaces, TESTING.md | Yes |
| Tests | Unit coverage for new modules | Yes (not executed here) |

---

## 8. Risks, trade-offs, next steps

**Risks**

- Shipping targeted mode as default without a UI toggle would surprise users who rely on bulk vault fill.
- Transferring multi-million address lists to every worker via structured clone is expensive; prefer Bloom transfer + shared exact set on main thread for huge lists.
- Bloom `fromBits` assumes identical parameters; tests cover round-trip.

**Trade-offs**

- Kept the existing “store everything” path fully intact for backward compatibility.
- Did not rewrite `WalletCreationPanel` Start handler in this pass (high UI risk, needs product decision on mode switch copy).

**Recommended next steps (order)**

1. UI: add “حالت هدف‌دار / Targeted” toggle; when on, require TXT, call `generate-match-and-store-batch`, show matched/discarded rates.
2. Extend `WalletVaultPool` to accept a shared `BuiltTargetAddressSet` and fan out match-batches.
3. Optional WASM backend behind `cryptoBackend: 'wasm-secp'` once a vetted build is available.
4. Property tests for random TXT lines and address-near-miss strings.
5. CI: wire `npm run validate` on PR.

**Explicitly not done**

- Full product pivot of Start button (needs UX + migration messaging).
- WebGPU implementation (documented extension point only).
- Server-side or networked matching (forbidden by threat model).
