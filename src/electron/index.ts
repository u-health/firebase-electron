import { ipcMain, type WebContents } from 'electron';
import ElectronStore from 'electron-store';

import { listen, type Client } from '../core/listen';
import { register, type FirebaseCredentials } from '../core/register';

import {
  NOTIFICATION_RECEIVED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_SERVICE_STARTED,
  START_NOTIFICATION_SERVICE,
  STOP_NOTIFICATION_SERVICE,
  TOKEN_UPDATED,
  createEventName,
} from './consts';

const config = new ElectronStore();
const LOG_PREFIX = '[push-receiver]';

// Track active connections by namespace
const activeConnections = new Map<string, Client>();

type StartPayload = { namespace: string; credentials: FirebaseCredentials };
type StopPayload = { namespace: string };

// To be called from the main process
function setup(webContents: WebContents): void {
  console.log(`${LOG_PREFIX} setup invoked for webContents#${webContents.id}`);
  // Handler for starting the notification service
  const startListener = async (_: any, payload: StartPayload) => {
    const reportedNamespace = (payload as any)?.namespace ?? '<unknown>';
    console.log(`${LOG_PREFIX} start request received for namespace "${reportedNamespace}"`);
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

    const credentialsKey = namespace ? `credentials_${namespace}` : 'credentials';
    const firebaseCredentialsKey = namespace ? `firebaseCredentials_${namespace}` : 'firebaseCredentials';
    const persistentIdsKey = namespace ? `persistentIds_${namespace}` : 'persistentIds';

    // Retrieve saved credentials
    let credentials: any = config.get(credentialsKey);
    // Retrieve saved senderId
    const savedFirebaseCredentials: FirebaseCredentials | undefined = config.get(firebaseCredentialsKey) as
      | FirebaseCredentials
      | undefined;

    // Check if already started
    if (activeConnections.has(namespace)) {
      console.log(`${LOG_PREFIX} namespace "${namespace}" already active; skipping new listener`);
      webContents.send(createEventName(namespace, NOTIFICATION_SERVICE_STARTED), (credentials?.fcm || {}).token);
      return;
    }

    try {
      // Retrieve saved persistentIds : avoid receiving all already received notifications on start
      const persistentIds: string[] = (config.get(persistentIdsKey) as string[]) || [];
      console.log(
        `${LOG_PREFIX} found ${persistentIds.length} persistent ids for namespace "${namespace}"`,
      );
      // Register if no credentials or if senderId has changed
      if (
        !credentials ||
        !savedFirebaseCredentials ||
        savedFirebaseCredentials.appId !== firebaseCredentials.appId ||
        savedFirebaseCredentials.apiKey !== firebaseCredentials.apiKey ||
        savedFirebaseCredentials.projectId !== firebaseCredentials.projectId ||
        savedFirebaseCredentials.vapidKey !== firebaseCredentials.vapidKey
      ) {
        console.log(`${LOG_PREFIX} registering new credentials for namespace "${namespace}"`);
        credentials = await register(firebaseCredentials, namespace);
        // Save credentials for later use
        config.set(credentialsKey, credentials);
        // Save senderId
        config.set(firebaseCredentialsKey, firebaseCredentials);
        // Notify the renderer process that the FCM token has changed
        webContents.send(createEventName(namespace, TOKEN_UPDATED), credentials.fcm.token);
      } else {
        console.log(`${LOG_PREFIX} re-using cached credentials for namespace "${namespace}"`);
      }
      // Listen for GCM/FCM notifications
      console.log(`${LOG_PREFIX} establishing listener for namespace "${namespace}"`);
      const client = await listen(
        { ...credentials, persistentIds },
        onNotification(webContents, namespace, persistentIdsKey),
      );
      // Store the active connection
      activeConnections.set(namespace, client);
      // Notify the renderer process that we are listening for notifications
      console.log(`${LOG_PREFIX} notification service started for namespace "${namespace}"`);
      webContents.send(createEventName(namespace, NOTIFICATION_SERVICE_STARTED), credentials.fcm.token);
    } catch (e) {
      console.error('PUSH_RECEIVER:::Error while starting the service', e);
      // Forward error to the renderer process
      webContents.send(createEventName(namespace, NOTIFICATION_SERVICE_ERROR), (e as Error).message);
    }
  };

  // Handler for stopping the notification service
  const stopListener = (_: any, payload: StopPayload) => {
    const reportedNamespace = (payload as any)?.namespace ?? '<unknown>';
    console.log(`${LOG_PREFIX} stop request received for namespace "${reportedNamespace}"`);
    let namespace: string;
    try {
      namespace = extractNamespace(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid stop payload';
      console.error(`PUSH_RECEIVER:::${message}`);
      webContents.send(createEventName('', NOTIFICATION_SERVICE_ERROR), message);
      return;
    }
    const connection = activeConnections.get(namespace);
    if (connection) {
      // Destroy the client connection
      connection.destroy();
      // Remove from active connections
      activeConnections.delete(namespace);
      console.log(`${LOG_PREFIX} notification service stopped for namespace "${namespace}"`);
    } else {
      console.warn(`${LOG_PREFIX} stop requested for namespace "${namespace}" with no active connection`);
    }
  };

  // Register listeners
  ipcMain.on(START_NOTIFICATION_SERVICE, startListener);
  ipcMain.on(STOP_NOTIFICATION_SERVICE, stopListener);
}

// Will be called on new notification
function onNotification(webContents: WebContents, namespace: string, persistentIdsKey: string) {
  return ({ notification, persistentId }: { notification: any; persistentId: string }) => {
    const persistentIds: string[] = (config.get(persistentIdsKey) as string[]) || [];
    // Update persistentId
    config.set(persistentIdsKey, [...persistentIds, persistentId]);
    console.log(
      `${LOG_PREFIX} notification received for namespace "${namespace}" (total ${persistentIds.length + 1})`,
    );
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
  createEventName,
  setup,
};
