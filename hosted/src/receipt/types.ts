import type { ActionTone, ToolEffect } from "../proxy/classify";

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
}

export interface ReceiptGitHub {
  repos: string[];
  diffMode: "snapshot";
  truncatedSnapshot: boolean;
  truncatedChanges: boolean;
  suppressedRemovals: boolean;
}

export interface ReceiptAction {
  id: string;
  time: string;
  upstream: string;
  tool: string;
  arguments: unknown;
  ok: boolean;
  summary: string;
  error?: string;
  durationMs: number;
  effect: ToolEffect;
  tone: ActionTone;
  source: "proxy";
  resultSummary?: string;
}

export interface Counts {
  added: number;
  removed: number;
  modified: number;
  verifiedClaims: number;
  missingClaims: number;
  unclaimedChanges: number;
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
  /** Tool calls forwarded by the Life Diff proxy. Readers of schema 1.0.0 ignore unknown fields. */
  actions?: ReceiptAction[];
  notes: string[];
  warnings?: string[];
}
