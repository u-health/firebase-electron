import { registerGCM, type GCMRegistrationResult } from './gcm';
import { registerFCM, type FCMRegistrationResult } from './fcm';

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

  // Should be unique by app - One GCM registration/token by app/appId
  const appId = `wp:receiver.push.com#${namespace}`;
  const gcmResult = await registerGCM(appId);
  const fcmResult = await registerFCM(gcmResult.token, credentials);

  // Need to be saved by the client
  return {
    keys: fcmResult.keys,
    fcm: fcmResult.fcm,
    gcm: gcmResult,
  };
}
