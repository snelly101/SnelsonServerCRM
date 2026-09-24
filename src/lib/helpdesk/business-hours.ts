import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * Business-time arithmetic for SLAs. A schedule is a weekly set of windows
 * in a named time zone plus holidays (dates in that zone). All maths is done
 * by walking calendar days in the zone and converting each window's local
 * start/end to an instant with fromZonedTime, so daylight-saving changes
 * shift the windows with the wall clock rather than the offset.
 */
export type DayWindow = { start: string; end: string }; // "09:00"-"17:30", local time
export type WeeklySchedule = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  DayWindow[]
>;
export type BusinessHours = {
  timezone: string;
  schedule: WeeklySchedule;
  holidays: string[];
  /** true = 24x7, ignore the schedule */ always?: boolean;
};

export const DEFAULT_SCHEDULE: WeeklySchedule = {
  mon: [{ start: "09:00", end: "17:30" }],
  tue: [{ start: "09:00", end: "17:30" }],
  wed: [{ start: "09:00", end: "17:30" }],
  thu: [{ start: "09:00", end: "17:30" }],
  fri: [{ start: "09:00", end: "17:30" }],
  sat: [],
  sun: [],
};
export const ALWAYS: BusinessHours = {
  timezone: "UTC",
  schedule: DEFAULT_SCHEDULE,
  holidays: [],
  always: true,
};
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function localDate(at: Date, tz: string) {
  return formatInTimeZone(at, tz, "yyyy-MM-dd");
}
function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function weekday(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
/** The open intervals (as instants) for one local calendar day. */
export function windowsFor(
  ymd: string,
  bh: BusinessHours,
): { start: Date; end: Date }[] {
  if (bh.holidays.includes(ymd)) return [];
  const day = bh.schedule[weekday(ymd)] ?? [];
  return day
    .map((w) => ({
      start: fromZonedTime(`${ymd}T${w.start}:00`, bh.timezone),
      end: fromZonedTime(`${ymd}T${w.end}:00`, bh.timezone),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Business minutes elapsed between two instants. */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  bh: BusinessHours,
): number {
  if (to <= from) return 0;
  if (bh.always) return (to.getTime() - from.getTime()) / 60000;
  let total = 0;
  let day = addDays(localDate(from, bh.timezone), -1); // start a day early to catch windows spanning midnight offsets
  const last = addDays(localDate(to, bh.timezone), 1);
  for (
    let guard = 0;
    day <= last && guard < 4000;
    guard++, day = addDays(day, 1)
  ) {
    for (const w of windowsFor(day, bh)) {
      const s = Math.max(w.start.getTime(), from.getTime());
      const e = Math.min(w.end.getTime(), to.getTime());
      if (e > s) total += (e - s) / 60000;
    }
  }
  return total;
}

/** The instant `minutes` of business time after `from`. */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  bh: BusinessHours,
): Date {
  if (minutes <= 0) return from;
  if (bh.always) return new Date(from.getTime() + minutes * 60000);
  let remaining = minutes;
  let day = addDays(localDate(from, bh.timezone), -1);
  for (let guard = 0; guard < 4000; guard++, day = addDays(day, 1)) {
    for (const w of windowsFor(day, bh)) {
      const start = Math.max(w.start.getTime(), from.getTime());
      if (w.end.getTime() <= start) continue;
      const available = (w.end.getTime() - start) / 60000;
      if (available >= remaining) return new Date(start + remaining * 60000);
      remaining -= available;
    }
  }
  return new Date(from.getTime() + minutes * 60000); // no windows at all: fall back to calendar time
}

/** Whether `at` falls inside business hours. */
export function isBusinessTime(at: Date, bh: BusinessHours) {
  if (bh.always) return true;
  return windowsFor(localDate(at, bh.timezone), bh).some(
    (w) => at >= w.start && at < w.end,
  );
}
