import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BotDelivery, RunBundle } from "./types.js";
import { redactText, redactUrl } from "./redaction.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const deliveryDir = path.join(rootDir, "reports", "bot");
const deliveryFile = path.join(deliveryDir, "deliveries.json");

async function readDeliveries() {
  try {
    const raw = await readFile(deliveryFile, "utf8");
    return JSON.parse(raw) as BotDelivery[];
  } catch {
    return [];
  }
}

async function writeDeliveries(deliveries: BotDelivery[]) {
  await mkdir(deliveryDir, { recursive: true });
  await writeFile(deliveryFile, JSON.stringify(deliveries.slice(-100), null, 2));
}

export async function listBotDeliveries() {
  return readDeliveries();
}

function botProvider(provider?: BotDelivery["provider"]): BotDelivery["provider"] {
  if (provider) return provider;
  if (!process.env.BOT_WEBHOOK_URL) return "simulated";
  if (["wecom", "feishu", "slack", "github_pr_comment", "generic"].includes(process.env.BOT_PROVIDER ?? "")) {
    return process.env.BOT_PROVIDER as BotDelivery["provider"];
  }
  return "generic";
}

function buildWebhookPayload(delivery: BotDelivery) {
  if (delivery.provider === "wecom") {
    return {
      msgtype: "markdown",
      markdown: {
        content: [
          `**${delivery.title}**`,
          "",
          delivery.body
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
          "",
          `> evidenceRefs=${delivery.evidenceRefs.join(", ") || "none"}`
        ].join("\n")
      }
    };
  }
  if (delivery.provider === "feishu") {
    return {
      msg_type: "text",
      content: {
        text: `${delivery.title}\n${delivery.body}\nevidenceRefs=${delivery.evidenceRefs.join(", ") || "none"}`
      }
    };
  }
  if (delivery.provider === "slack") {
    return {
      text: delivery.title,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${delivery.title}*` } },
        { type: "section", text: { type: "mrkdwn", text: delivery.body } },
        { type: "context", elements: [{ type: "mrkdwn", text: `evidenceRefs=${delivery.evidenceRefs.join(", ") || "none"}` }] }
      ]
    };
  }
  return {
    title: delivery.title,
    body: delivery.body,
    recipients: delivery.recipients,
    runId: delivery.runId,
    evidenceRefs: delivery.evidenceRefs
  };
}

function parseGithubPrUrl(input: string | undefined) {
  if (!input) return undefined;
  try {
    const parsed = new URL(input);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!parsed.hostname.includes("github.com") || !match) return undefined;
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  } catch {
    return undefined;
  }
}

async function sendGithubPrComment(delivery: BotDelivery, githubPrUrl?: string): Promise<Pick<BotDelivery, "status" | "error" | "httpStatus">> {
  const parsed = parseGithubPrUrl(githubPrUrl ?? process.env.BOT_GITHUB_PR_URL);
  if (!parsed) return { status: "failed", error: "Missing or invalid GitHub PR URL." };
  if (!process.env.GITHUB_TOKEN) return { status: "failed", error: "Missing GITHUB_TOKEN for GitHub PR comment delivery." };
  const apiBase = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "ai-test-officer"
    },
    body: JSON.stringify({ body: `### ${delivery.title}\n\n${delivery.body}\n\nEvidence: ${delivery.evidenceRefs.join(", ") || "none"}` })
  });
  if (!response.ok) return { status: "failed", httpStatus: response.status, error: `GitHub comment HTTP ${response.status}` };
  return { status: "sent", httpStatus: response.status };
}

async function sendWebhook(delivery: BotDelivery, githubPrUrl?: string): Promise<Pick<BotDelivery, "status" | "error" | "httpStatus">> {
  if (delivery.provider === "github_pr_comment") return sendGithubPrComment(delivery, githubPrUrl);
  const webhookUrl = process.env.BOT_WEBHOOK_URL;
  if (!webhookUrl) {
    return delivery.provider === "simulated"
      ? { status: "simulated" }
      : { status: "failed", error: `Missing BOT_WEBHOOK_URL for ${delivery.provider}.` };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(delivery))
    });
    if (!response.ok) {
      return { status: "failed", httpStatus: response.status, error: `Webhook HTTP ${response.status}` };
    }
    return { status: "sent", httpStatus: response.status };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Webhook request failed" };
  }
}

export async function buildDeliveryFromRun(input: {
  bundle: RunBundle;
  channel?: string;
  recipients?: string[];
  provider?: BotDelivery["provider"];
  includeScreenshots?: boolean;
  githubPrUrl?: string;
}) {
  const releaseJudge = input.bundle.judgeReport.releaseJudge;
  const finding = releaseJudge.findings[0];
  const provider = botProvider(input.provider);
  const screenshotRefs = input.includeScreenshots
    ? input.bundle.evidence.filter((item) => item.type === "screenshot").map((item) => item.id).slice(-3)
    : [];
  const topSuspects = (input.bundle.failureAttributions ?? [])
    .flatMap((item) => item.topSuspects ?? [])
    .slice(0, 3)
    .map((item) => ({
      title: item.filePath,
      confidence: item.confidence,
      suggestedFix: item.suggestedFix
    }));
  const blockedRelease = ["fail", "needs_review"].includes(releaseJudge.verdict) || input.bundle.result.verdict !== "continue";
  const delivery: BotDelivery = {
    id: `bot_${Date.now()}`,
    createdAt: new Date().toISOString(),
    provider,
    channel: input.channel ?? "值班群",
    recipients: input.recipients?.length ? input.recipients : ["oncall"],
    title: `[AI 测试官] ${finding?.title ?? input.bundle.result.verdict}`,
    body: redactText([
      `runId=${input.bundle.runId}`,
      `verdict=${input.bundle.result.verdict}`,
      `releaseJudge=${releaseJudge.verdict}`,
      `blockedRelease=${blockedRelease ? "yes" : "no"}`,
      `summary=${releaseJudge.summary}`,
      `readableReport=${input.bundle.result.htmlReportFile ?? input.bundle.result.markdownReportFile ?? input.bundle.result.reportFile}`,
      `report=${input.bundle.result.runBundleFile}`,
      topSuspects.length ? `topSuspects=${topSuspects.map((item) => `${item.title}(${item.confidence})`).join(", ")}` : "topSuspects=none",
      screenshotRefs.length ? `screenshots=${screenshotRefs.join(", ")}` : "screenshots=not_included"
    ].join("\n")),
    runId: input.bundle.runId,
    evidenceRefs: finding?.evidenceRefs ?? [],
    screenshotRefs,
    reportUrl: redactUrl(input.bundle.result.htmlReportFile ?? input.bundle.result.markdownReportFile ?? input.bundle.result.runBundleFile),
    blockedRelease,
    topSuspects,
    payloadSummary: redactText(`${provider}:${releaseJudge.verdict}:${input.bundle.runId}`),
    status: "queued"
  };
  const deliveryStatus = await sendWebhook(delivery, input.githubPrUrl);
  delivery.status = deliveryStatus.status;
  delivery.error = deliveryStatus.error;
  delivery.httpStatus = deliveryStatus.httpStatus;
  const deliveries = await readDeliveries();
  deliveries.push(delivery);
  await writeDeliveries(deliveries);
  return delivery;
}
