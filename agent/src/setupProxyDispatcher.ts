// Make the agent's global `fetch` (used by the LLM provider and other HTTP
// clients) honor the host proxy environment. Some LLM endpoints are only
// reachable through the host proxy (e.g. api.poe.com), while others are
// directly reachable (e.g. api.sophnet.com). Node's default fetch does NOT read
// http_proxy/https_proxy, so proxy-only endpoints fail with status 0.
//
// `EnvHttpProxyAgent` respects HTTP_PROXY/HTTPS_PROXY/NO_PROXY. Local project
// health checks must always bypass the proxy, even on machines whose shell
// does not define NO_PROXY (otherwise 127.0.0.1 can be sent to a remote proxy
// and reported as an unavailable project).
// Imported first in server.ts so the dispatcher is set before any fetch runs.
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

const proxyEnv =
  process.env.http_proxy || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.HTTPS_PROXY;

if (proxyEnv) {
  const noProxy = new Set(
    (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) noProxy.add(host);
  process.env.NO_PROXY = [...noProxy].join(",");
  process.env.no_proxy = process.env.NO_PROXY;
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
