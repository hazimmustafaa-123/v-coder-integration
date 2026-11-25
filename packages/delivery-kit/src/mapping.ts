import type { ChannelOrder, ExternalMenuItem, MenuItemForChannel } from './types.js';

/**
 * Menu mapping: which of OUR items each platform item is. Suggested automatically (the owner only confirms), checked before going live,
 * and used to turn a platform order into our lines. Matching is by name, written for Arabic menus: diacritics, alef/yaa/taa-marbuta
 * forms, Arabic digits and common filler words do not stop a match.
 */
const DIACRITICS = /[ً-ْٰـ]/g;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .join(' ')
    .trim();
}

const STOP = new Set(['ال', 'و', 'مع', 'the', 'and', 'with', 'من']);

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 0..1 similarity of two names (Dice coefficient on letter pairs of the normalised names; 1 = same after normalisation). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) {
    inter += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * inter) / total;
}

export interface MappingSuggestion {
  externalId: string;
  externalName: string;
  internalId: string | null;
  internalName: string | null;
  score: number;
  /** 'sure' needs only a glance, 'check' needs the owner's eye, 'none' found nothing. */
  confidence: 'sure' | 'check' | 'none';
}

/**
 * Proposes one of our items for each platform item. An item of ours is proposed for at most one platform item (the best scoring pair
 * wins), so two platform items never silently collapse into one of ours. A price that matches too raises the score a little.
 */
