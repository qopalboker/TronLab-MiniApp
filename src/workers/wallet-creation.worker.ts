import {
  deriveTronAddressFromPrivateKey,
  generateTronPrivateKeyWalletBatch,
} from '../lib/tronPrivateKey';
import type { WalletCreationRequest, WalletCreationResponse } from '../lib/walletCreationProtocol';
import { MAX_PRIVATE_KEY_BATCH_SIZE } from '../lib/walletConstants';

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WalletCreationRequest>) => void) | null;
  postMessage(message: WalletCreationResponse): void;
};

function respond(message: WalletCreationResponse): void {
  workerScope.postMessage(message);
}

async function handleRequest(request: WalletCreationRequest): Promise<void> {
  try {
    if (request.type === 'generate-private-key-batch' || request.type === 'benchmark-private-key-batch') {
      if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > MAX_PRIVATE_KEY_BATCH_SIZE) {
        throw new Error('اندازه دسته تولید کلید خصوصی خارج از محدوده مجاز است.');
      }
      const generationStartedAt = performance.now();
      const generatedWallets = generateTronPrivateKeyWalletBatch(request.count);
      const workerDurationMs = performance.now() - generationStartedAt;

      if (request.type === 'benchmark-private-key-batch') {
        // Benchmark only needs an aggregate count. Release all generated wallet references
        // inside the Worker and never send private keys or addresses to the UI thread.
        const generatedCount = generatedWallets.length;
        for (const wallet of generatedWallets) {
          wallet.privateKey = '';
          wallet.address = '';
        }
        generatedWallets.length = 0;
        respond({
          id: request.id,
          type: 'benchmark-batch-complete',
          count: generatedCount,
          metrics: { workerDurationMs },
        });
        return;
      }

      const wallets = generatedWallets.map((wallet) => ({
        format: 'private-key' as const,
        ...wallet,
        wordCount: 0 as const,
      }));
      respond({ id: request.id, type: 'generated-batch', wallets, metrics: { workerDurationMs } });
      return;
    }

    if (request.type === 'validate-private-key') {
      try {
        const address = deriveTronAddressFromPrivateKey(request.privateKey);
        respond({
          id: request.id,
          type: 'validated',
          format: 'private-key',
          valid: true,
          wordCount: 0,
          address,
          derivationPath: 'private-key',
        });
      } catch (error) {
        respond({
          id: request.id,
          type: 'validated',
          format: 'private-key',
          valid: false,
          wordCount: 0,
          message: error instanceof Error ? error.message : 'کلید خصوصی معتبر نیست.',
        });
      }
      return;
    }

    // Legacy mnemonic validation is isolated from the direct private-key generation path.
    const {
      createTronAddressDeriver,
      getEnglishBip39WordCount,
      isValidEnglishBip39Mnemonic,
    } = await import('../lib/seedDerivation');
    const wordCount = getEnglishBip39WordCount(request.mnemonic);
    if (!isValidEnglishBip39Mnemonic(request.mnemonic)) {
      respond({
        id: request.id,
        type: 'validated',
        format: 'mnemonic',
        valid: false,
        wordCount,
        message: 'عبارت انگلیسی BIP39 معتبر نیست؛ تعداد کلمات یا Checksum را بررسی کن.',
      });
      return;
    }

    const deriver = await createTronAddressDeriver(request.mnemonic);
    try {
      const firstAddress = deriver.deriveAt(0);
      respond({
        id: request.id,
        type: 'validated',
        format: 'mnemonic',
        valid: true,
        wordCount,
        address: firstAddress.address,
        derivationPath: firstAddress.derivationPath,
      });
    } finally {
      deriver.dispose();
    }

  } catch (error) {
    respond({ id: request.id, type: 'error', message: error instanceof Error ? error.message : 'عملیات کیف‌پول ناموفق بود.' });
  }
}

workerScope.onmessage = (event: MessageEvent<WalletCreationRequest>) => {
  void handleRequest(event.data);
};

export {};
