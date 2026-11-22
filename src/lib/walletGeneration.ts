import { MAX_PRIVATE_KEY_BATCH_SIZE } from './walletConstants';

/** One Worker response per batch amortizes RNG, messaging, and UI costs. */
export const PRIVATE_KEY_BATCH_SIZE = MAX_PRIVATE_KEY_BATCH_SIZE;

export { MAX_PRIVATE_KEY_BATCH_SIZE };
