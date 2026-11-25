/**
 * Attendance days: one row per employee per business day, built from three things and nothing else (the spec «حضور الموظفين الموحّد»,
 * shared by V-Fit and V-SUFRA):
 *
 *  1. the punches (stays: in, out), recorded with a proof and never changed afterwards;
 *  2. the employee's weekly schedule (when they are expected), which turns a missing day into an absence and a punch into lateness;
 *  3. the manager's entry for that day (absent, leave, day off, or present with the times), written with a reason. It sits ON TOP of
 *     what the punches say and wins, so «what the device said» and «what the manager decided» both stay visible.
 *
 * Times inside a day are minutes since the local midnight of the business date; a shift that ends after midnight goes past 1440.
 * Pure code with no dependencies: the same file runs on the terminal, the cloud and the browser.
 */

/** What a manager can set a day to. */
export type DayStatus = 'present' | 'absent' | 'leave' | 'day_off';
export const DAY_STATUSES: readonly DayStatus[] = ['present', 'absent', 'leave', 'day_off'];

/**
 * What the day IS once everything is weighed:
 *  - the four above (from punches or the manager);
 *  - 'in_now': clocked in and not out yet;
 *  - 'forgot': clocked in, never out (no hours until a manager writes the time);
 *  - 'pending': expected today and not in yet, and the shift is not over;
 *  - 'off': not expected and nothing recorded.
 */
export type DayState = DayStatus | 'in_now' | 'forgot' | 'pending' | 'off';

export const DAY_STATE_LABELS: Record<DayState, string> = {
  present: 'حاضر',
  absent: 'غايب',
  leave: 'إجازة',
  day_off: 'يوم راحة',
  in_now: 'حاضر دلوقتي',
  forgot: 'نسي الانصراف',
  pending: 'لسه ما جاش',
  off: 'مش في جدوله',
};

/** An open stay older than this was forgotten: it gives no hours and waits for a manager (same rule on every product). */
export const STALE_OPEN_MINUTES = 16 * 60;

/** Lateness and leaving early count only beyond this many minutes, unless the branch sets its own. */
export const DEFAULT_GRACE_MINUTES = 10;

/** One stay from the punches: in, and out (null while in, or when forgotten). */
export interface Stay {
  staffId: string;
  /** ISO instant. */
  inAt: string;
  /** ISO instant, or null. */
  outAt: string | null;
  /** Closed by the system as forgotten (no out). */
  forgot?: boolean;
  /** How the in and the out were proven ('phone', 'fingerprint', 'manager', 'manual'…). */
  inMethod?: string | null;
  outMethod?: string | null;
  /** The manager who approved a punch without other proof. */
  approvedBy?: string | null;
}

/** The manager's entry for one employee and one business day. Times are minutes since that day's local midnight. */
export interface DayEntry {
  staffId: string;
  /** Business date, YYYY-MM-DD. */
  date: string;
  status: DayStatus;
  inMinute: number | null;
  outMinute: number | null;
  note: string | null;
  /** Why the manager wrote it (required). */
  reason: string;
  /** Who wrote it, and when (ISO). */
  by: string;
  at: string;
}

/** When an employee is expected on one weekday: start and end as HH:MM. An end at or before the start ends the next day. */
export interface ScheduleDay {
  start: string;
  end: string;
}

/** An employee's week. `days[0]` is Sunday … `days[6]` Saturday; null = not expected that day. */
export interface WeeklySchedule {
  staffId: string;
  days: (ScheduleDay | null)[];
}

export interface DayRow {
  staffId: string;
  staffName: string;
  date: string;
  state: DayState;
  /** Where the state comes from: the punches, the manager, the schedule (an absence nobody recorded), or nothing. */
  source: 'punch' | 'manual' | 'schedule' | 'none';
  /** First in and last out, minutes since the day's local midnight (out may pass 1440). */
  inMinute: number | null;
  outMinute: number | null;
  /** Worked minutes (closed stays only, or the manager's times). */
  minutes: number;
  stays: Stay[];
  entry: DayEntry | null;
  /** A forgotten out (or one open too long) that nobody has settled yet. */
  needsCorrection: boolean;
  /** The schedule for that day in minutes, when there is one. */
  expected: { start: number; end: number } | null;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
}

