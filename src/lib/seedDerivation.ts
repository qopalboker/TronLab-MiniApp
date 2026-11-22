import { secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeed, validateMnemonic } from '@scure/bip39';
// @scure/bip39@1.5.4 exports the English wordlist without a .js subpath.
import { wordlist } from '@scure/bip39/wordlists/english';
import { tronAddressFromPublicKey } from './tronAddress';
import type { DerivationScheme } from '../types';

export interface DerivedAddress {
  address: string;
  addressIndex: number;
  derivationPath: string;
}

export interface TronAddressDeriver {
  deriveAt(addressIndex: number): DerivedAddress;
  dispose(): void;
}

export type Bip39WordCount = 12 | 15 | 18 | 21 | 24;

export function normalizeEnglishMnemonic(mnemonic: string): string {
  return mnemonic.trim().normalize('NFKD').replace(/\s+/g, ' ');
}

export function getEnglishBip39WordCount(mnemonic: string): number {
  const normalized = normalizeEnglishMnemonic(mnemonic);
  return normalized ? normalized.split(' ').length : 0;
}

export function isValidEnglishBip39Mnemonic(mnemonic: string): boolean {
  const normalized = normalizeEnglishMnemonic(mnemonic);
  const wordCount = normalized ? normalized.split(' ').length : 0;
  if (![12, 15, 18, 21, 24].includes(wordCount)) return false;
  return validateMnemonic(normalized, wordlist);
}

/**
 * Opens a short-lived BIP39/BIP44 derivation context.
 * Only public addresses are returned. Private material is wiped best-effort
 * when each child is derived and when the caller disposes the context.
 */
export async function createTronAddressDeriver(
  mnemonicInput: string,
  accountIndex = 0,
  changeIndex = 0,
  bip39Passphrase = '',
  scheme: DerivationScheme = 'bip44-address-index',
): Promise<TronAddressDeriver> {
  const mnemonic = normalizeEnglishMnemonic(mnemonicInput);
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('عبارت BIP39 انگلیسی معتبر نیست یا Checksum آن نادرست است.');
  }
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > 100_000 || ![0, 1].includes(changeIndex)) {
    throw new Error('مسیر مشتق‌سازی معتبر نیست.');
  }

  const seed = await mnemonicToSeed(mnemonic, bip39Passphrase.normalize('NFKD'));
  let root: HDKey | null = null;
  let branch: HDKey | null = null;
  let disposed = false;
  const pathPrefix = `m/44'/195'/${accountIndex}'/${changeIndex}`;

  try {
    root = HDKey.fromMasterSeed(seed);
    if (scheme === 'bip44-address-index') branch = root.derive(pathPrefix);
    const activeBranch = branch;
    const activeRoot = root;

    return {
      deriveAt(addressIndex: number): DerivedAddress {
        if (disposed) throw new Error('بافت مشتق‌سازی بسته شده است.');
        if (!Number.isSafeInteger(addressIndex) || addressIndex < 0 || addressIndex > 2_147_483_647) {
          throw new Error('شاخص آدرس از محدوده مجاز خارج شد.');
        }

        const derivationPath = scheme === 'bip44-address-index'
          ? `${pathPrefix}/${addressIndex}`
          : `m/44'/195'/${addressIndex}'/0/0`;
        const child = scheme === 'bip44-address-index'
          ? activeBranch!.deriveChild(addressIndex)
          : activeRoot.derive(derivationPath);
        try {
          const privateKey = child.privateKey;
          if (!privateKey) throw new Error('مشتق‌سازی کلید فرزند ناموفق بود.');
          const publicKey = secp256k1.getPublicKey(privateKey, false);
          privateKey.fill(0);
          try {
            return {
              address: tronAddressFromPublicKey(publicKey),
              addressIndex,
              derivationPath,
            };
          } finally {
            publicKey.fill(0);
          }
        } finally {
          child.wipePrivateData();
        }
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        branch?.wipePrivateData();
        root?.wipePrivateData();
        seed.fill(0);
        branch = null;
        root = null;
      },
    };
  } catch (error) {
    branch?.wipePrivateData();
    root?.wipePrivateData();
    seed.fill(0);
    throw error;
  }
}

/** Convenience helper for tests and small derivation batches. */
export async function deriveTronAddressesFromMnemonic(
  mnemonic: string,
  startIndex: number,
  count: number,
  accountIndex = 0,
  changeIndex = 0,
  bip39Passphrase = '',
  scheme: DerivationScheme = 'bip44-address-index',
): Promise<DerivedAddress[]> {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new Error('محدوده شاخص مشتق‌سازی معتبر نیست.');
  }
  if (startIndex + count - 1 > 2_147_483_647) throw new Error('شاخص آدرس از محدوده مجاز خارج شد.');
  const deriver = await createTronAddressDeriver(mnemonic, accountIndex, changeIndex, bip39Passphrase, scheme);
  try {
    return Array.from({ length: count }, (_, offset) => deriver.deriveAt(startIndex + offset));
  } finally {
    deriver.dispose();
  }
}
