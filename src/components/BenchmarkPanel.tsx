import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import type { WalletCreationRequest, WalletCreationResponse } from '../lib/walletCreationProtocol';

const WORKER_COUNTS = [1, 2, 3] as const;
const BATCH_SIZE = 1_024;
const RUN_DURATION_MS = 60_000;
const REPEATS_PER_WORKER_COUNT = 3;
const COOLDOWN_MS = 60_000;
const WARMUP_BATCH_SIZE = 128;
const WINDOW_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const EXPECTED_TEST_ADDRESS = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
const TEST_PRIVATE_KEY = `${'0'.repeat(63)}1`;
const TOTAL_TRIALS = WORKER_COUNTS.length * REPEATS_PER_WORKER_COUNT;

interface BatchMeasurement {
  count: number;
  workerMs: number;
  roundTripMs: number;
  finishedAtMs: number;
}

interface WorkerSlot {
  index: number;
  worker: Worker;
  cancelPending: (() => void) | null;
}

interface MemorySnapshot {
  megabytes: number;
  source: 'agent-cluster' | 'main-thread';
}

interface TrialResult {
  workerCount: number;
  repeat: number;
  wallets: number;
  batches: number;
  elapsedMs: number;
  overrunMs: number;
  workerComputeMs: number;
  roundTripMs: number;
  firstWindowWallets: number;
  lastWindowWallets: number;
  averageWorkerBatchMs: number;
  averageRoundTripMs: number;
  aggregateWalletsPerSecond: number;
  workerComputeWalletsPerSecond: number;
  firstWindowWalletsPerSecond: number;
  lastWindowWalletsPerSecond: number;
  maxLongTaskMs: number | null;
  longTaskCount: number | null;
  memoryDeltaMb: number | null;
  memorySource: MemorySnapshot['source'] | 'unavailable';
  poolWarmupMs: number;
}

interface SummaryRow {
  workerCount: number;
  runs: number;
  wallets: number;
  batches: number;
  elapsedMs: number;
  workerComputeWalletsPerSecond: number;
  aggregateWalletsPerSecond: number;
  firstWindowWalletsPerSecond: number;
  lastWindowWalletsPerSecond: number;
  averageWorkerBatchMs: number;
  averageRoundTripMs: number;
  maxLongTaskMs: number | null;
  totalLongTasks: number | null;
  averageMemoryDeltaMb: number | null;
  memorySource: TrialResult['memorySource'];
  averagePoolWarmupMs: number;
}

interface Props {
  onBack: () => void;
}

let requestSequence = 0;

function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('fa-IR', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

async function readMemorySnapshot(): Promise<MemorySnapshot | null> {
  const performanceWithMemory = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  };

  if (typeof performanceWithMemory.measureUserAgentSpecificMemory === 'function') {
    try {
      const result = await performanceWithMemory.measureUserAgentSpecificMemory.call(performance);
      if (typeof result.bytes === 'number' && Number.isFinite(result.bytes)) {
        return { megabytes: result.bytes / (1024 * 1024), source: 'agent-cluster' };
      }
    } catch {
      // This API may require cross-origin isolation or may be blocked in WebViews.
    }
  }

  const usedHeapBytes = performanceWithMemory.memory?.usedJSHeapSize;
  if (typeof usedHeapBytes === 'number' && Number.isFinite(usedHeapBytes)) {
    return { megabytes: usedHeapBytes / (1024 * 1024), source: 'main-thread' };
  }

  return null;
}

function supportsLongTaskObserver(): boolean {
  if (typeof PerformanceObserver === 'undefined') return false;
  const supported = (PerformanceObserver as typeof PerformanceObserver & { supportedEntryTypes?: string[] }).supportedEntryTypes;
  return Array.isArray(supported) && supported.includes('longtask');
}

function createWorkerSlot(index: number): WorkerSlot {
  return {
    index,
    worker: new Worker(new URL('../workers/wallet-creation.worker.ts', import.meta.url), { type: 'module' }),
    cancelPending: null,
  };
}

