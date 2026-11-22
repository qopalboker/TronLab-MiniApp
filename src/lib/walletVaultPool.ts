
export type VaultPoolStatus = 'initializing' | 'ready' | 'running' | 'stopping' | 'stopped' | 'error';

interface PoolOptions {
  key: CryptoKey;
  scope: string;
  workerCount: number;
  batchSize: number;
  onBatchSaved: (count: number, durationMs: number, duplicates: number) => void;
  onStatus: (status: VaultPoolStatus) => void;
  onError: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  pendingId: string | null;
  pendingType: 'init' | 'batch' | 'decrypt' | null;
  timeoutId: number | null;
  resolve?: (value: DecryptedWallet) => void;
  reject?: (error: Error) => void;
}

export interface DecryptedWallet {
  id: string;
  address: string;
  privateKey: string;
  createdAt: string;
}

interface PoolMessage {
  id: string;
  type: string;
  count?: number;
  duplicates?: number;
  durationMs?: number;
  wallet?: DecryptedWallet;
  message?: string;
}

function makeId(): string {
  return crypto.randomUUID();
}

export class WalletVaultPool {
  private readonly options: Omit<PoolOptions, 'key'>;
  private bootstrapKey: CryptoKey | null;
  private readonly slots: Slot[] = [];
  private running = false;
  private destroyed = false;
  private initialized = false;
  private initResolve: (() => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;

  constructor(options: PoolOptions) {
    const { key, ...callbacks } = options;
    this.bootstrapKey = key;
    this.options = callbacks;
  }

  async initialize(): Promise<void> {
    if (!this.bootstrapKey) throw new Error('کلید امن برای راه‌اندازی Worker Pool در دسترس نیست.');
    const bootstrapKey = this.bootstrapKey;
    this.options.onStatus('initializing');
    const initPromise = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });

    try {
      for (let index = 0; index < this.options.workerCount; index += 1) {
        const worker = new Worker(new URL('../workers/wallet-vault.worker.ts', import.meta.url), { type: 'module' });
        const slot: Slot = { worker, pendingId: null, pendingType: null, timeoutId: null };
        this.slots.push(slot);
        worker.onmessage = (event: MessageEvent<PoolMessage>) => { void this.handleMessage(slot, event.data); };
        worker.onerror = (event) => this.fail(new Error(event.message || 'یکی از Workerهای تولید متوقف شد.'));
        const id = makeId();
        slot.pendingId = id;
        slot.pendingType = 'init';
        this.armTimeout(slot, id, 15_000, 'راه‌اندازی یکی از Workerها بیش از ۱۵ ثانیه طول کشید.');
        worker.postMessage({ id, type: 'init-vault', key: bootstrapKey, scope: this.options.scope });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('ساخت Worker Pool ممکن نشد.'));
    }

    let timeoutId = 0;
    try {
      await Promise.race([
        initPromise,
        new Promise<never>((_, reject) => { timeoutId = window.setTimeout(() => reject(new Error('راه‌اندازی Worker Pool بیش از ۱۵ ثانیه طول کشید.')), 15_000); }),
      ]);
    } catch (error) {
      this.terminate();
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
    this.initialized = true;
    this.bootstrapKey = null;
    this.options.onStatus('ready');
  }

  start(): void {
    if (this.destroyed || !this.initialized || this.running) return;
    this.running = true;
    this.options.onStatus('running');
    for (const slot of this.slots) this.dispatchBatch(slot);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.options.onStatus(this.hasPendingBatches() ? 'stopping' : 'stopped');
  }

  async decrypt(walletId: string): Promise<DecryptedWallet> {
    if (this.destroyed || !this.initialized) throw new Error('Worker Pool آماده نیست.');
    if (this.running || this.hasPendingBatches()) throw new Error('برای نمایش کلید خصوصی ابتدا تولید را متوقف کن و منتظر ذخیره دسته جاری بمان.');
    const slot = this.slots.find((candidate) => candidate.pendingId === null);
    if (!slot) throw new Error('هیچ Worker آزادی برای رمزگشایی وجود ندارد.');

    const id = makeId();
    slot.pendingId = id;
    slot.pendingType = 'decrypt';
    this.armTimeout(slot, id, 15_000, 'رمزگشایی کیف‌پول بیش از ۱۵ ثانیه طول کشید.');
    return new Promise<DecryptedWallet>((resolve, reject) => {
      slot.resolve = resolve;
      slot.reject = reject;
      try {
        slot.worker.postMessage({ id, type: 'decrypt-wallet', walletId });
      } catch (error) {
        this.clearTimeout(slot);
        slot.pendingId = null;
        slot.pendingType = null;
        slot.resolve = undefined;
        slot.reject = undefined;
        reject(error instanceof Error ? error : new Error('ارسال درخواست رمزگشایی ناموفق بود.'));
      }
    });
  }

