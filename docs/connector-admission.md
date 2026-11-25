# Connector admission policy (decision ق-ت13)

A new official connector is built only when ALL of these hold, and the decision is written down here:

1. **Official interface and written permission** from the platform. No scraping, no unofficial endpoints, ever.
2. **Demand**: at least **5 paying customers** ask for it, or the owner decides it is strategic.
3. **A named owner** of the connector and a runbook for its failures.
4. **Pricing covers maintenance**: about 10–20 % of the build effort every year.
5. **An exit plan**: how it is switched off without breaking customers' work.

## Register

| connector | status | admitted because | owner | exit plan |
|---|---|---|---|---|
| paymob | built (docs-verified) | strategic: online payment in every product's store | V CODER | owners fall back to cash on delivery; links stop being offered |
| whatsapp | built (docs-verified) | strategic: notifications in every product | V CODER | messages fall back to the existing wa.me links |
| delivery simulator | built | needed to build and prove the delivery layer before a partner exists | V CODER | it is a test tool |
| delivery middleware (Deliverect / Grubtech / UrbanPiper) | waiting for ق-ت3 partner choice | strategic (owner decision ق-ت3) | — | channel paused; the platform's tablet still works |
| ETA e-receipt transport | blocked on ق-م18 (tax adviser) | legal obligation | — | — |
