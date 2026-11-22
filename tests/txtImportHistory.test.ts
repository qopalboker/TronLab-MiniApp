import { describe, expect, it } from 'vitest';
import {
  createEmptyTxtImportHistory,
  hashTxtFile,
  isTxtImportHistory,
  registerTxtImport,
  setTxtImportStatus,
} from '../src/lib/txtImportHistory';

const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);

const input = (sha256 = firstHash, fileName = 'addresses.txt') => ({
  sha256,
  fileName,
  sizeBytes: 128,
});

describe('retained TXT import fingerprints', () => {
  it('records file metadata only and never stores the source text', () => {
    const result = registerTxtImport(createEmptyTxtImportHistory(), input(), '2026-11-22T08:00:00.000Z');
    expect(result.duplicate).toBe(false);
    expect(result.record).toMatchObject({ sha256: firstHash, fileName: 'addresses.txt', sizeBytes: 128, status: 'processing' });
    expect(Object.keys(result.record).sort()).toEqual(['fileName', 'lastAttemptAt', 'sha256', 'sizeBytes', 'status', 'uploadedAt'].sort());
    expect(JSON.stringify(result.history)).not.toContain('TUnknownAddress');
    expect(isTxtImportHistory(result.history)).toBe(true);
  });

  it('recognizes the exact same file content and does not register it twice', () => {
    const first = registerTxtImport(createEmptyTxtImportHistory(), input(), '2026-11-22T08:00:00.000Z');
    const second = registerTxtImport(first.history, input(firstHash, 'renamed.txt'), '2026-11-22T08:01:00.000Z');
    expect(second.duplicate).toBe(true);
    expect(second.history.records).toHaveLength(1);
    expect(second.record.fileName).toBe('addresses.txt');
  });

  it('records distinct files and marks an explicit retry status', () => {
    const first = registerTxtImport(createEmptyTxtImportHistory(), input(), '2026-11-22T08:00:00.000Z');
    const second = registerTxtImport(first.history, input(secondHash, 'other.txt'), '2026-11-22T08:01:00.000Z');
    const updated = setTxtImportStatus(second.history, firstHash, 'completed', '2026-11-22T08:02:00.000Z');
    expect(updated.record?.status).toBe('completed');
    expect(updated.record?.lastAttemptAt).toBe('2026-11-22T08:02:00.000Z');
    expect(updated.history.records[0].sha256).toBe(firstHash);
    expect(isTxtImportHistory(updated.history)).toBe(true);
  });

  it('rejects malformed metadata and extra fields that could carry TXT contents', () => {
    const result = registerTxtImport(createEmptyTxtImportHistory(), input());
    expect(isTxtImportHistory({ ...result.history, rawLines: ['TUnknownAddress'] })).toBe(false);
    expect(isTxtImportHistory({ ...result.history, records: [{ ...result.record, contents: 'TUnknownAddress' }] })).toBe(false);
    expect(() => registerTxtImport(result.history, { ...input(), sha256: 'not-a-hash' })).toThrow();
  });

  it('creates the same SHA-256 fingerprint for identical file bytes', async () => {
    const bytes = new TextEncoder().encode('TAddressLine1\nTAddressLine2\n');
    const fileLike = { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const first = await hashTxtFile(fileLike);
    const second = await hashTxtFile(fileLike);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});
