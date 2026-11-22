function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Memory-bounded Bloom prefilter. It may return false positives, never false negatives. */
export class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly bitCount: number;
  private readonly hashCount: number;

  static estimateByteLength(expectedItems: number, falsePositiveRate = 0.001): number {
    if (!Number.isFinite(falsePositiveRate) || falsePositiveRate <= 0 || falsePositiveRate >= 1) {
      throw new Error('نرخ خطای فیلتر باید بین صفر و یک باشد.');
    }
    const safeCount = Math.max(1, expectedItems);
    const rawBits = Math.ceil(-(safeCount * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2));
    return Math.ceil(Math.max(1024, rawBits) / 8);
  }

  constructor(expectedItems: number, falsePositiveRate = 0.001) {
    const safeCount = Math.max(1, expectedItems);
    const rawBits = Math.ceil(-(safeCount * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2));
    this.bitCount = Math.max(1024, rawBits);
    this.hashCount = Math.min(12, Math.max(1, Math.round((this.bitCount / safeCount) * Math.LN2)));
    this.bits = new Uint8Array(Math.ceil(this.bitCount / 8));
  }

  get byteLength(): number {
    return this.bits.byteLength;
  }

  getBitCount(): number {
    return this.bitCount;
  }

  getHashCount(): number {
    return this.hashCount;
  }

  /** Export raw bits for transfer to workers (structured clone / transferable). */
  exportBits(): Uint8Array {
    return this.bits.slice();
  }

  /**
   * Reconstruct a filter from exported bits. Caller must supply the same
   * bitCount and hashCount that were used when the filter was built.
   */
  static fromBits(bits: Uint8Array, bitCount: number, hashCount: number): BloomFilter {
    if (bitCount < 8 || hashCount < 1 || bits.byteLength < Math.ceil(bitCount / 8)) {
      throw new Error('پارامترهای فیلتر بلوم نامعتبر است.');
    }
    const filter = Object.create(BloomFilter.prototype) as BloomFilter;
    Object.defineProperty(filter, 'bitCount', { value: bitCount, writable: false });
    Object.defineProperty(filter, 'hashCount', { value: hashCount, writable: false });
    Object.defineProperty(filter, 'bits', { value: new Uint8Array(bits), writable: false });
    return filter;
  }

  add(value: string): void {
    const first = fnv1a(value);
    const second = (fnv1a(value, 0x9747b28c) | 1) >>> 0;
    for (let index = 0; index < this.hashCount; index += 1) {
      const position = ((first + Math.imul(index, second)) >>> 0) % this.bitCount;
      this.bits[position >>> 3] |= 1 << (position & 7);
    }
  }

  mayContain(value: string): boolean {
    const first = fnv1a(value);
    const second = (fnv1a(value, 0x9747b28c) | 1) >>> 0;
    for (let index = 0; index < this.hashCount; index += 1) {
      const position = ((first + Math.imul(index, second)) >>> 0) % this.bitCount;
      if ((this.bits[position >>> 3] & (1 << (position & 7))) === 0) return false;
    }
    return true;
  }
}
