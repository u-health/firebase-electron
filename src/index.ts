export { listen } from './core/listen';
export { register } from './core/register';
export { setup } from './electron/index';
export {
  START_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  STOP_NOTIFICATION_SERVICE,
  TOKEN_UPDATED,
  createEventName,
} from './electron/consts';
