export function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${JSON.stringify(value)}`);
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix: string, now: Date): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${prefix}_${stamp}_${hex}`;
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function addHours(iso: string, hours: number): string {
  return addMs(iso, hours * 60 * 60 * 1000);
}

export function addDays(iso: string, days: number): string {
  return addMs(iso, days * 24 * 60 * 60 * 1000);
}

export function isGitHubUserId(userId: string): boolean {
  return /^[0-9]+$/.test(userId);
}

export function fold(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function quoteName(value: string): string {
  const trimmed = value.trim();
  return JSON.stringify(trimmed === "" ? "Untitled" : trimmed);
}

export function displayName(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "Untitled" : trimmed;
}

export function formatInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  let zone = timeZone;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

const ZONE_SHORT: Record<string, string> = {
  CDT: "CT",
  CST: "CT",
  PDT: "PT",
  PST: "PT",
  EDT: "ET",
  EST: "ET",
  MDT: "MT",
  MST: "MT",
};

/** A clock range such as `9:02–9:41 AM CT` in the user's zone. */
export function formatRange(startIso: string, endIso: string, timeZone: string): string {
  const start = clockParts(startIso, timeZone);
  const end = clockParts(endIso, timeZone);
  if (!start || !end) return "";
  const zone = start.zone || end.zone;
  const zoneText = zone ? ` ${zone}` : "";
  if (start.hour === end.hour && start.minute === end.minute && start.meridiem === end.meridiem) {
    return `${start.hour}:${start.minute} ${start.meridiem}${zoneText}`;
  }
  if (start.meridiem === end.meridiem) {
    return `${start.hour}:${start.minute}–${end.hour}:${end.minute} ${end.meridiem}${zoneText}`;
  }
  return `${start.hour}:${start.minute} ${start.meridiem}–${end.hour}:${end.minute} ${end.meridiem}${zoneText}`;
}

function clockParts(iso: string, timeZone: string): { hour: string; minute: string; meridiem: string; zone: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let zone = timeZone;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const rawZone = get("timeZoneName");
  return {
    hour: get("hour"),
    minute: get("minute"),
    meridiem: get("dayPeriod").toUpperCase(),
    zone: ZONE_SHORT[rawZone] ?? rawZone,
  };
}

export function validTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeHttpsLink(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return "";
  return url.toString();
}

export function clip(value: string, max: number): string {
  const cleaned = value.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
