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
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? "连接成功" : `连接失败，HTTP ${response.status}`
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

