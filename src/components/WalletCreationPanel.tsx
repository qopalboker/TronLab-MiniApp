import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import AddressMatchPanel from './AddressMatchPanel';
import {
  beginGenerationCheckpoint,
  clearAllLocalVaultData,
  getOrInitializeWalletUsageStats,
  getEncryptedWalletPage,
  recordWalletUsageStats,
  deleteEncryptedWallet,
  listEncryptedWalletPage,
  inspectVaultDatabaseHealth,
  pauseGenerationCheckpoint,
  recoverGenerationCheckpoint,
  type WalletSummary,
} from '../lib/localDb';
import { WalletVaultPool, type DecryptedWallet, type VaultPoolStatus } from '../lib/walletVaultPool';
import type { GenerationCheckpoint } from '../lib/generationCheckpoint';
import { addWalletUsageStatsDelta, type WalletUsageStats, type WalletUsageStatsDelta } from '../lib/walletUsageStats';

interface Props {
  onNotify: (message: string, success?: boolean) => void;
  vaultKey: CryptoKey;
  scope: string;
}

const WALLETS_PER_PAGE = 100;
const WORKER_COUNT = 3;
const BATCH_SIZE = 1024;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('fa-IR', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export default function WalletCreationPanel({ onNotify, vaultKey, scope }: Props) {
  const [poolStatus, setPoolStatus] = useState<VaultPoolStatus>('initializing');
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [walletTotal, setWalletTotal] = useState(0);
  const [walletPageLoading, setWalletPageLoading] = useState(true);
  const [usageStatsLoading, setUsageStatsLoading] = useState(true);
  const [usageStats, setUsageStats] = useState<WalletUsageStats | null>(null);
  const [walletPage, setWalletPage] = useState(0);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [revealedWallet, setRevealedWallet] = useState<DecryptedWallet | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [storagePersistence, setStoragePersistence] = useState<'granted' | 'not-granted' | 'unavailable'>('unavailable');
  const [generationRate, setGenerationRate] = useState(0);
  const [lastBatchDurationMs, setLastBatchDurationMs] = useState(0);
  const [checkpoint, setCheckpoint] = useState<GenerationCheckpoint | null>(null);
  const [databaseHealth, setDatabaseHealth] = useState<{ healthy: boolean; message: string } | null>(null);
  const [startPending, setStartPending] = useState(false);
  const [matchingBusy, setMatchingBusy] = useState(false);
  const matchingBusyRef = useRef(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [clearingAllData, setClearingAllData] = useState(false);
  const [clearStage, setClearStage] = useState<'counting' | 'clearing' | null>(null);
  const [deletingWallet, setDeletingWallet] = useState(false);
  const [matchingResetToken, setMatchingResetToken] = useState(0);
  const [selectedSummary, setSelectedSummary] = useState<WalletSummary | null>(null);
  const poolRef = useRef<WalletVaultPool | null>(null);
  const aliveRef = useRef(true);
  const pageRefreshTimerRef = useRef<number | null>(null);
  const savedCountRef = useRef(0);
  const rateBaselineRef = useRef(0);
  const rateStartedAtRef = useRef<number | null>(null);
  const startPendingRef = useRef(false);
  const clearingAllDataRef = useRef(false);

  const handleMatchingBusyChange = useCallback((busy: boolean) => {
    matchingBusyRef.current = busy;
    setMatchingBusy(busy);
  }, []);

  const handleUsageStatsDelta = useCallback((delta: Pick<WalletUsageStatsDelta, 'checkedAddressCount' | 'matchedAddressCount' | 'unmatchedAddressCount' | 'deletedWalletCount'>) => {
    setUsageStats((current) => current ? addWalletUsageStatsDelta(current, delta) : current);
  }, []);

  const handleOperationFailure = useCallback(() => {
    setUsageStats((current) => current ? addWalletUsageStatsDelta(current, { failedOperationCount: 1 }) : current);
    void recordWalletUsageStats({ failedOperationCount: 1 })
      .then((stats) => { if (aliveRef.current) setUsageStats(stats); })
      .catch((error) => {
        if (aliveRef.current) onNotify(error instanceof Error ? error.message : 'ثبت آمار خطای پردازش ناموفق بود.', false);
      });
  }, [onNotify]);

  const refreshPage = useCallback(async (page: number) => {
    setWalletPageLoading(true);
    try {
      let result = await getEncryptedWalletPage(page, WALLETS_PER_PAGE);
      if (!aliveRef.current) return;
      const pageCount = Math.max(1, Math.ceil(result.total / WALLETS_PER_PAGE));
      const safePage = Math.min(Math.max(0, page), pageCount - 1);
      if (safePage !== page) result = await getEncryptedWalletPage(safePage, WALLETS_PER_PAGE);
      if (!aliveRef.current) return;
      setWalletPage(safePage);
      setWallets(result.rows);
      savedCountRef.current = result.total;
      setWalletTotal(result.total);
    } finally {
      if (aliveRef.current) setWalletPageLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      void navigator.storage.persist()
        .then((granted) => { if (aliveRef.current) setStoragePersistence(granted ? 'granted' : 'not-granted'); })
        .catch(() => { if (aliveRef.current) setStoragePersistence('not-granted'); });
    } else {
      setStoragePersistence('unavailable');
    }
    const pool = new WalletVaultPool({
      key: vaultKey,
      scope,
      workerCount: WORKER_COUNT,
      batchSize: BATCH_SIZE,
      onBatchSaved: (count, durationMs, duplicates) => {
        if (!aliveRef.current) return;
        savedCountRef.current += count;
        setWalletTotal(savedCountRef.current);
        setUsageStats((current) => current ? addWalletUsageStatsDelta(current, {
          generatedCount: count + duplicates,
          successfulWalletCount: count,
          notStoredCount: duplicates,
        }) : current);
        const rateStartedAt = rateStartedAtRef.current;
        if (rateStartedAt !== null) {
          const elapsedSeconds = (performance.now() - rateStartedAt) / 1_000;
          if (elapsedSeconds > 0) {
            setGenerationRate((savedCountRef.current - rateBaselineRef.current) / elapsedSeconds);
          }
        }
        if (durationMs > 0) setLastBatchDurationMs(durationMs);
        setCheckpoint((current) => current ? {
          ...current,
          savedCount: current.savedCount + count,
          duplicateCount: current.duplicateCount + duplicates,
          lastBatchAt: new Date().toISOString(),
          lastBatchCount: count,
          lastBatchDuplicates: duplicates,
        } : current);
        setWalletPage(0);
        if (pageRefreshTimerRef.current === null) {
          pageRefreshTimerRef.current = window.setTimeout(() => {
            pageRefreshTimerRef.current = null;
            void listEncryptedWalletPage(0, WALLETS_PER_PAGE)
              .then((rows) => { if (aliveRef.current) setWallets(rows); })
              .catch((error) => onNotify(error instanceof Error ? error.message : 'به‌روزرسانی فهرست کیف‌پول‌ها ناموفق بود.', false));
          }, 750);
        }
      },
      onStatus: (status) => {
        if (!aliveRef.current) return;
        setPoolStatus(status);
        if (status === 'stopped') {
          void pauseGenerationCheckpoint()
            .then((savedCheckpoint) => { if (aliveRef.current) setCheckpoint(savedCheckpoint); })
            .catch((error) => onNotify(error instanceof Error ? error.message : 'ثبت نقطه توقف ناموفق بود.', false));
        }
      },
      onError: (error) => {
        if (!aliveRef.current) return;
        handleOperationFailure();
        onNotify(error.message, false);
      },
    });
    poolRef.current = pool;
    void (async () => {
      try {
        // Show dashboard data as each request resolves instead of waiting for
        // the integrity scan to finish. Starting workers remains gated by audit.
        const healthTask = inspectVaultDatabaseHealth().then((health) => {
          if (aliveRef.current) {
            setDatabaseHealth({
              healthy: health.healthy,
              message: health.healthy
                ? `سلامت دیتابیس تأیید شد · ${formatNumber(health.walletCount)} رکورد · ساختار ${health.schemaVersion}`
                : `بررسی یکپارچگی دیتابیس ناموفق بود: ${health.issues.join(' ')}`,
            });
          }
          return health;
        });
        const statsTask = getOrInitializeWalletUsageStats()
          .then((stats) => {
            if (aliveRef.current) setUsageStats(stats);
            return stats;
          })
          .finally(() => { if (aliveRef.current) setUsageStatsLoading(false); });
        const pageTask = refreshPage(0);
        const checkpointTask = recoverGenerationCheckpoint().then((savedCheckpoint) => {
          if (aliveRef.current) setCheckpoint(savedCheckpoint);
          return savedCheckpoint;
        });

        const [healthResult, statsResult, pageResult, checkpointResult] = await Promise.allSettled([
          healthTask, statsTask, pageTask, checkpointTask,
        ]);
        if (!aliveRef.current) return;
        for (const result of [healthResult, statsResult, pageResult, checkpointResult]) {
          if (result.status === 'rejected') throw result.reason;
        }
        const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
        if (!health) throw new Error('نتیجه ممیزی دیتابیس دریافت نشد.');
        if (!health.healthy) {
          const message = `بررسی یکپارچگی دیتابیس ناموفق بود: ${health.issues.join(' ')}`;
          setDatabaseHealth({ healthy: false, message });
          throw new Error(message);
        }
        await pool.initialize();
      } catch (error) {
        if (aliveRef.current) {
          setPoolStatus('error');
          const message = error instanceof Error ? error.message : 'راه‌اندازی دیتابیس یا Worker Pool ناموفق بود.';
          setDatabaseHealth((current) => current ?? { healthy: false, message });
          onNotify(message, false);
        }
      }
    })();

    const pauseSensitiveWork = () => {
      // Keep the vault session and Worker Pool alive, but hide any decrypted
      // private key and pause generation cleanly so its in-flight batch can commit.
      setRevealedWallet(null);
      poolRef.current?.stop();
    };
    const onVisibilityChange = () => {
      // Android's document picker temporarily backgrounds the WebView.
      if (document.visibilityState !== 'visible') pauseSensitiveWork();
    };
    const onPageHide = () => pauseSensitiveWork();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      if (pageRefreshTimerRef.current !== null) window.clearTimeout(pageRefreshTimerRef.current);
      pageRefreshTimerRef.current = null;
      poolRef.current?.terminate();
      poolRef.current = null;
    };
  }, [vaultKey, scope, onNotify, refreshPage, handleOperationFailure]);

  const poolBusy = poolStatus === 'running' || poolStatus === 'stopping' || poolStatus === 'initializing';
  const pageCount = Math.max(1, Math.ceil(walletTotal / WALLETS_PER_PAGE));

  async function startGeneration() {
    if (startPendingRef.current || revealing || matchingBusyRef.current || purgeBusy || clearingAllDataRef.current || deletingWallet || (poolStatus !== 'ready' && poolStatus !== 'stopped')) return;
    startPendingRef.current = true;
    setStartPending(true);
    try {
      const nextCheckpoint = await beginGenerationCheckpoint();
      if (!aliveRef.current || !poolRef.current) return;
      setCheckpoint(nextCheckpoint);
      setSelectedWalletId(null);
      setSelectedSummary(null);
      setRevealedWallet(null);
      rateBaselineRef.current = savedCountRef.current;
      rateStartedAtRef.current = performance.now();
      setLastBatchDurationMs(0);
      setGenerationRate(0);
      poolRef.current.start();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'ثبت وضعیت شروع تولید ناموفق بود.', false);
    } finally {
      startPendingRef.current = false;
      if (aliveRef.current) setStartPending(false);
    }
  }

  function stopGeneration() {
    poolRef.current?.stop();
  }

  function openWallet(wallet: WalletSummary) {
    setSelectedWalletId(wallet.id);
    setSelectedSummary(wallet);
    setRevealedWallet(null);
    setRevealing(false);
  }

  async function revealPrivateKey() {
    if (!selectedWalletId || poolBusy || revealing || clearingAllDataRef.current || deletingWallet) return;
    setRevealing(true);
    try {
      const decrypted = await poolRef.current?.decrypt(selectedWalletId);
      if (!decrypted) throw new Error('Worker رمزگشایی در دسترس نیست.');
      if (!aliveRef.current || document.visibilityState !== 'visible') {
        decrypted.privateKey = '';
        return;
      }
      if (decrypted.address !== selectedSummary?.address) throw new Error('اعتبارسنجی آدرس کیف‌پول ناموفق بود.');
      setRevealedWallet(decrypted);
    } catch (error) {
      if (document.visibilityState === 'visible') {
        onNotify(error instanceof Error ? error.message : 'رمزگشایی کلید خصوصی ناموفق بود.', false);
      }
    } finally {
      if (aliveRef.current) setRevealing(false);
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      onNotify('آدرس عمومی کپی شد.');
    } catch {
      onNotify('دسترسی Clipboard در این محیط در دسترس نیست.', false);
    }
  }

  async function copyPrivateKey() {
    if (!selectedWalletId || poolBusy || clearingAllDataRef.current || deletingWallet) return;
    const alreadyRevealed = Boolean(revealedWallet);
    let temporaryWallet: DecryptedWallet | null = null;
    try {
      const wallet = revealedWallet ?? await poolRef.current?.decrypt(selectedWalletId);
      if (!wallet) throw new Error('کلید خصوصی قابل بازیابی نیست.');
      if (!aliveRef.current || document.visibilityState !== 'visible') {
        if (!alreadyRevealed) wallet.privateKey = '';
        return;
      }
      if (!alreadyRevealed) temporaryWallet = wallet;
      await navigator.clipboard.writeText(wallet.privateKey);
      onNotify('کلید خصوصی کپی شد؛ از افشای آن در Clipboard و برنامه‌های دیگر جلوگیری کن.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'کپی کلید خصوصی ناموفق بود.', false);
    } finally {
      // Best-effort release of the temporary plaintext string; JavaScript does not guarantee memory zeroization.
      if (temporaryWallet) temporaryWallet.privateKey = '';
    }
  }

  async function removeSelectedWallet() {
    if (!selectedWalletId || poolBusy || matchingBusy || clearingAllDataRef.current || deletingWallet) return;
    setDeletingWallet(true);
    try {
      await deleteEncryptedWallet(selectedWalletId);
      setUsageStats(await getOrInitializeWalletUsageStats());
      setSelectedWalletId(null);
      setSelectedSummary(null);
      setRevealedWallet(null);
      setMatchingResetToken((value) => value + 1);
      await refreshPage(walletPage);
      onNotify('رکورد کیف‌پول از دیتابیس رمزگذاری‌شده حذف شد.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'حذف کیف‌پول ناموفق بود.', false);
    } finally {
      if (aliveRef.current) setDeletingWallet(false);
    }
  }

  async function clearAllAppData() {
    if (clearingAllDataRef.current || poolBusy || matchingBusy || purgeBusy || revealing || deletingWallet || startPending || databaseHealth?.healthy !== true) return;
    const accepted = window.confirm('پاک‌سازی کامل انجام شود؟ همه کیف‌پول‌ها، آمار عملکرد، سابقه فایل‌های TXT، نتایج تطبیق و نقطه بازیابی این حساب از دیتابیس همین دستگاه حذف می‌شوند.');
    if (!accepted) return;
    const finalConfirmation = window.confirm('تأیید نهایی: این عملیات برگشت‌ناپذیر است. رکورد بررسی کلید و تنظیم بیومتریک حفظ می‌شوند تا ورود امن بعدی بدون ساخت کلید رمزگذاری جدید انجام شود. ادامه می‌دهی؟');
    if (!finalConfirmation) return;
    clearingAllDataRef.current = true;
    setClearingAllData(true);
    setClearStage('counting');
    try {
      const { deletedWalletCount } = await clearAllLocalVaultData((phase) => {
        if (aliveRef.current) setClearStage(phase);
      });
      const resetStats = await getOrInitializeWalletUsageStats();
      setUsageStats(resetStats);
      setCheckpoint(null);
      setSelectedWalletId(null);
      setSelectedSummary(null);
      setRevealedWallet(null);
      setMatchingResetToken((value) => value + 1);
      setWallets([]);
      savedCountRef.current = 0;
      setWalletTotal(0);
      setWalletPage(0);
      rateBaselineRef.current = 0;
      rateStartedAtRef.current = null;
      setGenerationRate(0);
      setLastBatchDurationMs(0);
      onNotify(`پاک‌سازی کامل شد؛ ${formatNumber(deletedWalletCount)} کیف‌پول حذف شد و آمار از صفر شروع می‌شود. تنظیم بیومتریک حفظ شد.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'پاک‌سازی کامل داده‌های برنامه ناموفق بود.', false);
    } finally {
      clearingAllDataRef.current = false;
      if (aliveRef.current) {
        setClearingAllData(false);
        setClearStage(null);
      }
    }
  }

  async function changePage(nextPage: number) {
    if (poolBusy || matchingBusy || clearingAllData || deletingWallet || walletPageLoading) return;
    try {
      await refreshPage(nextPage);
      setSelectedWalletId(null);
      setSelectedSummary(null);
      setRevealedWallet(null);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'تغییر صفحه ناموفق بود.', false);
    }
  }

  const statusLabel = poolStatus === 'initializing' ? 'در حال آماده‌سازی Workerها'
    : poolStatus === 'ready' ? 'آماده تولید'
      : poolStatus === 'running' ? 'در حال تولید و ذخیره امن'
        : poolStatus === 'stopping' ? 'در حال تکمیل دسته‌های جاری'
          : poolStatus === 'error' ? 'خطای موتور تولید'
            : 'متوقف';

  return (
    <section className="panel-stack wallet-panel">
      <div className="wallet-create-card wallet-create-card-compact">
        <div className="wallet-compact-heading">
          <div>
            <span className="eyebrow">TRON WALLET LAB · SECURE VAULT</span>
            <h1>تولید کیف‌پول</h1>
            <p className="wallet-build-note">۳ Worker مستقل · دسته‌های ۱٬۰۲۴تایی · رمزگذاری محدودشده پیش از ذخیره</p>
          </div>
          <button className="wallet-clear-all-button" type="button" onClick={() => void clearAllAppData()} disabled={poolBusy || matchingBusy || purgeBusy || revealing || startPending || deletingWallet || clearingAllData || databaseHealth?.healthy !== true} aria-busy={clearingAllData}>
            {clearingAllData ? <span className="spinner" aria-hidden="true"/> : <Icon name="trash-2" size={14}/>}
            <span>{clearingAllData ? 'در حال پاک‌سازی…' : 'پاک‌سازی کامل'}</span>
          </button>
        </div>

        {(poolStatus === 'initializing' || walletPageLoading || usageStatsLoading) && !clearingAllData && (
          <div className="wallet-init-progress" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true"/>
            <span>{databaseHealth === null ? 'در حال بررسی دیتابیس و بارگذاری اطلاعات…' : 'اطلاعات دریافت شد؛ در حال آماده‌سازی موتور امن…'}</span>
          </div>
        )}

        {clearingAllData && (
          <div className="wallet-operation-progress is-danger" role="status" aria-live="polite" aria-busy="true">
            <span className="spinner" aria-hidden="true"/>
            <div>
              <strong>پاک‌سازی کامل در حال انجام است</strong>
              <span>{clearStage === 'counting' ? 'در حال شمارش رکوردها و آماده‌سازی تراکنش امن…' : 'در حال حذف داده‌ها و ثبت نهایی تغییرات در دیتابیس…'}</span>
            </div>
            <div className="operation-progress-track"><span/></div>
          </div>
        )}

        <section className="wallet-usage-dashboard" aria-label="آمار عملکرد خزانه و تطبیق">
          <div className="wallet-usage-heading"><strong>آمار کلی عملکرد</strong><span>{usageStatsLoading ? 'در حال دریافت آمار…' : 'مجموع همه اجراهای قبلی و فعلی · ذخیره‌شده روی همین دستگاه'}</span></div>
          <div className="wallet-usage-grid" aria-live="polite">
            <div className="wallet-usage-stat"><strong>{formatNumber(usageStats?.generatedCount ?? 0)}</strong><span>ولت ساخته‌شده</span></div>
            <div className="wallet-usage-stat"><strong>{formatNumber(usageStats?.checkedAddressCount ?? 0)}</strong><span>مجموع آدرس‌های معتبر TXT در همه اجراها</span></div>
            <div className="wallet-usage-stat is-success"><strong>{formatNumber(usageStats?.matchedAddressCount ?? 0)}</strong><span>مجموع تطابق‌ها در همه اجراها</span></div>
            <div className="wallet-usage-stat"><strong>{formatNumber(usageStats?.unmatchedAddressCount ?? 0)}</strong><span>مجموع بدون تطابق در همه اجراها</span></div>
            <div className="wallet-usage-stat"><strong>{formatNumber(usageStats?.deletedWalletCount ?? 0)}</strong><span>ولت حذف‌شده</span></div>
            <div className="wallet-usage-stat is-success"><strong>{formatNumber(usageStats?.successfulWalletCount ?? 0)}</strong><span>ذخیره موفق</span></div>
            <div className="wallet-usage-stat"><strong>{formatNumber(walletTotal)}</strong><span>موجود در خزانه</span></div>
          </div>
          <div className="wallet-usage-footer">ذخیره‌نشده: {formatNumber(usageStats?.notStoredCount ?? 0)} <span>·</span> خطاهای پردازش: {formatNumber(usageStats?.failedOperationCount ?? 0)}</div>
        </section>

        <div className="wallet-run-actions wallet-run-actions-compact">
          <button className={poolStatus === 'running' ? 'stop-button' : 'primary-button'} type="button"
            onClick={() => poolStatus === 'running' ? stopGeneration() : startGeneration()}
            disabled={revealing || startPending || matchingBusy || purgeBusy || clearingAllData || deletingWallet || poolStatus === 'initializing' || poolStatus === 'stopping' || poolStatus === 'error' || (poolStatus !== 'running' && poolStatus !== 'ready' && poolStatus !== 'stopped')}
          >
            {poolStatus === 'running' ? <><Icon name="stop"/> توقف</> : startPending ? 'در حال ثبت وضعیت…' : <><Icon name="play"/> {checkpoint ? 'ادامه تولید' : 'شروع پیوسته'}</>}
          </button>
          <span className={`wallet-run-indicator ${poolStatus === 'running' ? 'is-running' : ''}`}><i/>{statusLabel}{generationRate > 0 && <small className="wallet-run-rate">≈ {formatNumber(generationRate, 1)} کیف‌پول/ثانیه{lastBatchDurationMs > 0 ? ` · آخرین دسته ${formatNumber(lastBatchDurationMs / 1_000, 1)} ثانیه` : ''}</small>}</span>
        </div>

        {checkpoint && (
          <div className="vault-checkpoint-note" role="status">
            <strong>{checkpoint.status === 'interrupted' ? 'اجرای قبلی پیش از تکمیل قطع شده بود' : checkpoint.status === 'paused' ? 'آخرین اجرا متوقف شده است' : 'وضعیت اجرای قبلی'}</strong>
            <span>{formatNumber(checkpoint.savedCount)} کیف‌پول در این اجرا به‌طور قطعی ذخیره شده است.</span>
            {checkpoint.duplicateCount > 0 && <small>{formatNumber(checkpoint.duplicateCount)} آدرس تکراری از ذخیره‌سازی رد شده است.</small>}
            {checkpoint.lastBatchAt && <small>آخرین ذخیره: {formatDate(checkpoint.lastBatchAt)}</small>}
          </div>
        )}

        <div className="vault-security-strip">
          <Icon name="shield" size={16}/>
          <span>کلید خصوصی داخل Worker با AES-256-GCM رمزگذاری و مستقیماً در IndexedDB ذخیره می‌شود؛ کلید خام به رابط کاربری ارسال نمی‌شود.</span>
        </div>
        {databaseHealth && (
          <div className={`vault-health-note ${databaseHealth.healthy ? '' : 'is-error'}`} role="status">
            <Icon name={databaseHealth.healthy ? 'check-circle' : 'alert-circle'} size={14}/>
            <span>{databaseHealth.message}</span>
          </div>
        )}
        {storagePersistence !== 'granted' && (
          <div className="vault-storage-warning" role="status">
            {storagePersistence === 'not-granted'
              ? 'مرورگر فضای ذخیره‌سازی پایدار را تضمین نکرده است؛ احتمال پاک‌شدن داده‌های محلی در شرایط فشار حافظه وجود دارد.'
              : 'این مرورگر API تضمین ماندگاری IndexedDB را ارائه نمی‌کند؛ داده‌های محلی ممکن است در شرایط خاص پاک شوند.'}
          </div>
        )}

        <AddressMatchPanel
          scope={scope}
          resetToken={matchingResetToken}
          disabled={databaseHealth?.healthy !== true || usageStats === null || clearingAllData || deletingWallet || poolBusy || startPending}
          generationActive={poolBusy || startPending}
          onBusyChange={handleMatchingBusyChange}
          onPurgeBusyChange={setPurgeBusy}
          onUsageStatsDelta={handleUsageStatsDelta}
          onOperationFailure={handleOperationFailure}
          onSelectWallet={openWallet}
          onNotify={onNotify}
          onVaultChanged={() => {
            void (async () => {
              try {
                const [stats] = await Promise.all([
                  getOrInitializeWalletUsageStats(),
                  refreshPage(0),
                ]);
                if (aliveRef.current) setUsageStats(stats);
              } catch (error) {
                onNotify(error instanceof Error ? error.message : 'به‌روزرسانی فهرست پس از پاک‌سازی ناموفق بود.', false);
              }
            })();
            setSelectedWalletId(null);
            setSelectedSummary(null);
            setRevealedWallet(null);
          }}
        />

        {selectedSummary && (
          <div className="wallet-result-card">
            <div className="wallet-result-head">
            <div><span className="seed-badge strong-badge">ENCRYPTED · AES-256-GCM</span><h2>اطلاعات کیف‌پول</h2></div>
            <button className="icon-button" type="button" onClick={() => void removeSelectedWallet()} disabled={poolBusy || matchingBusy || revealing || clearingAllData || deletingWallet} aria-label="حذف کیف‌پول" aria-busy={deletingWallet}>{deletingWallet ? <span className="spinner"/> : <Icon name="trash" size={16}/>}</button>
          </div>
          <div className="wallet-address-block"><span>آدرس عمومی دریافت TRON</span><div><code>{selectedSummary.address}</code><button className="icon-button" type="button" onClick={() => void copyAddress(selectedSummary.address)} aria-label="کپی آدرس"><Icon name="copy" size={16}/></button></div></div>
          <div className="wallet-address-block private-key-display"><span>کلید خصوصی · ذخیره‌شده به‌صورت رمزگذاری‌شده</span><div><code>{revealedWallet ? revealedWallet.privateKey : '•'.repeat(64)}</code></div></div>
          <div className="wallet-actions">
            {!revealedWallet
              ? <button className="secondary-button" type="button" onClick={() => void revealPrivateKey()} disabled={revealing || poolBusy || clearingAllData || deletingWallet}><Icon name="eye" size={16}/>{revealing ? 'در حال رمزگشایی…' : 'نمایش کلید خصوصی'}</button>
              : <button className="secondary-button" type="button" onClick={() => setRevealedWallet(null)}><Icon name="eye-off" size={16}/>مخفی‌کردن کلید</button>}
            <button className="secondary-button" type="button" onClick={() => void copyPrivateKey()} disabled={poolBusy || revealing || clearingAllData || deletingWallet}><Icon name="copy" size={16}/>کپی کلید خصوصی</button>
          </div>
          <p className="wallet-footnote">کلید خصوصی فقط هنگام درخواست نمایش یا کپی رمزگشایی می‌شود. پس از قفل‌شدن برنامه، Workerها خاتمه پیدا می‌کنند و دسترسی این نشست از بین می‌رود.</p>
        </div>
      )}

      {walletTotal > 0 && (
          <div className="wallet-batch-list-card">
            <div className="wallet-batch-list-head">
              <strong>کیف‌پول‌های ذخیره‌شده</strong>
              <span>{walletPageLoading ? <><span className="spinner"/> در حال بارگذاری…</> : `${formatNumber(walletTotal)} مورد`}</span>
            </div>
            <div className="wallet-batch-list">
              {wallets.map((wallet, index) => (
                <button key={wallet.id} type="button" className={`wallet-batch-item ${selectedWalletId === wallet.id ? 'selected' : ''}`} onClick={() => openWallet(wallet)} disabled={poolBusy || matchingBusy || revealing || clearingAllData || deletingWallet}>
                  <span>#{(walletTotal - walletPage * WALLETS_PER_PAGE - index).toLocaleString('fa-IR')} · {formatDate(wallet.createdAt)}</span>
                  <code>{wallet.address}</code>
                </button>
              ))}
            </div>
            <div className="wallet-pagination">
              <button className="secondary-button" type="button" onClick={() => void changePage(walletPage + 1)} disabled={walletPage >= pageCount - 1 || poolBusy || matchingBusy || revealing || walletPageLoading || clearingAllData || deletingWallet}>قدیمی‌تر</button>
              <span>صفحه {(walletPage + 1).toLocaleString('fa-IR')} از {pageCount.toLocaleString('fa-IR')}</span>
              <button className="secondary-button" type="button" onClick={() => void changePage(walletPage - 1)} disabled={walletPage === 0 || poolBusy || matchingBusy || revealing || walletPageLoading || clearingAllData || deletingWallet}>جدیدتر</button>
            </div>
          </div>
        )}
        {walletPageLoading && walletTotal === 0 && (
          <div className="wallet-list-loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true"/>
            <span>در حال خواندن کیف‌پول‌های ذخیره‌شده…</span>
          </div>
        )}
      </div>


      <p className="wallet-footnote">اطلاعات کیف‌پول در دیتابیس محلی همین دستگاه ذخیره می‌شود. کلید رمزگذاری در فضای امن بیومتریک تلگرام قرار دارد. پاک‌شدن توکن بیومتریک، داده‌های تلگرام یا IndexedDB می‌تواند دسترسی را برای همیشه از بین ببرد؛ Backup/Restore در این نسخه وجود ندارد.</p>
    </section>
  );
}
