import { describe, expect, it } from 'vitest';
import {
  advanceGenerationCheckpoint,
  createGenerationCheckpoint,
  markCheckpointInterrupted,
  markCheckpointPaused,
  startOrResumeCheckpoint,
  isGenerationCheckpoint,
} from '../src/lib/generationCheckpoint';

describe('generation checkpoint lifecycle', () => {
  it('creates a clean checkpoint for a first run', () => {
    const checkpoint = createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1');
    expect(checkpoint).toMatchObject({
      runId: 'run-1', status: 'running', savedCount: 0, duplicateCount: 0,
      lastBatchAt: null, lastBatchCount: 0, lastBatchDuplicates: 0,
    });
  });

  it('marks an uncleanly closed run interrupted without changing committed counters', () => {
    const running = advanceGenerationCheckpoint(
      createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1'), 2048, 3, '2026-11-22T10:01:00.000Z',
    );
    const recovered = markCheckpointInterrupted(running, '2026-11-22T10:02:00.000Z');
    expect(recovered).toMatchObject({ status: 'interrupted', runId: 'run-1', savedCount: 2048, duplicateCount: 3 });
    expect(recovered.lastBatchAt).toBe('2026-11-22T10:01:00.000Z');
  });

  it('resumes the same run without resetting its durable progress', () => {
    const interrupted = markCheckpointInterrupted(
      advanceGenerationCheckpoint(createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1'), 1024, 2, '2026-11-22T10:01:00.000Z'), '2026-11-22T10:02:00.000Z',
    );
    const resumed = startOrResumeCheckpoint(interrupted, '2026-11-22T10:03:00.000Z', 'unused-new-id');
    expect(resumed).toMatchObject({ status: 'running', runId: 'run-1', startedAt: '2026-11-22T10:00:00.000Z', savedCount: 1024, duplicateCount: 2 });
  });

  it('increments only inserted and explicitly skipped duplicate counts', () => {
    const first = createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1');
    const next = advanceGenerationCheckpoint(first, 1000, 24, '2026-11-22T10:01:00.000Z');
    expect(next).toMatchObject({ savedCount: 1000, duplicateCount: 24, lastBatchCount: 1000, lastBatchDuplicates: 24 });
    expect(advanceGenerationCheckpoint(next, 512, 1, '2026-11-22T10:02:00.000Z')).toMatchObject({ savedCount: 1512, duplicateCount: 25 });
  });

  it('marks manual stop as paused and leaves an already paused checkpoint unchanged', () => {
    const running = createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1');
    const paused = markCheckpointPaused(running, '2026-11-22T10:02:00.000Z');
    expect(paused.status).toBe('paused');
    expect(markCheckpointPaused(paused, '2026-11-22T10:04:00.000Z')).toBe(paused);
  });

  it('rejects invalid batch counters', () => {
    const checkpoint = createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1');
    expect(() => advanceGenerationCheckpoint(checkpoint, -1, 0, '2026-11-22T10:01:00.000Z')).toThrow();
    expect(() => advanceGenerationCheckpoint(checkpoint, 1.5, 0, '2026-11-22T10:01:00.000Z')).toThrow();
  });

  it('rejects malformed persisted checkpoints and counter overflow', () => {
    const checkpoint = createGenerationCheckpoint('2026-11-22T10:00:00.000Z', 'run-1');
    expect(isGenerationCheckpoint(checkpoint)).toBe(true);
    expect(isGenerationCheckpoint({ ...checkpoint, savedCount: -1 })).toBe(false);
    expect(isGenerationCheckpoint({ ...checkpoint, updatedAt: 'not-a-date' })).toBe(false);
    expect(() => startOrResumeCheckpoint({ ...checkpoint, duplicateCount: Number.MAX_SAFE_INTEGER + 1 }, '2026-11-22T10:01:00.000Z', 'run-2')).toThrow();
    expect(() => advanceGenerationCheckpoint({ ...checkpoint, savedCount: Number.MAX_SAFE_INTEGER }, 1, 0, '2026-11-22T10:01:00.000Z')).toThrow();
  });

});
