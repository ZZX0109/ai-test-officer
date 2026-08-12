import { Trash2 } from "lucide-react";
import type { PlannedBusinessFlow } from "../types";
import { LazyDetails, ProgressiveDetailsList } from "./ProgressiveDetailsList";

export function BusinessFlowList(props: {
  flows: PlannedBusinessFlow[];
  total?: number;
  hasMore: boolean;
  loading: boolean;
  deletingId: string | null;
  onLoadMore: () => Promise<void>;
  onDelete: (id: string) => void;
  onHoverStart: (id: string) => void;
  onHoverEnd: (id: string) => void;
}) {
  const { flows, total, hasMore, loading, deletingId } = props;
  return <ProgressiveDetailsList
    className="planning-flow-list"
    items={flows}
    itemKey={(flow) => flow.id}
    initialCount={24}
    batchSize={24}
    totalCount={total}
    hasMore={hasMore}
    loadingMore={loading}
    onLoadMore={props.onLoadMore}
    summary={<>查看全部 {total ?? flows.length} 条业务流程</>}
    renderItem={(flow) => <article className={`planning-flow ${flow.status}`} onMouseEnter={() => props.onHoverStart(flow.id)} onMouseLeave={() => props.onHoverEnd(flow.id)}>
      <div>
        <strong>{flow.title}</strong>
        <span>{flow.kind === "page" ? "页面" : flow.kind === "component" ? "功能组件" : flow.kind === "api" ? "接口" : flow.kind === "data" ? "数据" : flow.kind === "background-task" ? "后台任务" : "测试场景"} · {flow.confidence} confidence</span>
      </div>
      <div className="planning-flow-actions">
        <span className="planning-flow-status">{flow.status === "executable" ? "可执行" : flow.status === "auto-bindable" ? "可自动生成" : flow.status === "needs-input" ? "待补条件" : "覆盖缺口"}</span>
        {deletingId === flow.id ? <button className="planning-flow-delete" type="button" onClick={() => props.onDelete(flow.id)} aria-label={`从本次测试计划删除 ${flow.title}`}><Trash2 size={13} />删除</button> : null}
      </div>
      <p>{flow.reason}</p>
      {flow.pathVersion === "2.0" ? <LazyDetails className="planning-flow-evidence" summary={<>查看业务依据{flow.sourceCount ? ` · ${flow.sourceCount} 个代码节点` : ""}</>}>
        {flow.summary ? <p>{flow.summary}</p> : null}
        {flow.surfaces?.length ? <p><strong>覆盖层：</strong>{flow.surfaces.map((surface) => surface === "background-task" ? "后台任务" : surface === "data" ? "数据" : surface === "api" ? "接口" : "页面").join(" → ")}</p> : null}
        {flow.roles?.length ? <p><strong>角色与权限：</strong>{flow.roles.join("；")}</p> : null}
        {flow.actionCandidates?.length ? <p><strong>计划动作：</strong>{flow.actionCandidates.join("；")}</p> : null}
        {flow.oracleCandidates?.length ? <p><strong>验证依据：</strong>{flow.oracleCandidates.join("；")}</p> : null}
        {flow.sourceLocations?.length ? <ul>{flow.sourceLocations.slice(0, 12).map((source) => <li key={`${source.file}:${source.line ?? 0}`}>{source.file}{source.line ? `:${source.line}` : ""} · {source.parser}</li>)}</ul> : null}
      </LazyDetails> : null}
    </article>}
  />;
}
