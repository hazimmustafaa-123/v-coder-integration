# V CODER integration kit

The shared integration library of V CODER (decision ق-ت8 of the integration study,
https://claude.ai/artifact/1sAMpvpGqmopj7gzSLScFJ). V CODER builds and runs every official integration itself (Managed Integrations);
this repository holds what is common to all products so it is written once:

| package | what it is |
|---|---|
| `@v-coder/integration-kit` (`packages/kit-core`) | event envelope, outbox/inbox job runner with retries and circuit breaker, Standard Webhooks signatures, credential encryption, safe outbound HTTP (allow-list, SSRF guard, timeout, size cap), health assessment, Arabic owner messages, reconciliation helpers |
| `@v-coder/connector-paymob` | Paymob (Egypt): payment intention + hosted checkout link, signed callback check, confirmation by query, refund |
| `@v-coder/connector-whatsapp` | WhatsApp Business Cloud API: templates, text, signed webhooks, delivery statuses |
| `@v-coder/delivery-kit` | the neutral delivery-channel contract, Arabic-aware menu mapping, go-live checks, a simulated delivery platform |

## Rules (non-negotiable)

1. **A build-time dependency, never a service.** Each product pins an exact version from a `.tgz` file kept in its own repository
   (`vendor/v-coder/`). Nothing here calls V CODER's platform or any V CODER server. If this repository disappeared, every product would
   still build and run with the version it holds.
2. **No database, no product knowledge.** Storage is an interface each product implements over its own tables (its RLS, its migrations).
   Nothing here knows what a restaurant, a shop or a gym is.
3. **No runtime dependencies** besides Node ≥ 22 itself. Published as compiled ESM JavaScript with type declarations (V-Fit runs
   TypeScript directly, and Node does not strip types inside `node_modules`).
4. **Not on cashier devices.** Product clouds only.

See `docs/` for the integration contract, the release and rollback policy, the connector admission policy and each connector's
verification checklist.

## Work here

```
pnpm install --offline     # dev tools only (typescript, vitest); see package.json pnpm.overrides
pnpm run build             # tsc, core first
pnpm test                  # vitest over every package
node scripts/release.mjs   # build + test + pack into packs/ (refuses to overwrite a released version)
node scripts/consumer-matrix.mjs <packs-dir>   # run each product's integration tests against a candidate (docs/release-policy.md)
```

Ownership: © V CODER. Licensed internally to V CODER's products under `LICENSE.md`.
