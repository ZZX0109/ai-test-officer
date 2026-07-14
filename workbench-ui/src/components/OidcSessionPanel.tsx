import { beginOidcLogin, clearOidcSession } from "../auth";
export function OidcSessionPanel({ configured, authenticated }: { configured: boolean; authenticated: boolean }) {
  if (!configured) return <span className="status-pill">开发会话</span>;
  return authenticated
    ? <button className="ghost-button" type="button" onClick={() => { clearOidcSession(); window.location.reload(); }}>退出 OIDC</button>
    : <button className="ghost-button" type="button" onClick={() => void beginOidcLogin()}>OIDC 登录</button>;
}
