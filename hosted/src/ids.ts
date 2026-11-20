import { createHash } from "node:crypto";

export function changeId(service: string, resourceId: string, kind: string): string {
  const hex = createHash("sha256").update(`${service}\n${resourceId}\n${kind}`).digest("hex");
  return `chg_${hex.slice(0, 12)}`;
}
