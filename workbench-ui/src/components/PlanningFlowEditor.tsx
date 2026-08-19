import { useState } from "react";
import type { PlannedBusinessFlow } from "../types";

// The pre-confirm editable feature list. Planning identifies businessFlows;
// before the user confirms the test plan they may prune, rename, or add a
// custom flow so the confirmed list is a real approval gate — not a rubber
// stamp on whatever the scan produced. Existing excludePlanningFlow logic is
// reused for delete; rename/add are local state mutations on planningResult.

interface PlanningFlowEditorProps {
  flows: PlannedBusinessFlow[];
  disabled?: boolean;
  onExclude: (flowId: string) => void;
  onEditTitle: (flowId: string, title: string) => void;
  onAdd: (title: string) => void;
}

const STATUS_LABEL: Record<PlannedBusinessFlow["status"], string> = {
  executable: "可直接执行",
  "auto-bindable": "待页面确认",
  "needs-input": "需补充信息",
  "coverage-gap": "覆盖缺口"
};

export function PlanningFlowEditor({ flows, disabled, onExclude, onEditTitle, onAdd }: PlanningFlowEditorProps) {
  const [newTitle, setNewTitle] = useState("");
  return (
    <section className="planning-flow-editor" aria-label="功能清单（确认前可增删改）">
      <strong>功能清单</strong>
      <p className="field-hint">确认前可裁剪、改名或补充自定义功能；确认后即作为测试范围，不会修改项目代码。</p>
      {flows.length === 0 ? (
        <p className="planning-flow-empty">暂无识别到的可执行功能；可在下方手动添加要测试的功能。</p>
      ) : (
        <ul className="planning-flow-list">
          {flows.map((flow) => (
            <li key={flow.id} className="planning-flow-item">
              <input
                className="planning-flow-title"
                aria-label="功能名称"
                value={flow.title}
                disabled={disabled}
                onChange={(event) => onEditTitle(flow.id, event.target.value)}
              />
              <span className={`flow-status-chip is-${flow.status}`}>{STATUS_LABEL[flow.status]}</span>
              <button
                type="button"
                className="planning-flow-exclude"
                disabled={disabled}
                onClick={() => onExclude(flow.id)}
                title="从本次测试范围排除"
              >
                排除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="planning-flow-add">
        <input
          aria-label="自定义功能名称"
          value={newTitle}
          disabled={disabled}
          placeholder="补充一个要测试的功能，例如：导出 PDF 报告"
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newTitle.trim() && !disabled) {
              onAdd(newTitle.trim());
              setNewTitle("");
            }
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={disabled || !newTitle.trim()}
          onClick={() => {
            if (newTitle.trim()) {
              onAdd(newTitle.trim());
              setNewTitle("");
            }
          }}
        >
          添加
        </button>
      </div>
    </section>
  );
}
