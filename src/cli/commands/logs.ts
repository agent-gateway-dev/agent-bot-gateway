import { spawn } from "node:child_process";
import fs from "node:fs";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveCliRuntimePaths } from "../paths.js";

export async function runLogsCommand(args: string[], context: CliContext): Promise<CliCommandResult> {
  const options = parseLogsOptions(args);
  if (!options.ok) {
    return {
      ok: false,
      message: options.error,
      details: {
        usage: "logs [--lines <n>] [--stdout] [--stderr] [--no-follow]"
      }
    };
  }

  const paths = resolveCliRuntimePaths(context.cwd);
  const targetPaths = [];
  if (options.includeStdout) {
    targetPaths.push(paths.stdoutLogPath);
  }
  if (options.includeStderr) {
    targetPaths.push(paths.stderrLogPath);
  }
  const uniqueTargetPaths = [...new Set(targetPaths)];

  const existing = uniqueTargetPaths.filter((entry) => fs.existsSync(entry));
  if (existing.length === 0) {
    console.error(
      `[dc-bridge logs] no log file exists yet. waiting on: ${uniqueTargetPaths.map((entry) => `'${entry}'`).join(", ")}`
    );
  } else {
    console.error(`[dc-bridge logs] tailing: ${existing.map((entry) => `'${entry}'`).join(", ")}`);
  }

  const tailArgs = ["-n", String(options.lines)];
  if (options.follow) {
    tailArgs.push("-F");
  }
  tailArgs.push(...uniqueTargetPaths);

  const exitCode = await runTail(tailArgs);
  if (exitCode === 0 || exitCode === null) {
    return {
      ok: true,
      message: "logs stream ended",
      details: {
        follow: options.follow,
        lines: options.lines,
        paths: uniqueTargetPaths
      }
    };
  }
  return {
    ok: false,
    message: `tail exited with code ${exitCode}`,
    details: {
      follow: options.follow,
      lines: options.lines,
      paths: uniqueTargetPaths
    }
  };
}

async function runTail(args: string[]): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn("tail", args, { stdio: "inherit" });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => resolve(code));
  });
}

function parseLogsOptions(args: string[]):
  | { ok: true; lines: number; follow: boolean; includeStdout: boolean; includeStderr: boolean }
  | { ok: false; error: string } {
  let lines = 200;
  let follow = true;
  let includeStdout = true;
  let includeStderr = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? "").trim();
    if (!arg) {
      continue;
    }
    if (arg === "--no-follow") {
      follow = false;
      continue;
    }
    if (arg === "--stdout") {
      includeStdout = true;
      includeStderr = false;
      continue;
    }
    if (arg === "--stderr") {
      includeStdout = false;
      includeStderr = true;
      continue;
    }
    if (arg === "--lines") {
      const raw = String(args[index + 1] ?? "").trim();
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: "invalid value for --lines (must be a positive integer)" };
      }
      lines = parsed;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }

  return {
    ok: true,
    lines,
    follow,
    includeStdout,
    includeStderr
  };
}
