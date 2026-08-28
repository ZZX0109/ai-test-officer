import { Activity } from "lucide-react";
import type { PlanningAutomationPhase } from "../appPresentation";

interface RunPreparationModalProps {
  phase: PlanningAutomationPhase;
  detail: string;
  loginUsername: string;
  loginPassword: string;
  loginError: string;
  loginSaving: boolean;
  onClose: () => void;
  onLoginUsernameChange: (value: string) => void;
  onLoginPasswordChange: (value: string) => void;
  onSkipCredentials: () => void;
  onSaveCredentials: () => void;
  onCancelPermission: () => void;
  onGrantPermission: () => void;
  onReturnBlocked: () => void;
}

const COMPLETED_PHASES = ["discovering", "binding", "starting-run", "running", "ready"] as const;

export function RunPreparationModal(props: RunPreparationModalProps) {
  const { phase } = props;
  return (
    <div className="run-preview-overlay" role="dialog" aria-modal="true" aria-label="AI 测试准备与授权">
      <section className="run-preview-dialog showing-preparation">
        <header>
          <div>
            <span className="section-kicker">
              {phase === "needs-credentials" ? "需要测试账号"
                : phase === "needs-permission" ? "需要你的确认"
                  : phase === "blocked" ? "准备遇到问题" : "正在准备测试"}
            </span>
            <strong>{props.detail || "正在检查隔离环境与测试条件"}</strong>
          </div>
          <button type="button" onClick={props.onClose}>最小化</button>
        </header>
        <div className="run-preparation-panel" aria-live="polite">
          <ol className="run-preparation-steps">
            <li className={phase === "needs-permission" || phase === "needs-credentials" ? "active" : COMPLETED_PHASES.includes(phase as typeof COMPLETED_PHASES[number]) ? "complete" : ""}>
              <span>1</span>
              <div><strong>确认操作授权</strong><small>授权仅对本次运行生效，可随时取消</small></div>
            </li>
            <li className={phase === "preparing-project" ? "active" : COMPLETED_PHASES.includes(phase as typeof COMPLETED_PHASES[number]) ? "complete" : ""}>
              <span>2</span>
              <div><strong>准备隔离环境</strong><small>检查项目服务、沙盒和运行地址</small></div>
            </li>
            <li className={phase === "discovering" ? "active" : ["binding", "starting-run", "running", "ready"].includes(phase) ? "complete" : ""}>
              <span>3</span>
              <div><strong>扫描真实页面</strong><small>识别控件、接口和可验证结果</small></div>
            </li>
            <li className={phase === "binding" ? "active" : ["starting-run", "running", "ready"].includes(phase) ? "complete" : ""}>
              <span>4</span>
              <div><strong>生成可执行路径</strong><small>绑定动作、断言与证据要求</small></div>
            </li>
          </ol>
          {phase === "needs-credentials" ? (
            <section className="run-permission-request run-credentials-request">
              <strong>本次测试需要登录账号</strong>
              <p>测试计划包含登录步骤。账号会加密保存，只在本次项目的隔离沙盒中使用，不会写入对话或项目源码。</p>
              <div className="connector-grid">
                <label>
                  测试账号
                  <input autoComplete="off" value={props.loginUsername} onChange={(event) => props.onLoginUsernameChange(event.target.value)} placeholder="邮箱或用户名" />
                </label>
                <label>
                  测试密码
                  <input type="password" autoComplete="new-password" value={props.loginPassword} onChange={(event) => props.onLoginPasswordChange(event.target.value)} placeholder="输入测试密码" />
                </label>
              </div>
              {props.loginError ? <p className="project-login-save-message" role="alert">{props.loginError}</p> : null}
              <div>
                <button type="button" onClick={props.onSkipCredentials}>暂不配置</button>
                <button className="primary" type="button" disabled={props.loginSaving} onClick={props.onSaveCredentials}>
                  {props.loginSaving ? "正在保存…" : "保存账号并继续"}
                </button>
              </div>
            </section>
          ) : phase === "needs-permission" ? (
            <section className="run-permission-request">
              <strong>允许 AI 操作本次沙盒浏览器？</strong>
              <p>将执行点击、输入、页面跳转和证据采集；不会控制你的桌面或其他应用。</p>
              <div>
                <button type="button" onClick={props.onCancelPermission}>暂不授权</button>
                <button className="primary" type="button" onClick={props.onGrantPermission}>允许并继续</button>
              </div>
            </section>
          ) : phase === "blocked" ? (
            <section className="run-preparation-error">
              <strong>自动准备暂时无法继续</strong>
              <p>{props.detail}</p>
              <button type="button" onClick={props.onReturnBlocked}>返回 AI 测试助手处理</button>
            </section>
          ) : (
            <div className="run-preparation-waiting">
              <Activity size={18} />
              <span>{props.detail || "正在准备，请稍候…"}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
