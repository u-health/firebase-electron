import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import ElectronStore from 'electron-store';

import { listen, type Client } from '../core/listen';
import { register, type FirebaseCredentials, type RegisterCredentials } from '../core/register';
import { DEFAULT_VAPID_KEY } from '../core/fcm/server-key';

import {
  NOTIFICATION_RECEIVED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_SERVICE_STARTED,
  START_NOTIFICATION_SERVICE,
  STOP_NOTIFICATION_SERVICE,
  TOKEN_UPDATED,
  TOKEN_REGISTERED,
  createEventName,
} from './consts';

const config = new ElectronStore();
const LOG_PREFIX = '[push-receiver]';
// Earlier registrations mismatched VAPID keys or reused provider scopes across devices.
const REGISTRATION_VERSION = 3;

interface Registration {
  version: number;
  firebaseCredentials: FirebaseCredentials;
  credentials: RegisterCredentials;
  supersededTokens: string[];
}

interface Service {
  webContents: WebContents;
  firebaseCredentials: FirebaseCredentials;
  ready: Promise<void>;
  client?: Client;
}

const services = new Map<string, Service>();

type StartPayload = { namespace: string; credentials: FirebaseCredentials };
type StopPayload = { namespace: string };
type RegisteredPayload = { namespace: string; token: string };

