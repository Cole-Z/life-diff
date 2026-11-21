import type { Classification } from "../proxy/classify";
import { redactText } from "../proxy/redact";
import { displayName } from "./names";

export interface PhraseInput {
  upstream: string;
  tool: string;
  classification: Classification;
  args?: unknown;
  subject?: string;
  ok: boolean;
  error?: string;
}

/** One sentence a person can read. Tool names, opaque ids, and tokens stay out of it. */
export function phraseAction(input: PhraseInput): string {
  const service = displayName(input.upstream);
  const tool = input.tool.trim();
  const subject = usable(input.subject) || subjectFrom(input.args);
  const built = sentence(service, tool, input.classification, input.args, subject);
  if (!input.ok) {
    const reason = publicReason(input.error, tool);
    return reason ? `Failed in ${service}. ${reason}` : `Failed in ${service}`;
  }
  return built.ok;
}

export function repoOf(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const repo = text(record.repo) || text(record.repository) || text(record.repoName) || text(record.repo_name);
  if (repo?.includes("/")) return repo;
  const owner = text(record.owner);
  if (owner && repo) return `${owner}/${repo}`;
  return undefined;
}

export function safeLink(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = findHttps(value);
    if (found) return found;
  }
  return undefined;
}

function sentence(service: string, tool: string, classification: Classification, args: unknown, subject: string | undefined): { ok: string; fail: string } {
  const known = knownRead(service, tool, args, subject);
  if (known && classification.effect !== "write") return pair(`look up ${known}`, `Looked up ${known}`);
  if (classification.verb === "ask" || tool === "ask_wiki_question" || tool.endsWith("_question")) {
    const topic = subject ? `'${subject}'` : "a question";
    return pair(`ask ${service} about ${topic}`, `Asked ${service} about ${topic}`);
  }
  const renamed = renameRest(service, args, subject);
  if (renamed && (tool.includes("rename") || classification.verb === "update" || classification.verb === "move" || classification.verb === "edit")) {
    return pair(`rename ${renamed}`, `Renamed ${renamed}`);
  }
  const place = repoOf(args) || service;
  const title = titleOf(args) || subject;
  const number = publicNumber(args);
  const kind = objectKind(tool, service);
  if (classification.verb === "send" || tool.includes("send")) {
    const what = title ? `'${title}'` : "something";
    return pair(`send ${what} from ${service}`, `Sent ${what} from ${service}`);
  }
  if (classification.verb === "revoke" || classification.verb === "unshare" || tool.includes("unshare") || tool.includes("revoke")) {
    return pair(`change sharing in ${service}`, `Changed sharing in ${service}`);
  }
  if (classification.verb === "share" || tool.includes("share")) {
    const what = title ? `'${title}'` : "something";
    return pair(`share ${what} in ${service}`, `Shared ${what} in ${service}`);
  }
  if (classification.effect === "write") {
    const verb = writeVerb(classification, tool);
    const object = describeObject(kind, number, title);
    const rest = `${object} in ${place}`;
    return pair(`${verb} ${rest}`, `${past(verb)} ${rest}`);
  }
  const what = title ? `'${title}'` : "something";
  return pair(`look up ${what} in ${service}`, title ? `Looked up ${what} in ${service}` : `Looked something up in ${service}`);
}

function pair(failRest: string, ok: string): { ok: string; fail: string } {
  const done = ok.endsWith(".") ? ok : `${ok}.`;
  const fail = failRest.endsWith(".") ? `Could not ${failRest}` : `Could not ${failRest}.`;
  return { ok: done, fail };
}

function knownRead(service: string, tool: string, args: unknown, subject: string | undefined): string | undefined {
  const topic = wikiTopic(args) || subject;
  if (tool === "read_wiki_structure") {
    return topic ? `the docs outline for ${topic} in ${service}` : `a docs outline in ${service}`;
  }
  if (tool === "read_wiki_contents") {
    return topic ? `the docs for ${topic} in ${service}` : `the docs in ${service}`;
  }
  return undefined;
}

function writeVerb(classification: Classification, tool: string): string {
  const name = tool.toLowerCase();
  if (name.includes("reopen")) return "reopen";
  if (name.includes("close")) return "close";
  if (name.includes("merge")) return "merge";
  if (classification.verb === "delete" || classification.verb === "remove" || classification.tone === "removed") return "delete";
  if (classification.tone === "created" || classification.verb === "create" || classification.verb === "add" || classification.verb === "insert") return "create";
  return "change";
}

