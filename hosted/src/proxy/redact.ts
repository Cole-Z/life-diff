const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|key/i;
export const RESULT_SNIPPET_LIMIT = 240;
const PREFERRED_SUBJECTS = ["question", "title", "subject", "name", "query", "q", "text", "message", "prompt", "summary"];
const LOW_VALUE = new Set(["repo", "owner", "reponame", "repository", "url", "uri", "id", "path", "type", "format", "model", "tool"]);

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

/** Redact secret-like keys inside a stored result, then cap the snippet. */
export function redactSnippet(value: string, limit = RESULT_SNIPPET_LIMIT): string {
  let text = value.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      text = JSON.stringify(redactValue(JSON.parse(text)));
    } catch {
      text = redactLoose(text);
    }
  } else {
    text = redactLoose(text);
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function redactLoose(text: string): string {
  return text.replace(
    /"(token|secret|password|passwd|authorization|api_key|apikey|cookie|credential|access_key|refresh_token)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
}

export function pickSubject(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of PREFERRED_SUBJECTS) {
    const found = subjectAt(record, key);
    if (found) return found;
  }
  for (const item of Object.values(record)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const key of PREFERRED_SUBJECTS) {
      const found = subjectAt(item as Record<string, unknown>, key);
      if (found) return found;
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (SECRET_KEY.test(key) || LOW_VALUE.has(key.toLowerCase())) continue;
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
