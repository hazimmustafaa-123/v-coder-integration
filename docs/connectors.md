# Connector verification checklists

Every connector here was written from the platform's public documentation and tested against recorded/simulated messages only
(`verifiedAgainst: 'docs'`). Nothing was sent to any company and no account was opened (owner's instruction, 2026-11-25). Before the
first real customer uses a connector, run its checklist against the platform's test environment and set `verifiedAgainst: 'sandbox'`.

## Paymob

Needs: a Paymob test merchant account (owner opens it — study phase 0 task 5).

1. `POST /api/auth/tokens` with the API key returns `token` → «اختبر الاتصال» works.
2. `POST /v1/intention/` with `Authorization: Token <secret key>`, body as in `createIntention`, returns `client_secret`; the checkout link
   `unifiedcheckout/?publicKey=…&clientSecret=…` opens Paymob's page.
3. A test card payment triggers the transaction callback to `notification_url` with `?hmac=`; `verifyTransactionCallback` accepts it
   (confirms the field list and order in `HMAC_FIELDS`).
4. **Confirm** that `special_reference` comes back as `order.merchant_order_id` (or note where it appears) — `normalizeTransaction`
   reads both.
5. `GET /api/acceptance/transactions/{id}` with the Bearer token returns the same transaction (the "confirm by query" step).
6. `POST /api/ecommerce/orders/transaction_inquiry` with `merchant_order_id` finds a payment whose callback was blocked (reconciliation).
7. Wallet payment (integration id of the wallet) goes through the same callback.
8. Refund of a test payment.

## WhatsApp Cloud API

Needs: a Meta business account, an app, a test phone number (Meta gives one), a system-user token.

1. `GET /{phone-number-id}?fields=display_phone_number,verified_name` (the connection test).
2. Send the `hello_world` template to a verified test recipient.
3. Webhook subscription: Meta's `hub.challenge` answered by `answerVerification`.
4. `x-hub-signature-256` verified on a real webhook (`verifyWebhookSignature`).
5. Statuses `sent` → `delivered` → `read` parsed (`parseWebhook`).
6. Free text refused outside the 24-hour window → error 131047 → `outside_window`.
7. For one-click activation: V CODER registers as a Meta **Tech Provider** (business step) — then switch activation to `oauth`.

## Delivery channels

The neutral contract (`@v-coder/delivery-kit`) and the simulator are complete. A real adapter is written once the partner is chosen
(ق-ت3, criteria in the study §12): it implements `DeliveryConnector` (parseInbound with the partner's signature scheme, pushStatus,
pushAvailability, setStoreOpen, listMenu, listOrdersSince). The product side does not change.
