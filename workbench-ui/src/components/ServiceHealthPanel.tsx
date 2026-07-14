import { useEffect, useState } from "react";

type ServiceStatus = "listening" | "missing" | "unhealthy";

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

const serviceChecks = [
  { id: "agent", label: "Agent", url: viteEnv.VITE_AGENT_HEALTH_URL ?? "http://127.0.0.1:4317/api/health" },
  { id: "appApi", label: "App API", url: viteEnv.VITE_APP_API_HEALTH_URL ?? "http://127.0.0.1:6172/api/health" },
  { id: "appWeb", label: "App Web", url: viteEnv.VITE_APP_URL ?? "http://127.0.0.1:6173" },
  { id: "workbench", label: "Workbench", url: viteEnv.VITE_WORKBENCH_URL ?? "http://127.0.0.1:6174" }
];

async function check(url: string): Promise<ServiceStatus> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok ? "listening" : "unhealthy";
  } catch {
    return "missing";
  }
}

export function ServiceHealthPanel() {
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const entries = await Promise.all(serviceChecks.map(async (service) => [service.id, await check(service.url)] as const));
      if (!cancelled) setStatuses(Object.fromEntries(entries));
    }
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="service-health-box">
      <h3>Service Runtime</h3>
      <div className="readiness-grid">
        {serviceChecks.map((service) => {
          const status = statuses[service.id] ?? "missing";
          return (
            <article className={status === "listening" ? "passed" : status === "unhealthy" ? "warning" : "failed"} key={service.id}>
              <strong>{service.label}</strong>
              <span>{status}</span>
            </article>
          );
        })}
      </div>
      <p><code>npm run health:check</code> 输出同一组 JSON 状态。</p>
    </section>
  );
}
