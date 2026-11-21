const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|key/i;
export const RESULT_SNIPPET_LIMIT = 240;
const PREFERRED_SUBJECTS = ["question", "title", "subject", "name", "query", "q", "text", "message", "prompt", "summary"];
const LOW_VALUE = new Set(["repo", "owner", "reponame", "repository", "url", "uri", "id", "path", "type", "format", "model", "tool"]);

const SECRET_NAME = "access[_-]?token|private[_-]?key|client[_-]?secret|api[_-]?key|password|passwd|authorization|cookie|token|secret|pwd";
const ASSIGN = new RegExp(
  `\\b(${SECRET_NAME})\\b(\\s*[:=]\\s*)("[^"\\n]{0,400}"|'[^'\\n]{0,400}'|bearer\\s+\\S+|\\S+)`,
  "gi",
);
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_SHAPES = [
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bgh[pos]_[A-Za-z0-9_]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\brk_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Hide secret values inside free text. Key names alone are not enough. */
export function redactText(value: string): string {
  let text = value.replace(PRIVATE_KEY, "[redacted]");
  text = text.replace(ASSIGN, (_match, key: string, separator: string, value: string) => {
    return `${key}${separator}${redactAssigned(value)}`;
  });
  text = text.replace(BEARER, "Bearer [redacted]");
  for (const pattern of TOKEN_SHAPES) text = text.replace(pattern, "[redacted]");
  return text;
}

/** Walk stored JSON and redact every string. Field names such as cardToken stay. */
export function redactStrings<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactStrings(item, depth + 1);
    return out as T;
  }
  return value;
}

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
  if (typeof value === "string") {
    const cleaned = redactText(value);
    if (cleaned.length > 2000) return `[${cleaned.length} characters]`;
    return cleaned;
  }
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
  return redactText(out).slice(0, 500);
}

/** Redact secret-like keys and values inside a stored result, then cap the snippet. */
export function redactSnippet(value: string, limit = RESULT_SNIPPET_LIMIT): string {
  const original = value.trim();
  let text: string;
  if (original.startsWith("{") || original.startsWith("[")) {
    try {
      text = JSON.stringify(redactValue(JSON.parse(original)));
    } catch {
      text = redactText(original);
    }
  } else {
    text = redactText(original);
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
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

/** Keep the key, the : or = separator, and a Bearer scheme. Replace only the secret. */
function redactAssigned(value: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  if (quoted) {
    const quote = quoted[1] ?? "";
    const inner = quoted[2] ?? "";
    return `${quote}${redactAssignedBody(inner)}${quote}`;
  }
  return redactAssignedBody(value);
}

function redactAssignedBody(value: string): string {
  const bearer = /^(bearer\s+)\S+/i.exec(value);
  if (bearer?.[1]) return `${bearer[1]}[redacted]`;
  return "[redacted]";
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
