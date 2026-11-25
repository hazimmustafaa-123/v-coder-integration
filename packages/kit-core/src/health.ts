/**
 * One connection's health, the same way in every product (reliability mechanism 5). The product gathers the numbers from its own tables;
 * this turns them into a level and reasons that the owner screen, the alerts and the platform's health view all show alike.
 */
export type ConnectionStatus = 'active' | 'paused' | 'needs_owner' | 'disconnected';
export type HealthLevel = 'ok' | 'warning' | 'down' | 'paused' | 'off';

export interface HealthInput {
  status: ConnectionStatus;
  now: Date;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  /** Jobs waiting (outbox) and messages not yet applied (inbox). */
  pendingOut: number;
  pendingIn: number;
  /** Dead letters nobody has replayed or dismissed. */
  dead: number;
  /** The oldest waiting job, if any. */
  oldestPendingAt: Date | null;
  breakerOpen: boolean;
  /**
   * For channels that should be busy (delivery during opening hours): how long without any message is suspicious. null = no expectation
   * (payments and messaging can be quiet for days).
   */
  silenceAlertMs: number | null;
}

export interface HealthReason {
  code: 'needs_owner' | 'dead_letters' | 'breaker_open' | 'backlog' | 'silent' | 'recent_errors';
  ar: string;
}

export interface Health {
  level: HealthLevel;
  reasons: HealthReason[];
}

const BACKLOG_MS = 15 * 60_000;

export function assessHealth(h: HealthInput): Health {
  if (h.status === 'disconnected') return { level: 'off', reasons: [] };
  if (h.status === 'paused') return { level: 'paused', reasons: [] };
  const reasons: HealthReason[] = [];
  let level: HealthLevel = 'ok';
  const worse = (l: HealthLevel) => {
    const rank: Record<HealthLevel, number> = { off: 0, paused: 0, ok: 1, warning: 2, down: 3 };
    if (rank[l] > rank[level]) level = l;
  };
  if (h.status === 'needs_owner') {
    reasons.push({ code: 'needs_owner', ar: 'الربط محتاج تحديث بيانات من صاحب المكان' });
    worse('down');
  }
  if (h.breakerOpen) {
    reasons.push({ code: 'breaker_open', ar: 'المنصة بتفشل باستمرار دلوقتي' });
    worse('down');
  }
  if (h.dead > 0) {
    reasons.push({ code: 'dead_letters', ar: `${h.dead} عملية فشلت نهائيًا ومحتاجة «إعادة المحاولة»` });
    worse('warning');
  }
  if (h.oldestPendingAt && h.now.getTime() - h.oldestPendingAt.getTime() > BACKLOG_MS) {
    reasons.push({ code: 'backlog', ar: `فيه ${h.pendingOut + h.pendingIn} عملية متأخرة` });
    worse('warning');
  }
  if (h.silenceAlertMs !== null) {
    const last = h.lastSuccessAt?.getTime() ?? 0;
    if (h.now.getTime() - last > h.silenceAlertMs) {
      reasons.push({ code: 'silent', ar: 'مفيش أي رسالة من المنصة من فترة طويلة في وقت الشغل' });
      worse('warning');
    }
  }
  if (h.lastErrorAt && (!h.lastSuccessAt || h.lastErrorAt > h.lastSuccessAt) && h.now.getTime() - h.lastErrorAt.getTime() < 10 * 60_000) {
    reasons.push({ code: 'recent_errors', ar: 'آخر محاولة فشلت' });
    worse('warning');
  }
  return { level, reasons };
}
