import { describe, expect, it } from 'vitest';
import {
  createGenerationConfig,
  resolveWorkerCount,
  resolveBatchSize,
  DEFAULT_WORKER_COUNT,
  MAX_WORKER_COUNT,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} from '../src/lib/runtimeConfig';

describe('runtime configuration', () => {
  it('caps worker count by hardwareConcurrency and MAX_WORKER_COUNT', () => {
    expect(resolveWorkerCount(100, 4)).toBe(4);
    expect(resolveWorkerCount(2, 16)).toBe(2);
    expect(resolveWorkerCount(DEFAULT_WORKER_COUNT, 1)).toBe(1);
    expect(resolveWorkerCount(99, 99)).toBe(MAX_WORKER_COUNT);
  });

  it('caps batch size at MAX_BATCH_SIZE', () => {
    expect(resolveBatchSize(10_000)).toBe(MAX_BATCH_SIZE);
    expect(resolveBatchSize(0)).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize(512)).toBe(512);
  });

  it('createGenerationConfig merges overrides safely', () => {
    const cfg = createGenerationConfig({
      workerCount: 2,
      batchSize: 256,
      targetedMatchOnly: true,
      bloomFalsePositiveRate: 0.01,
    });
    expect(cfg.workerCount).toBe(2);
    expect(cfg.batchSize).toBe(256);
    expect(cfg.targetedMatchOnly).toBe(true);
    expect(cfg.bloomFalsePositiveRate).toBe(0.01);
    expect(cfg.cryptoBackend).toBe('noble-js');
  });
});
