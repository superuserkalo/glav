# Snapshot renewal

Glav's Cloudflare container disk is ephemeral. Each chat stores the ID of its latest filesystem snapshot in Durable Object storage. Cloudflare retains a snapshot for 30 days after creation or its most recent restore.

Automatic renewal restores that snapshot after 21 days without a successful save or restore. This leaves nine days for retries. The maintenance container uses `sleep infinity`, has internet access disabled, runs `true` to confirm readiness, and is destroyed immediately afterward. Renewal does not open a conversation, call a model, send Telegram messages, or replace the saved snapshot with a new one.

The conversation watchdog and renewal share the Durable Object's single alarm. Their deadlines are stored separately, and transactions schedule the earlier deadline. Renewal, normal container acquisition, and snapshot saving share a lock so maintenance cannot destroy a container already acquired by a user.

The watchdog explicitly stops a saved computer after five minutes without computer use, once no agent work is owed. Polling a running container every minute would reset its inactivity timeout indefinitely. The idle watchdog now schedules the actual shutdown deadline instead. Unsaved work keeps the computer alive.

A running user container postpones maintenance for an hour. A failed restore keeps the existing snapshot ID and expiry estimate, records the error, and schedules an hourly retry. The retry is persisted before starting the container, so it survives object eviction and does not rely on the platform's six automatic retries. A successful save or restore resets the schedule and clears prior renewal errors.

Older snapshots have no recorded creation date. When their object first wakes after deployment, renewal is scheduled immediately. Deploying Worker code alone does not wake every dormant object. During rollout, query existing chat IDs from D1's `usage` table and call the maintenance endpoint for each to initialize their alarms. This inventory may omit objects that never successfully reported usage.

## Operator checks

`POST /snapshot-retention?chat=<id>` requires the existing `Authorization: Bearer <AGENT_SECRET>` header. It returns the container's running state, saved snapshot ID, and retention metadata without opening the conversation. Sending `{"renew":true}` requests immediate renewal; a running user computer is still left alone. Ordinary `/status` responses also include `computer.retention`.

Worker and Durable Object code updates propagate independently. During rollout, an older object can briefly lack the maintenance method. The endpoint responds with HTTP 503 and `Retry-After: 60` in that case. Retry activation after propagation rather than interrupting the object.

Retention metadata contains `retainedAt`, estimated `expiresAt`, `nextAttemptAt`, consecutive `failures`, and `lastError` when present. Timestamps are Unix milliseconds. Legacy snapshots initially have an unknown expiry. The expiry estimate is updated only after a successful snapshot save or verified restore.

## What this protects

This is a renewal workaround for expiring snapshots, not permanent storage or an independent backup. An outage or scheduling failure lasting through the remaining retention period can still let the snapshot expire. Renewal cannot recover a snapshot that has already expired, or filesystem changes absent from the latest successful snapshot.

The follow-up is tracked in [TODO: durable storage for documents and memory](../TODO.md#durable-storage-for-documents-and-memory).

Snapshots preserve files, not running processes or memory. They are tied to their original container image version. Preserve that image during Worker-only deployments; changing the image requires a separate migration plan for files.

## Verification

Run `npm run typecheck` and `GLAV_TEST_NO_COMPUTER=1 npm test` from the repository root. Tests simulate repeated renewals across months, eviction, legacy migration, persistent retries, readiness failure, expiry, competing watchdog deadlines, and user acquisition during maintenance. The Worker integration test verifies operator authorization and that maintenance does not send Telegram messages.

Local container-free tests do not establish Cloudflare's actual restore or retention behavior. Verify a real snapshot restore through the operator endpoint during rollout, and inspect its updated retention metadata.

The 2026-10-11 rollout preserved the deployed container image and passed 26 integration tests against its isolated Worker bundle. Both existing chats discovered through D1 successfully renewed their real snapshots at 12:01 UTC: the saved snapshot IDs stayed unchanged, the maintenance containers stopped, failures were zero, and metadata scheduled the next renewal in 21 days with an estimated expiry in 30 days.

Sources: [Cloudflare snapshots](https://developers.cloudflare.com/containers/guides/snapshots/), [container lifecycle API](https://developers.cloudflare.com/containers/api/durable-object-container/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
