import { useState } from "react";
import type { BusinessFunction } from "../types";

function statusLabel(status: BusinessFunction["status"]) {
  return status === "ready" ? "可规划" : status === "needs-confirmation" ? "需补充条件" : status === "blocked" ? "暂不可执行" : "待确认";
}

/** User-facing capability list. Technical paths stay behind an explicit details disclosure. */
export function BusinessFunctionList(props: {
  functions: BusinessFunction[];
  total?: number;
  nextCursor?: string;
  loading?: boolean;
  onLoadMore?: () => void;
}) {
  return <section className="business-function-list" aria-label="业务功能清单">
    <div className="business-function-list__summary">
      <strong>{props.total ?? props.functions.length} 个业务功能</strong>
      <span>Agent 会在内部为每个功能选择页面、接口和数据测试路径</span>
    </div>
    {props.functions.map((feature) => <BusinessFunctionCard key={feature.id} feature={feature} />)}
    {props.nextCursor && props.onLoadMore ? <button className="business-function-load-more" type="button" disabled={props.loading} onClick={props.onLoadMore}>
      {props.loading ? "正在加载业务功能…" : `继续查看（还剩 ${Math.max(0, (props.total ?? props.functions.length) - props.functions.length)} 个）`}
    </button> : null}
  </section>;
}

function BusinessFunctionCard({ feature }: { feature: BusinessFunction }) {
  const [expanded, setExpanded] = useState(false);
  return <article className={`business-function-card business-function-card--${feature.status}`}>
    <header>
      <div>
        <strong>{feature.name}</strong>
        <p>{feature.purpose}</p>
      </div>
      <span className="business-function-status">{statusLabel(feature.status)}</span>
    </header>
    <div className="business-function-meta">
      <span>{feature.branchCount} 个测试分支</span>
      {feature.roles.length ? <span>{feature.roles.join("、")}</span> : null}
      <span>可信度：{feature.confidence}</span>
    </div>
    <button className="business-function-details-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      {expanded ? "收起处理依据" : "查看处理依据"}
    </button>
    {expanded && <div className="business-function-details">
      <p>{feature.summary}</p>
      {feature.sourceLocations.length ? <ul>{feature.sourceLocations.slice(0, 8).map((source) => <li key={`${source.file}:${source.line ?? 0}:${source.sourceHash}`}>{source.file}{source.line ? `:${source.line}` : ""}</li>)}</ul> : <p>尚未绑定源码依据。</p>}
    </div>}
  </article>;
}
