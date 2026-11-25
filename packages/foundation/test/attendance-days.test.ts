import { describe, expect, it } from 'vitest';
import { buildDay, entryProblem, expectedOf, formatHhmm, scheduleProblem, summarizeDays, zoneClock, type DayEntry, type Stay, type WeeklySchedule } from '../src/attendance-days.js';

/**
 * The shared cases of the unified attendance spec. V-Fit runs the same cases against its copy of this module
 * (packages/domain/test/attendance-days.test.ts): change one, change both.
 */
const cairo = zoneClock('Africa/Cairo'); // UTC+2 in November
const staff = [
  { id: 'm', name: 'منى' },
  { id: 's', name: 'سامي' },
];
const nineToFive: WeeklySchedule = { staffId: 'm', days: [null, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, null] };
// 2026-11-16 is a Monday
const DATE = '2026-11-16';
const at = (hhmm: string, date = DATE) => new Date(`${date}T${hhmm}:00+02:00`).toISOString();
const stay = (staffId: string, inHm: string, outHm: string | null, extra: Partial<Stay> = {}): Stay => ({ staffId, inAt: at(inHm), outAt: outHm ? at(outHm) : null, ...extra });
const entry = (staffId: string, e: Partial<DayEntry>): DayEntry => ({ staffId, date: DATE, status: 'present', inMinute: null, outMinute: null, note: null, reason: 'تصحيح', by: 'owner', at: at('20:00'), ...e });
const day = (stays: Stay[], entries: DayEntry[] = [], now = at('20:00'), schedules: WeeklySchedule[] = [nineToFive]) => buildDay({ date: DATE, nowIso: now, clock: cairo, staff, stays, entries, schedules });

describe('the day built from punches', () => {
  it('a full day: first in, last out, worked minutes over the closed stays', () => {
    const [m] = day([stay('m', '09:05', '13:00'), stay('m', '14:00', '17:30')]);
    expect(m).toMatchObject({ state: 'present', source: 'punch', inMinute: 9 * 60 + 5, outMinute: 17 * 60 + 30, minutes: 235 + 210 });
  });

  it('still in: «in now», no early or overtime yet', () => {
    const [m] = day([stay('m', '09:00', null)], [], at('12:00'));
    expect(m).toMatchObject({ state: 'in_now', needsCorrection: false, earlyMinutes: 0, overtimeMinutes: 0 });
  });

  it('a forgotten out gives no hours and waits for a manager, never a guess', () => {
    const [m] = day([stay('m', '09:00', null, { forgot: true })]);
    expect(m).toMatchObject({ state: 'forgot', minutes: 0, needsCorrection: true });
    const [late] = day([stay('m', '09:00', null)], [], at('03:00', '2026-11-17'));
    expect(late).toMatchObject({ state: 'forgot', needsCorrection: true }); // open for 18 hours
  });

  it('a night that runs past midnight belongs to the day it started, and its out passes 1440', () => {
    const s: Stay = { staffId: 's', inAt: at('22:00'), outAt: at('02:00', '2026-11-17') };
    const [, sami] = day([s]);
    expect(sami).toMatchObject({ state: 'present', inMinute: 22 * 60, outMinute: 26 * 60, minutes: 240 });
    expect(formatHhmm(sami!.outMinute)).toBe('02:00');
  });

  it('with a day cutoff, a punch at 01:00 belongs to the night before', () => {
    const late = zoneClock('Africa/Cairo', 4 * 60);
    expect(late.dateOf(at('01:00', '2026-11-17'))).toBe(DATE);
    expect(late.dateOf(at('05:00', '2026-11-17'))).toBe('2026-11-17');
  });
});