  terminate(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.bootstrapKey = null;
    for (const slot of this.slots) {
      this.clearTimeout(slot);
      slot.worker.terminate();
      slot.reject?.(new Error('نشست امن بسته شد.'));
      slot.pendingId = null;
      slot.pendingType = null;
      slot.resolve = undefined;
      slot.reject = undefined;
    }
    this.slots.length = 0;
  }

  private dispatchBatch(slot: Slot): void {
    if (!this.running || this.destroyed || slot.pendingId !== null) return;
    const id = makeId();
    slot.pendingId = id;
    slot.pendingType = 'batch';
    this.armTimeout(slot, id, 30_000, 'تولید یا ذخیره دسته کیف‌پول بیش از ۳۰ ثانیه طول کشید؛ برای جلوگیری از انباشت کار، Worker Pool متوقف شد.');
    try {
      slot.worker.postMessage({ id, type: 'generate-and-store-batch', count: this.options.batchSize });
    } catch (error) {
      this.clearTimeout(slot);
      slot.pendingId = null;
      slot.pendingType = null;
      this.fail(error instanceof Error ? error : new Error('ارسال دسته تولید ناموفق بود.'));
    }
  }

  private async handleMessage(slot: Slot, message: PoolMessage): Promise<void> {
    if (this.destroyed || message.id !== slot.pendingId) return;
    const pendingType = slot.pendingType;
    this.clearTimeout(slot);

    if (message.type === 'error') {
      slot.pendingId = null;
      slot.pendingType = null;
      const error = new Error(message.message || 'عملیات Worker ناموفق بود.');
      slot.reject?.(error);
      slot.resolve = undefined;
      slot.reject = undefined;
      this.fail(error);
      return;
    }

    if (pendingType === 'init' && message.type === 'ready') {
      slot.pendingId = null;
      slot.pendingType = null;
      if (this.slots.every((candidate) => candidate.pendingType !== 'init')) this.initResolve?.();
      return;
    }

    if (pendingType === 'decrypt' && message.type === 'decrypted-wallet' && message.wallet) {
      slot.pendingId = null;
      slot.pendingType = null;
      const resolve = slot.resolve;
      slot.resolve = undefined;
      slot.reject = undefined;
      resolve?.(message.wallet);
      return;
    }

    if (pendingType === 'batch' && message.type === 'batch-saved') {
      const count = message.count ?? 0;
      slot.pendingId = null;
      slot.pendingType = null;
      this.options.onBatchSaved(
        count,
        typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) ? message.durationMs : 0,
        typeof message.duplicates === 'number' && Number.isSafeInteger(message.duplicates) ? message.duplicates : 0,
      );
      if (this.running) this.dispatchBatch(slot);
      else if (!this.hasPendingBatches()) this.options.onStatus('stopped');
    }
  }

  private hasPendingBatches(): boolean {
    return this.slots.some((slot) => slot.pendingType === 'batch');
  }

  private armTimeout(slot: Slot, id: string, durationMs: number, message: string): void {
    this.clearTimeout(slot);
    slot.timeoutId = window.setTimeout(() => {
      if (slot.pendingId !== id || this.destroyed) return;
      this.fail(new Error(message));
    }, durationMs);
  }

  private clearTimeout(slot: Slot): void {
    if (slot.timeoutId !== null) {
      window.clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
  }

  private fail(error: Error): void {
    if (this.destroyed) return;
    this.running = false;
    this.destroyed = true;
    this.bootstrapKey = null;
    this.options.onStatus('error');
    this.initReject?.(error);
    this.options.onError(error);
    for (const slot of this.slots) {
      this.clearTimeout(slot);
      slot.worker.terminate();
      slot.reject?.(error);
      slot.resolve = undefined;
      slot.reject = undefined;
      slot.pendingId = null;
      slot.pendingType = null;
    }
    this.slots.length = 0;
  }
}
