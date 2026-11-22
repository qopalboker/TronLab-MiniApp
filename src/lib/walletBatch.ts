export interface HasWalletAddress {
  address: string;
}

/** Stable in-batch deduplication; the first record for each exact address wins. */
export function deduplicateWalletBatch<T extends HasWalletAddress>(
  records: readonly T[],
): { uniqueRecords: T[]; duplicates: number } {
  const seen = new Set<string>();
  const uniqueRecords: T[] = [];
  let duplicates = 0;
  for (const record of records) {
    if (seen.has(record.address)) {
      duplicates += 1;
      continue;
    }
    seen.add(record.address);
    uniqueRecords.push(record);
  }
  return { uniqueRecords, duplicates };
}
