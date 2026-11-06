import request from 'request-promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestWithRetry } from './core/utils/request';

vi.mock('request-promise', () => ({ default: vi.fn() }));
vi.mock('./core/utils/timeout', () => ({ waitFor: vi.fn(async () => undefined) }));

const logs: Array<{ level: string; args: unknown[] }> = [];
const privateValues = ['test-api-key', 'test-authorization', 'test-registration-token', 'test-notification-content'];
const options = {
  url: 'https://fcmregistrations.googleapis.com/v1/projects/test/registrations?key=test-api-key',
  method: 'POST',
  headers: { Authorization: 'Bearer test-authorization' },
  body: JSON.stringify({ token: 'test-registration-token', notification: 'test-notification-content' }),
};

beforeEach(() => {
  vi.mocked(request).mockReset();
  logs.length = 0;
  for (const level of ['warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push({ level, args });
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('push-service request diagnostics', () => {
  it('recovers from a transport failure without reporting it as an error', async () => {
    vi.mocked(request)
      .mockRejectedValueOnce({ cause: { code: 'ECONNRESET' } })
      .mockResolvedValueOnce('success');

    await expect(requestWithRetry('gcm.check_in', options)).resolves.toBe('success');
    expect(logs.some((entry) => entry.level === 'error')).toBe(false);
    expect(logs.find((entry) => entry.level === 'warn')?.args).toContainEqual(
      expect.objectContaining({ operation: 'gcm.check_in', code: 'ECONNRESET' }),
    );
  });

  it('preserves an exhausted failure and reports its safe diagnostic context', async () => {
    const failure = Object.assign(new Error('Service unavailable'), { statusCode: 503 });
    vi.mocked(request).mockRejectedValue(failure);

    await expect(requestWithRetry('firebase.install', options)).rejects.toBe(failure);
    expect(logs.find((entry) => entry.level === 'error')?.args).toContainEqual(
      expect.objectContaining({ operation: 'firebase.install', statusCode: 503 }),
    );
  });

  it('does not expose credentials or notification content from requests and failures', async () => {
    vi.mocked(request)
      .mockRejectedValueOnce({
        statusCode: '403 test-api-key',
        code: 'test-registration-token',
        cause: { code: 'test-authorization' },
        name: 'test-notification-content',
        message: privateValues.join(' '),
        options,
      })
      .mockResolvedValueOnce('success');

    await requestWithRetry('fcm.register', options);
    const output = JSON.stringify(logs);
    for (const value of privateValues) expect(output).not.toContain(value);
    expect(output).not.toContain('https://');
  });
});
