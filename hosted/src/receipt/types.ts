export type ChangeKind = "added" | "removed" | "modified";
export type Confidence = "high" | "medium" | "low";
export type ClaimStatus = "verified" | "missing" | "unclaimed";

export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface ActorRef {
  login: string;
  id?: number;
  type?: string;
}

export interface AppRef {
  id?: number;
  slug?: string;
  name?: string;
}

export interface Change {
  id: string;
  service: "github";
  kind: ChangeKind;
  resourceId: string;
  resourceName: string;
  summary: string;
  fields: FieldChange[];
  occurredAt?: string;
  confidence: Confidence;
  confidenceReason: string;
  claimStatus?: ClaimStatus;
  link?: string;
  /** Extension. Readers of schema 1.0.0 ignore unknown fields. */
  resourceType: string;
  repo: string;
  actor?: ActorRef;
  viaApp?: AppRef;
  labelsChanged?: boolean;
}

export interface ClaimInput {
  id?: string;
  service?: string;
  action?: string;
  target: string;
  detail?: string;
  repo?: string;
  /** Previous value, when the agent knows it. Optional and ignored by older readers. */
  before?: string;
  /** New value, when the agent knows it. Optional and ignored by older readers. */
  after?: string;
  /** HTTPS link to the object. Optional and ignored by older readers. */
  url?: string;
}

export interface ClaimResult {
  id: string;
  service?: string;
  action?: string;
  target: string;
  detail?: string;
  status: "verified" | "missing";
  confidence?: Confidence;
  matchedChangeIds?: string[];
  reason: string;
  resource?: string;
  repo?: string;
  before?: string;
  after?: string;
  url?: string;
  /** True when this claim matches a call Life Diff forwarded in the same session. */
  corroborated?: boolean;
  /** Id of the proxied action this claim was folded into. */
  matchedActionId?: string;
}

export interface ReceiptGitHub {
  repos: string[];
  diffMode: "snapshot";
  truncatedSnapshot: boolean;
  truncatedChanges: boolean;
  suppressedRemovals: boolean;
  /** True only when this session named repositories. Older receipts omit it. */
  optIn?: boolean;
}

export interface Counts {
  added: number;
  removed: number;
  modified: number;
  verifiedClaims: number;
  missingClaims: number;
  unclaimedChanges: number;
}

export type ActionEffect = "read" | "write" | "unknown";
export type ActionTone = "created" | "changed" | "removed" | "read" | "unknown";

export interface RecordedAction {
  id: string;
  time: string;
  upstream: string;
  tool: string;
  summary: string;
  tone: ActionTone;
  effect: ActionEffect;
  verb?: string;
  ok: boolean;
  status: string;
  result?: string;
  error?: string;
  durationMs?: number;
  arguments?: unknown;
  source: "proxy" | "claim";
  /** A log_action claim in this session described the same call. */
  corroborated?: boolean;
  /** MCP client that reported the call, when more than one agent is in view. */
  client?: string;
  /** Repository this call was about, when the agent named one. */
  repo?: string;
}

export interface Receipt {
  schemaVersion: "1.0.0";
  id: string;
  generatedAt: string;
  readOnly: true;
  producer: { name: string; version: string };
  snapshot: { id: string; takenAt: string };
  comparedAt: string;
  timeZone: string;
  session: { startedAt: string; checkedAt: string };
  github: ReceiptGitHub;
  counts: Counts;
  changes: Change[];
  claimsChecked: boolean;
  claims: ClaimResult[];
  notes: string[];
  warnings?: string[];
  /** Tool calls recorded by the proxy. Readers of schema 1.0.0 ignore unknown fields. */
  actions?: RecordedAction[];
  /** Unguessable token for the public receipt card image. */
  cardToken?: string;
}
