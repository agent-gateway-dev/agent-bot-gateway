import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStartCommand, runStopCommand } from "../src/cli/commands/service.js";
import { resolveInstalledLaunchdPlistPath } from "../src/cli/paths.js";

const tempDirs: string[] = [];
const originalLaunchdLabel = process.env.DISCORD_LAUNCHD_LABEL;
const originalHome = process.env.HOME;

beforeEach(() => {
  delete process.env.DISCORD_LAUNCHD_LABEL;
});

afterEach(async () => {
  process.env.DISCORD_LAUNCHD_LABEL = originalLaunchdLabel;
  process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function seedLaunchdSupportFiles(cwd: string): Promise<void> {
  await fs.mkdir(path.join(cwd, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "scripts", "launchd-wrapper.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\nexec /bin/bash ./scripts/restart-supervisor.sh -- /usr/bin/node ./scripts/start-with-proxy.mjs\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "scripts", "restart-supervisor.sh"),
    "#!/usr/bin/env bash\n# Host-managed restart supervisor\n",
    "utf8"
  );
  await fs.chmod(path.join(cwd, "scripts", "launchd-wrapper.sh"), 0o755);
  await fs.chmod(path.join(cwd, "scripts", "restart-supervisor.sh"), 0o755);
}

describe("cli service commands", () => {
  test("start command bootstraps/enables/kickstarts service", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await fs.writeFile(
      path.join(cwd, "com.agent.gateway.plist"),
      "<plist><dict><key>Label</key><string>com.agent.gateway</string></dict></plist>",
      "utf8"
    );
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });

    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    const installedPlistPath = resolveInstalledLaunchdPlistPath("com.agent.gateway");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("service started");
    expect(calls).toEqual([
      ["bootstrap", domain, installedPlistPath],
      ["enable", `${domain}/com.agent.gateway`],
      ["kickstart", "-k", `${domain}/com.agent.gateway`]
    ]);
    const installedPlist = await fs.readFile(installedPlistPath, "utf8");
    expect(installedPlist).toContain("<string>/bin/bash</string>");
    expect(installedPlist).toContain("<string>-lc</string>");
    expect(installedPlist).toContain(`cd &apos;${cwd}&apos;`);
    expect(installedPlist).toContain("./scripts/start-with-proxy.mjs");
    expect(fsSync.existsSync(path.join(fakeHome, "Library", "Application Support", "AgentGateway", "com.agent.gateway"))).toBe(false);
  });

  test("start tolerates already-loaded bootstrap responses", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    let invocation = 0;

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      invocation += 1;
      if (invocation === 1) {
        return { code: 5, stdout: "", stderr: "service already loaded" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(3);
  });

  test("start returns error when launchd support files are missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-missing-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    const calls: string[][] = [];
    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("failed to prepare launchd service files");
    expect(String(result.details?.error ?? "")).toContain("launchd-wrapper.sh");
    expect(calls).toEqual([]);
  });

  test("start tolerates launchctl bootstrap I/O error when service is already loaded", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    let invocation = 0;

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      invocation += 1;
      if (invocation === 1) {
        return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      if (invocation === 2) {
        return { code: 0, stdout: "service loaded", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      [
        "bootstrap",
        `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`,
        resolveInstalledLaunchdPlistPath("com.agent.gateway")
      ],
      ["print", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.agent.gateway`],
      ["enable", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.agent.gateway`],
      ["kickstart", "-k", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.agent.gateway`]
    ]);
  });

  test("start tolerates kickstart failure when the service is already loaded", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await fs.writeFile(
      path.join(cwd, "com.agent.gateway.plist"),
      "<plist><dict><key>Label</key><string>com.agent.gateway</string></dict></plist>",
      "utf8"
    );
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    let invocation = 0;

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      invocation += 1;
      if (invocation === 3) {
        return { code: 37, stdout: "", stderr: "" };
      }
      if (invocation === 4) {
        return { code: 0, stdout: "service loaded", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["bootstrap", domain, resolveInstalledLaunchdPlistPath("com.agent.gateway")],
      ["enable", `${domain}/com.agent.gateway`],
      ["kickstart", "-k", `${domain}/com.agent.gateway`],
      ["print", `${domain}/com.agent.gateway`]
    ]);
  });

  test("stop command accepts already-stopped state", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-stop-"));
    tempDirs.push(cwd);

    const result = await runStopCommand([], { cwd, now: new Date() }, async () => {
      return { code: 3, stdout: "", stderr: "Could not find service" };
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("service stopped");
  });

  test("start/stop reject unexpected args", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-args-"));
    tempDirs.push(cwd);

    const start = await runStartCommand(["now"], { cwd, now: new Date() });
    expect(start.ok).toBe(false);
    expect(start.message).toContain("does not accept arguments");

    const stop = await runStopCommand(["now"], { cwd, now: new Date() });
    expect(stop.ok).toBe(false);
    expect(stop.message).toContain("does not accept arguments");
  });
});
