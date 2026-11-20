export const DEFAULT_TIME_ZONE = "America/Chicago";
export const DEFAULT_DAY_END = "18:00";

export interface LocalClock {
  date: string;
  hour: number;
  minute: number;
}

export interface UserSettings {
  timeZone: string;
  dayEnd: string;
  githubDaily: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = {
  timeZone: DEFAULT_TIME_ZONE,
  dayEnd: DEFAULT_DAY_END,
  githubDaily: false,
};

export function parseDayEnd(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function localClock(now: Date, timeZone: string): LocalClock {
  const shifted = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return {
    date: `${shifted.getUTCFullYear()}-${month}-${day}`,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function dayWindow(date: string, timeZone: string): { start: string; end: string } {
  const start = zonedToUtc(date, "00:00", timeZone);
  const end = zonedToUtc(shiftDate(date, 1), "00:00", timeZone);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}

export function pastDayEnd(clock: LocalClock, dayEnd: string): boolean {
  const parsed = parseDayEnd(dayEnd);
  if (!parsed) return false;
  return clock.hour > parsed.hour || (clock.hour === parsed.hour && clock.minute >= parsed.minute);
}

/** Local days whose stored diff should be finalized at `now`. */
export function dueDays(now: Date, timeZone: string, dayEnd: string, finalized: ReadonlySet<string>): string[] {
  const clock = localClock(now, timeZone);
  const days: string[] = [];
  const yesterday = shiftDate(clock.date, -1);
  if (!finalized.has(yesterday)) days.push(yesterday);
  if (pastDayEnd(clock, dayEnd) && !finalized.has(clock.date)) days.push(clock.date);
  return days;
}

export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, 0);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}
