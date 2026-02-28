import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runLogsCommand } from "../src/cli/commands/logs";

const ENV_KEYS = ["DISCORD_STDOUT_LOG_PATH", "DISCORD_STDERR_LOG_PATH"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("cli logs command", () => {
  test("clears logs with --clear --no-follow", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-logs-clear-"));
    const stdoutPath = path.join(tempDir, "stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");
    fs.writeFileSync(stdoutPath, "stdout line\n");
    fs.writeFileSync(stderrPath, "stderr line\n");
    process.env.DISCORD_STDOUT_LOG_PATH = stdoutPath;
    process.env.DISCORD_STDERR_LOG_PATH = stderrPath;

    const result = await runLogsCommand(["--clear", "--no-follow"], { cwd: tempDir, now: new Date() });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("logs cleared");
    expect(fs.readFileSync(stdoutPath, "utf8")).toBe("");
    expect(fs.readFileSync(stderrPath, "utf8")).toBe("");
  });

  test("prints only matching lines with --since --no-follow", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-logs-since-"));
    const stdoutPath = path.join(tempDir, "stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");
    const now = new Date("2026-02-28T10:30:00.000Z");

    fs.writeFileSync(
      stdoutPath,
      [
        "2026-02-28T10:10:00.000Z old line",
        "2026-02-28T10:28:00.000Z new line",
        '{"at":"2026-02-28T10:29:00.000Z","message":"json line"}'
      ].join("\n")
    );
    fs.writeFileSync(stderrPath, "2026-02-28T10:00:00.000Z old err\n");
    process.env.DISCORD_STDOUT_LOG_PATH = stdoutPath;
    process.env.DISCORD_STDERR_LOG_PATH = stderrPath;

    const writes = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let result: Awaited<ReturnType<typeof runLogsCommand>>;
    try {
      result = await runLogsCommand(["--since", "5m", "--no-follow"], { cwd: tempDir, now });
    } finally {
      process.stdout.write = originalWrite;
    }

    const combined = writes.join("");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("logs since output complete");
    expect(combined).toContain("new line");
    expect(combined).toContain("json line");
    expect(combined).not.toContain("old line");
    expect(combined).not.toContain("old err");
  });

  test("returns usage errors for invalid args", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-logs-invalid-"));

    const unknown = await runLogsCommand(["--wat"], { cwd: tempDir, now: new Date() });
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain("unknown argument");

    const invalidLines = await runLogsCommand(["--lines", "0"], { cwd: tempDir, now: new Date() });
    expect(invalidLines.ok).toBe(false);
    expect(invalidLines.message).toContain("invalid value for --lines");

    const missingSince = await runLogsCommand(["--since"], { cwd: tempDir, now: new Date() });
    expect(missingSince.ok).toBe(false);
    expect(missingSince.message).toContain("missing value for --since");

    const invalidSince = await runLogsCommand(["--since", "banana"], { cwd: tempDir, now: new Date() });
    expect(invalidSince.ok).toBe(false);
    expect(invalidSince.message).toContain("invalid value for --since");
  });

  test("supports absolute --since timestamps and stderr-only mode", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-logs-iso-"));
    const stdoutPath = path.join(tempDir, "stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");
    const now = new Date("2026-02-28T10:30:00.000Z");

    fs.writeFileSync(stdoutPath, "2026-02-28T10:29:00.000Z stdout line\n");
    fs.writeFileSync(
      stderrPath,
      ["2026-02-28T10:20:00.000Z old err", "2026-02-28T10:29:30.000Z new err"].join("\n")
    );
    process.env.DISCORD_STDOUT_LOG_PATH = stdoutPath;
    process.env.DISCORD_STDERR_LOG_PATH = stderrPath;

    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let result: Awaited<ReturnType<typeof runLogsCommand>>;
    try {
      result = await runLogsCommand(["--stderr", "--since", "2026-02-28T10:25:00.000Z", "--no-follow"], {
        cwd: tempDir,
        now
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const combined = writes.join("");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("logs since output complete");
    expect(combined).toContain("new err");
    expect(combined).not.toContain("old err");
    expect(combined).not.toContain("stdout line");
  });

  test("returns non-zero exit result when tail fails on missing selected file", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-logs-tail-fail-"));
    const missingStdoutPath = path.join(tempDir, "missing-stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");
    fs.writeFileSync(stderrPath, "stderr line\n");
    process.env.DISCORD_STDOUT_LOG_PATH = missingStdoutPath;
    process.env.DISCORD_STDERR_LOG_PATH = stderrPath;

    const result = await runLogsCommand(["--stdout", "--no-follow"], { cwd: tempDir, now: new Date() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("tail exited with code");
  });
});
