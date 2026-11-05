import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from './core/listen';
import { EVENTS } from './core/events';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), destroy: vi.fn() }));
vi.mock('./core/client', async () => {
  const { EventEmitter } = await import('events');
  return {
    Client: class extends EventEmitter {
      connect = mocks.connect;
      destroy = mocks.destroy;
    },
  };
});

const credentials = {
  gcm: { androidId: '123', securityToken: '456' },
  keys: { privateKey: 'private', authSecret: 'auth' },
  persistentIds: [],
};

beforeEach(() => {
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.destroy.mockReset();
});

describe('notification listener startup', () => {
  it('delivers received notifications to the application', async () => {
    const receive = vi.fn();
    const client = await listen(credentials, receive);
    const message = {
      notification: { title: 'Test', body: 'Test push', data: {} },
      persistentId: 'test-message',
    };
    client.emit(EVENTS.ON_NOTIFICATION_RECEIVED, message);
    expect(receive).toHaveBeenCalledWith(message);
  });

  it('closes a partially connected receiver if startup fails', async () => {
    const failure = new Error('Parser startup failed');
    mocks.connect.mockRejectedValueOnce(failure);
    await expect(listen(credentials, vi.fn())).rejects.toBe(failure);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
