import { condenseLines, storyFromReceipt } from "./story";
import { renderDiffPage } from "./page";
import type { Receipt } from "./types";

export function renderHtml(receipt: Receipt): string {
  const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
  return renderDiffPage({
    title: `Life Diff receipt ${receipt.id}`,
    eyebrow: "SESSION DIFF",
    lines,
    timeZone: receipt.timeZone,
    startedAt: receipt.session.startedAt,
    endedAt: receipt.session.checkedAt,
    ...(receipt.agentName ? { agentName: receipt.agentName } : {}),
    receiptId: receipt.id,
    notes: receipt.notes,
    footerNote: `Receipt ${receipt.id}`,
  });
}
