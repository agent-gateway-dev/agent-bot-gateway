import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStartCommand, runStopCommand } from "../src/cli/commands/service.js";

const tempDirs: string[] = [];
const originalLaunchdLabel = process.env.DISCORD_LAUNCHD_LABEL;

afterEach(async () => {
  process.env.DISCORD_LAUNCHD_LABEL = originalLaunchdLabel;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("cli service commands", () => {
  test("start command bootstraps/enables/kickstarts service", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    await fs.writeFile(
      path.join(cwd, "com.codex.discord.bridge.plist"),
      "<plist><dict><key>Label</key><string>com.codex.discord.bridge</string></dict></plist>",
      "utf8"
    );
    const calls: string[][] = [];

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });

    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    expect(result.ok).toBe(true);
    expect(result.message).toBe("service started");
    expect(calls).toEqual([
      ["bootstrap", domain, path.join(cwd, "com.codex.discord.bridge.plist")],
      ["enable", `${domain}/com.codex.discord.bridge`],
      ["kickstart", "-k", `${domain}/com.codex.discord.bridge`]
    ]);
  });

  test("start tolerates already-loaded bootstrap responses", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
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
