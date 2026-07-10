const projectLocks = new Map<string, { tail: Promise<unknown>; startedAt: string }>();

export function listRunLocks() {
  return Array.from(projectLocks.keys()).map((projectId) => ({
    projectId,
    status: "locked" as const,
    startedAt: projectLocks.get(projectId)?.startedAt
  }));
}

export async function withProjectRunLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId)?.tail ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  projectLocks.set(projectId, { tail, startedAt: new Date().toISOString() });
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (projectLocks.get(projectId)?.tail === tail) {
      projectLocks.delete(projectId);
    }
  }
}
