import type { ReadinessCheck } from "@ai-test-officer/contracts";

export interface ReadinessCheckDefinition {
  id: string;
  requiredBy: string[];
}

/**
 * The single collection boundary for readiness checks. Definitions are
 * registered once, while every inspection gets a fresh result set. This
 * prevents two adapters from silently emitting the same check id and makes
 * the report contract extensible without moving checks into route handlers.
 */
export class ReadinessRegistry {
  private readonly definitions = new Map<string, ReadinessCheckDefinition>();
  private readonly results = new Map<string, ReadinessCheck>();

  register(definition: ReadinessCheckDefinition) {
    if (this.definitions.has(definition.id)) throw new Error(`readiness_check_duplicate:${definition.id}`);
    this.definitions.set(definition.id, { ...definition, requiredBy: [...definition.requiredBy] });
    return this;
  }

  fork() {
    const next = new ReadinessRegistry();
    for (const definition of this.definitions.values()) next.register(definition);
    return next;
  }

  record(check: ReadinessCheck) {
    const definition = this.definitions.get(check.id);
    if (!definition) throw new Error(`readiness_check_unregistered:${check.id}`);
    if (this.results.has(check.id)) throw new Error(`readiness_check_duplicate_result:${check.id}`);
    this.results.set(check.id, {
      ...check,
      requiredBy: check.requiredBy.length ? check.requiredBy : definition.requiredBy
    });
  }

  values() {
    return [...this.results.values()];
  }
}

export function createDefaultReadinessRegistry() {
  return new ReadinessRegistry()
    .register({ id: "project.exists", requiredBy: ["bootstrap", "execution"] })
    .register({ id: "runtime.container-engine", requiredBy: ["sandbox", "execution"] })
    .register({ id: "runtime.playwright-chromium", requiredBy: ["browser", "execution"] })
    .register({ id: "credentials.model", requiredBy: ["planning", "judge"] })
    .register({ id: "credentials.project-login", requiredBy: ["discovery", "browser", "execution"] })
    .register({ id: "project.dependencies", requiredBy: ["sandbox", "execution"] })
    .register({ id: "network.egress", requiredBy: ["sandbox", "network"] })
    .register({ id: "database.connections", requiredBy: ["data-oracle", "execution"] })
    .register({ id: "project.runtime", requiredBy: ["browser", "execution"] })
    .register({ id: "project.frontend-health", requiredBy: ["browser", "discovery"] })
    .register({ id: "project.backend-health", requiredBy: ["api", "database", "execution"] });
}
