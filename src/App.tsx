import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AccessGate from './components/AccessGate';
import WalletCreationPanel from './components/WalletCreationPanel';
import Icon from './components/Icon';
import { APP_VERSION } from './version';
import { getVaultSessionRemainingMs, isVaultSessionExpired } from './lib/vaultSession';

const BenchmarkPanel = lazy(() => import('./components/BenchmarkPanel'));
type AppTheme = 'dark' | 'light';

interface VaultSession {
  key: CryptoKey;
  scope: string;
}

export default function App() {
  const webApp = useMemo(() => window.Telegram?.WebApp, []);
  const scope = webApp?.initDataUnsafe?.user?.id ? String(webApp.initDataUnsafe.user.id) : '';
  const [theme, setTheme] = useState<AppTheme>(() => {
    try {
      const saved = window.localStorage.getItem('tron-lab-theme-v1');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // Theme is not sensitive; use Telegram's theme if storage is unavailable.
    }
    return webApp?.colorScheme === 'light' ? 'light' : 'dark';
  });
  const [session, setSession] = useState<VaultSession | null>(null);
  const lastActivityAtRef = useRef(0);
  const [toast, setToast] = useState('');
  const [showBenchmark, setShowBenchmark] = useState(false);

  const notify = useCallback((message: string, success = true) => {
    setToast(message);
    webApp?.HapticFeedback?.notificationOccurred(success ? 'success' : 'error');
  }, [webApp]);

  const onUnlock = useCallback((key: CryptoKey) => {
    if (!scope) throw new Error('شناسه حساب تلگرام در دسترس نیست؛ خزانه باز نشد.');
    if (document.visibilityState !== 'visible') throw new Error('برنامه در پیش‌زمینه نیست؛ پس از بازگشت به تلگرام دوباره احراز هویت کن.');
    lastActivityAtRef.current = performance.now();
    setSession({ key, scope });
  }, [scope]);

  useEffect(() => {
    webApp?.ready();
    webApp?.expand();
  }, [webApp]);

  useEffect(() => {
    if (!session) return;

    let timeoutId = 0;
    let active = true;

    const lockIfExpired = () => {
      if (!active) return;
      const now = performance.now();
      if (isVaultSessionExpired(lastActivityAtRef.current, now)) {
        active = false;
        window.clearTimeout(timeoutId);
        setSession(null);
        return;
      }
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(lockIfExpired, getVaultSessionRemainingMs(lastActivityAtRef.current, now));
    };

    const recordActivity = () => {
      if (!active) return;
      const now = performance.now();
      // Do not let an interaction after expiry revive an old authenticated session.
      if (isVaultSessionExpired(lastActivityAtRef.current, now)) {
        lockIfExpired();
        return;
      }
      lastActivityAtRef.current = now;
      lockIfExpired();
    };

    const onVisibilityChange = () => {
      // Opening Android's document picker temporarily hides the WebView. Keep the
      // authenticated page mounted and only enforce the idle deadline on return.
      if (document.visibilityState === 'visible') lockIfExpired();
    };

    const onPageShow = () => lockIfExpired();
    const activityEvents: Array<keyof DocumentEventMap> = [
      'pointerdown', 'keydown', 'input', 'change', 'touchstart', 'wheel', 'scroll',
    ];
    for (const eventName of activityEvents) {
      document.addEventListener(eventName, recordActivity, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    lockIfExpired();

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      for (const eventName of activityEvents) {
        document.removeEventListener(eventName, recordActivity, true);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [session]);

  useEffect(() => {
    const background = theme === 'dark' ? '#101820' : '#f3f6f7';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
    try { window.localStorage.setItem('tron-lab-theme-v1', theme); } catch { /* ignore theme persistence failure */ }
    webApp?.setHeaderColor(background);
    webApp?.setBackgroundColor(background);
  }, [theme, webApp]);

  if (!session) return <AccessGate scope={scope} webApp={webApp} onUnlock={onUnlock} />;

  return (
    <main className="app-shell" dir="rtl">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark">₮</div>
          <div className="brand-copy">
            <div className="brand-title-line">
              <span className="brand-title">TRON Lab</span>
              <span className="app-version" aria-label={`نسخه ${APP_VERSION}`}>v{APP_VERSION}</span>
            </div>
            <div className="brand-subtitle">تولیدکننده محلی کیف‌پول ترون</div>
          </div>
        </div>
        <div className="header-actions">
          {!showBenchmark && <button className="benchmark-toggle" type="button" onClick={() => setShowBenchmark(true)} aria-label="بازکردن آزمایش عملکرد"><Icon name="activity" size={15}/><span>آزمایش سرعت</span></button>}
          <div className="local-pill"><span /> رمزگذاری‌شده</div>
          <button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'فعال‌کردن حالت روشن' : 'فعال‌کردن حالت تاریک'} aria-pressed={theme === 'light'} title={theme === 'dark' ? 'حالت روشن' : 'حالت تاریک'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          <button className="header-lock-button" type="button" onClick={() => { setShowBenchmark(false); setSession(null); }} aria-label="قفل‌کردن خزانه">قفل خزانه</button>
        </div>
      </header>

      <div className="content-area">
        {showBenchmark
          ? <Suspense fallback={<div className="benchmark-loading">در حال بارگذاری ابزار آزمایش…</div>}><BenchmarkPanel onBack={() => setShowBenchmark(false)} /></Suspense>
          : <WalletCreationPanel onNotify={notify} vaultKey={session.key} scope={session.scope} />}
      </div>

      <footer className="app-footer"><span>TRON · ENCRYPTED PRIVATE KEY VAULT</span><span>LOCAL ONLY</span></footer>
      {toast && <div className="toast" role="status" aria-live="polite"><span>{toast}</span><button type="button" onClick={() => setToast('')} aria-label="بستن پیام"><Icon name="close" size={15} /></button></div>}
    </main>
  );
}
