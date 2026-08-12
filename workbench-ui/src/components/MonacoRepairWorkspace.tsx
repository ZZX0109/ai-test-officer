// Runtime-only boundary for the heavy Monaco editor. App.tsx loads this
// module with React.lazy, so the Workbench preview/assistant path never pays
// the editor, language services or worker cost. RepairWorkspace itself stays
// runtime-agnostic and remains cheap to exercise in component tests.
import "../monaco";

export { RepairWorkspace } from "./RepairWorkspace";
