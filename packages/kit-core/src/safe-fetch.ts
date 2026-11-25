import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { IntegrationError, errorForStatus, toIntegrationError } from './errors.js';

/**
 * Outbound calls to platforms (contract §8). Every connector call goes through here:
 * - https only (plain http only when a test asks for it explicitly);
 * - the host must be on the connector's allow-list (exact name, or a sub-domain of an entry written as ".example.com");
 * - the name must not resolve to a private, loopback, link-local or otherwise internal address (SSRF guard), checked right before the call;
 * - a timeout and a cap on the response size;
 * - non-2xx answers become IntegrationErrors with the right class (see errors.ts).
 *
 * Known limit: fetch resolves the name again itself, so a DNS answer that changes between our check and the call is not caught. The
 * allow-list (platform hosts only) is the main guard; the address check is the second line.
 */
export interface SafeFetchOptions {
  allowHosts: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Tests inject a fake fetch. */
  fetchImpl?: typeof fetch;
  /** Tests inject a fake resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Only for local tests against http://127.0.0.1 — never in production code paths. */
  allowInsecureLocalForTests?: boolean;
  now?: () => Date;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast and reserved
    );
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice('::ffff:'.length));
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  }
  return true; // not an address at all: refuse
}

export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowHosts.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e;
  });
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((r) => r.address);

export async function safeFetch(url: string, init: RequestInit, opts: SafeFetchOptions): Promise<SafeResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IntegrationError('bad_url', 'invalid platform URL', 'permanent');
  }
  const localTest = opts.allowInsecureLocalForTests === true && parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !localTest) throw new IntegrationError('insecure_url', 'platform URLs must use https', 'permanent');
  if (!localTest) {
    if (!hostAllowed(parsed.hostname, opts.allowHosts)) throw new IntegrationError('host_not_allowed', `host ${parsed.hostname} is not on this connector's allow-list`, 'permanent');
    const addresses = isIP(parsed.hostname) ? [parsed.hostname] : await (opts.lookup ?? defaultLookup)(parsed.hostname).catch(() => [] as string[]);
    if (addresses.length === 0) throw new IntegrationError('dns', `could not resolve ${parsed.hostname}`, 'retryable');
    if (addresses.some(isPrivateAddress)) throw new IntegrationError('private_address', `${parsed.hostname} resolves to an internal address`, 'permanent');
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let res: Response;
  try {
    res = await fetchImpl(parsed, { ...init, redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (error) {
    throw toIntegrationError(error);
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new IntegrationError('too_large', 'platform answer is too large', 'permanent');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new IntegrationError('too_large', 'platform answer is too large', 'permanent');
  const text = buf.toString('utf8');
  const err = errorForStatus(res.status, { retryAfter: res.headers.get('retry-after'), detail: text, ...(opts.now ? { now: opts.now() } : {}) });
  if (err) throw err;
  return {
    status: res.status,
    headers: res.headers,
    text,
    json<T>() {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new IntegrationError('bad_response', 'platform answer is not valid JSON', 'retryable');
      }
    },
  };
}
