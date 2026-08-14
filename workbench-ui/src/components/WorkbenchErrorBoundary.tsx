import React from "react";

type State = { error?: Error };

/** Keep one rendering defect from turning the entire operator surface white.
 * This does not invent a test result or retry the Graph; it only preserves a
 * visible recovery affordance for the Workbench itself. */
export class WorkbenchErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("workbench_render_failed", { error, componentStack: info.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="workbench-crash-state" role="alert">
        <section>
          <strong>工作台界面遇到异常</strong>
          <p>测试服务不会因此被判定为完成。刷新后会重新读取当前 Run、浏览器会话和已保存证据。</p>
          <button type="button" onClick={() => window.location.reload()}>重新载入工作台</button>
          <details>
            <summary>技术详情</summary>
            <pre>{this.state.error.message}</pre>
          </details>
        </section>
      </main>
    );
  }
}
