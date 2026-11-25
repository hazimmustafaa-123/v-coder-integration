/**
 * What every connector declares about itself (contract §5). The product's owner screen is built from this: the fields to ask for, the
 * way to activate, and what the connector can do. Nothing here knows about restaurants, shops or gyms.
 */
export type ConnectorKind = 'payments' | 'delivery' | 'messaging' | 'tax';

/**
 * - keys: the owner pastes keys from the platform's dashboard; we test them live before saving;
 * - oauth: the owner signs in on the platform and approves (no key is ever shown);
 * - partner: the account is opened through a partner (a delivery middleware) and we receive an account id.
 */
export type ActivationKind = 'keys' | 'oauth' | 'partner';

export interface CredentialField {
  key: string;
  labelAr: string;
  /** Secret fields are never shown again after saving (only their last 4 characters). */
  secret: boolean;
  /** Where the owner finds it, in plain Arabic. */
  helpAr?: string;
  /** A light format check before the live test. */
  pattern?: string;
  optional?: boolean;
}

export interface ConnectorManifest {
  id: string;
  nameAr: string;
  nameEn: string;
  version: string;
  kind: ConnectorKind;
  activation: ActivationKind;
  credentialFields: readonly CredentialField[];
  capabilities: readonly string[];
  /**
   * How far this connector has been proven: 'docs' = written from the platform's public documentation and tested against recorded and
   * simulated messages only; 'sandbox' = passed the platform's test environment; 'certified' = the platform approved it.
   */
  verifiedAgainst: 'docs' | 'sandbox' | 'certified';
  docsUrl?: string;
}

export type ConnectionTest = { ok: true; accountLabel?: string } | { ok: false; code: string; detail?: string };

/** Light checks of the owner's input against the manifest, before any call to the platform. Returns the bad field keys. */
export function checkCredentialFields(manifest: ConnectorManifest, input: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const f of manifest.credentialFields) {
    const v = input[f.key];
    if (v === undefined || v === null || v === '') {
      if (!f.optional) bad.push(f.key);
      continue;
    }
    if (typeof v !== 'string' || v.length > 4096) {
      bad.push(f.key);
      continue;
    }
    if (f.pattern && !new RegExp(f.pattern).test(v.trim())) bad.push(f.key);
  }
  return bad;
}

/** Keeps only the manifest's fields, trimmed. Anything else the browser sent is dropped. */
export function pickCredentials(manifest: ConnectorManifest, input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of manifest.credentialFields) {
    const v = input[f.key];
    if (typeof v === 'string' && v.trim() !== '') out[f.key] = v.trim();
  }
  return out;
}