export function suggestMappings(external: readonly ExternalMenuItem[], internal: readonly MenuItemForChannel[], opts: { sure?: number; check?: number } = {}): MappingSuggestion[] {
  const sure = opts.sure ?? 0.85;
  const check = opts.check ?? 0.5;
  const pairs: { e: number; i: number; score: number }[] = [];
  external.forEach((ex, e) => {
    internal.forEach((inn, i) => {
      let score = nameSimilarity(ex.name, inn.name);
      if (ex.price !== null && ex.price === inn.price) score = Math.min(1, score + 0.05);
      if (score >= check) pairs.push({ e, i, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const takenE = new Set<number>();
  const takenI = new Set<number>();
  const chosen = new Map<number, { i: number; score: number }>();
  for (const p of pairs) {
    if (takenE.has(p.e) || takenI.has(p.i)) continue;
    takenE.add(p.e);
    takenI.add(p.i);
    chosen.set(p.e, { i: p.i, score: p.score });
  }
  return external.map((ex, e) => {
    const c = chosen.get(e);
    const inn = c ? internal[c.i]! : null;
    return {
      externalId: ex.externalId,
      externalName: ex.name,
      internalId: inn?.internalId ?? null,
      internalName: inn?.name ?? null,
      score: c ? Math.round(c.score * 100) / 100 : 0,
      confidence: !c ? 'none' : c.score >= sure ? 'sure' : 'check',
    };
  });
}

/** A confirmed mapping: platform item id → our item id, or null = deliberately not sold on this channel. */
export type MenuMapping = Record<string, string | null>;

export interface ReadinessIssue {
  code: 'unmapped_items' | 'unknown_internal_item' | 'mapped_to_unavailable' | 'no_branch' | 'tax_mode_unset' | 'no_test_order';
  ar: string;
  items?: string[];
}

/**
 * The go-live checks (study §8): the channel is not switched on until this returns no issue. Every platform item must be mapped or
 * explicitly excluded, every mapped item must exist, the location must point to a branch, the tax mode must be chosen, and a test order
 * must have gone from the channel to the kitchen.
 */
export function checkReadiness(input: {
  externalMenu: readonly ExternalMenuItem[];
  mapping: MenuMapping;
  internalMenu: readonly MenuItemForChannel[];
  branchId: string | number | null;
  taxMode: 'inclusive' | 'exclusive' | null;
  testOrderPassed: boolean;
}): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const internalById = new Map(input.internalMenu.map((m) => [m.internalId, m]));
  const unmapped = input.externalMenu.filter((e) => !(e.externalId in input.mapping)).map((e) => e.name);
  if (unmapped.length) issues.push({ code: 'unmapped_items', ar: `${unmapped.length} صنف من المنصة لسه مش مربوط بصنف عندك ولا مستبعد`, items: unmapped });
  const unknown = Object.entries(input.mapping)
    .filter(([, id]) => id !== null && !internalById.has(id))
    .map(([ext]) => input.externalMenu.find((e) => e.externalId === ext)?.name ?? ext);
  if (unknown.length) issues.push({ code: 'unknown_internal_item', ar: 'فيه ربط على صنف اتمسح من المنيو عندك', items: unknown });
  const unavailable = Object.values(input.mapping)
    .filter((id): id is string => id !== null && internalById.get(id)?.available === false)
    .map((id) => internalById.get(id)!.name);
  if (unavailable.length) issues.push({ code: 'mapped_to_unavailable', ar: 'أصناف مربوطة لكنها «نافدة» عندك دلوقتي (هتتقفل على المنصة تلقائيًا)', items: unavailable });
  if (input.branchId === null || input.branchId === '') issues.push({ code: 'no_branch', ar: 'حدد الفرع اللي هيستلم طلبات المنصة' });
  if (input.taxMode === null) issues.push({ code: 'tax_mode_unset', ar: 'حدد هل أسعار المنصة شاملة الضريبة ولا لأ' });
  if (!input.testOrderPassed) issues.push({ code: 'no_test_order', ar: 'اعمل «طلب تجريبي» واتأكد إنه وصل المطبخ' });
  // an unavailable mapped item is a warning, not a blocker: the availability push closes it on the platform
  return issues;
}

export const BLOCKING_READINESS: ReadonlySet<ReadinessIssue['code']> = new Set(['unmapped_items', 'unknown_internal_item', 'no_branch', 'tax_mode_unset', 'no_test_order']);

export interface TranslatedLine {
  internalId: string;
  name: string;
  quantity: number;
  /** Unit price INCLUDING the modifiers, as the platform charged it. */
  unitPrice: number;
  lineTotal: number;
  note: string | null;
  modifiersText: string | null;
}

/**
 * Turns a platform order into our lines using the mapping. Prices stay the platform's (the customer paid THOSE); our menu price is not
 * applied. Lines whose item is not mapped come back in `unmapped` — the product still takes the order (refusing food a customer paid
 * for is worse) and puts the item's name on the ticket, and the owner is told to map it.
 */
export function translateOrder(order: ChannelOrder, mapping: MenuMapping): { lines: TranslatedLine[]; unmapped: ChannelOrder['lines'] } {
  const lines: TranslatedLine[] = [];
  const unmapped: ChannelOrder['lines'] = [];
  for (const line of order.lines) {
    const internalId = mapping[line.externalItemId];
    const modsPerUnit = line.modifiers.reduce((s, m) => s + m.unitPrice * m.quantity, 0);
    const unitPrice = line.unitPrice + modsPerUnit;
    const modifiersText = line.modifiers.length ? line.modifiers.map((m) => (m.quantity > 1 ? `${m.quantity}× ${m.name}` : m.name)).join('، ') : null;
    if (typeof internalId !== 'string') {
      unmapped.push(line);
      continue;
    }
    lines.push({ internalId, name: line.name, quantity: line.quantity, unitPrice, lineTotal: unitPrice * line.quantity, note: line.note, modifiersText });
  }
  return { lines, unmapped };
}

/** Sanity check of a platform order's arithmetic (a mismatch is logged and shown, never silently "fixed"). */
export function orderArithmeticOk(order: ChannelOrder): boolean {
  const lines = order.lines.reduce((s, l) => s + (l.unitPrice + l.modifiers.reduce((m, x) => m + x.unitPrice * x.quantity, 0)) * l.quantity, 0);
  return lines === order.totals.subtotal && order.totals.subtotal - order.totals.discount + order.totals.deliveryFee === order.totals.total;
}
