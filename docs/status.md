# Status — 2026-11-25

Owner's instruction: «انا مش هعمل ربط مع حد دلوقتي بس حابب احضرها من دلوقتي خلص المراحل كلها مره واحد». Everything below is built and
tested against public documentation, recorded messages, fakes and the delivery simulator. **No company was contacted, no account was
opened, nothing was deployed.**

| phase (study §17) | where | state |
|---|---|---|
| 0 founding | this repo `docs/` | contract, release policy, admission policy, connector checklists, licence draft, partner term sheet draft, middleware desk comparison |
| 1 library + V-SUFRA + Paymob | this repo 0.1.0; V-SUFRA branch `feature/integrations` | kit-core, Paymob, WhatsApp, delivery kit (68 tests); V-SUFRA layer + store online payment + owner screen (22 tests, full cloud suite green) |
| 2 delivery channels | V-SUFRA branch | neutral contract + simulator end to end (orders, statuses, sold-out, reconciliation, acceptance watchdog, go-live checks). Real adapter waits for the partner (ق-ت3) |
| 3 V-MART + V-Fit + WhatsApp | V-MART / V-Fit branches `feature/integrations` | both on the kit: connections with live test, Paymob payment links, callbacks, reconciliation, expiry; V-MART screen; V-Fit API (its web screen is a follow-up) |

Consumer matrix (`node scripts/consumer-matrix.mjs`): V-SUFRA 22, V-MART 9, V-Fit 4 — all green on 2026-11-25.

## Before the first real customer

1. Paymob test account → run `docs/connectors.md` checklist → `verifiedAgainst: 'sandbox'`.
2. Meta app + test number → WhatsApp checklist.
3. Partner chosen (ق-ت3) → write its `DeliveryConnector` adapter; certification.
4. Lawyer (ق-ت10), V-SUFRA partner agreement before any paid add-on (ق-ت6), security review of the inbound endpoints (ق-ت9).
5. Server: keyring file + worker service per product (each product's deploy notes); merge the branches; deploy staging first.
