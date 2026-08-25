import { startRunWorker } from "../runOrchestrator.js";

interface HttpApp {
  listen(port: number, host: string, callback: () => void): unknown;
}

export function listenAgentServer(input: {
  app: HttpApp;
  port: number;
  host: string;
  securitySummary: () => unknown;
}) {
  input.app.listen(input.port, input.host, () => {
    console.log(`AI Test Officer agent listening on http://${input.host}:${input.port}`);
    console.log("Security boundary:", input.securitySummary());
    // The API process also publishes PostgreSQL outbox rows when the worker
    // runs separately. This repairs a crash between event commit and Redis.
    void startRunWorker().catch((error) => {
      console.error("outbox_publisher_start_failed", error instanceof Error ? error.message : String(error));
    });
  });
}
