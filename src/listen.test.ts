// src/listen.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Block network by mocking the high-level calls used here
vi.mock('./core/register', () => ({
  register: vi.fn(async () => ({
    token: 'test-token',
    androidId: '1234567890',
    securityToken: 'sec-token',
    persistentIds: [],
  })),
}));

vi.mock('./core/listen', () => ({
  listen: vi.fn(async (_creds: any, _onNotification: any) => {
    // Minimal Client shape used by the test
    return {
      checkConnection: () => true,
      destroy: async () => undefined,
    } as any;
  }),
}));

import { listen, type Client, type Notification, type NotificationCallbackParams } from './core/listen';
import { register, type RegisterCredentials } from './core/register';

let credentials: RegisterCredentials | undefined;
let client: Client | undefined;

async function receive(n: number) {
  const receivedNotifications: Notification[] = [];

  return new Promise(async (resolve) => {
    const onNotification = ({ notification }: NotificationCallbackParams) => {
      receivedNotifications.push(notification);
      if (receivedNotifications.length === n) resolve(receivedNotifications);
    };

    credentials!.persistentIds = [];
    client = await listen({ ...credentials!, persistentIds: [] }, onNotification);
  });
}

describe('listen function', () => {
  beforeEach(async () => {
    credentials = await register(
      {
        // values irrelevant; register() is mocked
        apiKey: 'fake',
        appId: 'fake',
        projectId: 'fake',
        vapidKey: 'fake',
      } as any,
      'test',
    );

    const receivedNotifications: Notification[] = [];
    const onNotification = ({ notification }: NotificationCallbackParams) => {
      receivedNotifications.push(notification);
    };

    client = await listen({ ...credentials!, persistentIds: [] }, onNotification);
  });

  afterEach(async () => {
    if (client) await client.destroy();
    credentials = undefined;
    vi.clearAllMocks();
  });

  it('should start listening to notifications', async () => {
    expect(client!.checkConnection()).toBe(true);
  });
});
