/** The vault stays unlocked for 15 minutes after the most recent user activity. */
export const VAULT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Uses a monotonic clock value (performance.now), not wall-clock time.
 * Invalid timestamps fail closed.
 */
export function isVaultSessionExpired(lastActivityAt: number, now: number): boolean {
  if (!Number.isFinite(lastActivityAt) || !Number.isFinite(now) || lastActivityAt < 0 || now < lastActivityAt) {
    return true;
  }
  return now - lastActivityAt >= VAULT_SESSION_IDLE_TIMEOUT_MS;
}

export function getVaultSessionRemainingMs(lastActivityAt: number, now: number): number {
  if (isVaultSessionExpired(lastActivityAt, now)) return 0;
  return Math.max(0, VAULT_SESSION_IDLE_TIMEOUT_MS - (now - lastActivityAt));
}
