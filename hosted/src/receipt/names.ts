const DISPLAY: Record<string, string> = {
  deepwiki: "DeepWiki",
  github: "GitHub",
  calendar: "Google Calendar",
  googlecalendar: "Google Calendar",
  "google-calendar": "Google Calendar",
  google_calendar: "Google Calendar",
  drive: "Google Drive",
  googledrive: "Google Drive",
  "google-drive": "Google Drive",
  google_drive: "Google Drive",
  gmail: "Gmail",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
};

/** Brand name for a service. Unknown names are title-cased, never left as a raw slug. */
export function displayName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Service";
  const key = trimmed.toLowerCase();
  const compact = key.replace(/[\s_-]+/g, "");
  return DISPLAY[key] ?? DISPLAY[compact] ?? titleCase(trimmed);
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
