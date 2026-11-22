import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((character, index) => [character, index]));

function bytesToBigInt(bytes: Uint8Array): bigint {
  let output = 0n;
  for (const byte of bytes) output = (output << 8n) | BigInt(byte);
  return output;
}

function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  const output: number[] = [];
  let remaining = value;
  while (remaining > 0n) {
    output.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return new Uint8Array(output.reverse());
}

function base58Decode(value: string): Uint8Array | null {
  if (!value) return null;
  let number = 0n;
  for (const character of value) {
    const digit = INDEX.get(character);
    if (digit === undefined) return null;
    number = number * 58n + BigInt(digit);
  }
  const leadingZeroes = value.match(/^1+/)?.[0].length ?? 0;
  const body = bigIntToBytes(number);
  const result = new Uint8Array(leadingZeroes + body.length);
  result.set(body, leadingZeroes);
  return result;
}

function base58Encode(bytes: Uint8Array): string {
  let number = bytesToBigInt(bytes);
  let result = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = ALPHABET[remainder] + result;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return '1'.repeat(leadingZeroes) + result || '1';
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

/** Derive a mainnet-format TRON address from an uncompressed secp256k1 public key. */
export function tronAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('کلید عمومی باید در قالب uncompressed secp256k1 باشد.');
  }
  const accountHash = keccak_256(publicKey.slice(1));
  const payload = concatBytes(new Uint8Array([0x41]), accountHash.slice(-20));
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

/** Validate Base58 alphabet, payload length, TRON 0x41 prefix and Base58Check checksum. */
export function isValidTronAddress(address: string): boolean {
  if (address.length !== 34 || address[0] !== 'T') return false;
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) return false;
  const payload = decoded.slice(0, 21);
  const expected = sha256(sha256(payload)).slice(0, 4);
  let difference = 0;
  for (let index = 0; index < 4; index += 1) difference |= expected[index] ^ decoded[21 + index];
  return difference === 0;
}

export function normalizeTronAddress(value: string): string {
  return value.trim();
}
