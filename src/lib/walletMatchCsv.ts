import type { WalletSummary } from './localDb';

function safeCsvCell(value: string): string {
  // Spreadsheet apps may interpret quoted cells beginning with formula
  // characters as executable formulas. Persisted metadata is validated for
  // shape, but can still be edited outside this app; neutralize such values.
  const safeValue = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function makeWalletMatchesCsv(rows: WalletSummary[]): string {
  return [
    'address,wallet_id,created_at',
    ...rows.map((row) => [row.address, row.id, row.createdAt].map(safeCsvCell).join(',')),
  ].join('\r\n');
}
