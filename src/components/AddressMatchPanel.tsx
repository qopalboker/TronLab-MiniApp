import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import type { AddressMatchPhase, AddressMatchSummary, AddressMatchingResponse, MatchSnapshotPayload, WalletScanProgressPayload } from '../lib/addressMatchingProtocol';
import {
  getTxtImportHistory,
  purgeUnmatchedWallets,
  registerTxtImportFile,
  updateTxtImportFileStatus,
  type WalletSummary,
  type PurgeUnmatchedProgress,
} from '../lib/localDb';
import type { WalletMatchSnapshot } from '../lib/walletAddressMatching';
import type { TxtImportRecord, TxtImportStatus } from '../lib/txtImportHistory';
import { hashTxtFile, MAX_TXT_FILE_BYTES } from '../lib/txtImportHistory';
import { hasSafeUnmatchedPurgeAnchor } from '../lib/walletAddressMatching';
import type { WalletUsageStatsDelta } from '../lib/walletUsageStats';
import { makeWalletMatchesCsv } from '../lib/walletMatchCsv';

interface Props {
  scope: string;
  resetToken: number;
  disabled: boolean;
  generationActive: boolean;
  onBusyChange: (busy: boolean) => void;
  onPurgeBusyChange: (busy: boolean) => void;
  onUsageStatsDelta: (delta: Pick<WalletUsageStatsDelta, 'checkedAddressCount' | 'matchedAddressCount' | 'unmatchedAddressCount' | 'deletedWalletCount'>) => void;
  onOperationFailure: () => void;
  onSelectWallet: (wallet: WalletSummary) => void;
  onNotify: (message: string, success?: boolean) => void;
  onVaultChanged: () => void;
}

