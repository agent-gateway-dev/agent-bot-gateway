import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveCliRuntimePaths, resolveLaunchdServiceInfo } from "../paths.js";

interface LaunchctlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

export async function runStatusCommand(
  _args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl
): Promise<CliCommandResult> {
  const paths = resolveCliRuntimePaths(context.cwd);
  const service = resolveLaunchdServiceInfo(context.cwd);
  const packagePath = path.resolve(context.cwd, "package.json");

  const [version, stateSummary, heartbeatSummary, serviceSummary] = await Promise.all([
    readPackageVersion(packagePath),
    readStateSummary(paths.statePath),
    readHeartbeatSummary(paths.heartbeatPath),
    readServiceSummary(service.serviceTarget, runner)
  ]);

  const effectivePid = serviceSummary.pid ?? heartbeatSummary.pid ?? null;
  const pidSource = serviceSummary.pid !== null ? "launchctl" : heartbeatSummary.pid !== null ? "heartbeat" : "none";

  return {
    ok: true,
    message: "status: ok",
    details: {
      version,
      pid: effectivePid,
      pidSource,
      cliPid: process.pid,
      configPath: paths.configPath,
      statePath: paths.statePath,
      restartRequestPath: paths.restartRequestPath,
      restartAckPath: paths.restartAckPath,
      heartbeatPath: paths.heartbeatPath,
      stdoutLogPath: paths.stdoutLogPath,
      stderrLogPath: paths.stderrLogPath,
      bindings: stateSummary.bindings,
      heartbeat: heartbeatSummary,
      service: serviceSummary
    }
  };
}

async function readPackageVersion(packagePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version) {
      return parsed.version;
    }
  } catch {}
  return "unknown";
}

async function readStateSummary(statePath: string): Promise<{ bindings: number }> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { threadBindings?: Record<string, unknown> };
    const bindings = parsed && typeof parsed.threadBindings === "object" && parsed.threadBindings
      ? Object.keys(parsed.threadBindings).length
      : 0;
    return { bindings };
  } catch {
    return { bindings: 0 };
  }
}

async function readHeartbeatSummary(
  heartbeatPath: string
): Promise<{ found: boolean; pid?: number | null; [key: string]: unknown }> {
  try {
    const raw = await fs.readFile(heartbeatPath, "utf8");
    const parsed = JSON.parse(raw) as {
      updatedAt?: string;
      startedAt?: string;
      pid?: number;
      activeTurns?: number;
      pendingApprovals?: number;
    };
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    const ageMs = updatedAt ? Math.max(0, Date.now() - new Date(updatedAt).getTime()) : null;
    return {
      found: true,
      updatedAt,
      ageSeconds: Number.isFinite(ageMs) && ageMs !== null ? Math.floor(ageMs / 1000) : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      pid: Number.isFinite(parsed.pid) ? parsed.pid : null,
      activeTurns: Number.isFinite(parsed.activeTurns) ? parsed.activeTurns : null,
      pendingApprovals: Number.isFinite(parsed.pendingApprovals) ? parsed.pendingApprovals : null
    };
  } catch {
    return {
      found: false
    };
  }
}

async function readServiceSummary(
  serviceTarget: string,
  runner: LaunchctlRunner
): Promise<{ target: string; loaded: boolean; pid: number | null; source: "launchctl" | "none" }> {
  const result = await runner(["print", serviceTarget]);
  if (result.code !== 0) {
    return {
      target: serviceTarget,
      loaded: false,
      pid: null,
      source: "none"
    };
  }

  const pid = extractLaunchdPid(result.stdout, result.stderr);
  return {
    target: serviceTarget,
    loaded: true,
    pid,
    source: pid === null ? "none" : "launchctl"
  };
}

function extractLaunchdPid(stdout: string, stderr: string): number | null {
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/\bpid\s*=\s*(\d+)\b/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("launchctl", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}
