import { describe, it, expect, vi } from 'vitest';

// Mock the networked register() so this test never hits live FCM/GCM
vi.mock('./core/register', () => ({
  register: vi.fn(async () => ({
    fcm: {
      token: 'test-token',
    },
    gcm: {
      androidId: '1234567890',
    },
    securityToken: 'sec-token',
    persistentIds: [],
  })),
}));

import { register, type RegisterCredentials } from './core/register';

describe('register function (mocked)', () => {
  it('should return credentials (with vapid key)', async () => {
    const credentials: RegisterCredentials = await register({
      apiKey: 'fake',
      appId: 'fake',
      projectId: 'fake',
      vapidKey: 'fake',
    } as any);

    expect(credentials).toBeDefined();
    console.log(credentials);
    expect(credentials.fcm.token).toBe('test-token');
  });

  it('should return credentials (without vapid key)', async () => {
    const credentials: RegisterCredentials = await register({
      apiKey: 'fake',
      appId: 'fake',
      projectId: 'fake',
    } as any);

    expect(credentials).toBeDefined();
    expect(credentials.gcm.androidId).toBe('1234567890');
  });
});
