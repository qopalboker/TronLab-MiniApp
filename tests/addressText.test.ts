import { describe, expect, it } from 'vitest';
import { iterateTextLines } from '../src/lib/addressText';

describe('TXT line iteration', () => {
  it('supports LF, CRLF and CR without creating a phantom trailing line', () => {
    expect([...iterateTextLines('one\ntwo\r\nthree\rfour\n')]).toEqual([
      'one', 'two', 'three', 'four',
    ]);
  });

  it('preserves genuine blank lines but not a trailing empty segment', () => {
    expect([...iterateTextLines('one\n\ntwo')]).toEqual(['one', '', 'two']);
    expect([...iterateTextLines('\n')]).toEqual(['']);
  });

  it('returns no lines for an empty input', () => {
    expect([...iterateTextLines('')]).toEqual([]);
  });
});
