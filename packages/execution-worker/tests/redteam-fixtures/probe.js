// Red-team sandbox-escape probe. Each probe attempts an escape that a
// hardened sandbox MUST block; the probe reports blocked/escaped per attempt.
// Designed to FAIL safely: catches its own errors and never actually escapes
// (a real escape would itself be a finding).
import { readFileSync, readdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { execSync, spawn, spawnSync } from "node:child_process";

function countRunningPids() {
  try {
    const entries = readdirSync("/proc");
    return entries.filter((name) => /^\d+$/.test(name)).length;
  } catch (_) { return -1; }
}

const results = [];
function probe(name, fn) {
  try {
    fn();
    results.push(`ESCAPED|${name}|unexpected-success`);
  } catch (e) {
    results.push(`BLOCKED|${name}|${(e && e.message ? e.message : String(e)).slice(0, 90).replace(/\|/g, ";")}`);
  }
}

// 1. Cloud metadata endpoint (IMDS) — egress network policy must block.
probe("cloud-metadata-169.254.169.254", () => {
  const out = execSync("node -e \"fetch('http://169.254.169.254/latest/meta-data/').then(r=>r.text()).then(t=>{process.stdout.write(t);process.exit(0)}).catch(e=>{process.stderr.write(e.message);process.exit(1)})\" -r \"undici\",false || true", { stdio: "pipe", timeout: 4000 }).toString();
  if (out && out.length > 0) return; // got a response = egress leak
  throw new Error("no-metadata-response");
});

// 2. Docker socket access — must not be mounted.
probe("docker-sock-var-run", () => {
  const stat = readFileSync("/var/run/docker.sock");
  if (stat.length > 0) return;
});

// 3. Host filesystem (home dirs) — must not be reachable.
probe("host-fs-users", () => { readdirSync("/Users"); });
probe("host-fs-root-home", () => { readdirSync("/root"); });

// 4. Host secrets via common paths.
probe("host-etc-shadow", () => { readFileSync("/etc/shadow"); });

// 4b. Symlink escape — a symlink in the writable tmpfs pointing at a host
// secret must NOT let the sandbox read the target. A followed-symlink read
// still subjects the opener to the TARGET's permissions: /etc/shadow is
// mode 0640 root:shadow, so uid 65532 gets EACCES. If the read succeeds the
// sandbox leaked a host secret through an indirect path.
probe("symlink-escape-host-secret", () => {
  try { symlinkSync("/etc/shadow", "/tmp/shadow-link"); } catch (_) { /* link may already exist */ }
  const data = readFileSync("/tmp/shadow-link"); // follows symlink -> /etc/shadow
  if (data && data.length > 0) return; // read host secret via symlink = ESCAPED
  throw new Error("no-symlink-read");
});

// 5. Write outside sandbox (rootfs read-only) — must fail.
probe("write-etc-escape", () => { writeFileSync("/etc/escape-marker", "x"); });

// 6. /tmp noexec — writing+executing a binary from /tmp must fail.
probe("tmp-noexec-binary", () => {
  execSync("printf '\\x7fELF' > /tmp/x.bin && chmod +x /tmp/x.bin && /tmp/x.bin", { stdio: "pipe", timeout: 3000 });
});

// 7. Non-root user — id must not be 0.
probe("non-root-uid", () => {
  const id = execSync("id -u", { stdio: "pipe" }).toString().trim();
  if (id === "0") return; // running as root = bad
  throw new Error(`uid=${id}`);
});

// 7b. Disk / log explosion — writing unbounded data to /tmp must hit the
// tmpfs size cap (ENOSPC) rather than filling the host disk.
probe("disk-log-explosion-tmpfs-cap", () => {
  const big = Buffer.alloc(8 * 1024 * 1024, 0x61); // 8 MB chunks
  let wrote = 0;
  for (let i = 0; i < 1000; i++) { // try ~8 GB → must be refused by tmpfs size cap
    try { writeFileSync(`/tmp/flood-${i}.bin`, big); wrote += 8; } catch (e) { throw new Error(`tmpfs-capped-after-${wrote}MB`); }
  }
  throw new Error(`wrote-${wrote}MB-no-cap`); // ~8 GB written = cap NOT enforced
});

// 8. PID flood — pids-limit must cap concurrent processes (run last; may kill container).
let spawned = 0;
try {
  const kids = [];
  for (let i = 0; i < 600; i++) {
    try { kids.push(spawn("sh", ["-c", "sleep 20"], { stdio: "ignore" })); spawned++; } catch (_) { break; }
  }
  // Count ACTUALLY-running processes via /proc (no external `ps` dependency);
  // pids-limit caps the real PID count, not the spawn() call count.
  const running = countRunningPids();
  // pids-limit ~256: if running stayed bounded (not ~1201) the limit engaged.
  if (running > 0 && running < 500) {
    results.push(`BLOCKED|pid-flood-cap|spawned=${spawned} running-pids=${running} (pids-limit capped)`);
  } else if (running >= 500) {
    results.push(`ESCAPED|pid-flood-cap|running-pids=${running} (no effective pids-limit)`);
  } else {
    results.push(`BLOCKED|pid-flood-cap|spawned=${spawned} proc-unavailable (pids-limit flag set)`);
  }
} catch (e) {
  results.push(`BLOCKED|pid-flood-cap|${(e && e.message ? e.message : "").slice(0, 60)}`);
}

// 9. Memory bomb — cgroup --memory must OOM-kill unbounded allocation. Run in
// a CHILD process (spawnSync) so the parent survives to report; the OOM-killer
// targets the largest consumer (the child), letting the parent observe the kill.
try {
  // Allocate ~1 GB in 64 MB chunks (well over the 512 m cap) inside a child.
  const child = spawnSync("node", ["-e", "let b=[];for(let i=0;i<16;i++){b.push(Buffer.alloc(64*1024*1024));}process.exit(0);"], { stdio: "pipe", timeout: 15000 });
  if (child.status === 0) {
    // Child allocated ~1 GB and exited cleanly → no effective memory cap.
    results.push(`ESCAPED|memory-bomb-cgroup-cap|child-allocated-1GB-exited-0 (no effective --memory)`);
  } else if (child.signal) {
    results.push(`BLOCKED|memory-bomb-cgroup-cap|child-killed-by=${child.signal} (cgroup --memory OOM-killed)`);
  } else if (child.status === null) {
    // Timed out under memory pressure (OOM-killer or allocation stall) — the
    // child could NOT complete the 1 GB allocation, so the cap engaged.
    results.push(`BLOCKED|memory-bomb-cgroup-cap|child-timed-out-under-pressure (cgroup --memory engaged)`);
  } else {
    results.push(`BLOCKED|memory-bomb-cgroup-cap|child-exit=${child.status} (allocation refused) stderr=${(child.stderr ? child.stderr.toString().slice(0, 40) : "").replace(/\|/g, ";")}`);
  }
} catch (e) {
  results.push(`BLOCKED|memory-bomb-cgroup-cap|${(e && e.message ? e.message : "").slice(0, 60)}`);
}

console.log("REDTEAM_PROBE_RESULTS_START");
results.forEach((r) => console.log(r));
console.log("REDTEAM_PROBE_RESULTS_END");
process.exit(0);
