import { createVaultToken, importVaultKeyFromToken, InvalidVaultTokenError, VaultTokenScopeError } from './vaultCrypto';

export interface BiometricStatus {
  supported: boolean;
  available: boolean;
  accessGranted: boolean;
  accessRequested: boolean;
  tokenSaved: boolean;
  deviceId: string;
  type: 'finger' | 'face' | 'unknown';
}

const TELEGRAM_CALLBACK_TIMEOUT_MS = 15_000;

function getManager(webApp?: TelegramWebApp): TelegramBiometricManager | null {
  if (!webApp?.BiometricManager) return null;
  if (webApp.isVersionAtLeast && !webApp.isVersionAtLeast('7.2')) return null;
  return webApp.BiometricManager;
}

const unsupportedStatus: BiometricStatus = {
  supported: false,
  available: false,
  accessGranted: false,
  accessRequested: false,
  tokenSaved: false,
  deviceId: '',
  type: 'unknown',
};

function callbackResult<T>(
  invoke: (callback: (value: T) => void) => unknown,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, TELEGRAM_CALLBACK_TIMEOUT_MS);

    try {
      invoke((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

export async function initializeBiometrics(webApp?: TelegramWebApp): Promise<{ manager: TelegramBiometricManager | null; status: BiometricStatus }> {
  const manager = getManager(webApp);
  if (!manager) return { manager: null, status: unsupportedStatus };

  if (!manager.isInited) {
    await callbackResult<void>(
      (callback) => manager.init(callback),
      'تلگرام در مهلت مقرر وضعیت بیومتریک را ارسال نکرد؛ Mini App را دوباره باز کن.',
    );
  }

  return {
    manager,
    status: {
      supported: true,
      available: Boolean(manager.isBiometricAvailable),
      accessGranted: Boolean(manager.isAccessGranted),
      accessRequested: Boolean(manager.isAccessRequested),
      tokenSaved: Boolean(manager.isBiometricTokenSaved),
      deviceId: manager.deviceId || '',
      type: manager.biometricType || 'unknown',
    },
  };
}

export function requestBiometricAccess(manager: TelegramBiometricManager): Promise<boolean> {
  if (manager.isAccessGranted) return Promise.resolve(true);
  return callbackResult<boolean>(
    (callback) => manager.requestAccess(
      { reason: 'برای محافظت از کلیدهای خصوصی کیف‌پول ترون، دسترسی بیومتریک لازم است.' },
      callback,
    ),
    'پاسخی از پنجره مجوز بیومتریک تلگرام دریافت نشد.',
  );
}

function updateBiometricToken(manager: TelegramBiometricManager, token: string): Promise<boolean> {
  return callbackResult<boolean>(
    (callback) => manager.updateBiometricToken(token, callback),
    'ذخیره توکن در فضای امن تلگرام پاسخ نداد.',
  );
}

function authenticate(manager: TelegramBiometricManager): Promise<{ authenticated: boolean; token?: string }> {
  return callbackResult<{ authenticated: boolean; token?: string }>(
    (callback) => manager.authenticate(
      { reason: 'برای بازکردن دیتابیس رمزگذاری‌شده TRON هویت خود را تأیید کن.' },
      (authenticated, token) => callback({ authenticated, token }),
    ),
    'درخواست احراز هویت بیومتریک از تلگرام پاسخی دریافت نکرد.',
  );
}

/** Creates a random AES-256 key token and stores it only in Telegram's biometric secure storage. */
export async function enrollBiometricVault(manager: TelegramBiometricManager, scope: string): Promise<CryptoKey> {
  const granted = await requestBiometricAccess(manager);
  if (!granted) throw new Error('اجازه استفاده از بیومتریک تلگرام داده نشد.');

  const token = createVaultToken(scope);
  const updated = await updateBiometricToken(manager, token);
  if (!updated) throw new Error('تلگرام نتوانست کلید رمزگذاری را در فضای امن دستگاه ذخیره کند.');

  // Saving a token is not itself proof of biometric identity. Immediately request
  // a native biometric confirmation and use only the token returned by Telegram.
  const confirmation = await authenticate(manager);
  if (!confirmation.authenticated || !confirmation.token || confirmation.token !== token) {
    // The authentication request has completed, so this cleanup is not concurrent
    // with another biometric operation.
    await updateBiometricToken(manager, '');
    throw new Error('تأیید بیومتریک اولیه ناموفق بود؛ توکن موقت از فضای امن تلگرام پاک شد.');
  }
  return importVaultKeyFromToken(confirmation.token, scope);
}

/** Retrieves the AES key only after Telegram confirms biometric authentication. */
export async function unlockBiometricVault(
  manager: TelegramBiometricManager,
  scope: string,
  options: { allowReEnrollmentWhenVaultEmpty?: boolean } = {},
): Promise<CryptoKey> {
  const granted = await requestBiometricAccess(manager);
  if (!granted) throw new Error('اجازه دسترسی بیومتریک فعال نیست.');
  if (!manager.isBiometricTokenSaved) throw new Error('کلید امن در فضای بیومتریک تلگرام پیدا نشد.');

  const result = await authenticate(manager);
  if (!result.authenticated) throw new Error('تأیید اثر انگشت یا چهره ناموفق بود.');

  try {
    if (typeof result.token !== 'string' || result.token.length === 0) {
      throw new InvalidVaultTokenError('تلگرام پس از احراز هویت، توکن ذخیره‌شده‌ای برنگرداند.');
    }
    return await importVaultKeyFromToken(result.token, scope);
  } catch (error) {
    const replaceable = error instanceof InvalidVaultTokenError || error instanceof VaultTokenScopeError;
    if (!replaceable) throw error;
    if (!options.allowReEnrollmentWhenVaultEmpty) {
      throw new Error('توکن ذخیره‌شده در تلگرام با کلید این خزانه سازگار نیست. چون دیتابیس اطلاعات دارد، برای جلوگیری از قفل‌شدن دائمی کیف‌پول‌ها توکن جایگزین نشد.');
    }
  }

  // Telegram may still hold a token from an interrupted/older empty-vault setup.
  // Re-enrollment is allowed only when AccessGate has confirmed there are
  // no encrypted wallet records. Never rotate a key for a non-empty vault.
  const replacementToken = createVaultToken(scope);
  const updated = await updateBiometricToken(manager, replacementToken);
  if (!updated) throw new Error('توکن قدیمی نامعتبر است و تلگرام نتوانست کلید جدید را در فضای امن ذخیره کند.');

  const confirmation = await authenticate(manager);
  if (!confirmation.authenticated || confirmation.token !== replacementToken) {
    throw new Error('کلید جدید در تلگرام ثبت شد، اما تأیید نهایی آن موفق نبود. خزانه باز نشد؛ دوباره تلاش کن.');
  }
  return importVaultKeyFromToken(confirmation.token, scope);
}
