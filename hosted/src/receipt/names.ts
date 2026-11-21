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

const KEYS: Record<string, string> = {
  github: "github",
  gh: "github",
  googlecalendar: "google_calendar",
  calendar: "google_calendar",
  googledrive: "google_drive",
  drive: "google_drive",
  gmail: "gmail",
  slack: "slack",
  notion: "notion",
  linear: "linear",
  deepwiki: "deepwiki",
};

/** Brand name for a service. Unknown names are title-cased, never left as a raw slug. */
export function displayName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Service";
  const key = trimmed.toLowerCase();
  const compact = key.replace(/[\s_-]+/g, "");
  return DISPLAY[key] ?? DISPLAY[compact] ?? titleCase(trimmed);
}

/** Service key and brand name from a tool such as `google_calendar` or `github.create_file`. */
export function serviceFromTool(tool: string): { key: string; display: string } {
  const trimmed = tool.trim();
  const head = trimmed.split(/[./]/).map((part) => part.trim()).find(Boolean) ?? trimmed;
  const compact = head.toLowerCase().replace(/[\s_-]+/g, "");
  const key = KEYS[compact] ?? head.toLowerCase().replace(/[\s.]+/g, "_");
  return { key, display: displayName(head) };
}

/** `log_action` stores `Tool <name>` on the claim detail so a later read can recover the service. */
export function toolMentioned(detail?: string): string | undefined {
  const match = /(?:^|\.\s*)Tool ([^.]+)/.exec(detail ?? "");
  const tool = match?.[1]?.trim();
  return tool || undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
