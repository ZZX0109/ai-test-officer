import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WorkbenchErrorBoundary } from "./components/WorkbenchErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  // The Workbench owns durable Runs, live browser frames and SSE reconnects.
  // React StrictMode deliberately mounts effects twice in development, which
  // made a local Vite session open duplicate stream/polling lifecycles while
  // an Agent run was starting. Keep the production lifecycle identical to the
  // operator's local session; component tests still run under their own strict
  // test harnesses where appropriate.
  <WorkbenchErrorBoundary>
    <App />
  </WorkbenchErrorBoundary>
);
