# V CODER integration contract (v1)

The rules every V CODER product follows for integrations (phase 0, task 1 of the study). The library implements the shared parts; each
product implements the rest in the same shape, so a reader of one product finds the same thing in the others.

## 1. Where things live

| layer | contents | location |
|---|---|---|
| core library | envelope, jobs runner, retries, breaker, signatures, credential sealing, safe HTTP, health, owner messages | `@v-coder/integration-kit` |
| shared connectors | Paymob, WhatsApp, ETA transport (later) | `@v-coder/connector-*` |
| product integration layer | tables, worker process, IntegrationPort, owner screen, plan gating | inside each product |
| single-product connectors | delivery channels (V-SUFRA), marketplaces and shipping (V-MART) | inside that product |

V CODER's platform (the console) only: enables a paid add-on (`setPlan` addons), pushes a kill switch that the product stores, reads
`health()`. It is never on the path of an order, a payment or a message. If it is down, integrations keep working.

## 2. Event envelope

`{ fmt: 'vc1', id, type, version, tenant, occurredAt, data }` (`makeEnvelope`). `type` = `<product>.<entity>.<event>`
(`sufra.order.status_changed`). `tenant` is always set by our code, never taken from a platform message. `version` is the version of `data`
for that type; additive changes keep it, breaking ones bump it.

## 3. Tables every product has (names may carry the product's prefix; columns are the contract)

- **connections**: one per (tenant, connector, optional branch/location): `status` (`active` | `paused` | `needs_owner` |
  `disconnected`), `credentials` (sealed, `vcs1.` format), `config` (jsonb, non-secret), `last_success_at`, `last_error_code`,
  `last_error_at`, `created_at`, `updated_at`.
- **jobs** (outbox and inbox in one table with `direction`): `tenant`, `connector`, `direction` (`out` | `in`), `kind`,
  `external_event_id` (inbox: unique per tenant+connector, the duplicate guard), `payload`, `state` (`pending` | `leased` | `done` |
  `dead`), `attempts`, `due_at`, `lease_until`, `last_error_code`, `last_error`, `created_at`, `done_at`.
- **external_refs**: `(tenant, system, entity, external_id) → internal_id`, unique. Mapping, duplicate guard, and the way back from a
  platform's id to ours.
- **integration_audit**: who connected, disconnected, changed credentials, replayed or dismissed a dead letter, paused or resumed.

Every tenant table: RLS ENABLE + FORCE with the product's usual tenant policy. The worker finds due work across tenants through ONE narrow
`SECURITY DEFINER` function that returns only (tenant, job id) pairs; it then processes each job inside that tenant's own context.

## 4. Writing jobs

An outbox job is written **in the same transaction** as the change that causes it. An inbox message is saved **before** the platform is
answered (2xx only after a durable write). A platform message with a bad signature is answered 401 and never stored as a job.

## 5. Money, time, numbers

Money: integer minor units (piastres) + ISO currency. Time: ISO-8601 UTC instants; the business day is the product's own rule. Phones:
Egyptian mobiles normalised (`201xxxxxxxxx` for WhatsApp, the product's usual form elsewhere). Idempotency: `Idempotency-Key` on writes we
expose; `idempotencyKey(...)` for our outbound calls where the platform supports one.

## 6. The IntegrationPort

Each product has ONE module through which connectors reach its rules (create a channel order, mark a payment paid, list the menu for
mapping, read sold-out items…). Functions, not HTTP. **No business rule inside a connector**: a connector translates and calls the port.
A future public API, if ever approved, is another adapter over the same port.

## 7. Permissions

Names `resource:action` inside the product's existing permission catalogue (`integrations:manage`, `integrations:view`). Only holders of
`integrations:manage` connect, disconnect, change credentials or replay dead letters.

## 8. Owner-facing behaviour

The owner screen shows per connection: status colour, last success, last error in plain Arabic with its action button
(`ownerMessage`), waiting jobs, dead letters with «إعادة المحاولة», and pause/disconnect. Credentials are tested live before they are saved
and never shown again (last 4 characters only).

## 9. Versioning of stored formats

Sealed credentials (`vcs1.<keyId>…`), envelopes (`fmt: 'vc1'`) and job kinds are versioned. A worker that meets a job kind it does not
know leaves it pending (attempt not counted) — this is what makes rolling the library or the product back safe.