function requestBenchmarkBatch(slot: WorkerSlot, count: number): Promise<Omit<BatchMeasurement, 'finishedAtMs'>> {
  if (slot.cancelPending) return Promise.reject(new Error('در این Worker یک درخواست در حال اجراست.'));

  const id = `reliability-bench-${++requestSequence}`;
  const requestStartedAt = performance.now();
  const request: WalletCreationRequest = {
    id,
    type: 'benchmark-private-key-batch',
    count,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      slot.worker.removeEventListener('message', onMessage);
      slot.worker.removeEventListener('error', onError);
      if (slot.cancelPending === cancelPending) slot.cancelPending = null;
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const cancelPending = () => fail(new Error('BENCHMARK_CANCELLED'));

    const onMessage = (event: MessageEvent<WalletCreationResponse>) => {
      const response = event.data;
      if (!response || response.id !== id || settled) return;
      settled = true;
      cleanup();

      if (response.type === 'error') {
        reject(new Error(response.message));
        return;
      }
      if (response.type !== 'benchmark-batch-complete') {
        reject(new Error('پاسخ غیرمنتظره از Worker در آزمایش دریافت شد.'));
        return;
      }

      const workerMs = response.metrics?.workerDurationMs;
      if (response.count !== count) {
        reject(new Error(`تعداد خروجی آزمایش (${response.count}) با دسته درخواستی (${count}) برابر نیست.`));
        return;
      }
      if (typeof workerMs !== 'number' || !Number.isFinite(workerMs) || workerMs <= 0) {
        reject(new Error('زمان محاسبه Worker معتبر نیست.'));
        return;
      }

      resolve({
        count: response.count,
        workerMs,
        roundTripMs: performance.now() - requestStartedAt,
      });
    };

    const onError = (event: ErrorEvent) => {
      fail(new Error(event.message || `خطای Worker شماره ${slot.index + 1}.`));
    };

    slot.cancelPending = cancelPending;
    slot.worker.addEventListener('message', onMessage);
    slot.worker.addEventListener('error', onError);
    timeoutId = window.setTimeout(() => {
      fail(new Error(`Worker شماره ${slot.index + 1} بیش از ${REQUEST_TIMEOUT_MS / 1_000} ثانیه پاسخ نداد؛ آزمایش متوقف شد.`));
    }, REQUEST_TIMEOUT_MS);

    try {
      slot.worker.postMessage(request);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('ارسال درخواست آزمایش ناموفق بود.'));
    }
  });
}

function terminateSlots(slots: WorkerSlot[]): void {
  for (const slot of slots) {
    slot.cancelPending?.();
    slot.worker.terminate();
  }
}

function summarizeTrials(trials: TrialResult[], workerCount: number): SummaryRow | null {
  const selected = trials.filter((trial) => trial.workerCount === workerCount);
  if (selected.length === 0) return null;

  const sum = (pick: (trial: TrialResult) => number) => selected.reduce((total, trial) => total + pick(trial), 0);
  const wallets = sum((trial) => trial.wallets);
  const batches = sum((trial) => trial.batches);
  const elapsedMs = sum((trial) => trial.elapsedMs);
  const workerComputeMs = sum((trial) => trial.workerComputeMs);
  const roundTripMs = sum((trial) => trial.roundTripMs);
  const memoryValues = selected.map((trial) => trial.memoryDeltaMb).filter((value): value is number => value !== null);
  const longTaskValues = selected.map((trial) => trial.maxLongTaskMs).filter((value): value is number => value !== null);
  const memorySources = [...new Set(selected.map((trial) => trial.memorySource))];

  return {
    workerCount,
    runs: selected.length,
    wallets,
    batches,
    elapsedMs,
    workerComputeWalletsPerSecond: workerComputeMs > 0 ? wallets / (workerComputeMs / 1_000) : 0,
    aggregateWalletsPerSecond: elapsedMs > 0 ? wallets / (elapsedMs / 1_000) : 0,
    firstWindowWalletsPerSecond: sum((trial) => trial.firstWindowWallets) / (selected.length * (WINDOW_MS / 1_000)),
    lastWindowWalletsPerSecond: sum((trial) => trial.lastWindowWallets) / (selected.length * (WINDOW_MS / 1_000)),
    averageWorkerBatchMs: batches > 0 ? workerComputeMs / batches : 0,
    averageRoundTripMs: batches > 0 ? roundTripMs / batches : 0,
    maxLongTaskMs: longTaskValues.length > 0 ? Math.max(...longTaskValues) : null,
    totalLongTasks: selected.every((trial) => trial.longTaskCount !== null)
      ? sum((trial) => trial.longTaskCount ?? 0)
      : null,
    averageMemoryDeltaMb: memoryValues.length > 0 ? memoryValues.reduce((total, value) => total + value, 0) / memoryValues.length : null,
    memorySource: memorySources.length === 1 ? memorySources[0] : 'unavailable',
    averagePoolWarmupMs: sum((trial) => trial.poolWarmupMs) / selected.length,
  };
}