describe('the schedule', () => {
  it('lateness and leaving early count only beyond the grace minutes', () => {
    expect(day([stay('m', '09:08', '16:55')])[0]).toMatchObject({ lateMinutes: 0, earlyMinutes: 0 });
    expect(day([stay('m', '09:25', '16:30')])[0]).toMatchObject({ lateMinutes: 25, earlyMinutes: 30, overtimeMinutes: 0 });
    expect(day([stay('m', '09:00', '18:30')])[0]).toMatchObject({ overtimeMinutes: 90 });
  });

  it('expected and not there: «not in yet» during the shift, «absent» once it is over', () => {
    expect(day([], [], at('11:00'))[0]).toMatchObject({ state: 'pending', source: 'schedule' });
    expect(day([], [], at('17:30'))[0]).toMatchObject({ state: 'absent', source: 'schedule' });
  });

  it('not expected and nothing recorded: off, and someone without a schedule is never absent', () => {
    const sunday = buildDay({ date: '2026-11-15', nowIso: at('20:00', '2026-11-15'), clock: cairo, staff, stays: [], entries: [], schedules: [nineToFive] });
    expect(sunday.map((r) => r.state)).toEqual(['off', 'off']);
  });

  it('a night shift ends the next day', () => {
    expect(expectedOf({ start: '22:00', end: '06:00' })).toEqual({ start: 1320, end: 1800 });
  });
});

describe('the manager writes on top', () => {
  it('a manager entry wins over the punches, and keeps them visible', () => {
    const [m] = day([stay('m', '09:00', null, { forgot: true })], [entry('m', { status: 'present', inMinute: 540, outMinute: 1020 })]);
    expect(m).toMatchObject({ state: 'present', source: 'manual', minutes: 480, needsCorrection: false });
    expect(m!.stays).toHaveLength(1);
  });

  it('absent, leave and day off from the manager', () => {
    const rows = day([], [entry('m', { status: 'leave' }), entry('s', { status: 'day_off' })]);
    expect(rows.map((r) => r.state)).toEqual(['leave', 'day_off']);
  });

  it('a manager «present» without times takes them from the punches', () => {
    const [m] = day([stay('m', '09:00', '17:00')], [entry('m', { status: 'present' })]);
    expect(m).toMatchObject({ source: 'manual', inMinute: 540, outMinute: 1020, minutes: 480 });
  });

  it('refuses entries that make no sense, and one with no reason', () => {
    expect(entryProblem({ status: 'absent', inMinute: 540, outMinute: null, reason: 'غياب' })).toMatch(/حضور بس/);
    expect(entryProblem({ status: 'present', inMinute: null, outMinute: 600, reason: 'نسي' })).toMatch(/محتاج ميعاد حضور/);
    expect(entryProblem({ status: 'present', inMinute: 600, outMinute: 540, reason: 'نسي' })).toMatch(/بعد الحضور/);
    expect(entryProblem({ status: 'leave', reason: '' })).toMatch(/السبب/);
    expect(entryProblem({ status: 'present', inMinute: 1380, outMinute: 1500, reason: 'وردية ليل' })).toBeNull();
  });

  it('a schedule needs seven days with real times', () => {
    expect(scheduleProblem(nineToFive.days)).toBeNull();
    expect(scheduleProblem([null])).toMatch(/7 أيام/);
    expect(scheduleProblem([{ start: '9', end: '17:00' }, null, null, null, null, null, null])).toMatch(/09:00/);
  });
});

describe('a period', () => {
  it('adds the days per employee', () => {
    const d1 = day([stay('m', '09:30', '17:00')]);
    const d2 = buildDay({ date: '2026-11-17', nowIso: at('20:00', '2026-11-17'), clock: cairo, staff, stays: [], entries: [entry('m', { date: '2026-11-17', status: 'leave' })], schedules: [nineToFive] });
    const m = summarizeDays([...d1, ...d2]).find((t) => t.staffId === 'm');
    expect(m).toMatchObject({ staffName: 'منى', present: 1, leave: 1, minutes: 450, lateDays: 1, lateMinutes: 30, manual: 1 });
  });
});
