import { describe, expect, it } from 'vitest';
import { buildTargetAddressSetFromText } from '../src/lib/targetAddressSet';

describe('target address set builder', () => {
  it('parses valid, invalid, blank, and duplicate lines', async () => {
    const text = [
      'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
      '',
      '  ',
      'not-an-address',
      'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
      'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
    ].join('\n');

    const set = await buildTargetAddressSetFromText(text);
    expect(set.summary.validUnique).toBe(2);
    expect(set.summary.blankLines).toBe(2);
    expect(set.summary.invalid).toBe(1);
    expect(set.summary.duplicates).toBe(1);
    expect(set.has('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC')).toBe(true);
    expect(set.has('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')).toBe(true);
    expect(set.has('not-an-address')).toBe(false);
  });

  it('rejects oversized address counts', async () => {
    const one = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
    // maxAddresses is checked after each successful add; limit 0 rejects the first valid.
    await expect(buildTargetAddressSetFromText(`${one}\n`, { maxAddresses: 0 })).rejects.toThrow(/سقف/);
  });

  it('builds Bloom only when requested and size > 0', async () => {
    const empty = await buildTargetAddressSetFromText('');
    expect(empty.bloom).toBeNull();

    const withBloom = await buildTargetAddressSetFromText('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC\n', {
      useBloom: true,
    });
    expect(withBloom.bloom).not.toBeNull();
    expect(withBloom.bloom!.mayContain('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC')).toBe(true);

    const noBloom = await buildTargetAddressSetFromText('TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC\n', {
      useBloom: false,
    });
    expect(noBloom.bloom).toBeNull();
  });
});