/** Reads instants in the business's own time zone, with an optional day cutoff (a night that runs past midnight). */
export interface ZoneClock {
  /** The business date an instant belongs to. */
  dateOf(iso: string): string;
  /** Minutes from the local midnight of `date` to the instant (negative before it, past 1440 the next day). */
  minuteOf(iso: string, date: string): number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Every date from `from` to `to`, both included (empty when `to` is before `from`). */
export function datesFromTo(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export function zoneClock(timeZone: string, cutoffMinutes = 0): ZoneClock {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (iso: string) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minute: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  };
  const cutoff = Math.max(0, Math.min(1439, Math.trunc(cutoffMinutes || 0)));
  return {
    dateOf(iso) {
      const p = parts(iso);
      return p.minute < cutoff ? addDaysIso(p.date, -1) : p.date;
    },
    minuteOf(iso, date) {
      const p = parts(iso);
      return daysBetween(date, p.date) * 1440 + p.minute;
    },
  };
}

/** 'HH:MM' → minutes, or null when it is not a time. */
export function parseHhmm(v: unknown): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since a day's midnight → 'HH:MM' (past midnight shows the next day's clock time). */
export function formatHhmm(minute: number | null): string {
  if (minute == null) return '';
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** The expected start and end of a schedule day in minutes (an end at or before the start is the next day). */
export function expectedOf(day: ScheduleDay | null | undefined): { start: number; end: number } | null {
  if (!day) return null;
  const start = parseHhmm(day.start);
  let end = parseHhmm(day.end);
  if (start == null || end == null) return null;
  if (end <= start) end += 1440;
  return { start, end };
}

/** Why a schedule is not acceptable, or null. Seven entries, each null or a valid start and end. */
export function scheduleProblem(days: unknown): string | null {
  if (!Array.isArray(days) || days.length !== 7) return 'الجدول لازم يبقى 7 أيام';
  for (const d of days) {
    if (d == null) continue;
    if (typeof d !== 'object') return 'يوم في الجدول مش صحيح';
    const e = expectedOf(d as ScheduleDay);
    if (!e) return 'اكتب ميعاد الحضور والانصراف بالشكل 09:00';
    if (e.end - e.start > 16 * 60) return 'الوردية أطول من 16 ساعة';
  }
  return null;
}

/** Why a manager's entry is not acceptable, or null. */
export function entryProblem(e: { status: unknown; inMinute?: unknown; outMinute?: unknown; reason?: unknown }): string | null {
  if (!DAY_STATUSES.includes(e.status as DayStatus)) return 'اختار حالة اليوم';
  const inM = e.inMinute ?? null;
  const outM = e.outMinute ?? null;
  const isMin = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (inM !== null && !isMin(inM, 0, 1439)) return 'ميعاد الحضور مش صحيح';
  if (outM !== null && !isMin(outM, 1, 2879)) return 'ميعاد الانصراف مش صحيح';
  if (e.status !== 'present' && (inM !== null || outM !== null)) return 'المواعيد بتتكتب ليوم حضور بس';
  if (outM !== null && inM === null) return 'الانصراف محتاج ميعاد حضور';
  if (outM !== null && inM !== null && (outM as number) <= (inM as number)) return 'الانصراف لازم يبقى بعد الحضور';
  if (typeof e.reason !== 'string' || e.reason.trim().length < 3) return 'اكتب السبب';
  return null;
}

/**
 * The day of every employee given. `stays` and `entries` may hold other days and other people: each row takes its own. A stay
 * belongs to the business date of its in.
 */
export function buildDay(input: {
  date: string;
  nowIso: string;
  clock: ZoneClock;
  staff: { id: string; name: string }[];
  stays: Stay[];
  entries: DayEntry[];
  schedules: WeeklySchedule[];
  graceMinutes?: number;
}): DayRow[] {
  const { date, nowIso, clock } = input;
  const grace = Math.max(0, Math.trunc(input.graceMinutes ?? DEFAULT_GRACE_MINUTES));
  const nowMinute = clock.minuteOf(nowIso, date);
  const weekday = weekdayOf(date);
  const staysOf = new Map<string, Stay[]>();
  for (const s of input.stays) {
    if (clock.dateOf(s.inAt) !== date) continue;
    const list = staysOf.get(s.staffId) ?? [];
    list.push(s);
    staysOf.set(s.staffId, list);
  }
  const entryOf = new Map(input.entries.filter((e) => e.date === date).map((e) => [e.staffId, e]));
  const scheduleOf = new Map(input.schedules.map((s) => [s.staffId, s]));

  return input.staff.map((person): DayRow => {
    const stays = (staysOf.get(person.id) ?? []).slice().sort((a, b) => (a.inAt < b.inAt ? -1 : 1));
    const entry = entryOf.get(person.id) ?? null;
    const expected = expectedOf(scheduleOf.get(person.id)?.days[weekday]);
    const row: DayRow = {
      staffId: person.id,
      staffName: person.name,
      date,
      state: 'off',
      source: 'none',
      inMinute: null,
      outMinute: null,
      minutes: 0,
      stays,
      entry,
      needsCorrection: false,
      expected,
      lateMinutes: 0,
      earlyMinutes: 0,
      overtimeMinutes: 0,
    };

    if (entry) {
      row.state = entry.status;
      row.source = 'manual';
      if (entry.status === 'present') {
        const closed = stays.filter((s) => s.outAt && !s.forgot);
        row.inMinute = entry.inMinute ?? (stays[0] ? clock.minuteOf(stays[0].inAt, date) : null);
        row.outMinute = entry.outMinute ?? (closed.length ? clock.minuteOf(closed[closed.length - 1]!.outAt!, date) : null);
        if (entry.inMinute != null && entry.outMinute != null) row.minutes = entry.outMinute - entry.inMinute;
        else row.minutes = closed.reduce((sum, s) => sum + Math.max(0, clock.minuteOf(s.outAt!, date) - clock.minuteOf(s.inAt, date)), 0);
      }
    } else if (stays.length > 0) {
      row.source = 'punch';
      row.inMinute = clock.minuteOf(stays[0]!.inAt, date);
      let open = false;
      let forgot = false;
      for (const s of stays) {
        if (s.outAt && !s.forgot) {
          row.minutes += Math.max(0, clock.minuteOf(s.outAt, date) - clock.minuteOf(s.inAt, date));
          row.outMinute = Math.max(row.outMinute ?? -Infinity, clock.minuteOf(s.outAt, date));
        } else if (s.forgot || nowMinute - clock.minuteOf(s.inAt, date) > STALE_OPEN_MINUTES) forgot = true;
        else open = true;
      }
      row.state = open ? 'in_now' : forgot ? 'forgot' : 'present';
      row.needsCorrection = forgot && !open;
    } else if (expected) {
      row.source = 'schedule';
      row.state = nowMinute > expected.end ? 'absent' : 'pending';
    }

    // lateness, leaving early and overtime: only against a schedule, only on a day worked, only beyond the grace minutes
    if (expected && (row.state === 'present' || row.state === 'in_now' || row.state === 'forgot') && row.inMinute != null) {
      const late = row.inMinute - expected.start;
      if (late > grace) row.lateMinutes = late;
      if (row.outMinute != null && row.state !== 'in_now') {
        const early = expected.end - row.outMinute;
        if (early > grace) row.earlyMinutes = early;
        const over = row.outMinute - expected.end;
        if (over > grace) row.overtimeMinutes = over;
      }
    }
    return row;
  });
}

/** Totals per employee over many days (the rows of every day of a period). */
export interface PeriodTotals {
  staffId: string;
  staffName: string;
  /** Days worked (present, in now, or forgot the out). */
  present: number;
  absent: number;
  leave: number;
  dayOff: number;
  /** Days with a forgotten out nobody settled. */
  forgot: number;
  /** Days a manager wrote. */
  manual: number;
  minutes: number;
  lateDays: number;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
}

export function summarizeDays(rows: DayRow[]): PeriodTotals[] {
  const by = new Map<string, PeriodTotals>();
  for (const r of rows) {
    const t = by.get(r.staffId) ?? { staffId: r.staffId, staffName: r.staffName, present: 0, absent: 0, leave: 0, dayOff: 0, forgot: 0, manual: 0, minutes: 0, lateDays: 0, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0 };
    if (r.state === 'present' || r.state === 'in_now' || r.state === 'forgot') t.present += 1;
    if (r.state === 'absent') t.absent += 1;
    if (r.state === 'leave') t.leave += 1;
    if (r.state === 'day_off') t.dayOff += 1;
    if (r.needsCorrection) t.forgot += 1;
    if (r.source === 'manual') t.manual += 1;
    t.minutes += r.minutes;
    if (r.lateMinutes > 0) t.lateDays += 1;
    t.lateMinutes += r.lateMinutes;
    t.earlyMinutes += r.earlyMinutes;
    t.overtimeMinutes += r.overtimeMinutes;
    by.set(r.staffId, t);
  }
  return [...by.values()].sort((a, b) => a.staffName.localeCompare(b.staffName, 'ar'));
}

/** Minutes as «8 س 30 د». */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} س ${m % 60} د` : `${m % 60} د`;
}