function objectKind(tool: string, service: string): string | undefined {
  const name = tool.toLowerCase();
  if (name.includes("pull_request") || name.includes("pullrequest")) return "pull request";
  if (name.includes("issue")) return "issue";
  if (name.includes("commit")) return "commit";
  if (name.includes("event") || service === "Google Calendar") return "event";
  if (name.includes("draft")) return "draft";
  if (name.includes("message")) return "message";
  if (name.includes("file") || service === "Google Drive") return "file";
  if (name.includes("page")) return "page";
  if (name.includes("comment")) return "comment";
  return undefined;
}

function describeObject(kind: string | undefined, number: string | undefined, title: string | undefined): string {
  const named = title ? `'${title}'` : "";
  const numbered = number ? `#${number}` : "";
  if (kind && numbered && named) return `${kind} ${numbered} ${named}`;
  if (kind && numbered) return `${kind} ${numbered}`;
  if (kind && named) return `${kind} ${named}`;
  if (named) return named;
  return "something";
}

function renameRest(service: string, args: unknown, title: string | undefined): string | undefined {
  const previous = previousName(args);
  if (!previous || !title || previous === title) return undefined;
  return `'${previous}' to '${title}' in ${service}`;
}

function previousName(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  for (const key of ["previous", "prior", "before", "old", "from", "oldName", "old_name"]) {
    const item = record[key];
    const direct = text(item);
    if (direct) return direct;
    const nested = recordOf(item);
    const named = nested ? text(nested.title) || text(nested.name) : undefined;
    if (named) return named;
  }
  return undefined;
}

function wikiTopic(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  return text(record.repo) || text(record.repository) || text(record.repoName) || text(record.repo_name);
}

function titleOf(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  return text(record.title) || text(record.name) || text(record.summary) || text(record.subject);
}

function subjectFrom(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  for (const key of ["question", "title", "subject", "name", "query", "q", "text", "message", "prompt", "summary"]) {
    const found = text(record[key]);
    if (found) return found;
  }
  return undefined;
}

/** Issue and pull request numbers are public. Opaque ids are not. */
function publicNumber(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  for (const key of ["number", "issue_number", "issueNumber", "pull_number", "pullNumber"]) {
    const found = text(record[key]);
    if (found && /^\d{1,8}$/.test(found)) return found;
  }
  return undefined;
}

function publicReason(error: string | undefined, tool: string): string | undefined {
  if (!error) return undefined;
  let cleaned = redactText(error).replaceAll(tool, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^(error|exception|failed|failure)\b[:\s-]*/i, "").trim();
  if (!cleaned || /[{}[\]<>]/.test(cleaned)) return undefined;
  if (/^https?:\/\//i.test(cleaned)) return undefined;
  if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 79).trimEnd()}…`;
  const sentence = cleaned.replace(/\.$/, "");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function findHttps(value: unknown): string | undefined {
  if (typeof value === "string") {
    const match = value.match(/https:\/\/[^\s)"']+/);
    return acceptLink(match?.[0]);
  }
  const record = recordOf(value);
  if (!record) return undefined;
  for (const key of ["html_url", "htmlUrl", "url", "link", "permalink", "webViewLink", "web_view_link"]) {
    const found = acceptLink(text(record[key]));
    if (found) return found;
  }
  return undefined;
}

export function publicHttpsLink(value: string | undefined): string | undefined {
  return acceptLink(value?.trim());
}

function acceptLink(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("https://")) return undefined;
  if (/token|secret|password|sig=|key=/i.test(value)) return undefined;
  return value.slice(0, 300);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed === "[redacted]") return undefined;
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "[redacted]") return undefined;
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

function past(verb: string): string {
  switch (verb) {
    case "create":
      return "Created";
    case "change":
      return "Changed";
    case "delete":
      return "Deleted";
    case "send":
      return "Sent";
    case "close":
      return "Closed";
    case "reopen":
      return "Reopened";
    case "merge":
      return "Merged";
    case "rename":
      return "Renamed";
    default:
      return verb.charAt(0).toUpperCase() + verb.slice(1);
  }
}
