import request from 'request-promise';
import { waitFor } from './timeout';

// In seconds
const MAX_RETRY_TIMEOUT = 15;
// Step in seconds
const RETRY_STEP = 5;
const MAX_RETRY_ATTEMPTS = 5;

type RequestArgs = Parameters<typeof request>;

export function requestWithRetry(...args: RequestArgs): Promise<any> {
  return retry(1, ...args);
}

async function retry(attempt: number, ...args: RequestArgs): Promise<any> {
  try {
    const result = await request(...args);

    return result;
  } catch (e) {
    if (attempt >= MAX_RETRY_ATTEMPTS) {
      console.error(`Request failed after ${MAX_RETRY_ATTEMPTS} attempts, aborting`);

      throw e;
    }

    const timeout = Math.min((attempt - 1) * RETRY_STEP, MAX_RETRY_TIMEOUT);

    console.error(`Request failed : ${(e as Error).message}`);
    console.error(`Retrying in ${timeout} seconds`);

    await waitFor(timeout * 1000);

    const result = await retry(attempt + 1, ...args);

    return result;
  }
}
