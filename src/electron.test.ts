import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { RegisterCredentials } from './core/register';
import {
  START_NOTIFICATION_SERVICE,
  STOP_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_ERROR,
  TOKEN_UPDATED,
  TOKEN_REGISTERED,
  createEventName,
} from './electron/consts';

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  listeners: new Map<string, ((...args: any[]) => unknown)[]>(),
  register: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('electron-store', () => ({
  default: class {
    get(key: string) {
      return mocks.store.get(key);
    }
    set(key: string, value: unknown) {
      mocks.store.set(key, value);
    }
    delete(key: string) {
      mocks.store.delete(key);
    }
  },
}));
vi.mock('electron', () => ({
  ipcMain: {
    on(event: string, listener: (...args: any[]) => unknown) {
      mocks.listeners.set(event, [...(mocks.listeners.get(event) || []), listener]);
    },
    removeListener(event: string, listener: (...args: any[]) => unknown) {
      mocks.listeners.set(
        event,
        (mocks.listeners.get(event) || []).filter((item) => item !== listener),
      );
    },
  },
}));
vi.mock('./core/register', () => ({ register: mocks.register }));
vi.mock('./core/listen', () => ({ listen: mocks.listen }));

const credentials = { appId: 'test-app', apiKey: 'test-api', projectId: 'test-project', vapidKey: 'test-key' };
const namespace = 'test-user';
const makeRegistration = (token: string): RegisterCredentials => ({
  fcm: { token },
  gcm: { token: 'endpoint', androidId: '123', securityToken: '456', appId: 'test-app' },
  keys: { publicKey: 'public', privateKey: 'private', authSecret: 'auth' },
});
const makeWindow = () => ({ id: 1, send: vi.fn(), once: vi.fn(), isDestroyed: () => false });
let window: ReturnType<typeof makeWindow>;
let setup: typeof import('./electron').setup;

async function dispatch(event: string, payload: unknown, sender = window) {
  await Promise.all((mocks.listeners.get(event) || []).map((listener) => listener({ sender }, payload)));
}
const start = (options = credentials) => dispatch(START_NOTIFICATION_SERVICE, { namespace, credentials: options });
const stop = () => dispatch(STOP_NOTIFICATION_SERVICE, { namespace });
const acknowledge = (token = 'new-token') => dispatch(TOKEN_REGISTERED, { namespace, token });
const cached = () =>
  mocks.store.get(`registration_${namespace}`) as {
    credentials: RegisterCredentials;
    supersededTokens: string[];
  };

function seedLegacy() {
  mocks.store.set(`credentials_${namespace}`, makeRegistration('old-token'));
  mocks.store.set(`firebaseCredentials_${namespace}`, credentials);
  mocks.store.set(`persistentIds_${namespace}`, ['old-message']);
}

beforeEach(async () => {
  vi.resetModules();
  mocks.store.clear();
  mocks.listeners.clear();
  mocks.register.mockReset().mockResolvedValue(makeRegistration('new-token'));
  mocks.listen.mockReset().mockImplementation(async () => ({ destroy: vi.fn() }));
  window = makeWindow();
  setup = (await import('./electron')).setup;
  setup(window as unknown as WebContents);
});

