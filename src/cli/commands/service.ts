import { spawn } from "node:child_process";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveLaunchdServiceInfo } from "../paths.js";

interface LaunchctlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

export async function runStartCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl
): Promise<CliCommandResult> {
  if (args.length > 0) {
    return {
      ok: false,
      message: "start command does not accept arguments",
      details: {
        usage: "start"
      }
    };
  }

  const service = resolveLaunchdServiceInfo(context.cwd);
  const bootstrap = await runner(["bootstrap", service.domain, service.plistPath]);
  if (bootstrap.code !== 0 && !isAlreadyLoaded(bootstrap.stderr)) {
    return failure("failed to bootstrap launchd service", service, bootstrap);
  }

  const enable = await runner(["enable", service.serviceTarget]);
  if (enable.code !== 0) {
    return failure("failed to enable launchd service", service, enable);
  }

  const kickstart = await runner(["kickstart", "-k", service.serviceTarget]);
  if (kickstart.code !== 0) {
    return failure("failed to start launchd service", service, kickstart);
  }

  return {
    ok: true,
    message: "service started",
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.plistPath
    }
  };
}

export async function runStopCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl
): Promise<CliCommandResult> {
  if (args.length > 0) {
    return {
      ok: false,
      message: "stop command does not accept arguments",
      details: {
        usage: "stop"
      }
    };
  }

  const service = resolveLaunchdServiceInfo(context.cwd);
  const bootout = await runner(["bootout", service.serviceTarget]);
  if (bootout.code !== 0 && !isAlreadyStopped(bootout.stderr)) {
    return failure("failed to stop launchd service", service, bootout);
  }

  return {
    ok: true,
    message: "service stopped",
    details: {
      serviceTarget: service.serviceTarget
    }
  };
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
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function isAlreadyLoaded(stderr: string): boolean {
  return /already|in use|service is running|service already loaded/i.test(String(stderr ?? ""));
}

function isAlreadyStopped(stderr: string): boolean {
  return /could not find service|service not found|no such process|not loaded/i.test(String(stderr ?? ""));
}

function failure(message: string, service: ReturnType<typeof resolveLaunchdServiceInfo>, result: LaunchctlResult): CliCommandResult {
  return {
    ok: false,
    message,
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.plistPath,
      code: result.code,
      stderr: truncate(result.stderr),
      stdout: truncate(result.stdout)
    }
  };
}

function truncate(value: string, limit = 400): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}
