import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { MCP_URL } from "../src/constants";
import { renderHome, renderSample } from "../src/http/pages";
import { renderCardPng } from "../src/receipt/card";
import { renderDiffPage } from "../src/receipt/page";
import { sampleLines, sampleNotes, sampleReceipt } from "../src/receipt/sample";
import { agentTitle, renderStory } from "../src/receipt/story";

const lines = sampleLines();
const timeZone = sampleReceipt.timeZone;
const { startedAt, checkedAt } = sampleReceipt.session;
const title = agentTitle(lines, timeZone, startedAt, checkedAt);
const dailyHtml = renderDiffPage({
  title: "Sample daily roundup · Life Diff",
  eyebrow: "Sample daily roundup",
  lines,
  timeZone,
  sample: true,
  notes: sampleNotes,
  footerNote: "Synthetic fixture · November 20, 2026",
});
const markdown = renderStory({
  headline: "",
  lines: lines.map(({ undo, link, ...line }) => line),
  link: "https://lifediff.dev/sample-receipt",
  linkLabel: "Full sample receipt",
  eyebrow: "SAMPLE SESSION RECEIPT",
  title,
  timeZone,
});

const out = new URL("../../docs/images/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("card.png", out), await renderCardPng(lines, title, "SAMPLE SESSION RECEIPT"));
const browser = await chromium.launch({ channel: process.env.LIFEDIFF_SCREENSHOT_BROWSER });
try {
  await shoot(renderSample(), "light", "receipt-light.webp");
  await shoot(renderSample(), "dark", "receipt-dark.webp");
  await shoot(dailyHtml, "light", "daily.webp");
  await shoot(dailyHtml, "dark", "daily-dark.webp");
  await shootSocialPreview();
} finally {
  await browser.close();
}
process.stdout.write(`${markdown}\n`);

async function shoot(html: string, colorScheme: "light" | "dark", name: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 860, height: 800 }, colorScheme, deviceScaleFactor: 2 });
  try {
    await page.setContent(html);
    const png = await page.locator(".card").screenshot();
    const webp = await page.evaluate(async (base64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + base64;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      return canvas.toDataURL("image/webp", 0.9).split(",")[1];
    }, png.toString("base64"));
    if (!webp) throw new Error("The fixture screenshot could not be encoded.");
    await writeFile(new URL(name, out), Buffer.from(webp, "base64"));
  } finally {
    await page.close();
  }
}

async function shootSocialPreview(): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: "light" });
  try {
    await page.setContent(renderHome(MCP_URL));
    await page.addStyleTag({ content: `
      header { padding-inline: 46px; }
      header p { max-width: none; }
      main {
        display: grid;
        grid-template-columns: 0.9fr 1.1fr;
        gap: 36px;
        align-items: center;
        min-height: 567px;
        max-width: none;
        padding: 28px 46px;
      }
      main > :not(.hero-title, .card) { display: none; }
      .hero-title { font-size: 56px; }
    ` });
    await page.screenshot({ path: new URL("social-preview.png", out).pathname });
  } finally {
    await page.close();
  }
}
