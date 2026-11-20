const SECRET_KEY = /token|secret|password|authorization|cookie|key/i;
const PREFERRED_SUBJECTS = ["title", "name", "query", "q", "text", "message", "subject", "path", "repo", "reponame", "url", "question"];

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `[${value.length} characters]`;
  return value;
}

export function scrubSecrets(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    out = out.split(trimmed).join("[redacted]");
    const bearer = trimmed.replace(/^Bearer\s+/i, "");
    if (bearer.length >= 4 && bearer !== trimmed) out = out.split(bearer).join("[redacted]");
  }
  return out.slice(0, 500);
}

export function pickSubject(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of PREFERRED_SUBJECTS) {
    const found = subjectAt(record, key);
    if (found) return found;
  }
  for (const [key, item] of Object.entries(record)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof item === "string" && item.trim() && item !== "[redacted]") return clip(item);
  }
  return undefined;
}

function subjectAt(record: Record<string, unknown>, wanted: string): string | undefined {
  for (const [key, item] of Object.entries(record)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof item === "string" && item.trim() && item !== "[redacted]") return clip(item);
  }
  return undefined;
}

function clip(value: string): string {
  const one = value.trim().replace(/\s+/g, " ");
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

export function boundJson(value: unknown): unknown {
  const redacted = redactValue(value);
  try {
    const encoded = JSON.stringify(redacted);
    if (encoded.length <= 4000) return redacted;
  } catch {
    return { note: "arguments could not be stored" };
  }
  return { note: "arguments were too large to store" };
}
