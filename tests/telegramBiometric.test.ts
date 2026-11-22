import { describe, expect, it, vi } from 'vitest';
import { enrollBiometricVault, initializeBiometrics, unlockBiometricVault } from '../src/lib/telegramBiometric';

function createManager(): TelegramBiometricManager {
  let saved = '';
  const manager: TelegramBiometricManager = {
    isInited: true,
    isBiometricAvailable: true,
    biometricType: 'finger',
    isAccessRequested: true,
    isAccessGranted: true,
    isBiometricTokenSaved: false,
    deviceId: 'unit-test-device',
    init: vi.fn((callback?: () => void) => { callback?.(); return manager; }),
    requestAccess: vi.fn((_params: { reason?: string }, callback?: (granted: boolean) => void) => { callback?.(true); manager.isAccessGranted = true; return manager; }),
    authenticate: vi.fn((_params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => { callback?.(Boolean(saved), saved || undefined); return manager; }),
    updateBiometricToken: vi.fn((token: string, callback?: (updated: boolean) => void) => { saved = token; manager.isBiometricTokenSaved = Boolean(token); callback?.(true); return manager; }),
    openSettings: vi.fn(() => manager),
  };
  return manager;
}

describe('Telegram biometric vault token', () => {

  it('returns the permission-request state after Telegram biometric initialization', async () => {
    const manager = createManager();
    const webApp = {
      version: '7.2',
      isVersionAtLeast: () => true,
      BiometricManager: manager,
    } as unknown as TelegramWebApp;
    const initialized = await initializeBiometrics(webApp);
    expect(initialized.status).toMatchObject({
      supported: true,
      available: true,
      accessGranted: true,
      accessRequested: true,
      tokenSaved: false,
      deviceId: 'unit-test-device',
    });
  });
  it('creates a non-extractable AES-256 key only after Telegram biometric confirmation', async () => {
    const manager = createManager();
    const key = await enrollBiometricVault(manager, 'unit-test-user');
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['encrypt', 'decrypt']);
    expect(manager.updateBiometricToken).toHaveBeenCalledOnce();
    expect(manager.authenticate).toHaveBeenCalledOnce();
    expect(manager.isBiometricTokenSaved).toBe(true);
  });

  it('unlocks only with the token returned by successful biometric authentication', async () => {
    const manager = createManager();
    await enrollBiometricVault(manager, 'unit-test-user');
    const unlockedKey = await unlockBiometricVault(manager, 'unit-test-user');
    expect(unlockedKey.extractable).toBe(false);
    // Enrollment verifies once, then unlock must authenticate again.
    expect(manager.authenticate).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Telegram refuses to store the vault token', async () => {
    const manager = createManager();
    manager.updateBiometricToken = vi.fn((_token: string, callback?: (updated: boolean) => void) => { callback?.(false); return manager; });
    await expect(enrollBiometricVault(manager, 'unit-test-user')).rejects.toThrow('تلگرام نتوانست کلید رمزگذاری را در فضای امن دستگاه ذخیره کند.');
    expect(manager.authenticate).not.toHaveBeenCalled();
  });

  it('rejects when Telegram biometric auth fails', async () => {
    const manager = createManager();
    await enrollBiometricVault(manager, 'unit-test-user');
    manager.authenticate = vi.fn((_params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => { callback?.(false, undefined); return manager; });
    await expect(unlockBiometricVault(manager, 'unit-test-user')).rejects.toThrow('تأیید اثر انگشت یا چهره ناموفق بود.');
  });

  it('removes the newly saved token if the initial biometric proof is explicitly denied', async () => {
    const manager = createManager();
    manager.authenticate = vi.fn((_params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => { callback?.(false, undefined); return manager; });
    await expect(enrollBiometricVault(manager, 'unit-test-user')).rejects.toThrow('تأیید بیومتریک اولیه ناموفق بود؛ توکن موقت از فضای امن تلگرام پاک شد.');
    expect(manager.updateBiometricToken).toHaveBeenCalledTimes(2);
    expect(manager.isBiometricTokenSaved).toBe(false);
  });

  it('rejects an invalid token instead of creating a fallback key', async () => {
    const manager = createManager();
    await enrollBiometricVault(manager, 'unit-test-user');
    manager.authenticate = vi.fn((_params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => { callback?.(true, 'not-a-vault-token'); return manager; });
    await expect(unlockBiometricVault(manager, 'unit-test-user')).rejects.toThrow('توکن ذخیره‌شده در تلگرام با کلید این خزانه سازگار نیست.');
  });

  it('re-enrolls a malformed legacy token only when the caller confirms the vault is empty', async () => {
    const manager = createManager();
    await enrollBiometricVault(manager, 'unit-test-user');
    const originalAuthenticate = manager.authenticate;
    let firstCall = true;
    manager.authenticate = vi.fn((params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => {
      if (firstCall) {
        firstCall = false;
        callback?.(true, 'legacy-token-with-unknown-format');
        return manager;
      }
      return originalAuthenticate(params, callback);
    });

    const key = await unlockBiometricVault(manager, 'unit-test-user', { allowReEnrollmentWhenVaultEmpty: true });
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(false);
    expect(manager.updateBiometricToken).toHaveBeenCalledTimes(2);
    expect(manager.authenticate).toHaveBeenCalledTimes(2);
  });

  it('does not replace a malformed token unless the vault is confirmed empty', async () => {
    const manager = createManager();
    await enrollBiometricVault(manager, 'unit-test-user');
    manager.authenticate = vi.fn((_params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => {
      callback?.(true, 'legacy-token-with-unknown-format');
      return manager;
    });

    await expect(unlockBiometricVault(manager, 'unit-test-user')).rejects.toThrow(
      'توکن ذخیره‌شده در تلگرام با کلید این خزانه سازگار نیست. چون دیتابیس اطلاعات دارد',
    );
    expect(manager.updateBiometricToken).toHaveBeenCalledOnce();
  });


  it('repairs an empty-vault token state when Telegram authenticates but returns an empty token', async () => {
    const manager = createManager();
    await enrollBiometricVault(manager, 'unit-test-user');
    const originalAuthenticate = manager.authenticate;
    let firstCall = true;
    manager.authenticate = vi.fn((params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void) => {
      if (firstCall) {
        firstCall = false;
        callback?.(true, '');
        return manager;
      }
      return originalAuthenticate(params, callback);
    });
    const key = await unlockBiometricVault(manager, 'unit-test-user', { allowReEnrollmentWhenVaultEmpty: true });
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(manager.updateBiometricToken).toHaveBeenCalledTimes(2);
  });

});
