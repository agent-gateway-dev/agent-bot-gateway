import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStatusCommand } from "../src/cli/commands/status.js";

describe("cli status command", () => {
  test("reports service pid from launchctl when available", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-status-"));
    try {
      await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "1.2.3" }, null, 2), "utf8");
      await fs.mkdir(path.join(cwd, "data"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "data", "bridge-heartbeat.json"),
        JSON.stringify({ pid: 4444, updatedAt: new Date().toISOString() }, null, 2),
        "utf8"
      );

      const result = await runStatusCommand([], { cwd, now: new Date() }, async () => {
        return {
          code: 0,
          stdout: "service = {\n  pid = 98765\n}",
          stderr: ""
        };
      });

      expect(result.ok).toBe(true);
      expect(result.details?.pid).toBe(98765);
      expect(result.details?.cliPid).toBe(process.pid);
      expect((result.details?.service as { pid?: number }).pid).toBe(98765);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("falls back to heartbeat pid when launchctl service is not loaded", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-status-"));
    try {
      await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "1.2.3" }, null, 2), "utf8");
      await fs.mkdir(path.join(cwd, "data"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "data", "bridge-heartbeat.json"),
        JSON.stringify({ pid: 24680, updatedAt: new Date().toISOString() }, null, 2),
        "utf8"
      );

      const result = await runStatusCommand([], { cwd, now: new Date() }, async () => {
        return {
          code: 3,
          stdout: "",
          stderr: "Could not find service"
        };
      });

      expect(result.ok).toBe(true);
      expect(result.details?.pid).toBe(24680);
      expect((result.details?.service as { loaded?: boolean }).loaded).toBe(false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
