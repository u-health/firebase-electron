# firebase-electron

Receive Firebase push notifications in your Electron app.

## Installation

```bash
npm i firebase-electron
```

## Usage

Usage is similar to the [`electron-push-receiver`](https://github.com/MatthieuLemoine/electron-push-receiver) package.

### In the main process (`main.js/.ts`)

```typescript
import { setup as setupPushReceiver } from 'firebase-electron';

// Call it before 'did-finish-load' with mainWindow a reference to your window
setupPushReceiver(mainWindow.webContents);
```

### In the renderer process (`renderer.js/.ts`)

```typescript
import { ipcRenderer } from 'electron';
import {
  START_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  STOP_NOTIFICATION_SERVICE,
  TOKEN_UPDATED,
  TOKEN_REGISTERED,
  createEventName,
} from 'firebase-electron/dist/electron/consts';

const namespace = 'main-window'; // Required, stable per signed-in user in this installation

// Both events provide (event, token, supersededTokens). Deduplicate identical saves.
// These application functions must save the new token first, then delete only the
// supplied superseded tokens from this user's registrations. Never delete other devices.
const saveRegistration = async (_, token, supersededTokens: string[] = []) => {
  try {
    await saveTokenToBackend(token);
    await removeSupersededTokensFromBackend(supersededTokens.filter((previous) => previous !== token));
    ipcRenderer.send(TOKEN_REGISTERED, { namespace, token });
  } catch {
    // Retry persistence in your app. Do not acknowledge a failed save or cleanup.
    console.warn('Unable to save push registration');
  }
};
ipcRenderer.on(createEventName(namespace, NOTIFICATION_SERVICE_STARTED), saveRegistration);
ipcRenderer.on(createEventName(namespace, TOKEN_UPDATED), saveRegistration);
// Handle notification errors
ipcRenderer.on(createEventName(namespace, NOTIFICATION_SERVICE_ERROR), (_, error) => {
  // do something
});
// Display notification
ipcRenderer.on(createEventName(namespace, NOTIFICATION_RECEIVED), (_, notification) => {
  // display notification
});

// Start service
ipcRenderer.send(START_NOTIFICATION_SERVICE, {
  namespace,
  credentials: { appId, apiKey, projectId, vapidKey },
});
// or
window.ipc.send(START_NOTIFICATION_SERVICE, {
  namespace,
  credentials: { appId, apiKey, projectId, vapidKey },
});

// Optionally namespace events (e.g. when using multiple renderer contexts)
const settingsNamespace = 'settings';
ipcRenderer.send(START_NOTIFICATION_SERVICE, {
  namespace: settingsNamespace,
  credentials: { appId, apiKey, projectId, vapidKey },
});
ipcRenderer.on(createEventName(settingsNamespace, NOTIFICATION_RECEIVED), (_, notification) => {
  // handle notification scoped to this namespace
});
ipcRenderer.send(STOP_NOTIFICATION_SERVICE, { namespace: settingsNamespace });
```

All renderer-side events are emitted with the namespace-aware helpers above. `createEventName(namespace, baseEvent)` mirrors the namespacing used on the main process and ensures each renderer context listens on the correct channel.

### Registration migration and cleanup

The receiver replaces registrations cached by older versions once because their endpoint could
be bound to a different VAPID key. Subsequent starts reuse the corrected registration.

`TOKEN_UPDATED` and `NOTIFICATION_SERVICE_STARTED` keep the token as their first payload argument,
and add a `supersededTokens: string[]` argument. These are only registrations previously cached
under this namespace and Firebase project on this installation, not a list of the user's other devices.
The receiver persists and replays them across restarts until the renderer sends `TOKEN_REGISTERED`
with the current `{ namespace, token }` after a successful backend save and cleanup.
Consumers that ignore the extra argument still receive the new token, but must implement this
acknowledgement flow to retire their old backend registrations.

Changing Firebase projects never retires registrations in the new project's database using
IDs from the old project. Stopping a service or destroying its window cancels pending startup.

The namespace is the app's stable cache and event-routing identity. Each new Google endpoint
gets its own random provider scope, saved with its credentials and reused on reconnect.
Do not use a shared doctor/user ID as the provider subscription scope across installations.

### Where to find `appId`, `apiKey`, `projectId` and `vapidKey`

1. Go to [Firebase Console](https://console.firebase.google.com/) & login to your account
2. Select your project
3. Click on the `Project Settings` cog icon
4. Click on `Project Settings`
5. Make sure you're on the `General` tab
6. Scroll down to the `Your apps` section
7. If you don't have an app, click on `Add app`
   - Select `Web`
   - Fill in the required fields
   - Click on `Register`
8. Copy the `appId`, `apiKey`, `projectId` listed under the `SDK setup and configuration` section
9. (Optional) Copy the `vapidKey` listed under the `Cloud Messaging` tab and `Web Configuration > Web Push certificates` section
10. (Optional) Generate a new `key pair` and use the value in the `Key pair` column as your `vapidKey`

Use the existing public key for the selected Firebase project; do not rotate it to repair a
cached registration. The receiver uses that key for both endpoint creation and FCM registration.
If omitted, it follows the Firebase JS SDK default-key protocol, including omitting
`web.applicationPubKey`. No private VAPID key belongs in your Electron app.

## Moving from `electron-push-receiver`

[`electron-push-receiver`](https://github.com/MatthieuLemoine/electron-push-receiver) library stopped working because it depends on the [Legacy FCM API](https://firebase.google.com/docs/cloud-messaging/migrate-v1) which was deprecated on June 21st, 2024 by Google.

This package is a fork of the `electron-push-receiver` package that has been updated to work with the new Firebase Cloud Messaging (FCM) protocol.

I'm giving all credits to [Matthieu Lemoine](https://github.com/MatthieuLemoine) for the initial work and all the contributors for the `electron-push-receiver` package. I only updated the package to work with the new FCM protocol.

### What's new

- Uses the new FCM protocol ([HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/migrate-v1))
- Uses updated dependencies (without any critical vulnerabilities)
- Remove unnecessary, deprecated and vulnerable dependencies (e.g. `request-promise`, `electron-config`)
- Simplified the codebase
- Latest Node.js (v22)
- Refactor tests and use [vitest](https://vitest.dev/) for testing
- Completely written in TypeScript

> [!CAUTION]
> Breaking changes - Instead of providing just a `senderId`, you now must provide `appId`, `apiKey`, `projectId` and optionally a `vapidKey`. See the updated [usage example](#usage).
>
> > Google deprecated https://fcm.googleapis.com/fcm/connect/subscribe (/send too), which is slated for full removal on June 22, 2024. (Source: https://firebase.google.com/docs/cloud-messaging/migrate-v1)

## Development

1. Make sure you have the right Node.js version installed (specified in `.nvmrc` file)
2. Install dependencies with `npm install`
3. Duplicate `.env.template` to `.env` and fill in the required fields
4. Run tests with `npm run test`
5. Everything should works :)
