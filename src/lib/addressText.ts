/**
 * Iterate logical text lines without allocating an array for the entire input.
 * CRLF, LF and CR are supported. A final line terminator does not create an
 * extra empty record; a genuinely empty line between terminators is preserved.
 */
export function* iterateTextLines(text: string): Generator<string> {
  if (text.length === 0) return;

  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '\r' && character !== '\n') continue;

    yield text.slice(lineStart, index);
    if (character === '\r' && text[index + 1] === '\n') index += 1;
    lineStart = index + 1;
  }

  if (lineStart < text.length) yield text.slice(lineStart);
}
