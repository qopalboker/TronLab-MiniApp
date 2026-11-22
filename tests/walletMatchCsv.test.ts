import { describe, expect, it } from 'vitest';
import { makeWalletMatchesCsv } from '../src/lib/walletMatchCsv';

describe('wallet match CSV export', () => {
  it('exports public wallet summaries as quoted CSV rows', () => {
    expect(makeWalletMatchesCsv([{ id: 'wallet-1', address: 'TAbc', createdAt: '2026-11-22T10:00:00.000Z' }]))
      .toBe('address,wallet_id,created_at\r\n"TAbc","wallet-1","2026-11-22T10:00:00.000Z"');
  });

  it('neutralizes spreadsheet formula prefixes in stored metadata', () => {
    const csv = makeWalletMatchesCsv([{ id: '=HYPERLINK("https://bad")', address: 'TAbc', createdAt: ' @SUM(1,1)' }]);
    expect(csv).toContain(`"'=HYPERLINK(""https://bad"")"`);
    expect(csv).toContain(`"' @SUM(1,1)"`);
  });
});
