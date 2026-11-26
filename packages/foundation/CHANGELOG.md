# @v-coder/foundation

## 0.2.0 — 2026-11-26
Additive. Language checks for VC-STD-15 (every product in Arabic and English):
- `@v-coder/foundation/i18n`: `checkDictionaries(ar, en)` — missing keys either way, empty text, different `{placeholders}` or plural variables, Arabic letters inside English, English that is just the Arabic.
- `@v-coder/foundation/i18n/scan` and the `v-coder-i18n-scan` command: counts Arabic typed in code per file and fails when it grows past the baseline file kept in the repository (a ratchet: it only goes down, new files start at zero).

## 0.1.0 — 2026-11-25
First release (م-2.1 of the cross-product study). Moved here unchanged, with their tests, from the copies the products held:
- `data-io`: from V-MART `packages/data-io` (identical to V-SUFRA `apps/cloud/src/data-io`);
- `web-push`: from V-SUFRA `apps/cloud/src/web-push.ts` (identical to V-MART's);
- `attendance-days`: from V-SUFRA `packages/shared/src/attendance-days.ts` (same rules as V-Fit's `packages/domain/src/attendance-days.ts`).
