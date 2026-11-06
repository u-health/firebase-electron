---
'firebase-electron': patch
---

Report recoverable push-service request failures as warnings, with safe operation, attempt,
HTTP-status and network-error diagnostics. Log successful recovery and keep exhausted retries
at error level without exposing request credentials or notification content.
