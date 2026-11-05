import path from 'path';
import protobuf from 'protobufjs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { register } from './core/register';
import { registerFCM } from './core/fcm';
import { DEFAULT_VAPID_KEY } from './core/fcm/server-key';
import { requestWithRetry } from './core/utils/request';

vi.mock('./core/utils/request', () => ({ requestWithRetry: vi.fn() }));

const firebaseCredentials = {
  apiKey: 'test-api-key',
  appId: 'test-app',
  projectId: 'test-project',
};

beforeEach(async () => {
  vi.mocked(requestWithRetry).mockReset();
  const root = await protobuf.load(path.join(__dirname, 'core/gcm/checkin.proto'));
  const response = root.lookupType('checkin_proto.AndroidCheckinResponse');
  const checkin = Buffer.from(
    response.encode(response.fromObject({ androidId: '123', securityToken: '456' })).finish(),
  );
  vi.mocked(requestWithRetry).mockImplementation(async (options: any) => {
    if (options.url.endsWith('/checkin')) return checkin;
    if (options.url.endsWith('/register3')) return 'token=test-endpoint';
    if (options.url.endsWith('/installations')) return JSON.stringify({ authToken: { token: 'test-installation' } });
    return JSON.stringify({ token: 'test-fcm-token' });
  });
});

describe('push registration requests', () => {
  it('binds the push endpoint and FCM registration to the same custom VAPID key', async () => {
    const vapidKey = Buffer.alloc(65, 4).toString('base64url');
    const result = await register({ ...firebaseCredentials, vapidKey }, 'test');
    const requests = vi.mocked(requestWithRetry).mock.calls.map(([options]) => options as any);
    const endpoint = requests.find((options) => options.url.endsWith('/register3'));
    const fcm = requests.find((options) => options.url.endsWith('/registrations'));
    const web = JSON.parse(fcm.body).web;

    expect(endpoint.form.sender).toBe(vapidKey);
    expect(web.applicationPubKey).toBe(vapidKey);
    expect(web.endpoint).toBe('https://fcm.googleapis.com/fcm/send/test-endpoint');
    expect(Buffer.from(web.p256dh, 'base64')).toHaveLength(65);
    expect(Buffer.from(web.auth, 'base64')).toHaveLength(16);
    expect(result.fcm.token).toBe('test-fcm-token');
  });

  it.each([undefined, '', DEFAULT_VAPID_KEY])(
    'uses the Firebase default subscription protocol when vapidKey is %s',
    async (vapidKey) => {
      await register({ ...firebaseCredentials, vapidKey }, 'test');
      const requests = vi.mocked(requestWithRetry).mock.calls.map(([options]) => options as any);
      expect(requests.find((options) => options.url.endsWith('/register3')).form.sender).toBe(DEFAULT_VAPID_KEY);
      const fcm = requests.find((options) => options.url.endsWith('/registrations'));
      expect(JSON.parse(fcm.body).web).not.toHaveProperty('applicationPubKey');
    },
  );

  it('gives separate registrations for the same user distinct opaque provider scopes', async () => {
    await register(firebaseCredentials, 'same-user');
    await register(firebaseCredentials, 'same-user');
    const scopes = vi
      .mocked(requestWithRetry)
      .mock.calls.map(([options]) => options as any)
      .filter((options) => options.url.endsWith('/register3'))
      .map((options) => options.form['X-subtype']);
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).not.toBe(scopes[1]);
    for (const scope of scopes) {
      expect(scope).toMatch(/^wp:receiver\.push\.com#[a-f0-9]{32}$/);
      expect(scope).not.toContain('same-user');
    }
  });

  it('keeps concurrent registrations bound to their own Firebase projects and keys', async () => {
    let releaseFirst!: () => void;
    const firstInstallation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(requestWithRetry).mockImplementation(async (options: any) => {
      if (options.url.includes('/first/installations')) await firstInstallation;
      if (options.url.endsWith('/installations')) {
        return JSON.stringify({ authToken: { token: options.url.includes('/first/') ? 'first-auth' : 'second-auth' } });
      }
      return JSON.stringify({ token: 'test-token' });
    });

    const first = registerFCM('first-endpoint', { ...firebaseCredentials, projectId: 'first', vapidKey: 'first-key' });
    const second = registerFCM('second-endpoint', {
      ...firebaseCredentials,
      projectId: 'second',
      vapidKey: 'second-key',
    });
    await second;
    releaseFirst();
    await first;

    const registrations = vi
      .mocked(requestWithRetry)
      .mock.calls.map(([options]) => options as any)
      .filter((options) => options.url.endsWith('/registrations'));
    for (const project of ['first', 'second']) {
      const request = registrations.find((options) => options.url.includes(`/${project}/`));
      expect(request.headers['x-goog-firebase-installations-auth']).toBe(`${project}-auth`);
      expect(JSON.parse(request.body).web).toMatchObject({
        applicationPubKey: `${project}-key`,
        endpoint: `https://fcm.googleapis.com/fcm/send/${project}-endpoint`,
      });
    }
  });
});
