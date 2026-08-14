import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WorkbenchErrorBoundary } from "./components/WorkbenchErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkbenchErrorBoundary>
      <App />
    </WorkbenchErrorBoundary>
  </React.StrictMode>
);
