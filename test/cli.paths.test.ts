import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCliRuntimePaths } from "../src/cli/paths.js";

const tempDirs: string[] = [];
const originalStdout = process.env.DISCORD_STDOUT_LOG_PATH;
const originalStderr = process.env.DISCORD_STDERR_LOG_PATH;

beforeEach(() => {
  delete process.env.DISCORD_STDOUT_LOG_PATH;
  delete process.env.DISCORD_STDERR_LOG_PATH;
});

afterEach(async () => {
  process.env.DISCORD_STDOUT_LOG_PATH = originalStdout;
  process.env.DISCORD_STDERR_LOG_PATH = originalStderr;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("cli paths", () => {
  test("reads launchd stdout/stderr log paths from plist", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-paths-"));
    tempDirs.push(cwd);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>StandardOutPath</key><string>/tmp/custom.out.log</string>
<key>StandardErrorPath</key><string>/tmp/custom.err.log</string>
</dict></plist>`;
    await fs.writeFile(path.join(cwd, "com.codex.discord.bridge.plist"), plist, "utf8");

    const runtimePaths = resolveCliRuntimePaths(cwd);
    expect(runtimePaths.stdoutLogPath).toBe(path.resolve("/tmp/custom.out.log"));
    expect(runtimePaths.stderrLogPath).toBe(path.resolve("/tmp/custom.err.log"));
  });

  test("env overrides plist log paths", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-paths-"));
    tempDirs.push(cwd);
    await fs.writeFile(
      path.join(cwd, "com.codex.discord.bridge.plist"),
      "<plist><dict><key>StandardOutPath</key><string>/tmp/plist.out.log</string></dict></plist>",
      "utf8"
    );
    process.env.DISCORD_STDOUT_LOG_PATH = "/tmp/env.out.log";
    process.env.DISCORD_STDERR_LOG_PATH = "/tmp/env.err.log";

    const runtimePaths = resolveCliRuntimePaths(cwd);
    expect(runtimePaths.stdoutLogPath).toBe(path.resolve("/tmp/env.out.log"));
    expect(runtimePaths.stderrLogPath).toBe(path.resolve("/tmp/env.err.log"));
  });
});
