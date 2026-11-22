/** Worker batch bound only; there is intentionally no per-session wallet count cap. */
// Web Crypto getRandomValues accepts at most 65,536 bytes; 2,048 private keys × 32 bytes fills one request.
export const MAX_PRIVATE_KEY_BATCH_SIZE = 2_048;
