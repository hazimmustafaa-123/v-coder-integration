export { IntegrationError, errorForStatus, parseRetryAfter, toIntegrationError, type ErrorClass } from './errors.js';
export { DEFAULT_RETRY, FAST_RETRY, backoffMs, decideRetry, type RetryDecision, type RetryPolicy } from './retry.js';
export { CircuitBreakers, DEFAULT_BREAKER, type BreakerOptions, type BreakerState } from './breaker.js';
export { ENVELOPE_FORMAT, isEnvelope, makeEnvelope, type EventEnvelope } from './envelope.js';
export {
  WEBHOOK_TOLERANCE_SECONDS,
  generateWebhookSecret,
  hmacBase64,
  hmacHex,
  safeEqual,
  signWebhook,
  verifyWebhook,
  type SignedWebhookHeaders,
  type WebhookVerifyResult,
} from './signatures.js';
export {
  SEALED_PREFIX,
  SealedValueError,
  maskSecrets,
  needsRotation,
  newKeyringEntry,
  openCredentials,
  parseKeyring,
  sealCredentials,
  type Keyring,
} from './credentials.js';
export { hostAllowed, isPrivateAddress, safeFetch, type SafeFetchOptions, type SafeResponse } from './safe-fetch.js';
export { runJobsOnce, type Job, type JobError, type JobHandler, type JobOutcome, type JobStore, type RunOptions, type RunSummary } from './jobs.js';
export { ownerMessage, type OwnerMessage } from './messages.js';
export { assessHealth, type ConnectionStatus, type Health, type HealthInput, type HealthLevel, type HealthReason } from './health.js';
export {
  checkCredentialFields,
  pickCredentials,
  type ActivationKind,
  type ConnectionTest,
  type ConnectorKind,
  type ConnectorManifest,
  type CredentialField,
} from './connector.js';
export { idempotencyKey, reconcileById, type ReconcileResult } from './reconcile.js';

/** The library's own version, reported in health so we always know which build a product runs. */
export const KIT_VERSION = '0.1.0';
