export const TXT_IMPORT_HISTORY_KEY = 'txt-import-history-v1' as const;
export const TXT_IMPORT_HISTORY_VERSION = 1 as const;
export const MAX_TRACKED_TXT_IMPORTS = 50;
export const MAX_TXT_FILE_BYTES = 16 * 1024 * 1024;

export type TxtImportStatus = 'processing' | 'completed' | 'cancelled' | 'failed';

export interface TxtImportRecord {
  sha256: string;
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
  lastAttemptAt: string;
  status: TxtImportStatus;
}

export interface TxtImportHistory {
  key: typeof TXT_IMPORT_HISTORY_KEY;
  version: typeof TXT_IMPORT_HISTORY_VERSION;
  records: TxtImportRecord[];
}

export interface NewTxtImportRecord {
  sha256: string;
  fileName: string;
  sizeBytes: number;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isTxtImportStatus(value: unknown): value is TxtImportStatus {
  return value === 'processing' || value === 'completed' || value === 'cancelled' || value === 'failed';
}

export function isTxtImportRecord(value: unknown): value is TxtImportRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowedKeys = new Set(['sha256', 'fileName', 'sizeBytes', 'uploadedAt', 'lastAttemptAt', 'status']);
  return Object.keys(item).every((key) => allowedKeys.has(key))
    && typeof item.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(item.sha256)
    && typeof item.fileName === 'string'
    && item.fileName.length > 0
    && item.fileName.length <= 255
    && !/[\u0000-\u001f\u007f]/.test(item.fileName)
    && typeof item.sizeBytes === 'number'
    && Number.isSafeInteger(item.sizeBytes)
    && item.sizeBytes >= 0
    && item.sizeBytes <= MAX_TXT_FILE_BYTES
    && isTimestamp(item.uploadedAt)
    && isTimestamp(item.lastAttemptAt)
    && isTxtImportStatus(item.status);
}

export function createEmptyTxtImportHistory(): TxtImportHistory {
  return { key: TXT_IMPORT_HISTORY_KEY, version: TXT_IMPORT_HISTORY_VERSION, records: [] };
}

export function isTxtImportHistory(value: unknown): value is TxtImportHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const history = value as Record<string, unknown>;
  const allowedKeys = new Set(['key', 'version', 'records']);
  return Object.keys(history).every((key) => allowedKeys.has(key))
    && history.key === TXT_IMPORT_HISTORY_KEY
    && history.version === TXT_IMPORT_HISTORY_VERSION
    && Array.isArray(history.records)
    && history.records.length <= MAX_TRACKED_TXT_IMPORTS
    && history.records.every(isTxtImportRecord)
    && new Set(history.records.map((item) => (item as TxtImportRecord).sha256)).size === history.records.length;
}

export function registerTxtImport(
  history: TxtImportHistory,
  input: NewTxtImportRecord,
  now = new Date().toISOString(),
): { history: TxtImportHistory; record: TxtImportRecord; duplicate: boolean } {
  if (!isTxtImportHistory(history)) throw new Error('تاریخچه فایل‌های TXT معتبر نیست.');
  if (!/^[a-f0-9]{64}$/.test(input.sha256)
    || typeof input.fileName !== 'string'
    || !input.fileName.trim()
    || input.fileName.length > 255
    || /[\u0000-\u001f\u007f]/.test(input.fileName)
    || !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes < 0
    || input.sizeBytes > MAX_TXT_FILE_BYTES
    || !isTimestamp(now)) {
    throw new Error('مشخصات فایل TXT برای ثبت معتبر نیست.');
  }

  const existing = history.records.find((record) => record.sha256 === input.sha256);
  if (existing) return { history, record: existing, duplicate: true };

  const record: TxtImportRecord = {
    sha256: input.sha256,
    fileName: input.fileName.trim(),
    sizeBytes: input.sizeBytes,
    uploadedAt: now,
    lastAttemptAt: now,
    status: 'processing',
  };
  return {
    history: {
      ...history,
      records: [record, ...history.records].slice(0, MAX_TRACKED_TXT_IMPORTS),
    },
    record,
    duplicate: false,
  };
}

export function setTxtImportStatus(
  history: TxtImportHistory,
  sha256: string,
  status: TxtImportStatus,
  now = new Date().toISOString(),
): { history: TxtImportHistory; record: TxtImportRecord | null } {
  if (!isTxtImportHistory(history) || !/^[a-f0-9]{64}$/.test(sha256) || !isTxtImportStatus(status) || !isTimestamp(now)) {
    throw new Error('وضعیت فایل TXT برای به‌روزرسانی معتبر نیست.');
  }
  const index = history.records.findIndex((record) => record.sha256 === sha256);
  if (index < 0) return { history, record: null };
  const updated: TxtImportRecord = { ...history.records[index], status, lastAttemptAt: now };
  const records = [...history.records];
  records.splice(index, 1);
  records.unshift(updated);
  return { history: { ...history, records }, record: updated };
}

/** Hash the file bytes, not its name or modification time, to detect exact re-uploads. */
export async function hashTxtFile(file: Pick<File, 'arrayBuffer'>): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('امکان بررسی اثرانگشت امن فایل در این مرورگر وجود ندارد.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