export default function BenchmarkPanel({ onBack }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('آماده اجرای آزمایش پایداری چند‌Worker');
  const [trials, setTrials] = useState<TrialResult[]>([]);
  const [testVectorOk, setTestVectorOk] = useState<boolean | null>(null);
  const [completedTrials, setCompletedTrials] = useState(0);
  const [backgroundInterrupted, setBackgroundInterrupted] = useState(false);
  const workerSlotsRef = useRef<WorkerSlot[]>([]);
  const cancelRequestedRef = useRef(false);
  const backgroundInterruptedRef = useRef(false);
  const manualStopRef = useRef(false);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  const setStatusSafe = (message: string) => {
    if (mountedRef.current) setStatus(message);
  };

  const interruptForBackground = () => {
    if (!runningRef.current || cancelRequestedRef.current) return;
    backgroundInterruptedRef.current = true;
    cancelRequestedRef.current = true;
    if (mountedRef.current) setBackgroundInterrupted(true);
    setStatusSafe('برنامه به پس‌زمینه رفت؛ آزمایش جاری برای جلوگیری از ثبت عدد نامعتبر لغو شد. نتایج اجراهای کامل قبلی حفظ شده‌اند.');
    const activeSlots = workerSlotsRef.current;
    workerSlotsRef.current = [];
    terminateSlots(activeSlots);
  };

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') interruptForBackground();
    };
    const handlePageHide = () => interruptForBackground();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      mountedRef.current = false;
      cancelRequestedRef.current = true;
      terminateSlots(workerSlotsRef.current);
      workerSlotsRef.current = [];
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, []);

  async function runSingleTrial(workerCount: number, repeat: number, completedBefore: number): Promise<TrialResult> {
    const memoryBefore = await readMemorySnapshot();
    if (cancelRequestedRef.current) throw new Error('BENCHMARK_CANCELLED');
    const setupStartedAt = performance.now();
    const slots: WorkerSlot[] = [];
    workerSlotsRef.current = slots;

    try {
      for (let index = 0; index < workerCount; index += 1) {
        slots.push(createWorkerSlot(index));
      }
      if (cancelRequestedRef.current) throw new Error('BENCHMARK_CANCELLED');
      setStatusSafe(`راه‌اندازی ${formatNumber(workerCount)} Worker و گرم‌سازی موتور…`);
      await Promise.all(slots.map((slot) => requestBenchmarkBatch(slot, WARMUP_BATCH_SIZE)));
      if (cancelRequestedRef.current) throw new Error('BENCHMARK_CANCELLED');
      const poolWarmupMs = performance.now() - setupStartedAt;

      const runStartedAt = performance.now();
      const deadline = runStartedAt + RUN_DURATION_MS;
      const batchMeasurements: BatchMeasurement[] = [];
      let maxLongTaskMs: number | null = null;
      let longTaskCount: number | null = null;
      let longTaskObserver: PerformanceObserver | null = null;
      const longTaskSupported = supportsLongTaskObserver();

      if (longTaskSupported) {
        try {
          longTaskCount = 0;
          const recordLongTasks = (entries: PerformanceEntry[]) => {
            if (document.visibilityState !== 'visible') return;
            for (const entry of entries) {
              maxLongTaskMs = Math.max(maxLongTaskMs ?? 0, entry.duration);
              longTaskCount = (longTaskCount ?? 0) + 1;
            }
          };
          longTaskObserver = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
          longTaskObserver.observe({ entryTypes: ['longtask'] });
          maxLongTaskMs = 0;
        } catch {
          longTaskObserver?.disconnect();
          longTaskObserver = null;
          longTaskCount = null;
        }
      }

      const progressTimer = window.setInterval(() => {
        const elapsed = Math.min(RUN_DURATION_MS, performance.now() - runStartedAt);
        const fraction = (completedBefore + elapsed / RUN_DURATION_MS) / TOTAL_TRIALS;
        if (mountedRef.current) setProgress(Math.min(100, Math.round(fraction * 100)));
        setStatusSafe(`تکرار ${formatNumber(repeat)} · ${formatNumber(workerCount)} Worker · ${formatNumber(Math.floor(elapsed / 1_000))} از ۶۰ ثانیه`);
      }, 500);

      const runWorkerLane = async (slot: WorkerSlot): Promise<void> => {
        while (!cancelRequestedRef.current && performance.now() < deadline) {
          const measurement = await requestBenchmarkBatch(slot, BATCH_SIZE);
          batchMeasurements.push({
            ...measurement,
            finishedAtMs: performance.now() - runStartedAt,
          });
        }
      };

      try {
        await Promise.all(slots.map((slot) => runWorkerLane(slot)));
      } finally {
        window.clearInterval(progressTimer);
        if (longTaskObserver) {
          if (document.visibilityState === 'visible') {
            for (const entry of longTaskObserver.takeRecords()) {
              maxLongTaskMs = Math.max(maxLongTaskMs ?? 0, entry.duration);
              longTaskCount = (longTaskCount ?? 0) + 1;
            }
          }
          longTaskObserver.disconnect();
        }
      }

      if (cancelRequestedRef.current) throw new Error('BENCHMARK_CANCELLED');

      const elapsedMs = performance.now() - runStartedAt;
      const wallets = batchMeasurements.reduce((total, batch) => total + batch.count, 0);
      const workerComputeMs = batchMeasurements.reduce((total, batch) => total + batch.workerMs, 0);
      const roundTripMs = batchMeasurements.reduce((total, batch) => total + batch.roundTripMs, 0);
      const firstWindowWallets = batchMeasurements
        .filter((batch) => batch.finishedAtMs < WINDOW_MS)
        .reduce((total, batch) => total + batch.count, 0);
      const lastWindowWallets = batchMeasurements
        .filter((batch) => batch.finishedAtMs >= RUN_DURATION_MS - WINDOW_MS)
        .reduce((total, batch) => total + batch.count, 0);
      const batches = batchMeasurements.length;
      const memoryAfter = await readMemorySnapshot();
      if (cancelRequestedRef.current) throw new Error('BENCHMARK_CANCELLED');
      let memoryDeltaMb: number | null = null;
      let memorySource: TrialResult['memorySource'] = 'unavailable';
      if (memoryBefore && memoryAfter && memoryBefore.source === memoryAfter.source) {
        memoryDeltaMb = memoryAfter.megabytes - memoryBefore.megabytes;
        memorySource = memoryAfter.source;
      }

      return {
        workerCount,
        repeat,
        wallets,
        batches,
        elapsedMs,
        overrunMs: Math.max(0, elapsedMs - RUN_DURATION_MS),
        workerComputeMs,
        roundTripMs,
        firstWindowWallets,
        lastWindowWallets,
        averageWorkerBatchMs: batches > 0 ? workerComputeMs / batches : 0,
        averageRoundTripMs: batches > 0 ? roundTripMs / batches : 0,
        aggregateWalletsPerSecond: elapsedMs > 0 ? wallets / (elapsedMs / 1_000) : 0,
        workerComputeWalletsPerSecond: workerComputeMs > 0 ? wallets / (workerComputeMs / 1_000) : 0,
        firstWindowWalletsPerSecond: firstWindowWallets / (WINDOW_MS / 1_000),
        lastWindowWalletsPerSecond: lastWindowWallets / (WINDOW_MS / 1_000),
        maxLongTaskMs,
        longTaskCount,
        memoryDeltaMb,
        memorySource,
        poolWarmupMs,
      };
    } finally {
      terminateSlots(slots);
      if (workerSlotsRef.current === slots) workerSlotsRef.current = [];
    }
  }

  async function waitForCooldown(): Promise<boolean> {
    const deadline = performance.now() + COOLDOWN_MS;
    while (!cancelRequestedRef.current) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) return true;
      setStatusSafe(`استراحت خنک‌شدن دستگاه · ${formatNumber(Math.ceil(remainingMs / 1_000))} ثانیه`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(1_000, remainingMs)));
    }
    return false;
  }

  async function runBenchmark() {
    if (runningRef.current) return;
    if (document.visibilityState !== 'visible') {
      setStatus('برای شروع آزمایش، برنامه باید در پیش‌زمینه باشد.');
      return;
    }

    runningRef.current = true;
    cancelRequestedRef.current = false;
    backgroundInterruptedRef.current = false;
    manualStopRef.current = false;
    setBackgroundInterrupted(false);
    setRunning(true);
    setTrials([]);
    setCompletedTrials(0);
    setProgress(0);
    setStatus('آماده‌سازی آزمایش ۹ مرحله‌ای…');

    const schedule = [
      [1, 2, 3],
      [2, 3, 1],
      [3, 1, 2],
    ] as const;
    const completed: TrialResult[] = [];
    let aborted = false;

    try {
      for (let roundIndex = 0; roundIndex < schedule.length; roundIndex += 1) {
        const round = schedule[roundIndex];
        for (let position = 0; position < round.length; position += 1) {
          if (cancelRequestedRef.current) {
            aborted = true;
            break;
          }
          if (completed.length > 0) {
            const cooled = await waitForCooldown();
            if (!cooled) {
              aborted = true;
              break;
            }
          }

          const workerCount = round[position];
          const repeat = roundIndex + 1;
          setStatusSafe(`شروع آزمایش ${formatNumber(completed.length + 1)} از ${formatNumber(TOTAL_TRIALS)} · ${formatNumber(workerCount)} Worker`);
          const result = await runSingleTrial(workerCount, repeat, completed.length);
          completed.push(result);
          if (mountedRef.current) {
            setTrials([...completed]);
            setCompletedTrials(completed.length);
            setProgress(Math.round((completed.length / TOTAL_TRIALS) * 100));
          }
        }
        if (aborted) break;
      }

      if (backgroundInterruptedRef.current) {
        setStatusSafe(`برنامه به پس‌زمینه رفت؛ آزمایش لغو شد. ${formatNumber(completed.length)} اجرای کامل حفظ شد؛ اجرای نیمه‌تمام وارد گزارش نشده است.`);
      } else if (manualStopRef.current || cancelRequestedRef.current || aborted) {
        setStatusSafe(`آزمایش به درخواست کاربر متوقف شد؛ ${formatNumber(completed.length)} اجرای کامل حفظ شد.`);
      } else {
        setProgress(100);
        setStatusSafe('تمام ۹ آزمایش کامل شد؛ فقط آمار تجمیعی ثبت شده و هیچ کلید یا آدرسی به رابط ارسال نشده است.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'اجرای Benchmark ناموفق بود.';
      if (backgroundInterruptedRef.current) {
        setStatusSafe(`برنامه به پس‌زمینه رفت؛ آزمایش لغو شد. ${formatNumber(completed.length)} اجرای کامل حفظ شد؛ اجرای نیمه‌تمام وارد گزارش نشده است.`);
      } else if (manualStopRef.current || message === 'BENCHMARK_CANCELLED') {
        setStatusSafe(`آزمایش به درخواست کاربر متوقف شد؛ ${formatNumber(completed.length)} اجرای کامل حفظ شد.`);
      } else {
        setStatusSafe(message);
      }
    } finally {
      terminateSlots(workerSlotsRef.current);
      workerSlotsRef.current = [];
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  }

  function stopBenchmark() {
    if (!runningRef.current) return;
    manualStopRef.current = true;
    cancelRequestedRef.current = true;
    setStatusSafe('در حال تکمیل دسته‌های فعال؛ اجرای نیمه‌تمام برای مقایسه معتبر در گزارش ثبت نمی‌شود…');
  }

  async function verifyKnownTestVector() {
    try {
      const { deriveTronAddressFromPrivateKey } = await import('../lib/tronPrivateKey');
      const actual = deriveTronAddressFromPrivateKey(TEST_PRIVATE_KEY);
      setTestVectorOk(actual === EXPECTED_TEST_ADDRESS);
    } catch {
      setTestVectorOk(false);
    }
  }

  function buildReport(): string {
    const longTaskSupported = supportsLongTaskObserver();
    const lines = [
      'TRON Lab reliability benchmark v2.2.7',
      `batch=${BATCH_SIZE}, duration_ms=${RUN_DURATION_MS}, repeats_per_worker=${REPEATS_PER_WORKER_COUNT}, cooldown_ms=${COOLDOWN_MS}, request_timeout_ms=${REQUEST_TIMEOUT_MS}`,
      `hardware_concurrency=${navigator.hardwareConcurrency || 'unknown'}, device_memory_gb=${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 'unknown'}`,
      'order=round1:1,2,3;round2:2,3,1;round3:3,1,2',
      'benchmark_mode=count-only;wallet_objects_sent_to_ui=0;private_keys_or_addresses_sent_to_ui=0',
      `long_task_api=${longTaskSupported ? 'supported' : 'unavailable'}`,
      `background_policy=abort_suite_on_hidden;background_interrupted=${backgroundInterruptedRef.current ? 'yes' : 'no'};manual_stop=${manualStopRef.current ? 'yes' : 'no'}`,
      ...WORKER_COUNTS.map((workerCount) => {
        const summary = summarizeTrials(trials, workerCount);
        if (!summary) return `workers=${workerCount}, runs=0`;
        return [
          `workers=${workerCount}`,
          `runs=${summary.runs}`,
          `wallets=${summary.wallets}`,
          `batches=${summary.batches}`,
          `worker_active_compute_wallets_s=${summary.workerComputeWalletsPerSecond.toFixed(2)}`,
          `aggregate_wallets_s=${summary.aggregateWalletsPerSecond.toFixed(2)}`,
          `first15s_wallets_s=${summary.firstWindowWalletsPerSecond.toFixed(2)}`,
          `last15s_wallets_s=${summary.lastWindowWalletsPerSecond.toFixed(2)}`,
          `worker_avg_ms=${summary.averageWorkerBatchMs.toFixed(2)}`,
          `ack_roundtrip_avg_ms=${summary.averageRoundTripMs.toFixed(2)}`,
          `longtask_max_ms=${summary.maxLongTaskMs === null ? 'unavailable' : summary.maxLongTaskMs.toFixed(2)}`,
          `longtask_count=${summary.totalLongTasks === null ? 'unavailable' : summary.totalLongTasks}`,
          `memory_delta_mb=${summary.averageMemoryDeltaMb === null ? 'unavailable' : summary.averageMemoryDeltaMb.toFixed(2)}`,
          `memory_source=${summary.memorySource}`,
          `pool_warmup_avg_ms=${summary.averagePoolWarmupMs.toFixed(2)}`,
        ].join(', ');
      }),
      'individual_trials:',
      ...trials.map((trial) => `trial=${trial.repeat}, workers=${trial.workerCount}, wallets=${trial.wallets}, batches=${trial.batches}, elapsed_ms=${trial.elapsedMs.toFixed(2)}, overrun_ms=${trial.overrunMs.toFixed(2)}, worker_active_compute_wallets_s=${trial.workerComputeWalletsPerSecond.toFixed(2)}, aggregate_wallets_s=${trial.aggregateWalletsPerSecond.toFixed(2)}, first15s_wallets_s=${trial.firstWindowWalletsPerSecond.toFixed(2)}, last15s_wallets_s=${trial.lastWindowWalletsPerSecond.toFixed(2)}, ack_roundtrip_avg_ms=${trial.averageRoundTripMs.toFixed(2)}, longtask_max_ms=${trial.maxLongTaskMs === null ? 'unavailable' : trial.maxLongTaskMs.toFixed(2)}, longtask_count=${trial.longTaskCount === null ? 'unavailable' : trial.longTaskCount}, memory_delta_mb=${trial.memoryDeltaMb === null ? 'unavailable' : trial.memoryDeltaMb.toFixed(2)}, memory_source=${trial.memorySource}, pool_warmup_ms=${trial.poolWarmupMs.toFixed(2)}`),
    ];
    return lines.join('\n');
  }

  async function copyBenchmarkResults() {
    const report = buildReport();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard در این WebView در دسترس نیست.');
      await navigator.clipboard.writeText(report);
      setStatusSafe('گزارش کامل Benchmark کپی شد.');
    } catch {
      setStatusSafe('کپی در این WebView ممکن نشد؛ جدول یا گزارش را دستی انتخاب کن.');
    }
  }

  const hardwareConcurrency = navigator.hardwareConcurrency || null;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const longTaskAvailable = supportsLongTaskObserver();
  const summaries = WORKER_COUNTS
    .map((workerCount) => summarizeTrials(trials, workerCount))
    .filter((row): row is SummaryRow => row !== null);

  return (
    <section className="panel-stack benchmark-panel" dir="rtl">
      <div className="benchmark-heading">
        <div>
          <span className="eyebrow">TRON LAB · RELIABILITY DIAGNOSTICS</span>
          <h1>آزمایش پایداری چند‌Worker</h1>
          <p>اندازه‌گیری عملکرد در پیش‌زمینه و تشخیص توقف یا افت پاسخ‌گویی</p>
        </div>
        <button type="button" className="secondary-button benchmark-back" onClick={onBack} disabled={running}>
          <Icon name="arrow-right" size={15}/> بازگشت
        </button>
      </div>

      <div className="benchmark-note">
        <Icon name="info" size={17}/>
        <span>در این نسخه فقط شمارنده و زمان محاسبه به UI می‌رسد؛ هیچ کلید خصوصی یا آدرسی از Worker خارج نمی‌شود. اگر برنامه به پس‌زمینه برود، کل آزمایش لغو و اجرای نیمه‌تمام حذف می‌شود تا عدد گمراه‌کننده ثبت نشود.</span>
      </div>

      <div className="benchmark-device-card">
        <div><span>هسته‌های منطقی گزارش‌شده</span><strong>{hardwareConcurrency ? formatNumber(hardwareConcurrency) : 'نامشخص'}</strong></div>
        <div><span>حافظه دستگاه (در صورت پشتیبانی)</span><strong>{deviceMemory ? `${formatNumber(deviceMemory)} GB` : 'نامشخص'}</strong></div>
        <div><span>Long Task API</span><strong>{longTaskAvailable ? 'پشتیبانی می‌شود' : 'در دسترس نیست'}</strong></div>
      </div>

      <div className="benchmark-run-card">
        <div className="benchmark-run-head">
          <div><strong>طرح آزمایش · ۹ اجرا</strong><span>۱ / ۲ / ۳ Worker · سه تکرار برای هر حالت</span></div>
          <span className={`benchmark-state ${running ? 'is-running' : ''}`}>{running ? 'در حال اجرا' : backgroundInterrupted ? 'با خروج از برنامه متوقف شد' : 'آماده'}</span>
        </div>
        <div className="benchmark-batch-chips">
          <span>batch 1,024</span>
          <span>60 sec × 3</span>
          <span>60 sec cooldown</span>
          <span>count-only output</span>
        </div>
        {running && <div className="benchmark-progress"><div style={{ width: `${progress}%` }}/></div>}
        <p className="benchmark-status" aria-live="polite">{status}</p>
        <div className="benchmark-run-actions">
          <button type="button" className={running ? 'stop-button' : 'primary-button'} onClick={() => running ? stopBenchmark() : void runBenchmark()}>
            {running ? <><Icon name="stop" size={16}/> توقف پس از دسته فعال</> : <><Icon name="activity" size={16}/> شروع آزمایش ۹ مرحله‌ای</>}
          </button>
          <span>{formatNumber(progress)}٪ · {formatNumber(completedTrials)}/{formatNumber(TOTAL_TRIALS)}</span>
        </div>
        <p className="benchmark-footnote">مدت کل حدود ۱۷ دقیقه به‌علاوه گرم‌سازی است. هنگام آزمایش از برنامه خارج نشو و صفحه را در پیش‌زمینه نگه دار؛ دستگاه خنک و ترجیحاً از شارژ جدا باشد.</p>
      </div>

      {summaries.length > 0 && (
        <div className="benchmark-results-card">
          <div className="card-heading"><div className="icon-tile"><Icon name="chart-no-axes-combined" size={19}/></div><div><h2>مقایسه تجمیعی Workerها</h2><p>معیار اصلی، تعداد دسته‌های تکمیل‌شده تقسیم بر زمان واقعی فعال اجرا است؛ پاسخ Worker فقط شامل آمار می‌شود.</p></div></div>
          <div className="benchmark-results-table-wrap">
            <table className="benchmark-results-table multi-worker-summary-table">
              <thead><tr><th>Worker</th><th>تکرار</th><th>تعداد</th><th>نرخ محاسبه Worker</th><th>نرخ کل واقعی</th><th>۱۵ ثانیه آخر</th><th>بیشینه Long Task</th></tr></thead>
              <tbody>{summaries.map((row) => <tr key={row.workerCount}>
                <td>{formatNumber(row.workerCount)}</td>
                <td>{formatNumber(row.runs)}/۳</td>
                <td>{formatNumber(row.wallets)}</td>
                <td>{formatNumber(row.workerComputeWalletsPerSecond)}</td>
                <td><strong>{formatNumber(row.aggregateWalletsPerSecond)}</strong></td>
                <td>{formatNumber(row.lastWindowWalletsPerSecond)}</td>
                <td>{row.maxLongTaskMs === null ? '—' : `${formatNumber(row.maxLongTaskMs, 1)} ms`}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="benchmark-footnote">نرخ محاسبه Worker بر مجموع زمان فعال Workerها نرمال شده و throughput کل نیست. Long Task زمان اجرای وظایف طولانی Main Thread است؛ در صورت نبود API با علامت — گزارش می‌شود.</p>
          <button type="button" className="secondary-button full-button" onClick={() => void copyBenchmarkResults()}>
            <Icon name="copy" size={15}/> کپی گزارش کامل و اجراهای جداگانه
          </button>
        </div>
      )}

      {trials.length > 0 && (
        <div className="benchmark-results-card">
          <div className="card-heading"><div className="icon-tile"><Icon name="list" size={19}/></div><div><h2>جزئیات هر اجرا</h2><p>برای بررسی نوسان، افت سرعت و تأخیرهای واقعی Main Thread.</p></div></div>
          <div className="benchmark-results-table-wrap">
            <table className="benchmark-results-table multi-worker-trials-table">
              <thead><tr><th>تکرار</th><th>Worker</th><th>تعداد</th><th>مدت کل</th><th>میانگین دسته</th><th>۱۵ ثانیه اول</th><th>۱۵ ثانیه آخر</th><th>Long Task</th><th>Memory Δ</th></tr></thead>
              <tbody>{trials.map((trial, index) => <tr key={`${trial.repeat}-${trial.workerCount}-${index}`}>
                <td>{formatNumber(trial.repeat)}</td>
                <td>{formatNumber(trial.workerCount)}</td>
                <td>{formatNumber(trial.wallets)}</td>
                <td>{formatNumber(trial.elapsedMs / 1_000, 1)} s</td>
                <td>{formatNumber(trial.averageWorkerBatchMs, 1)} ms</td>
                <td>{formatNumber(trial.firstWindowWalletsPerSecond)}</td>
                <td>{formatNumber(trial.lastWindowWalletsPerSecond)}</td>
                <td>{trial.maxLongTaskMs === null ? '—' : `${formatNumber(trial.maxLongTaskMs, 1)} ms`}</td>
                <td>{trial.memoryDeltaMb === null ? '—' : `${formatNumber(trial.memoryDeltaMb, 1)} MB`}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="benchmark-footnote">حافظه فقط در صورت پشتیبانی API اندازه‌گیری می‌شود؛ منبع آن در گزارش مشخص است و ممکن است فقط Heap صفحه اصلی باشد، نه حافظه Workerها.</p>
          <button type="button" className="secondary-button full-button" onClick={() => void copyBenchmarkResults()}>
            <Icon name="copy" size={15}/> کپی نتایج برای ارسال
          </button>
        </div>
      )}

      <div className="benchmark-test-vector-card">
        <div className="benchmark-test-vector-copy">
          <strong>کنترل صحت محاسبه آدرس</strong>
          <span>کلید خصوصی ثابت تستی ۱ باید به آدرس نمونه شناخته‌شده برسد؛ این بررسی جست‌وجوی تصادفی نیست.</span>
        </div>
        <button type="button" className="secondary-button" onClick={() => void verifyKnownTestVector()} disabled={running}>بررسی صحت</button>
        {testVectorOk !== null && <div className={`benchmark-vector-result ${testVectorOk ? 'success' : 'failure'}`}>
          <Icon name={testVectorOk ? 'check-circle' : 'alert-circle'} size={15}/>
          {testVectorOk ? 'آدرس نمونه صحیح محاسبه شد.' : 'محاسبه آدرس نمونه با مقدار مورد انتظار مطابقت ندارد.'}
        </div>}
      </div>

      <p className="benchmark-disclaimer">این صفحه فقط ابزار تشخیصی است و Worker Pool موتور تولید عملیاتی را تغییر نمی‌دهد. خروج از برنامه یا قفل‌شدن صفحه باعث لغو آزمایش جاری می‌شود؛ برای مقایسه معتبر، تمام اجراها را در پیش‌زمینه و شرایط حرارتی مشابه انجام بده.</p>
    </section>
  );
}