describe('notification registration lifecycle', () => {
  it('migrates legacy registrations once and replays cleanup until the backend acknowledges it', async () => {
    seedLegacy();
    await start();
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(window.send).toHaveBeenCalledWith(createEventName(namespace, TOKEN_UPDATED), 'new-token', ['old-token']);
    expect(mocks.store.get(`persistentIds_${namespace}`)).toEqual([]);
    expect(mocks.store.has(`credentials_${namespace}`)).toBe(false);

    await stop();
    await start();
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(window.send).toHaveBeenLastCalledWith(
      createEventName(namespace, NOTIFICATION_SERVICE_STARTED),
      'new-token',
      ['old-token'],
    );
    await acknowledge('outdated-acknowledgement');
    expect(cached().supersededTokens).toEqual(['old-token']);
    await acknowledge();
    expect(cached().supersededTokens).toEqual([]);
    await stop();
    await start();
    expect(window.send).toHaveBeenLastCalledWith(
      createEventName(namespace, NOTIFICATION_SERVICE_STARTED),
      'new-token',
      [],
    );
  });

  it('preserves pending cleanup through a process restart without registering another token', async () => {
    seedLegacy();
    await start();
    await stop();
    vi.resetModules();
    mocks.listeners.clear();
    setup = (await import('./electron')).setup;
    setup(window as unknown as WebContents);
    await start();
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(cached().supersededTokens).toEqual(['old-token']);
  });

  it('replaces a matching-key cache that still used a shared provider scope', async () => {
    mocks.store.set(`registration_${namespace}`, {
      version: 2,
      firebaseCredentials: credentials,
      credentials: makeRegistration('shared-scope-token'),
      supersededTokens: ['earlier-token'],
    });
    await start();
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(cached().credentials.fcm.token).toBe('new-token');
    expect(cached().supersededTokens).toEqual(['earlier-token', 'shared-scope-token']);
    await stop();
    await start();
    expect(mocks.register).toHaveBeenCalledOnce();
  });

  it('keeps legacy credentials when registration fails and recovers on the next start', async () => {
    seedLegacy();
    mocks.register.mockRejectedValueOnce(new Error('network failure'));
    await start();
    expect(mocks.store.get(`credentials_${namespace}`)).toEqual(makeRegistration('old-token'));
    expect(window.send).toHaveBeenCalledWith(
      createEventName(namespace, NOTIFICATION_SERVICE_ERROR),
      'Unable to start the push notification service',
    );
    await start();
    expect(cached().supersededTokens).toEqual(['old-token']);
  });

  it('retains migration metadata when the connection fails after token generation', async () => {
    seedLegacy();
    mocks.listen.mockRejectedValueOnce(new Error('connection failed'));
    await start();
    expect(cached().supersededTokens).toEqual(['old-token']);
    await start();
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(window.send).toHaveBeenLastCalledWith(
      createEventName(namespace, NOTIFICATION_SERVICE_STARTED),
      'new-token',
      ['old-token'],
    );
  });

  it('shares concurrent starts and does not resurrect a service stopped during registration', async () => {
    seedLegacy();
    let release!: (value: RegisterCredentials) => void;
    mocks.register.mockReturnValueOnce(
      new Promise<RegisterCredentials>((resolve) => {
        release = resolve;
      }),
    );
    const first = start();
    const second = start();
    expect(mocks.register).toHaveBeenCalledTimes(1);
    await stop();
    release(makeRegistration('cancelled-token'));
    await Promise.all([first, second]);
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(window.send).not.toHaveBeenCalled();
    expect(mocks.store.has(`registration_${namespace}`)).toBe(false);
    await start();
    expect(cached().credentials.fcm.token).toBe('new-token');
  });

  it('closes a connection that completes after logout without announcing it as started', async () => {
    const destroy = vi.fn();
    let release!: (value: { destroy: typeof destroy }) => void;
    mocks.listen.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = start();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
    await stop();
    release({ destroy });
    await pending;
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      window.send.mock.calls.some(([event]) => event === createEventName(namespace, NOTIFICATION_SERVICE_STARTED)),
    ).toBe(false);
  });

  it('re-registers active services after configuration changes without retiring another project’s tokens', async () => {
    seedLegacy();
    await start();
    await start({ ...credentials, projectId: 'another-project' });
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(cached().supersededTokens).toEqual([]);
  });

  it('retains every superseded token across repeated rotations and ignores stale acknowledgements', async () => {
    seedLegacy();
    await start();
    mocks.register.mockResolvedValueOnce(makeRegistration('newer-token'));
    await start({ ...credentials, vapidKey: 'changed-key' });
    await acknowledge('new-token');
    expect(cached().supersededTokens).toEqual(['old-token', 'new-token']);
    await acknowledge('newer-token');
    expect(cached().supersededTokens).toEqual([]);
  });

  it('ignores requests and acknowledgements from another renderer', async () => {
    seedLegacy();
    await start();
    await dispatch(TOKEN_REGISTERED, { namespace, token: 'new-token' }, makeWindow());
    await dispatch(STOP_NOTIFICATION_SERVICE, { namespace }, makeWindow());
    expect(cached().supersededTokens).toEqual(['old-token']);
    await start();
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});
