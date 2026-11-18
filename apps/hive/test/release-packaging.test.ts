import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("release packaging", () => {
  it("the hive image takes HIVE_VERSION and exposes it as env before USER node", () => {
    const df = read("apps/hive/Dockerfile");
    const arg = df.indexOf("ARG HIVE_VERSION=dev");
    const env = df.indexOf("ENV HIVE_VERSION=$HIVE_VERSION");
    expect(arg).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(arg);
    expect(df.indexOf("USER node")).toBeGreaterThan(env);
  });

  it("the release compose lets the image names be overridden, defaulting to GHCR", () => {
    const c = read("docker-compose.release.yml");
    expect(c).toContain("${HIVE_IMAGE:-ghcr.io/bennybrau/hive}:${HIVE_VERSION:-latest}");
    expect(c).toContain("${HIVE_WORKER_IMAGE:-ghcr.io/bennybrau/hive-worker}:${HIVE_VERSION:-latest}");
  });

  it(".env.example documents the image overrides", () => {
    const e = read(".env.example");
    expect(e).toMatch(/^# HIVE_IMAGE=$/m);
    expect(e).toMatch(/^# HIVE_WORKER_IMAGE=$/m);
  });

  it("the workflow passes HIVE_VERSION and attaches the plugin to the release", () => {
    const w = read(".github/workflows/images.yml");
    expect(w).toContain('echo "HIVE_VERSION=${version}"');
    expect(w).toContain("${GITHUB_REF_NAME#v}");
    expect(w).toContain("main-${GITHUB_SHA::7}");
    expect(w).toContain("CLAUDE_CODE_VERSION=2.1.284");
    const release = w.slice(w.indexOf("gh release create") - 200);
    expect(release).toContain("docker-compose.release.yml hive.env.example hive-plugin.tar.gz");
  });

  it("install-e2e sets HIVE_HOME from RUNNER_TEMP in a first step, not in the job env", () => {
    const w = read(".github/workflows/install-e2e.yml");
    expect(w).not.toMatch(/\$\{\{\s*runner\./);
    const env = w.slice(w.indexOf("    env:"), w.indexOf("    steps:"));
    expect(env).not.toContain("HIVE_HOME");
    const steps = w.slice(w.indexOf("    steps:"));
    const set = steps.indexOf('echo "HIVE_HOME=$RUNNER_TEMP/hive-e2e" >> "$GITHUB_ENV"');
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(steps.indexOf("actions/checkout"));
  });

  it("install-e2e runs on installer, compose, image, workflow and .env.example changes", () => {
    const w = read(".github/workflows/install-e2e.yml");
    const paths = w.slice(w.indexOf("    paths:"), w.indexOf("  schedule:"));
    for (const p of [
      "scripts/install.sh",
      "docker-compose.release.yml",
      "apps/hive/Dockerfile",
      "apps/worker/Dockerfile",
      ".github/workflows/install-e2e.yml",
      ".github/workflows/images.yml",
      ".env.example",
    ]) {
      expect(paths).toContain(`- ${p}\n`);
    }
  });

  it("the plugin archive command puts everything under hive/ without tests or __pycache__", () => {
    const out = mkdtempSync(join(tmpdir(), "hive-plugin-"));
    try {
      const tarball = join(out, "hive-plugin.tar.gz");
      execFileSync("tar", ["-czf", tarball, "--exclude=tests", "--exclude=__pycache__", "-C", "plugins", "hive"], {
        cwd: root,
      });
      const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
      expect(files.length).toBeGreaterThan(1);
      expect(files.every((f) => f === "hive/" || f.startsWith("hive/"))).toBe(true);
      expect(files.some((f) => /(^|\/)tests(\/|$)/.test(f) || f.includes("__pycache__"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("test-release.sh builds with the version arg and asserts /health reports it", () => {
    const s = read("scripts/test-release.sh");
    expect(s).toContain('--build-arg HIVE_VERSION="$TAG"');
    expect(s).toContain("HIVE_IMAGE=hive");
    expect(s).toContain("HIVE_WORKER_IMAGE=hive-worker");
    expect(s).toMatch(/version/);
  });
});
