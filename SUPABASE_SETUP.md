# Supabase PostgreSQL integration (review branch only)

This branch has NOT been deployed or merged.

## Setup
1. Create a Supabase project and obtain its PostgreSQL connection string from **Connect**. Prefer a session-pooler connection string compatible with IPv4 hosting. Use SSL and keep credentials private.
2. Configure Render environment variables (only at deployment time):
   - `DATABASE_URL`: Supabase PostgreSQL connection string
   - `CREDENTIAL_ENCRYPTION_KEY`: 64 hex characters representing 32 random bytes (generate locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
3. Install dependencies and start the backend. Tables are created on startup. Never commit either secret.
4. Test against a separate Supabase project and non-production provider account before any production deployment.

## Behavior
- Schedules, legs, logs, and delivered history are stored in PostgreSQL.
- API keys are encrypted using AES-256-GCM before database storage. Keep the encryption key backed up securely; losing it makes pending credentials unreadable.
- A database claim prevents simultaneous workers from submitting the same waiting leg.
- After a restart, waiting legs are still in PostgreSQL and are picked up once the service is running again.
- In-flight submissions interrupted by a restart are marked `uncertain`, not retried automatically. Provider timeouts without a definitive rejection are also marked `uncertain`. Verify these in YoYoMedia before any manual resubmission.
- Deleting a schedule removes its pending legs. Previously submitted provider orders are not cancelled.

## Known limitations / release blockers
- Render Free sleeps when inactive; this branch does **not** execute jobs while the service is asleep. Use an always-on worker/paid instance or a properly designed external scheduled invocation.
- No automatic migration of schedules previously held only in RAM. Deploying this branch restarts the old backend, so wait until all current schedules finish.
- The database contains target links and encrypted provider credentials. Secure database access and rotate secrets if exposed.
- No tests have been executed against a live Supabase project. Test pause/resume, restart recovery, concurrent claims, provider timeout, invalid provider response, deletion and logs before merge.
- No automatic replay of missed times during downtime is desirable without confirming the business policy. On wake, overdue waiting legs execute; review whether this is acceptable.
- Keep exactly one deployment worker until the concurrency and failure recovery scenarios have been tested thoroughly.

## Staging safety mode
Set `TEST_MODE=true` **only on the separate Render test service**. This blocks provider `action=add` through both the scheduler and proxy. Never connect the test service to the production frontend. Remove test mode only after a reviewed deployment plan and explicit approval.

The staging test service needs these environment variables: `DATABASE_URL`, `CREDENTIAL_ENCRYPTION_KEY`, and `TEST_MODE=true`.

**Warning:** This is a development branch, not production-ready. Do not merge or deploy to the production service. Integration tests against a real Supabase database have not been run.
