// Make the agent's global `fetch` (used by the LLM provider and other HTTP
// clients) honor the host proxy environment. Some LLM endpoints are only
// reachable through the host proxy (e.g. api.poe.com), while others are
// directly reachable (e.g. api.sophnet.com). Node's default fetch does NOT read
// http_proxy/https_proxy, so proxy-only endpoints fail with status 0.
//
// `EnvHttpProxyAgent` respects HTTP_PROXY/HTTPS_PROXY/NO_PROXY, so localhost
// health checks (127.0.0.1) still bypass the proxy when NO_PROXY lists them.
// Imported first in server.ts so the dispatcher is set before any fetch runs.
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

const proxyEnv =
  process.env.http_proxy || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.HTTPS_PROXY;

if (proxyEnv) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
