---
'firebase-electron': patch
---

Use the same VAPID public key for endpoint creation and FCM registration, including Firebase's
default-key protocol. Replace legacy cached registrations once and report superseded tokens
until the app confirms backend persistence and cleanup. Keep concurrent registrations isolated
and cancel pending startup when the service is stopped.

Preserve existing subscriptions when connecting or reconnecting, and correctly decrypt Google
push messages whose encryption headers contain multiple parameters.

Give each newly created provider registration a distinct opaque scope rather than reusing the
user namespace across devices and token rotations.
