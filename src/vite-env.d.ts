/// <reference types="vite/client" />

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramBiometricManager {
  isInited: boolean;
  isBiometricAvailable: boolean;
  biometricType: 'finger' | 'face' | 'unknown';
  isAccessRequested: boolean;
  isAccessGranted: boolean;
  isBiometricTokenSaved: boolean;
  deviceId: string;
  init(callback?: () => void): TelegramBiometricManager;
  requestAccess(params: { reason?: string }, callback?: (granted: boolean) => void): TelegramBiometricManager;
  authenticate(params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void): TelegramBiometricManager;
  updateBiometricToken(token: string, callback?: (updated: boolean) => void): TelegramBiometricManager;
  openSettings(): TelegramBiometricManager;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: TelegramUser };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  isVersionAtLeast?(version: string): boolean;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  BiometricManager?: TelegramBiometricManager;
  Serverless?: {
    call(
      name: string,
      input: Record<string, unknown>,
      callback: (error: (Error & { type?: string; parameters?: Record<string, unknown> }) | null, result?: unknown) => void,
    ): void;
  };
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
