import { useEffect, useState } from "react";
import { bootstrapProject, getProjectReadiness, getReadiness } from "../api";
import type { ReadinessReport } from "../types";

export function useReadiness(projectId: string | null, credentialCount: number) {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [docker, setDocker] = useState<{ available: boolean; engine: "docker" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const refresh = () => {
    if (!projectId) return;
    setLoading(true);
    void getProjectReadiness(projectId).then((data) => setReport(data.report)).finally(() => setLoading(false));
  };
  const bootstrap = () => {
    if (!projectId || bootstrapping) return;
    setBootstrapping(true);
    void bootstrapProject(projectId).then((data) => setReport(data.report)).finally(() => setBootstrapping(false));
  };
  useEffect(() => {
    let cancelled = false;
    void getReadiness().then((data) => { if (!cancelled) setDocker(data.docker); }).catch(() => undefined);
    if (!projectId) { setReport(null); return () => { cancelled = true; }; }
    setLoading(true);
    void getProjectReadiness(projectId).then((data) => { if (!cancelled) setReport(data.report); }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, credentialCount]);
  return { report, docker, loading, bootstrapping, refresh, bootstrap };
}
