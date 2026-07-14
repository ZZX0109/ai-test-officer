const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const issuer = env.VITE_OIDC_ISSUER?.replace(/\/$/, "");
const clientId = env.VITE_OIDC_CLIENT_ID;
const redirectUri = env.VITE_OIDC_REDIRECT_URI ?? (typeof window !== "undefined" ? `${window.location.origin}/` : "");

function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomValue() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return encode(bytes); }

export function oidcConfigured() { return Boolean(issuer && clientId); }
export function getAccessToken() { return sessionStorage.getItem("ato_access_token") ?? undefined; }
export function clearOidcSession() { sessionStorage.removeItem("ato_access_token"); sessionStorage.removeItem("ato_oidc_verifier"); sessionStorage.removeItem("ato_oidc_state"); }

export async function beginOidcLogin() {
  if (!issuer || !clientId) throw new Error("OIDC is not configured");
  const verifier = randomValue(); const state = randomValue();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  sessionStorage.setItem("ato_oidc_verifier", verifier); sessionStorage.setItem("ato_oidc_state", state);
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid profile", state, code_challenge: encode(new Uint8Array(digest)), code_challenge_method: "S256" });
  window.location.assign(`${issuer}/protocol/openid-connect/auth?${query}`);
}

export async function initializeOidc() {
  if (!oidcConfigured()) return { configured: false, authenticated: false };
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  if (code) {
    const state = query.get("state"); const expected = sessionStorage.getItem("ato_oidc_state"); const verifier = sessionStorage.getItem("ato_oidc_verifier");
    if (!state || state !== expected || !verifier) throw new Error("oidc_callback_state_invalid");
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId!, redirect_uri: redirectUri, code, code_verifier: verifier }) });
    if (!response.ok) throw new Error(`oidc_token_exchange_${response.status}`);
    const token = (await response.json() as { access_token?: string }).access_token;
    if (!token) throw new Error("oidc_access_token_missing");
    sessionStorage.setItem("ato_access_token", token);
    history.replaceState({}, document.title, window.location.pathname);
  }
  return { configured: true, authenticated: Boolean(getAccessToken()) };
}
