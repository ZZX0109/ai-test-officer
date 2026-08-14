import React from "react";

type State = { error?: Error };

export class WorkbenchSectionBoundary extends React.Component<React.PropsWithChildren<{ label: string }>, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("workbench_section_render_failed", {
      section: this.props.label,
      error,
      componentStack: info.componentStack
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="workbench-section-error" role="status" aria-live="polite">
        <strong>{this.props.label}暂时无法显示</strong>
        <span>其他区域和当前测试继续保持运行。</span>
        <button type="button" onClick={() => this.setState({ error: undefined })}>恢复显示</button>
        <details>
          <summary>技术详情</summary>
          <pre>{this.state.error.message}</pre>
        </details>
      </section>
    );
  }
}
