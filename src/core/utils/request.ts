import request from 'request-promise';
import { waitFor } from './timeout';

// In seconds
const MAX_RETRY_TIMEOUT = 15;
// Step in seconds
const RETRY_STEP = 5;
const MAX_RETRY_ATTEMPTS = 5;

type RequestArgs = Parameters<typeof request>;
type PushRequestOperation = 'gcm.check_in' | 'gcm.register' | 'firebase.install' | 'fcm.register';

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export function requestWithRetry(operation: PushRequestOperation, ...args: RequestArgs): Promise<any> {
  return retry(operation, 1, ...args);
}

async function retry(operation: PushRequestOperation, attempt: number, ...args: RequestArgs): Promise<any> {
  try {
    const result = await request(...args);
    if (attempt > 1) {
      console.info('Push service request recovered', { operation, attempt, maxAttempts: MAX_RETRY_ATTEMPTS });
    }
    return result;
  } catch (e) {
    const details = { operation, attempt, maxAttempts: MAX_RETRY_ATTEMPTS, ...safeFailureDetails(e) };
    if (attempt >= MAX_RETRY_ATTEMPTS) {
      console.error(`Push service request failed after ${MAX_RETRY_ATTEMPTS} attempts, aborting`, details);
      throw e;
    }

    const timeout = Math.min((attempt - 1) * RETRY_STEP, MAX_RETRY_TIMEOUT);

    console.warn('Push service request failed; retrying', { ...details, retryDelaySeconds: timeout });

    await waitFor(timeout * 1000);
    return retry(operation, attempt + 1, ...args);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeFailureDetails(error: unknown): { statusCode?: number; code?: string } {
  const failure = asRecord(error);
  const statusCode = httpStatus(failure?.statusCode) ?? httpStatus(asRecord(failure?.response)?.statusCode);
  const code = [failure?.code, asRecord(failure?.cause)?.code].find(
    (value): value is string => typeof value === 'string' && NETWORK_ERROR_CODES.has(value),
  );

  // Never log the error, message, URL, headers, response body, or arbitrary error codes.
  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}
