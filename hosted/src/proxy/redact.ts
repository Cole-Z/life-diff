const SECRET_WORD = new Set(["token", "secret", "password", "authorization", "key"]);

export function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((word) => SECRET_WORD.has(word) || word.endsWith("token") || word.endsWith("secret") || word.endsWith("password"));
}

export function redactText(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(sk|ghp|gho|ghu|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => redactValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? "[redacted]" : redactValue(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    if (value.length > 2000) return `[${value.length} characters]`;
    return redactText(value);
  }
  return value;
}
