import { decrypt } from "./credentialStore.js";
import type { CredentialRecord } from "./types.js";

export async function testCredentialConnection(record: CredentialRecord) {
  const apiKey = await decrypt(record.apiKeyEncrypted);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const url = `${record.baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {
    accept: "application/json"
  };
  if (record.provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);
    let modelAvailable = false;
    if (response.ok) {
      const payload = await response.json().catch(() => undefined) as { data?: Array<{ id?: string }> } | undefined;
      modelAvailable = Boolean(payload?.data?.some((model) => model.id === record.model));
    }
    return {
      ok: response.ok && modelAvailable,
      status: response.status,
      model: record.model,
      modelAvailable,
      message: response.ok ? modelAvailable ? "连接成功，固定模型可访问" : "连接成功，但固定模型不可访问" : `连接失败，HTTP ${response.status}`
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : "连接失败"
    };
  }
}
