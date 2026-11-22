import { scanStoredWalletsByAddressSet, configureDatabaseScope, recordWalletUsageStats } from '../lib/localDb';
import { ExactAddressLineTracker } from '../lib/walletAddressMatching';
import { iterateTextLines } from '../lib/addressText';
import type { AddressMatchSummary, AddressMatchingRequest, AddressMatchingResponse } from '../lib/addressMatchingProtocol';

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<AddressMatchingRequest>) => void) | null;
  postMessage(message: AddressMatchingResponse): void;
};

const MAX_FILE_BYTES = 16 * 1024 * 1024;
let busy = false;
let cancelRequested = false;

function post(message: AddressMatchingResponse): void {
  workerScope.postMessage(message);
}

function createSummary(): AddressMatchSummary {
  return { totalLines: 0, blankLines: 0, validUnique: 0, invalid: 0, duplicates: 0, matched: 0 };
}

async function* textLines(text: string): AsyncGenerator<string> {
  yield* iterateTextLines(text);
}

async function* fileLines(file: File): AsyncGenerator<string> {
  if (!file.stream) {
    const bytes = await file.arrayBuffer();
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('فایل TXT باید با کدگذاری UTF-8 معتبر ذخیره شده باشد.');
    }
    yield* textLines(decoded);
    return;
  }
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      try {
        buffer += decoder.decode(value, { stream: !done });
      } catch {
        throw new Error('فایل TXT باید با کدگذاری UTF-8 معتبر ذخیره شده باشد.');
      }
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character === '\n') {
          yield buffer.slice(start, index);
          start = index + 1;
        } else if (character === '\r') {
          // Keep a trailing CR until the next chunk so split CRLF pairs are one newline.
          if (index === buffer.length - 1 && !done) break;
          yield buffer.slice(start, index);
          if (buffer[index + 1] === '\n') index += 1;
          start = index + 1;
        }
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer) yield buffer;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function runMatch(request: Extract<AddressMatchingRequest, { type: 'match-file' | 'match-text' }>): Promise<void> {
  if (busy) throw new Error('یک تطبیق دیگر در حال اجراست.');
  if (!request.scope) throw new Error('محدوده امن دیتابیس مشخص نیست.');
  if ((request.type === 'match-file' && request.file.size > MAX_FILE_BYTES)
    || (request.type === 'match-text' && request.text.length > MAX_FILE_BYTES)) {
    throw new Error('حجم ورودی بیشتر از ۱۶ مگابایت است؛ فایل را به چند بخش کوچک‌تر تقسیم کن.');
  }
  busy = true;
  cancelRequested = false;

  const summary = createSummary();
  const tracker = new ExactAddressLineTracker();
  let processedLines = 0;
  let lastProgressAt = 0;

  try {
    configureDatabaseScope(request.scope);
    const lines = request.type === 'match-file' ? fileLines(request.file) : textLines(request.text);
    for await (const rawLine of lines) {
      if (cancelRequested) break;
      processedLines += 1;
      summary.totalLines += 1;
      const parsed = tracker.classify(rawLine);
      if (parsed.status === 'blank') summary.blankLines += 1;
      else if (parsed.status === 'invalid') summary.invalid += 1;
      else if (parsed.status === 'duplicate') summary.duplicates += 1;
      else if (parsed.address) summary.validUnique += 1;

      if (processedLines - lastProgressAt >= 2_000) {
        post({
          id: request.id,
          type: 'match-progress',
          phase: 'parsing',
          summary: { ...summary },
          processedLines,
        });
        lastProgressAt = processedLines;
      }
    }

    let snapshotPayload: { newestCreatedAt: string | null; newestCreatedAtWalletIds: string[] } | null = null;
    let wasCancelled = cancelRequested;
    if (!wasCancelled && tracker.addresses.size > 0) {
      post({
        id: request.id,
        type: 'match-progress',
        phase: 'scanning-vault',
        summary: { ...summary },
        processedLines,
        walletScan: { scannedCount: 0, totalCount: tracker.addresses.size, matchedWalletCount: 0 },
      });

      const scanResult = await scanStoredWalletsByAddressSet(tracker.addresses, {
        onMatches: (matches) => {
          post({ id: request.id, type: 'match-batch', matches });
        },
        onProgress: (progress) => {
          summary.matched = progress.matchedAddressCount;
          post({
            id: request.id,
            type: 'match-progress',
            phase: 'scanning-vault',
            summary: { ...summary },
            processedLines,
            walletScan: {
              scannedCount: progress.scannedCount,
              totalCount: progress.totalCount,
              matchedWalletCount: progress.matchedWalletCount,
              scanMode: progress.mode,
            },
          });
        },
        shouldCancel: () => cancelRequested,
      });

      summary.matched = scanResult.matchedAddressCount;
      wasCancelled = scanResult.cancelled || cancelRequested;
      if (!wasCancelled) {
        const unmatchedAddressCount = Math.max(0, summary.validUnique - scanResult.matchedAddressCount);
        await recordWalletUsageStats({
          checkedAddressCount: summary.validUnique,
          matchedAddressCount: scanResult.matchedAddressCount,
          unmatchedAddressCount,
        });
        post({
          id: request.id,
          type: 'match-progress',
          phase: 'scanning-vault',
          summary: { ...summary },
          processedLines,
          walletScan: {
            scannedCount: scanResult.scannedCount,
            totalCount: scanResult.progressTotalCount,
            matchedWalletCount: scanResult.matchedWalletCount,
            scanMode: scanResult.mode,
          },
          usageDelta: {
            checkedAddressCount: summary.validUnique,
            matchedAddressCount: scanResult.matchedAddressCount,
            unmatchedAddressCount,
          },
        });
        snapshotPayload = {
          newestCreatedAt: scanResult.snapshot.newestCreatedAt,
          newestCreatedAtWalletIds: Array.from(scanResult.snapshot.newestCreatedAtWalletIds),
        };
      }
    }

    post({
      id: request.id,
      type: 'match-complete',
      summary: { ...summary },
      cancelled: wasCancelled,
      snapshot: snapshotPayload,
    });
  } finally {
    busy = false;
    cancelRequested = false;
  }
}

workerScope.onmessage = (event: MessageEvent<AddressMatchingRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelRequested = true;
    return;
  }
  void runMatch(request).catch((error) => {
    post({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'تطبیق آدرس‌های TXT ناموفق بود.',
    });
  });
};

export {};
