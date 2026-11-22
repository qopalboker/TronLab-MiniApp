import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../version';
import { configureDatabaseScope, getVaultState, readVaultKeyCheck, writeVaultKeyCheck } from '../lib/localDb';
import { createVaultCheck, verifyVaultCheck } from '../lib/vaultCrypto';
import { shouldBlockVaultAccess } from '../lib/vaultAccessPolicy';
import { enrollBiometricVault, initializeBiometrics, unlockBiometricVault, type BiometricStatus } from '../lib/telegramBiometric';

interface Props {
  scope: string;
  webApp?: TelegramWebApp;
  onUnlock: (key: CryptoKey) => void;
}

export default function AccessGate({ scope, webApp, onUnlock }: Props) {
  const [manager, setManager] = useState<TelegramBiometricManager | null>(null);
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const [vaultWalletCount, setVaultWalletCount] = useState(0);
  const [vaultHasCheck, setVaultHasCheck] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unlockState, setUnlockState] = useState<'waiting' | 'running' | 'failed'>('waiting');
  const [error, setError] = useState('');
  const autoUnlockStartedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!scope || scope === 'local-preview' || !webApp) throw new Error('این برنامه فقط داخل Telegram Mini App قابل استفاده است.');
        configureDatabaseScope(scope);
        const [{ manager: biometricManager, status: biometricStatus }, vaultState] = await Promise.all([
          initializeBiometrics(webApp),
          getVaultState(),
        ]);
        if (!active) return;
        setManager(biometricManager);
        setStatus(biometricStatus);
        setVaultWalletCount(vaultState.walletCount);
        setVaultHasCheck(vaultState.hasKeyCheck);
        if (!biometricManager || !biometricStatus.supported) {
          setError('نسخه تلگرام از BiometricManager پشتیبانی نمی‌کند. برای حفظ امنیت، تولید کیف‌پول غیرفعال است.');
        } else if (!biometricStatus.available) {
          setError('روی این دستگاه اثر انگشت یا تشخیص چهره قابل استفاده نیست. تولید و ذخیره کیف‌پول غیرفعال است.');
        } else if (!biometricStatus.deviceId) {
          setError('شناسه امن دستگاه از تلگرام دریافت نشد؛ امکان بازکردن دیتابیس وجود ندارد.');
        } else if (!biometricStatus.tokenSaved && vaultState.walletCount > 0) {
          setError('توکن بیومتریک قبلی در تلگرام موجود نیست و دیتابیس کیف‌پول رمزگذاری‌شده دارد. برای جلوگیری از از دست‌رفتن داده‌ها، دسترسی مسدود شده است.');
        } else if (biometricStatus.tokenSaved && vaultState.walletCount > 0 && !vaultState.hasKeyCheck) {
          setError('دیتابیس کیف‌پول دارد اما رکورد بررسی کلید امن موجود نیست. برای جلوگیری از دسترسی با کلید اشتباه، دیتابیس قفل باقی می‌ماند.');
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'راه‌اندازی امنیت بیومتریک ناموفق بود.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [scope, webApp]);

  const handleUnlock = useCallback(async () => {
    if (!manager || !status || !status.available || busy) return;
    setBusy(true);
    setUnlockState('running');
    setError('');
    try {
      const currentState = await getVaultState();
      let key: CryptoKey;
      if (manager.isBiometricTokenSaved) {
        key = await unlockBiometricVault(manager, scope, {
          allowReEnrollmentWhenVaultEmpty: currentState.walletCount === 0,
        });
      } else {
        if (currentState.walletCount > 0) {
          throw new Error('کلید امن قبلی در فضای بیومتریک تلگرام موجود نیست؛ چون کیف‌پول رمزگذاری‌شده وجود دارد، بازنشانی مجاز نیست.');
        }
        key = await enrollBiometricVault(manager, scope);
      }

      const checkRecord = await readVaultKeyCheck({ allowMalformedWhenVaultEmpty: currentState.walletCount === 0 });
      if (checkRecord) {
        const verified = await verifyVaultCheck(key, scope, status.deviceId, checkRecord);
        if (!verified) {
          if (currentState.walletCount > 0) {
            throw new Error('کلید دریافتی از تلگرام با دیتابیس این دستگاه مطابقت ندارد. چون کیف‌پول ذخیره‌شده وجود دارد، کلید یا رکورد بررسی جایگزین نمی‌شود.');
          }
          // No encrypted wallet records exist, so it is safe to refresh only the
          // metadata check. Never do this once a wallet record has been stored.
          await writeVaultKeyCheck(await createVaultCheck(key, scope, status.deviceId));
        }
      } else {
        if (currentState.walletCount > 0) throw new Error('رکورد امن دیتابیس موجود نیست؛ ایجاد کلید جدید مجاز نیست.');
        await writeVaultKeyCheck(await createVaultCheck(key, scope, status.deviceId));
      }
      onUnlock(key);
    } catch (cause) {
      setStatus((current) => current && manager ? {
        ...current,
        accessRequested: Boolean(manager.isAccessRequested),
        tokenSaved: Boolean(manager.isBiometricTokenSaved),
        accessGranted: Boolean(manager.isAccessGranted),
      } : current);
      setUnlockState('failed');
      setError(cause instanceof Error ? cause.message : 'احراز هویت یا بازکردن دیتابیس ناموفق بود.');
    } finally {
      setBusy(false);
    }
  }, [busy, manager, onUnlock, scope, status]);

  const tokenSaved = manager ? Boolean(manager.isBiometricTokenSaved) : Boolean(status?.tokenSaved);
  const blocked = shouldBlockVaultAccess({
    managerPresent: Boolean(manager),
    supported: Boolean(status?.supported),
    available: Boolean(status?.available),
    deviceId: status?.deviceId,
    tokenSaved,
    walletCount: vaultWalletCount,
    hasKeyCheck: vaultHasCheck,
  });
  const buttonLabel = tokenSaved ? 'بازکردن دیتابیس با بیومتریک' : 'فعال‌سازی قفل بیومتریک و ساخت خزانه';

  // Start Telegram's native biometric prompt as soon as the Mini App has
  // initialized and the vault policy permits access. The ref prevents a second
  // prompt during React StrictMode's development effect replay.
  useEffect(() => {
    if (loading || !manager || !status || blocked || autoUnlockStartedRef.current) return;
    autoUnlockStartedRef.current = true;
    void handleUnlock();
  }, [blocked, handleUnlock, loading, manager, status]);

  function openBiometricSettings() {
    if (!manager) return;
    try {
      manager.openSettings();
      setError('دسترسی بیومتریک را در تنظیمات تلگرام فعال کن و Mini App را دوباره باز کن.');
    } catch {
      setError('بازکردن تنظیمات بیومتریک تلگرام ممکن نشد؛ برنامه را دوباره باز کن و مجدداً تلاش کن.');
    }
  }

  return (
    <main className="access-shell" dir="rtl">
      <span className="app-version access-version">v{APP_VERSION}</span>
      <section className="access-card">
        <div className="access-mark"><span>₮</span></div>
        <div className="eyebrow">TRON LAB · SECURE VAULT</div>
        <h1>خزانه امن ترون</h1>
        <p className="access-subtitle">کلیدهای خصوصی فقط پس از تأیید بیومتریک تلگرام قابل دسترسی هستند.</p>
        {loading ? (
          <div className="access-wait"><span className="spinner" />در حال بررسی تلگرام و دیتابیس امن…</div>
        ) : (
          <>
            <div className="biometric-caption">
              {status?.type === 'finger' ? 'روش شناسایی دستگاه: اثر انگشت' : status?.type === 'face' ? 'روش شناسایی دستگاه: تشخیص چهره' : 'روش شناسایی دستگاه: بیومتریک پشتیبانی‌شده'}
              <br />کلید AES-256 در فضای امن بیومتریک تلگرام نگهداری می‌شود؛ خود کلید خصوصی در IndexedDB رمزگذاری‌شده ذخیره خواهد شد.
            </div>
            {!blocked && status?.supported && status.available && unlockState !== 'failed' && (
              <div className="access-wait" role="status" aria-live="polite" aria-busy="true">
                <span className="spinner" />
                {busy ? 'در حال تأیید بیومتریک و بازکردن خزانه…' : 'در حال آماده‌سازی ورود بیومتریک خودکار…'}
              </div>
            )}
            {!blocked && status?.supported && status.available && unlockState === 'failed' && (
              <button className="biometric-button" type="button" onClick={() => void handleUnlock()} disabled={busy}>
                {busy ? <span className="spinner" /> : <span className="fingerprint-symbol">◎</span>}
                {busy ? 'در حال تأیید و بازکردن خزانه…' : buttonLabel}
              </button>
            )}
            {error && <div className="gate-error" role="alert">{error}</div>}
            {!blocked && status?.accessRequested && !status.accessGranted && unlockState === 'failed' && (
              <button className="secondary-button biometric-settings-button" type="button" onClick={openBiometricSettings}>
                بازکردن تنظیمات دسترسی بیومتریک
              </button>
            )}
            {blocked && <div className="biometric-caption">هیچ مسیر جایگزین PIN یا رمز عبور برای بازکردن دیتابیس وجود ندارد.</div>}
          </>
        )}
      </section>
    </main>
  );
}
