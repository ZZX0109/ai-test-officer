import { decrypt, getCredential, listCredentials } from "./credentialStore.js";
import { buildScenarioGrayPlan, fixedGrayPlan } from "./plan.js";
import { matchScenariosForContext } from "./scenarios.js";
import type { CredentialRecord, GrayPlan } from "./types.js";

interface GeneratePlanInput {
  requirement: string;
  diff: string;
  credentialId?: string;
}

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as GrayPlan;
  const match = trimmed.match(/```json\s*([\s\S]*?)```/);
  if (match) return JSON.parse(match[1]) as GrayPlan;
  throw new Error("LLM response did not contain JSON");
}

function coercePlan(candidate: GrayPlan): GrayPlan {
  if (!candidate.sessionName || !Array.isArray(candidate.risks) || !Array.isArray(candidate.levels)) {
    throw new Error("LLM plan schema is incomplete");
  }
  return candidate;
}

async function resolveCredential(id?: string) {
  if (id) return getCredential(id);
  const publicList = await listCredentials();
  const selected = publicList.find((item) => item.isDefault) ?? publicList[0];
  return selected ? getCredential(selected.id) : undefined;
}

function buildPrompt(input: GeneratePlanInput) {
  return `你是 AI 测试官。请根据需求和 Git diff 生成显式灰度测试 plan。必须只输出 JSON，不要输出 Markdown。

JSON schema:
{
  "sessionName": "string",
  "risks": [{"id":"string","level":"high|medium|low","title":"string","evidence":"string"}],
  "levels": [
    {"id":"smoke|core_path|edge_case|regression","title":"string","description":"string","paths":[{"id":"string","title":"string","riskReason":"string","expectedFrom":"requirement|diff|existing_test|llm_inferred","retry":1,"steps":["string"]}]}
  ]
}

必须包含四层：smoke、core_path、edge_case、regression。断言预期来源不清楚时 expectedFrom 必须用 llm_inferred。

需求:
${input.requirement}

Git diff:
${input.diff}`;
}

async function callOpenAICompatible(record: CredentialRecord, apiKey: string, prompt: string) {
  const response = await fetch(`${record.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: record.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You output strict JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`LLM request failed: HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(record: CredentialRecord, apiKey: string, prompt: string) {
  const response = await fetch(`${record.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: record.model,
      max_tokens: 2500,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!response.ok) throw new Error(`LLM request failed: HTTP ${response.status}`);
  const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find((item) => item.type === "text")?.text ?? "";
}

export async function generatePlan(input: GeneratePlanInput) {
  const credential = await resolveCredential(input.credentialId);
  if (!credential) {
    const scenario = matchScenariosForContext(input)[0]?.scenario;
    return {
      source: "fallback",
      message: scenario
        ? `未配置 API Key，已按场景 ${scenario.id} 生成显式灰度 plan。`
        : "未配置 API Key，已回退固定显式灰度 plan。",
      plan: scenario ? buildScenarioGrayPlan(scenario) : fixedGrayPlan
    };
  }

  const apiKey = await decrypt(credential.apiKeyEncrypted);
  const prompt = buildPrompt(input);
  const raw =
    credential.provider === "anthropic"
      ? await callAnthropic(credential, apiKey, prompt)
      : await callOpenAICompatible(credential, apiKey, prompt);
  return {
    source: "llm",
    message: "已通过 LLM 生成显式灰度 plan。",
    plan: coercePlan(extractJson(raw))
  };
}
