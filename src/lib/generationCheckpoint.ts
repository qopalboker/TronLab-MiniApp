export const GENERATION_CHECKPOINT_KEY = 'generation-checkpoint' as const;

export type GenerationCheckpointStatus = 'running' | 'paused' | 'interrupted';

export interface GenerationCheckpoint {
  key: typeof GENERATION_CHECKPOINT_KEY;
  version: 1;
  runId: string;
  status: GenerationCheckpointStatus;
  startedAt: string;
  updatedAt: string;
  savedCount: number;
  duplicateCount: number;
  lastBatchAt: string | null;
  lastBatchCount: number;
  lastBatchDuplicates: number;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Runtime validation for values read from IndexedDB; persisted data is untrusted input. */
export function isGenerationCheckpoint(value: unknown): value is GenerationCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<GenerationCheckpoint>;
  const validStatus = checkpoint.status === 'running' || checkpoint.status === 'paused' || checkpoint.status === 'interrupted';
  const validLastBatchAt = checkpoint.lastBatchAt === null || isTimestamp(checkpoint.lastBatchAt);
  return checkpoint.key === GENERATION_CHECKPOINT_KEY
    && checkpoint.version === 1
    && typeof checkpoint.runId === 'string'
    && checkpoint.runId.length > 0
    && checkpoint.runId.length <= 128
    && validStatus
    && isTimestamp(checkpoint.startedAt)
    && isTimestamp(checkpoint.updatedAt)
    && isCounter(checkpoint.savedCount)
    && isCounter(checkpoint.duplicateCount)
    && validLastBatchAt
    && isCounter(checkpoint.lastBatchCount)
    && isCounter(checkpoint.lastBatchDuplicates)
    && checkpoint.lastBatchCount <= checkpoint.savedCount
    && checkpoint.lastBatchDuplicates <= checkpoint.duplicateCount
    && (checkpoint.lastBatchAt !== null || (checkpoint.lastBatchCount === 0 && checkpoint.lastBatchDuplicates === 0));
}

function assertTimestamp(now: string): void {
  if (!isTimestamp(now)) throw new Error('زمان ثبت نقطه بازیابی معتبر نیست.');
}

function assertCheckpoint(checkpoint: GenerationCheckpoint): void {
  if (!isGenerationCheckpoint(checkpoint)) throw new Error('ساختار نقطه بازیابی خراب یا ناسازگار است؛ برای جلوگیری از ثبت ناقص، تولید متوقف شد.');
}

export function createGenerationCheckpoint(now: string, runId: string): GenerationCheckpoint {
  assertTimestamp(now);
  if (!runId || runId.length > 128) throw new Error('شناسه اجرای تولید معتبر نیست.');
  return {
    key: GENERATION_CHECKPOINT_KEY,
    version: 1,
    runId,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    savedCount: 0,
    duplicateCount: 0,
    lastBatchAt: null,
    lastBatchCount: 0,
    lastBatchDuplicates: 0,
  };
}

export function markCheckpointInterrupted(
  checkpoint: GenerationCheckpoint,
  now: string,
): GenerationCheckpoint {
  assertCheckpoint(checkpoint);
  assertTimestamp(now);
  return checkpoint.status === 'running'
    ? { ...checkpoint, status: 'interrupted', updatedAt: now }
    : checkpoint;
}

export function startOrResumeCheckpoint(
  checkpoint: GenerationCheckpoint | null,
  now: string,
  runId: string,
): GenerationCheckpoint {
  assertTimestamp(now);
  if (!checkpoint) return createGenerationCheckpoint(now, runId);
  assertCheckpoint(checkpoint);
  return { ...checkpoint, status: 'running', updatedAt: now };
}

export function advanceGenerationCheckpoint(
  checkpoint: GenerationCheckpoint,
  inserted: number,
  duplicates: number,
  now: string,
): GenerationCheckpoint {
  assertCheckpoint(checkpoint);
  assertTimestamp(now);
  if (checkpoint.status !== 'running') throw new Error('نقطه بازیابی در وضعیت اجرای فعال نیست؛ ذخیره دسته جدید مجاز نیست.');
  if (!isCounter(inserted) || !isCounter(duplicates)) {
    throw new Error('آمار batch برای نقطه بازیابی معتبر نیست.');
  }
  const savedCount = checkpoint.savedCount + inserted;
  const duplicateCount = checkpoint.duplicateCount + duplicates;
  if (!Number.isSafeInteger(savedCount) || !Number.isSafeInteger(duplicateCount)) {
    throw new Error('شمارنده نقطه بازیابی از محدوده امن خارج شده است.');
  }
  return {
    ...checkpoint,
    savedCount,
    duplicateCount,
    updatedAt: now,
    lastBatchAt: now,
    lastBatchCount: inserted,
    lastBatchDuplicates: duplicates,
  };
}

export function markCheckpointPaused(
  checkpoint: GenerationCheckpoint,
  now: string,
): GenerationCheckpoint {
  assertCheckpoint(checkpoint);
  assertTimestamp(now);
  return checkpoint.status === 'running'
    ? { ...checkpoint, status: 'paused', updatedAt: now }
    : checkpoint;
}
