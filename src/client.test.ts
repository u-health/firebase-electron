import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from './core/client';
import { requestWithRetry } from './core/utils/request';

vi.mock('./core/utils/request', () => ({ requestWithRetry: vi.fn() }));
vi.mock('tls', async () => {
  const { EventEmitter } = await import('events');
  return {
    default: {
      TLSSocket: class extends EventEmitter {
        destroyed = false;
        writable = true;
        setKeepAlive() {}
        connect() {
          this.emit('connect');
        }
        write() {
          return true;
        }
        destroy() {
          this.destroyed = true;
        }
      },
    },
  };
});

beforeEach(() => {
  vi.mocked(requestWithRetry).mockReset().mockRejectedValue(new Error('Unexpected device re-check-in'));
});

describe('receiving with existing device credentials', () => {
  it('connects and reconnects without re-checking in or replacing an issued subscription', async () => {
    const client = new Client(
      {
        gcm: { androidId: '123', securityToken: '456' },
        keys: { privateKey: 'unused', authSecret: 'unused' },
      },
      [],
    );
    try {
      await client.connect();
      expect(client.checkConnection()).toBe(true);
      client.destroy();
      await client.connect();
      expect(client.checkConnection()).toBe(true);
      expect(requestWithRetry).not.toHaveBeenCalled();
    } finally {
      client.destroy();
    }
  });
});
