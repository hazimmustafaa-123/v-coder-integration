# Phase 0 — what was done, what waits

Owner's instruction (2026-11-25): «انا مش هعمل ربط مع حد دلوقتي بس حابب احضرها من دلوقتي خلص المراحل كلها مره واحد». So every
deliverable that needs no outside party is done; everything that needs a company, an account, a lawyer or the partner is prepared and
waiting.

| # | task (study §18) | state |
|---|---|---|
| 1 | integration contract | done — `docs/integration-contract.md` |
| 2 | library design | done — this repository, `docs/release-policy.md` |
| 3 | middleware comparison | desk part done below; calls need the owner |
| 4 | partnership messages | drafts in the study §20; **not sent** |
| 5 | Paymob test account | **not opened** (needs the owner); checklist in `docs/connectors.md` |
| 6 | lawyer | **not contacted**; questions in the study §20; licence draft in `LICENSE.md` |
| 7 | V-SUFRA partner term sheet | draft below; **not discussed** |
| 8 | integrations screen prototype | replaced by the real screens built in the products |
| 9 | end-of-phase review | this file |

## Middleware comparison (desk only — every cell must be confirmed by the vendor)

| criterion | Deliverect | Grubtech | UrbanPiper |
|---|---|---|---|
| talabat in the region | yes (Delivery Hero integration listed) | yes (Foodics partnership: talabat, Careem, Jahez) | lists talabat among its channels |
| Egypt coverage, elmenus, Mrsool | to confirm | to confirm | to confirm |
| price per location | indicative AED 700–1,500/month in UAE (unverified blog) | to ask | to ask |
| POS partner programme | yes (many POS listed) | yes | yes |
| data location / DPA | to ask (EU company) | to ask (UAE) | to ask (India) |

## V-SUFRA partner term sheet (draft for discussion, not legal text)

1. The integration library and the shared connectors (payments, WhatsApp, tax) belong to V CODER and are licensed to V-SUFRA (`LICENSE.md`).
2. Restaurant-only connectors (delivery channels): ownership — **to agree** (proposal: V CODER owns the code; V-SUFRA has a perpetual
   licence).
3. Income from paid add-ons in V-SUFRA (delivery channels, extra WhatsApp volume): split — **to agree**; middleware costs are passed
   through to the restaurant before any split.
4. Support of integrations (alerts, incidents during rush hours): who staffs it and who pays — **to agree**.
5. End of partnership: V-SUFRA keeps a perpetual licence to the versions it holds, without updates — **to agree**.
6. Until signed: integrations in V-SUFRA are free or not offered; **no paid add-on**.
