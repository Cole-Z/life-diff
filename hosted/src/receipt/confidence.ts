import type { Confidence } from "./types";

const HIGH_SKEW_MS = 2 * 60 * 1000;
const MEDIUM_GRACE_MS = 15 * 60 * 1000;

/** Rate a GitHub timestamp against the session window. A missing time is medium. */
export function confidenceAt(occurred: string | undefined, startedAt: string, checkedAt: string): Confidence {
  if (!occurred) return "medium";
  const when = Date.parse(occurred);
  const start = Date.parse(startedAt);
  const end = Date.parse(checkedAt);
  if (Number.isNaN(when) || Number.isNaN(start) || Number.isNaN(end)) return "medium";
  if (when >= start - HIGH_SKEW_MS && when <= end + HIGH_SKEW_MS) return "high";
  if (when >= start - MEDIUM_GRACE_MS && when < start) return "medium";
  if (when < start) return "low";
  return "medium";
}

export function confidenceReason(level: Confidence): string {
  switch (level) {
    case "high":
      return "GitHub dates this during the session, between the snapshot and this check.";
    case "medium":
      return "The timing is unclear or only close to the session, so this check is partly sure.";
    case "low":
      return "GitHub dates this before the snapshot, so it may not have been done in this session.";
    default: {
      const never: never = level;
      throw new Error(`Unhandled confidence ${String(never)}`);
    }
  }
}