// To be called from the main process
function setup(webContents: WebContents): void {
  console.log(`${LOG_PREFIX} setup invoked for webContents#${webContents.id}`);
  const startListener = async (event: IpcMainEvent, payload: StartPayload) => {
    if (event.sender !== webContents) return;
    let namespace = '';
    let firebaseCredentials: FirebaseCredentials;

    try {
      ({ namespace, firebaseCredentials } = extractStartArgs(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid start payload';
      console.error(`PUSH_RECEIVER:::${message}`);
      webContents.send(createEventName(namespace, NOTIFICATION_SERVICE_ERROR), message);
      return;
    }

    const existing = services.get(namespace);
    if (existing?.webContents === webContents && sameCredentials(existing.firebaseCredentials, firebaseCredentials)) {
      await existing.ready;
      if (services.get(namespace) === existing && existing.client) {
        emitToken(existing, namespace, NOTIFICATION_SERVICE_STARTED);
      }
      return;
    }

    stopService(namespace);
    const service: Service = { webContents, firebaseCredentials, ready: Promise.resolve() };
    services.set(namespace, service);
    service.ready = startService(namespace, service).catch((error: unknown) => {
      if (services.get(namespace) !== service || webContents.isDestroyed()) return;
      services.delete(namespace);
      // Request errors can contain credentials or registration tokens; do not log them.
      console.error(`${LOG_PREFIX} notification service failed to start`, {
        errorName: error instanceof Error ? error.name : 'Error',
        projectId: firebaseCredentials.projectId,
      });
      webContents.send(
        createEventName(namespace, NOTIFICATION_SERVICE_ERROR),
        'Unable to start the push notification service',
      );
    });
    await service.ready;
  };

  const stopListener = (event: IpcMainEvent, payload: StopPayload) => {
    if (event.sender !== webContents) return;
    try {
      const namespace = extractNamespace(payload);
      if (services.get(namespace)?.webContents === webContents) {
        stopService(namespace);
      }
    } catch {
      console.warn(`${LOG_PREFIX} ignored invalid stop payload`);
    }
  };

  const registeredListener = (event: IpcMainEvent, payload: RegisteredPayload) => {
    if (event.sender !== webContents) return;
    try {
      const namespace = extractNamespace(payload);
      const registration = getRegistration(namespace);
      if (
        services.get(namespace)?.webContents === webContents &&
        registration?.credentials.fcm.token === payload.token
      ) {
        config.set(`registration_${namespace}`, { ...registration, supersededTokens: [] });
      }
    } catch {
      console.warn(`${LOG_PREFIX} ignored invalid token acknowledgement`);
    }
  };

  ipcMain.on(START_NOTIFICATION_SERVICE, startListener);
  ipcMain.on(STOP_NOTIFICATION_SERVICE, stopListener);
  ipcMain.on(TOKEN_REGISTERED, registeredListener);
  webContents.once('destroyed', () => {
    ipcMain.removeListener(START_NOTIFICATION_SERVICE, startListener);
    ipcMain.removeListener(STOP_NOTIFICATION_SERVICE, stopListener);
    ipcMain.removeListener(TOKEN_REGISTERED, registeredListener);
    for (const [namespace, service] of services) {
      if (service.webContents === webContents) stopService(namespace);
    }
  });
}

async function startService(namespace: string, service: Service): Promise<void> {
  const isCurrent = () => services.get(namespace) === service && !service.webContents.isDestroyed();
  let registration = getRegistration(namespace);
  const persistentIdsKey = `persistentIds_${namespace}`;

  if (
    !registration ||
    registration.version !== REGISTRATION_VERSION ||
    !sameCredentials(registration.firebaseCredentials, service.firebaseCredentials)
  ) {
    const credentials = await register(service.firebaseCredentials, namespace);
    if (!isCurrent()) return;
    // Only retire tokens from this installation, user namespace, and Firebase project.
    const previousTokens =
      registration?.firebaseCredentials.projectId === service.firebaseCredentials.projectId
        ? [...registration.supersededTokens, registration.credentials.fcm.token]
        : [];
    registration = {
      version: REGISTRATION_VERSION,
      firebaseCredentials: service.firebaseCredentials,
      credentials,
      supersededTokens: [...new Set(previousTokens)].filter((token) => token !== credentials.fcm.token),
    };
    // Keep migration and cleanup metadata together, including across a failed backend save.
    config.set(`registration_${namespace}`, registration);
    config.delete(`credentials_${namespace}`);
    config.delete(`firebaseCredentials_${namespace}`);
    config.set(persistentIdsKey, []);
    emitToken(service, namespace, TOKEN_UPDATED);
  }

  const client = await listen(
    { ...registration.credentials, persistentIds: (config.get(persistentIdsKey) as string[]) || [] },
    (notification) => {
      if (isCurrent()) onNotification(service.webContents, namespace, persistentIdsKey)(notification);
    },
  );
  if (!isCurrent()) {
    client.destroy();
    return;
  }
  service.client = client;
  emitToken(service, namespace, NOTIFICATION_SERVICE_STARTED);
}

function getRegistration(namespace: string): Registration | undefined {
  const current = config.get(`registration_${namespace}`) as Registration | undefined;
  if (current) return current;
  const credentials = config.get(`credentials_${namespace}`) as RegisterCredentials | undefined;
  const firebaseCredentials = config.get(`firebaseCredentials_${namespace}`) as FirebaseCredentials | undefined;
  if (!credentials || !firebaseCredentials) return undefined;
  return { version: 1, credentials, firebaseCredentials, supersededTokens: [] };
}

function sameCredentials(left: FirebaseCredentials, right: FirebaseCredentials): boolean {
  return (
    left.appId === right.appId &&
    left.apiKey === right.apiKey &&
    left.projectId === right.projectId &&
    (left.vapidKey || DEFAULT_VAPID_KEY) === (right.vapidKey || DEFAULT_VAPID_KEY)
  );
}

function emitToken(service: Service, namespace: string, event: string): void {
  const registration = getRegistration(namespace);
  if (registration && !service.webContents.isDestroyed()) {
    service.webContents.send(
      createEventName(namespace, event),
      registration.credentials.fcm.token,
      registration.supersededTokens,
    );
  }
}

function stopService(namespace: string): void {
  const service = services.get(namespace);
  services.delete(namespace);
  service?.client?.destroy();
}

// Will be called on new notification
function onNotification(webContents: WebContents, namespace: string, persistentIdsKey: string) {
  return ({ notification, persistentId }: { notification: any; persistentId: string }) => {
    const persistentIds: string[] = (config.get(persistentIdsKey) as string[]) || [];
    // Update persistentId
    config.set(persistentIdsKey, [...persistentIds, persistentId]);
    console.log(`${LOG_PREFIX} notification received for namespace "${namespace}" (total ${persistentIds.length + 1})`);
    // Notify the renderer process that a new notification has been received
    // And check if window is not destroyed for darwin Apps
    if (!webContents.isDestroyed()) {
      webContents.send(createEventName(namespace, NOTIFICATION_RECEIVED), notification);
    }
  };
}

function extractStartArgs(payload: StartPayload): {
  namespace: string;
  firebaseCredentials: FirebaseCredentials;
} {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload object is required when starting the notification service');
  }

  const namespace = typeof payload.namespace === 'string' ? payload.namespace.trim() : '';
  if (!namespace) {
    throw new Error('Namespace is required when starting the notification service');
  }

  if (!payload.credentials || typeof payload.credentials !== 'object') {
    throw new Error('Firebase credentials are required when starting the notification service');
  }
  for (const key of ['appId', 'apiKey', 'projectId'] as const) {
    if (typeof payload.credentials[key] !== 'string' || !payload.credentials[key].trim()) {
      throw new Error(`Firebase ${key} is required when starting the notification service`);
    }
  }
  if (payload.credentials.vapidKey !== undefined && typeof payload.credentials.vapidKey !== 'string') {
    throw new Error('Firebase vapidKey must be a string');
  }

  return {
    namespace,
    firebaseCredentials: payload.credentials,
  };
}

function extractNamespace(payload: StopPayload): string {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload object is required when stopping the notification service');
  }

  const namespace = typeof payload.namespace === 'string' ? payload.namespace.trim() : '';
  if (!namespace) {
    throw new Error('Namespace is required when stopping the notification service');
  }

  return namespace;
}

export {
  NOTIFICATION_RECEIVED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_SERVICE_STARTED,
  START_NOTIFICATION_SERVICE,
  STOP_NOTIFICATION_SERVICE,
  TOKEN_UPDATED,
  TOKEN_REGISTERED,
  createEventName,
  setup,
};