const EMPTY_SUMMARY: AddressMatchSummary = {
  totalLines: 0, blankLines: 0, validUnique: 0, invalid: 0, duplicates: 0, matched: 0,
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat('fa-IR').format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function statusText(status: TxtImportStatus): string {
  if (status === 'completed') return 'تطبیق کامل شده';
  if (status === 'processing') return 'اجرای قبلی کامل نشده';
  if (status === 'cancelled') return 'اجرای قبلی متوقف شده';
  return 'اجرای قبلی با خطا متوقف شده';
}

export default function AddressMatchPanel({
  scope,
  resetToken,
  disabled,
  generationActive,
  onBusyChange,
  onPurgeBusyChange,
  onUsageStatsDelta,
  onOperationFailure,
  onSelectWallet,
  onNotify,
  onVaultChanged,
}: Props) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [fileAutoRun, setFileAutoRun] = useState(false);
  const [duplicateFile, setDuplicateFile] = useState<TxtImportRecord | null>(null);
  const [latestImported, setLatestImported] = useState<TxtImportRecord | null>(null);
  const [checkingFile, setCheckingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processedLines, setProcessedLines] = useState(0);
  const [matchPhase, setMatchPhase] = useState<AddressMatchPhase>('parsing');
  const [walletScanProgress, setWalletScanProgress] = useState<WalletScanProgressPayload | null>(null);
  const [summary, setSummary] = useState<AddressMatchSummary>(EMPTY_SUMMARY);
  const [matches, setMatches] = useState<WalletSummary[]>([]);
  const [complete, setComplete] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeProgress, setPurgeProgress] = useState<PurgeUnmatchedProgress | null>(null);
  const [lastSnapshot, setLastSnapshot] = useState<WalletMatchSnapshot | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef('');
  const matchesRef = useRef<WalletSummary[]>([]);
  const activeFileHashRef = useRef<string | null>(null);
  const fileSelectionRef = useRef(0);

  const persistFileStatus = useCallback((sha256: string, status: TxtImportStatus) => {
    void updateTxtImportFileStatus(sha256, status)
      .then((record) => setLatestImported((current) => !current || current.sha256 === sha256 ? record : current))
      .catch((error) => onNotify(error instanceof Error ? error.message : 'ثبت وضعیت فایل TXT ناموفق بود.', false));
  }, [onNotify]);

  const clearCurrentMatch = useCallback(() => {
    const activeHash = activeFileHashRef.current;
    if (activeHash) persistFileStatus(activeHash, 'cancelled');
    workerRef.current?.terminate();
    workerRef.current = null;
    runIdRef.current = '';
    activeFileHashRef.current = null;
    matchesRef.current = [];
    setBusy(false);
    setCancelRequested(false);
    setProcessedLines(0);
    setMatchPhase('parsing');
    setWalletScanProgress(null);
    setSummary(EMPTY_SUMMARY);
    setMatches([]);
    setComplete(false);
    setLastSnapshot(null);
    setPurging(false);
    setPurgeProgress(null);
    onBusyChange(false);
  }, [onBusyChange, persistFileStatus]);

  useEffect(() => () => {
    fileSelectionRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
    activeFileHashRef.current = null;
    onBusyChange(false);
  }, [onBusyChange]);

  useEffect(() => {
    fileSelectionRef.current += 1;
    clearCurrentMatch();
    setCheckingFile(false);
    setFile(null);
    setFileHash(null);
    setFileAutoRun(false);
    setDuplicateFile(null);
    setText('');
    onBusyChange(false);
  }, [resetToken, clearCurrentMatch, onBusyChange]);

  useEffect(() => {
    let active = true;
    void getTxtImportHistory()
      .then((history) => { if (active) setLatestImported(history.records[0] ?? null); })
      .catch((error) => { if (active) onNotify(error instanceof Error ? error.message : 'خواندن سابقه فایل‌های TXT ناموفق بود.', false); });
    return () => { active = false; };
  }, [scope, resetToken, onNotify]);

  const runMatch = useCallback((selectedFile: File | null, selectedText: string, selectedFileHash: string | null = null) => {
    if (disabled || !scope || (!selectedFile && !selectedText.trim())) return;
    if ((selectedFile && selectedFile.size > MAX_TXT_FILE_BYTES) || (!selectedFile && selectedText.length > MAX_TXT_FILE_BYTES)) {
      clearCurrentMatch();
      onNotify('حداکثر حجم ورودی TXT برابر با ۱۶ مگابایت است.', false);
      return;
    }

    const previousHash = activeFileHashRef.current;
    if (previousHash && previousHash !== selectedFileHash) persistFileStatus(previousHash, 'cancelled');
    workerRef.current?.terminate();
    workerRef.current = null;
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/address-matching.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      clearCurrentMatch();
      if (selectedFileHash) persistFileStatus(selectedFileHash, 'failed');
      onOperationFailure();
      onNotify('ساخت Worker تطبیق ممکن نشد؛ مرورگر یا سیاست امنیتی اجرا را مسدود کرده است.', false);
      return;
    }

    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    activeFileHashRef.current = selectedFileHash;
    matchesRef.current = [];
    setMatches([]);
    setSummary(EMPTY_SUMMARY);
    setProcessedLines(0);
    setMatchPhase('parsing');
    setWalletScanProgress(null);
    setComplete(false);
    setCancelRequested(false);
    setBusy(true);
    onBusyChange(true);
    workerRef.current = worker;

    const finishWorker = () => {
      if (workerRef.current === worker) workerRef.current = null;
      if (activeFileHashRef.current === selectedFileHash) activeFileHashRef.current = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<AddressMatchingResponse>) => {
      const message = event.data;
      if (message.id !== runIdRef.current || workerRef.current !== worker) return;
      if (message.type === 'match-progress') {
        setSummary(message.summary);
        setProcessedLines(message.processedLines);
        if (message.phase) setMatchPhase(message.phase);
        if (message.walletScan) setWalletScanProgress(message.walletScan);
        if (message.usageDelta) onUsageStatsDelta(message.usageDelta);
      } else if (message.type === 'match-batch') {
        for (const match of message.matches) matchesRef.current.push(match);
        setMatches(matchesRef.current.slice(0, 100));
      } else if (message.type === 'match-complete') {
        setSummary(message.summary);

        setComplete(true);
        setBusy(false);
        setCancelRequested(false);
        onBusyChange(false);
        if (!message.cancelled && message.snapshot) {
          const payload: MatchSnapshotPayload = message.snapshot;
          setLastSnapshot({
            newestCreatedAt: payload.newestCreatedAt,
            newestCreatedAtWalletIds: new Set(payload.newestCreatedAtWalletIds),
          });
        } else {
          setLastSnapshot(null);
        }
        if (selectedFileHash) persistFileStatus(selectedFileHash, message.cancelled ? 'cancelled' : 'completed');
        finishWorker();
        onNotify(message.cancelled
          ? `تطبیق این ورودی متوقف شد؛ ${formatNumber(message.summary.validUnique)} آدرس معتبر تا این لحظه بررسی شد.`
          : `تطبیق این ورودی کامل شد: ${formatNumber(message.summary.matched)} تطابق از ${formatNumber(message.summary.validUnique)} آدرس معتبر.`);
      } else if (message.type === 'error') {
        setBusy(false);
        setCancelRequested(false);
        onBusyChange(false);
        if (selectedFileHash) persistFileStatus(selectedFileHash, 'failed');
        finishWorker();
        onOperationFailure();
        onNotify(message.message, false);
      }
    };
    worker.onerror = () => {
      if (workerRef.current !== worker) return;
      setBusy(false);
      setCancelRequested(false);
      onBusyChange(false);
      if (selectedFileHash) persistFileStatus(selectedFileHash, 'failed');
      finishWorker();
      onOperationFailure();
      onNotify('Worker تطبیق با خطای غیرمنتظره متوقف شد.', false);
    };

    try {
      if (selectedFile) {
        worker.postMessage({ id: runId, type: 'match-file', scope, file: selectedFile });
      } else {
        worker.postMessage({ id: runId, type: 'match-text', scope, text: selectedText });
      }
    } catch {
      setBusy(false);
      setCancelRequested(false);
      onBusyChange(false);
      if (selectedFileHash) persistFileStatus(selectedFileHash, 'failed');
      finishWorker();
      onOperationFailure();
      onNotify('ارسال فایل یا متن به Worker تطبیق ناموفق بود؛ ورودی را بررسی و دوباره تلاش کن.', false);
    }
  }, [clearCurrentMatch, disabled, onBusyChange, onNotify, onOperationFailure, onUsageStatsDelta, persistFileStatus, scope]);

  const handleFileSelection = useCallback(async (selected: File) => {
    const selectionId = ++fileSelectionRef.current;
    clearCurrentMatch();
    setFile(null);
    setFileHash(null);
    setFileAutoRun(false);
    setDuplicateFile(null);
    setText('');

    if (selected.size > MAX_TXT_FILE_BYTES) {
      onNotify('حداکثر حجم ورودی TXT برابر با ۱۶ مگابایت است.', false);
      return;
    }

    setCheckingFile(true);
    onBusyChange(true);
    try {
      const sha256 = await hashTxtFile(selected);
      if (selectionId !== fileSelectionRef.current) return;
      const registration = await registerTxtImportFile({
        sha256,
        fileName: selected.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'addresses.txt',
        sizeBytes: selected.size,
      });
      if (selectionId !== fileSelectionRef.current) return;
      setFile(selected);
      setFileHash(sha256);
      setLatestImported(registration.record);
      if (registration.duplicate) {
        setDuplicateFile(registration.record);
        setFileAutoRun(false);
        onNotify('این فایل قبلاً وارد شده است؛ برای جلوگیری از تطبیق تکراری، اجرای خودکار انجام نشد. در صورت نیاز «تطبیق مجدد» را بزن.', true);
      } else {
        setDuplicateFile(null);
        setFileAutoRun(true);
        onNotify('فایل جدید ثبت شد؛ تطبیق خودکار آغاز می‌شود. فقط اثرانگشت و نام فایل نگهداری می‌شود، نه محتوای TXT.');
      }
    } catch (error) {
      if (selectionId === fileSelectionRef.current) {
        setFile(null);
        setFileHash(null);
        setFileAutoRun(false);
        onNotify(error instanceof Error ? error.message : 'بررسی فایل TXT ناموفق بود.', false);
      }
    } finally {
      if (selectionId === fileSelectionRef.current) {
        setCheckingFile(false);
        onBusyChange(false);
      }
    }
  }, [clearCurrentMatch, onBusyChange, onNotify]);

  useEffect(() => {
    if (disabled || checkingFile) return;
    if (file) {
      if (!fileAutoRun) return;
      const timeout = window.setTimeout(() => runMatch(file, '', fileHash), 0);
      return () => window.clearTimeout(timeout);
    }
    if (!text.trim()) {
      clearCurrentMatch();
      return;
    }
    const timeout = window.setTimeout(() => runMatch(null, text), 550);
    return () => window.clearTimeout(timeout);
  }, [file, fileHash, fileAutoRun, text, disabled, checkingFile, runMatch, clearCurrentMatch]);

  function handleTextChange(value: string) {
    fileSelectionRef.current += 1;
    // Stop any previous Worker before releasing the busy lock; otherwise a
    // pending 550 ms debounce could leave two matching runs overlapping.
    clearCurrentMatch();
    setCheckingFile(false);
    setText(value);
    setFile(null);
    setFileHash(null);
    setFileAutoRun(false);
    setDuplicateFile(null);
  }

  async function rerunKnownFile() {
    if (!file || !fileHash || busy || disabled) return;
    try {
      const updated = await updateTxtImportFileStatus(fileHash, 'processing');
      setLatestImported(updated);
      setDuplicateFile(null);
      setFileAutoRun(false);
      runMatch(file, '', fileHash);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'ثبت اجرای مجدد فایل ناموفق بود.', false);
    }
  }

  function cancelMatch() {
    if (!busy || cancelRequested) return;
    try {
      workerRef.current?.postMessage({ id: runIdRef.current, type: 'cancel' });
      setCancelRequested(true);
    } catch {
      onNotify('ارسال فرمان توقف به Worker ناموفق بود؛ پردازش با بستن Worker متوقف می‌شود.', false);
      clearCurrentMatch();
    }
  }

  function exportMatches() {
    if (matchesRef.current.length === 0) return;
    const blob = new Blob([makeWalletMatchesCsv(matchesRef.current)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'tron-lab-address-matches.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    onNotify('فایل CSV تطابق‌ها آماده شد.');
  }

  async function handlePurgeUnmatched() {
    if (!complete || !lastSnapshot || busy || purging || disabled || generationActive) return;
    if (!lastSnapshot.newestCreatedAt) {
      onNotify('هیچ کیف‌پولی در محدوده این تطبیق وجود نداشت.', false);
      return;
    }

    const matchedIdSet = new Set(matchesRef.current.map((w) => w.id));
    if (!hasSafeUnmatchedPurgeAnchor(lastSnapshot, matchedIdSet)) {
      onNotify('هیچ کیف‌پول منطبقی برای حفظ وجود ندارد؛ برای جلوگیری از حذف ناخواسته کل خزانه، پاک‌سازی بدون‌تطابق‌ها متوقف شد. بررسی کن TXT شامل آدرس‌های همین خزانه باشد.', false);
      return;
    }
    const firstConfirm = window.confirm(
      'این عملیات تمام کیف‌پول‌هایی را که در لحظه شروع این تطبیق وجود داشتند و با هیچ آدرس هدفی منطبق نشدند، برای همیشه حذف می‌کند.\n\n'
      + `فقط ${formatNumber(matchedIdSet.size)} کیف‌پول تطبیق‌یافته باقی می‌ماند.\n\n`
      + 'این عمل برگشت‌پذیر نیست. آیا ادامه می‌دهی؟',
    );
    if (!firstConfirm) return;

    const secondConfirm = window.confirm(
      'تأیید نهایی: کیف‌پول‌های بدون تطابق حذف شوند و فضای ذخیره‌سازی آزاد شود؟',
    );
    if (!secondConfirm) return;

    setPurging(true);
    setPurgeProgress({ phase: 'scanning', scannedCount: 0, scanTotal: 0, deletedCount: 0, keptCount: matchedIdSet.size });
    onBusyChange(true);
    onPurgeBusyChange(true);
    let reportedDeletedCount = 0;
    const reportPurgeProgress = (progress: PurgeUnmatchedProgress) => {
      setPurgeProgress(progress);
      const newlyDeleted = progress.deletedCount - reportedDeletedCount;
      if (newlyDeleted > 0) {
        reportedDeletedCount = progress.deletedCount;
        // The database transaction has committed this batch, so the dashboard
        // counter can be updated immediately without waiting for the full scan.
        onUsageStatsDelta({ deletedWalletCount: newlyDeleted });
      }
    };
    try {
      const result = await purgeUnmatchedWallets(lastSnapshot, matchedIdSet, reportPurgeProgress);
      // Stats are already written inside the purge transactions; parent refreshes
      // inventory + reloads aggregate stats via onVaultChanged.
      onVaultChanged();
      setLastSnapshot(null);
      onNotify(
        result.deletedCount === 0
          ? 'هیچ کیف‌پول بدون تطابقی برای حذف پیدا نشد.'
          : `${formatNumber(result.deletedCount)} کیف‌پول بدون تطابق حذف شد؛ ${formatNumber(result.keptCount)} مورد تطبیق‌یافته باقی ماند.`,
        true,
      );
    } catch (error) {
      if (reportedDeletedCount > 0) onVaultChanged();
      onOperationFailure();
      onNotify(error instanceof Error ? error.message : 'حذف کیف‌پول‌های بدون تطابق ناموفق بود.', false);
    } finally {
      setPurging(false);
      setPurgeProgress(null);
      onPurgeBusyChange(false);
      onBusyChange(false);
    }
  }

  const purgePercent = purgeProgress
    ? (purgeProgress.scanTotal > 0 ? Math.min(100, Math.round((purgeProgress.scannedCount / purgeProgress.scanTotal) * 100)) : 0)
    : 0;

  const displayedFileName = file?.name ?? latestImported?.fileName ?? null;
  const canPurge = complete && !!lastSnapshot && hasSafeUnmatchedPurgeAnchor(lastSnapshot, new Set(matchesRef.current.map((wallet) => wallet.id))) && !busy && !purging && !disabled && !generationActive;

  return (
    <section className="address-match-card">
      <div className="card-heading">
        <div className="icon-tile"><Icon name="list-checks" size={20}/></div>
        <div><h2>تطبیق آدرس‌های عمومی (Watch-only)</h2><p>TXT یک‌بار به مجموعه آدرس‌های یکتا تبدیل می‌شود؛ برای فهرست‌های کوچک جست‌وجوی مستقیم و برای فایل‌های بزرگ پیمایش یک‌باره شاخص استفاده می‌شود. کلید خصوصی رمزگشایی نمی‌شود؛ برای snapshot ثابت، هنگام تطبیق تولید باید متوقف باشد.</p></div>
      </div>

      <label className={`match-file-picker ${checkingFile ? 'is-checking' : ''}`}>
        <Icon name="file-text" size={17}/>
        <span>{checkingFile ? 'در حال بررسی فایل…' : displayedFileName ?? 'انتخاب فایل TXT'}</span>
        <input type="file" accept=".txt,text/plain" disabled={disabled || checkingFile || purging} onChange={(event: { currentTarget: HTMLInputElement }) => { const input = event.currentTarget; const selected = input.files?.[0] ?? null; input.value = ''; if (selected) void handleFileSelection(selected); }}/>
      </label>

      {latestImported && (
        <div className="txt-import-retained" role="status">
          <Icon name="file-check" size={15}/>
          <span><strong>سابقه فایل نگهداری شده:</strong> {latestImported.fileName} · {statusText(latestImported.status)} · {formatDate(latestImported.lastAttemptAt)}</span>
        </div>
      )}

      {duplicateFile && file && (
        <div className="txt-import-duplicate" role="alert">
          <span>این فایل با همین محتوای دقیق قبلاً وارد شده است. اجرای خودکار متوقف شد تا ناخواسته دوباره شمرده یا تطبیق داده نشود.</span>
          <button className="secondary-button" type="button" onClick={() => void rerunKnownFile()} disabled={busy || disabled}><Icon name="refresh-cw" size={14}/> تطبیق مجدد همین فایل</button>
        </div>
      )}

      <div className="address-match-divider"><span>یا آدرس‌ها را مستقیم وارد کن</span></div>
      <textarea className="address-textarea address-match-textarea" value={text} onChange={(event: { currentTarget: HTMLTextAreaElement }) => handleTextChange(event.currentTarget.value)} placeholder="هر خط یک آدرس عمومی TRON… (فایل TXT با UTF-8)؛ پس از Paste، تطبیق خودکار شروع می‌شود" rows={4} maxLength={MAX_TXT_FILE_BYTES} spellCheck={false} disabled={disabled || checkingFile || purging}/>

      <div className="address-match-actions">
        {busy && (
          <button className="stop-button" type="button" onClick={cancelMatch} disabled={cancelRequested}>
            <Icon name="stop" size={16}/>{cancelRequested ? 'در حال توقف…' : 'توقف تطبیق'}
          </button>
        )}
        {complete && matchesRef.current.length > 0 && <button className="secondary-button" type="button" onClick={exportMatches}><Icon name="download" size={16}/> خروجی CSV</button>}
        {canPurge && (
          <button
            className="stop-button"
            type="button"
            onClick={() => void handlePurgeUnmatched()}
            disabled={purging || generationActive}
            title={generationActive ? 'ابتدا تولید را متوقف کن' : 'حذف کیف‌پول‌های بدون تطابق برای آزاد کردن فضا'}
          >
            {purging ? <span className="spinner" aria-hidden="true"/> : <Icon name="trash-2" size={16}/>}
            {purging ? 'در حال پاک‌سازی…' : 'حذف بدون‌تطابق‌ها (آزادسازی فضا)'}
          </button>
        )}
        {busy && <span className="muted-caption">پیمایش خزانه در حال انجام است؛ شروع تولید تا پایان تطبیق غیرفعال است</span>}
        {generationActive && !busy && (
          <span className="muted-caption">برای شروع تطبیق، ابتدا تولید را متوقف کن</span>
        )}
        {generationActive && complete && lastSnapshot && (
          <span className="muted-caption">برای پاک‌سازی بدون‌تطابق‌ها نیز ابتدا تولید را متوقف کن</span>
        )}
      </div>

      {purging && purgeProgress && (
        <div className="purge-progress-panel" role="status" aria-live="polite" aria-busy="true">
          <div className="purge-progress-heading">
            <strong>{purgeProgress.phase === 'scanning' ? 'در حال بررسی رکوردهای خزانه' : 'دسته حذف با موفقیت ثبت شد'}</strong>
            <span>{formatNumber(purgePercent)}٪</span>
          </div>
          <div className="purge-progress-track"><span style={{ width: `${purgePercent}%` }}/></div>
          <div className="purge-progress-caption">
            {`${formatNumber(purgeProgress.scannedCount)} از ${formatNumber(purgeProgress.scanTotal)} رکورد بررسی شد`}
            <span>{`${formatNumber(purgeProgress.deletedCount)} کیف‌پول حذف قطعی`}</span>
            <span>{formatNumber(purgeProgress.keptCount)} مورد منطبق حفظ می‌شود</span>
          </div>
        </div>
      )}

      {busy && (
        <div className="address-match-progress" role="status" aria-live="polite" aria-busy="true">
          <span className="spinner"/>
          {matchPhase === 'parsing' ? (
            <span>خواندن TXT: {formatNumber(processedLines)} خط · {formatNumber(summary.validUnique)} آدرس معتبر</span>
          ) : (
            <span>{walletScanProgress?.scanMode === 'direct-lookups' ? 'جست‌وجوی مستقیم آدرس‌های TXT در شاخص خزانه' : walletScanProgress?.scanMode === 'index-scan' ? 'پیمایش شاخص آدرس خزانه' : 'آماده‌سازی روش تطبیق'}: {formatNumber(walletScanProgress?.scannedCount ?? 0)} از {formatNumber(walletScanProgress?.totalCount ?? 0)}</span>
          )}
          <strong>{formatNumber(summary.matched)} تطابق</strong>
          {matchPhase === 'scanning-vault' && walletScanProgress && walletScanProgress.totalCount > 0 && (
            <div className="address-match-scan-progress">
              <div className="purge-progress-track">
                <span style={{ width: `${Math.min(100, Math.round((walletScanProgress.scannedCount / walletScanProgress.totalCount) * 100))}%` }}/>
              </div>
              <span>{formatNumber(walletScanProgress.matchedWalletCount)} کیف‌پول منطبق شناسایی‌شده</span>
            </div>
          )}
        </div>
      )}

      {(complete || summary.totalLines > 0) && (
        <div className="address-match-current-result" aria-live="polite">
          <div className="address-match-current-heading">
            <strong>نتیجه همین ورودی</strong>
            <span>{complete ? 'این اعداد فقط مربوط به آخرین اجرا هستند' : 'در حال پردازش ورودی فعلی'}</span>
          </div>
          <div className="address-match-stats">
            <div><strong>{formatNumber(summary.totalLines)}</strong><span>خط خوانده‌شده</span></div>
            <div><strong>{formatNumber(summary.validUnique)}</strong><span>آدرس معتبر یکتا</span></div>
            <div><strong>{formatNumber(summary.matched)}</strong><span>منطبق در همین اجرا</span></div>
            <div><strong>{formatNumber(Math.max(0, summary.validUnique - summary.matched))}</strong><span>بدون تطابق در همین اجرا</span></div>
            <div><strong>{formatNumber(summary.invalid)}</strong><span>نامعتبر</span></div>
            <div><strong>{formatNumber(summary.duplicates)}</strong><span>تکراری در TXT</span></div>
          </div>
        </div>
      )}

      {matches.length > 0 && (
        <div className="address-match-results">
          <div className="wallet-batch-list-head"><strong>کیف‌پول‌های تطبیق‌یافته</strong><span>{formatNumber(summary.matched)} مورد</span></div>
          {matches.map((wallet) => (
            <button className="address-match-result" key={wallet.id} type="button" onClick={() => onSelectWallet(wallet)} disabled={disabled}>
              <code>{wallet.address}</code><span>نمایش جزئیات <Icon name="chevron-left" size={13}/></span>
            </button>
          ))}
          {summary.matched > matches.length && <p className="muted-caption">برای سبک‌ماندن رابط، فقط ۱۰۰ مورد اول نمایش داده می‌شود؛ خروجی CSV شامل همه تطابق‌ها است.</p>}
        </div>
      )}

      {!busy && complete && summary.matched === 0 && (
        <p className="muted-caption">
          هیچ‌یک از آدرس‌های معتبر فایل در کیف‌پول‌های موجود هنگام شروع این بررسی پیدا نشد. برای جلوگیری از حذف اشتباهی همه کیف‌پول‌ها، عملیات «حذف بدون‌تطابق‌ها» در حالت صفر تطابق غیرفعال است. فایل TXT باید شامل آدرس‌های عمومی همین خزانه باشد؛ تولید تصادفی کیف‌پول، آدرس‌های دلخواه فایل را بازتولید نمی‌کند.
        </p>
      )}
      {!busy && complete && lastSnapshot && summary.matched > 0 && (
        <p className="muted-caption">
          پس از تطبیق موفق می‌توانی کیف‌پول‌های بدون تطابق را حذف کنی تا فقط موارد منطبق باقی بمانند و فضای ذخیره‌سازی آزاد شود.
        </p>
      )}
      <div className="note-card address-match-note">
        <Icon name="shield" size={15}/>
        <span>
          فقط نام فایل، اندازه و اثرانگشت SHA-256 برای جلوگیری از بارگذاری تکراری ذخیره می‌شود؛
          محتوای TXT و آدرس‌های بدون تطابق ذخیره نمی‌شوند. سابقه ۵۰ فایل اخیر نگهداری می‌شود.
          این بررسی فقط با آدرس‌های عمومی موجود در خزانه انجام می‌شود؛ برای رکوردهای نامنطبق فقط کلید شاخص خوانده می‌شود و داده رمزگذاری‌شده آن‌ها باز نمی‌شود. نتیجه تطبیق، به‌تنهایی هیچ کیف‌پولی را تغییر یا حذف نمی‌کند. حذف بدون‌تطابق‌ها فقط با فرمان مستقل و تأییدهای جداگانه انجام می‌شود.
        </span>
      </div>
    </section>
  );
}
