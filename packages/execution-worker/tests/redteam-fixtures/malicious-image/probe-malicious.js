// Red-team: malicious-OCI-image probe. The image bakes in a setuid binary, a
// malicious ENTRYPOINT, and host-escape binaries. This probe runs INSIDE the
// container with execution-worker's exact hardening and asserts every
// image-based malicious vector is BLOCKED. Designed to FAIL safely.
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const results = [];
function probe(name, fn) {
  try {
    fn();
    results.push(`ESCAPED|${name}|unexpected-success`);
  } catch (e) {
    results.push(`BLOCKED|${name}|${(e && e.message ? e.message : String(e)).slice(0, 120).replace(/\|/g, ";")}`);
  }
}

// 1. setuid escalation — no-new-privileges + non-root user must block the image-baked setuid binary.
probe("malicious-image-setuid-escalation", () => {
  const out = execSync('/usr/local/bin/setuid-sh -c "id"', { stdio: 'pipe', timeout: 4000 }).toString();
  if (out.includes('uid=0')) return; // escalated to root = ESCAPED
  throw new Error(`setuid did not escalate (no-new-privileges); id=${out.trim()}`);
});

// 2. ENTRYPOINT override — execution-worker uses --entrypoint /bin/sh -c, so the
//    image's malicious ENTRYPOINT must NOT have run. /etc/passwd must be clean.
probe("malicious-image-entrypoint-override", () => {
  const passwd = readFileSync('/etc/passwd', 'utf8');
  if (passwd.includes('attacker::0:0')) return; // ENTRYPOINT ran + persisted = ESCAPED
  throw new Error('entrypoint overridden (no attacker entry in /etc/passwd)');
});

// 3. mount host — cap-drop ALL + non-root must block the image-baked mount binary.
probe("malicious-image-mount-host", () => {
  let out = '';
  try { out = execSync('/usr/local/bin/mount-host 2>&1; echo "EXIT=$?"', { stdio: 'pipe', timeout: 4000 }).toString(); }
  catch (e) { out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''); }
  if (/\/mnt\b/.test(out) && !/not permitted|permission denied|denied|operation not|no such/i.test(out)) return;
  throw new Error('mount blocked (cap-drop ALL + non-root)');
});

// 4. read docker.sock — the image-baked binary tries to read /var/run/docker.sock.
//    Must not be mounted / not readable.
probe("malicious-image-read-docker-sock", () => {
  if (!existsSync('/var/run/docker.sock')) throw new Error('docker.sock not mounted (no host socket)');
  let out = '';
  try { out = execSync('/usr/local/bin/read-docker-sock 2>&1; echo "EXIT=$?"', { stdio: 'pipe', timeout: 4000 }).toString(); }
  catch (e) { out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''); }
  if (out.includes('{') && out.includes('"')) return; // read the sock = ESCAPED
  throw new Error('docker.sock present but not readable (non-root + no mount)');
});

console.log("REDTEAM_MALICIOUS_IMAGE_RESULTS_START");
results.forEach(r => console.log(r));
console.log("REDTEAM_MALICIOUS_IMAGE_RESULTS_END");
