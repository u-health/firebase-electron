import crypto from 'crypto';
import { registerGCM, type GCMRegistrationResult } from './gcm';
import { registerFCM, type FCMRegistrationResult } from './fcm';
import { DEFAULT_VAPID_KEY } from './fcm/server-key';

export interface RegisterCredentials extends FCMRegistrationResult {
  gcm: GCMRegistrationResult;
  persistentIds?: string[];
}

export interface FirebaseCredentials {
  appId: string;
  apiKey: string;
  projectId: string;
  vapidKey?: string;
}

export async function register(credentials: FirebaseCredentials, namespace: string): Promise<RegisterCredentials> {
  if (!namespace) {
    throw new Error('Namespace is required when registering the push receiver');
  }

  // The namespace routes events and caches credentials, not provider subscriptions.
  // Reusing a scope across new devices/registrations can yield UNREGISTERED tokens.
  const appId = `wp:receiver.push.com#${crypto.randomBytes(16).toString('hex')}`;
  const firebaseCredentials = { ...credentials, vapidKey: credentials.vapidKey || DEFAULT_VAPID_KEY };
  const gcmResult = await registerGCM(appId, firebaseCredentials.vapidKey);
  const fcmResult = await registerFCM(gcmResult.token, firebaseCredentials);

  // Need to be saved by the client
  return {
    keys: fcmResult.keys,
    fcm: fcmResult.fcm,
    gcm: gcmResult,
  };
}
