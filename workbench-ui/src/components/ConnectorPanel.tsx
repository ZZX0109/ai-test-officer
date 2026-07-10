import type { ChangeEvent } from "react";

interface ConnectorPanelProps {
  requirementPath: string;
  requirementUrl: string;
  bugTicketPath: string;
  bugTicketUrl: string;
  prDiffUrl: string;
  openApiPath: string;
  openApiUrl: string;
  strictInput: boolean;
  hasRemoteConnectorInput: boolean;
  onRequirementPathChange: (value: string) => void;
  onRequirementUrlChange: (value: string) => void;
  onBugTicketPathChange: (value: string) => void;
  onBugTicketUrlChange: (value: string) => void;
  onPrDiffUrlChange: (value: string) => void;
  onOpenApiPathChange: (value: string) => void;
  onOpenApiUrlChange: (value: string) => void;
  onStrictInputChange: (value: boolean) => void;
}

function value(handler: (value: string) => void) {
  return (event: ChangeEvent<HTMLInputElement>) => handler(event.target.value);
}

export function ConnectorPanel({
  requirementPath,
  requirementUrl,
  bugTicketPath,
  bugTicketUrl,
  prDiffUrl,
  openApiPath,
  openApiUrl,
  strictInput,
  hasRemoteConnectorInput,
  onRequirementPathChange,
  onRequirementUrlChange,
  onBugTicketPathChange,
  onBugTicketUrlChange,
  onPrDiffUrlChange,
  onOpenApiPathChange,
  onOpenApiUrlChange,
  onStrictInputChange
}: ConnectorPanelProps) {
  return (
    <section className="connector-box">
      <h3>MCP Connector 输入</h3>
      <div className="connector-grid">
        <label>
          需求文件路径
          <input value={requirementPath} onChange={value(onRequirementPathChange)} />
        </label>
        <label>
          需求文档 URL
          <input
            value={requirementUrl}
            onChange={value(onRequirementUrlChange)}
            placeholder="https://docs.example.com/requirement.md"
          />
        </label>
        <label>
          Bug/TAPD 文件路径
          <input value={bugTicketPath} onChange={value(onBugTicketPathChange)} />
        </label>
        <label>
          Bug/TAPD URL
          <input
            value={bugTicketUrl}
            onChange={value(onBugTicketUrlChange)}
            placeholder="https://tapd.example.com/bug/1024"
          />
        </label>
        <label className="connector-wide">
          PR Diff URL
          <input
            value={prDiffUrl}
            onChange={value(onPrDiffUrlChange)}
            placeholder="https://github.com/org/repo/pull/123.diff"
          />
        </label>
        <label>
          OpenAPI 文件
          <input value={openApiPath} onChange={value(onOpenApiPathChange)} placeholder="docs/openapi.json" />
        </label>
        <label>
          OpenAPI URL
          <input
            value={openApiUrl}
            onChange={value(onOpenApiUrlChange)}
            placeholder="https://api.example.com/openapi.json"
          />
        </label>
      </div>
      <label className="checkbox-row">
        <input
          checked={strictInput}
          onChange={(event) => onStrictInputChange(event.target.checked)}
          type="checkbox"
        />
        strictInput：禁止自动回退 demo fixture
      </label>
      <div className="connector-status">
        <span>{strictInput ? "strict" : hasRemoteConnectorInput ? "remote" : "local fixture"}</span>
        <p>
          {strictInput
            ? "严格模式下缺失来源会标记 missing，不会混入演示 fixture。"
            : hasRemoteConnectorInput
            ? "提交检查和需求验收会优先读取远程连接器输入。"
            : "未填写远程 URL 时使用本地 fixture，适合离线环境。"}
        </p>
        <p>
          本地文件路径默认只允许当前工作区；接入外部真实项目文档时，请在 Agent 环境中设置
          <code>WORKSPACE_ROOT</code> 或 <code>CONNECTOR_FILE_ROOTS</code>，未加入白名单的绝对路径会标记为 missing。
        </p>
      </div>
    </section>
  );
}
