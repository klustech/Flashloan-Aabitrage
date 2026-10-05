#!/usr/bin/env node
// Blocking dependency audit. Fails on any high/critical advisory in production
// dependencies that is not listed in security/audit-exceptions.json, and on any
// exception whose reviewBy date has passed. Exceptions are reviewed risk
// acceptances, not a mute button: each needs a reason and an expiry.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PROJECTS = [".", "server", "frontend"];
const BLOCKING = new Set(["high", "critical"]);
const EXCEPTIONS_PATH = path.join(ROOT, "security/audit-exceptions.json");

function audit(dir) {
  let out;
  try {
    out = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: path.join(ROOT, dir), encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (err) {
    out = err.stdout; // npm audit exits non-zero whenever it finds anything
  }
  const report = JSON.parse(out || "{}");
  if (report.error) throw new Error(`npm audit failed in ${dir}: ${report.error.summary || report.error.code}`);
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities || {}))
    for (const via of vuln.via || [])
      if (typeof via === "object" && BLOCKING.has(via.severity))
        found.set(via.url, { advisory: via.url, package: via.name, severity: via.severity, title: via.title });
  return [...found.values()];
}

function main({ today = new Date().toISOString().slice(0, 10), write = process.argv.includes("--write-baseline") } = {}) {
  const exceptions = fs.existsSync(EXCEPTIONS_PATH) ? JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, "utf8")) : [];
  const byAdvisory = new Map(exceptions.map(e => [e.advisory, e]));
  const findings = new Map();
  for (const dir of PROJECTS) for (const f of audit(dir)) {
    const existing = findings.get(f.advisory);
    findings.set(f.advisory, { ...f, projects: [...(existing?.projects || []), dir] });
  }
  if (write) {
    const reviewBy = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
    const baseline = [...findings.values()].sort((a, b) => a.advisory.localeCompare(b.advisory)).map(f => byAdvisory.get(f.advisory) ||
      { ...f, reason: "Pre-existing when the gate was introduced; triage required (upgrade, replace or document why unreachable).", reviewBy });
    fs.writeFileSync(EXCEPTIONS_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`Wrote ${baseline.length} exceptions to ${path.relative(ROOT, EXCEPTIONS_PATH)}`);
    return 0;
  }
  const errors = [];
  for (const f of findings.values()) {
    const exception = byAdvisory.get(f.advisory);
    if (!exception) errors.push(`UNREVIEWED ${f.severity} ${f.package}: ${f.title} (${f.advisory}) in ${f.projects.join(", ")}`);
    else if (!exception.reason || !exception.reviewBy) errors.push(`INCOMPLETE exception for ${f.advisory}`);
    else if (exception.reviewBy < today) errors.push(`EXPIRED exception (${exception.reviewBy}) ${f.severity} ${f.package}: ${f.advisory}`);
  }
  for (const e of exceptions) if (!findings.has(e.advisory)) console.log(`Resolved, remove from exceptions: ${e.package} ${e.advisory}`);
  console.log(`${findings.size} high/critical production advisories, ${exceptions.length} exceptions, ${errors.length} blocking`);
  for (const e of errors) console.error(e);
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
