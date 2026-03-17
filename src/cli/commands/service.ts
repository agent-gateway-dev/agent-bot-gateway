import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { renderLaunchdPlist, resolveLaunchdServiceInfo } from "../paths.js";

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
  try {
    await installLaunchdPlist(service);
  } catch (error) {
    return {
      ok: false,
      message: "failed to prepare launchd service files",
      details: {
        serviceTarget: service.serviceTarget,
        plistPath: service.installedPlistPath,
        sourcePlistPath: service.sourcePlistPath,
        error: truncateError(error)
      }
    };
  }
  const bootstrap = await runner(["bootstrap", service.domain, service.installedPlistPath]);
  const alreadyLoaded = bootstrap.code !== 0 && (isAlreadyLoaded(bootstrap.stderr) || (await isLoadedService(service, runner)));
  if (bootstrap.code !== 0 && !alreadyLoaded) {
    return failure("failed to bootstrap launchd service", service, bootstrap);
  }

  const enable = await runner(["enable", service.serviceTarget]);
  if (enable.code !== 0) {
    return failure("failed to enable launchd service", service, enable);
  }

  const kickstart = await runner(["kickstart", "-k", service.serviceTarget]);
  const kickstartRecovered = kickstart.code !== 0 && (await isLoadedService(service, runner));
  if (kickstart.code !== 0 && !kickstartRecovered) {
    return failure("failed to start launchd service", service, kickstart);
  }

  return {
    ok: true,
    message: "service started",
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.installedPlistPath,
      sourcePlistPath: service.sourcePlistPath
    }
  };
}

async function isLoadedService(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  runner: LaunchctlRunner
): Promise<boolean> {
  const result = await runner(["print", service.serviceTarget]);
  return result.code === 0;
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
      plistPath: service.installedPlistPath,
      sourcePlistPath: service.sourcePlistPath,
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

function truncateError(error: unknown, limit = 400): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return truncate(message, limit);
}

async function installLaunchdPlist(service: ReturnType<typeof resolveLaunchdServiceInfo>): Promise<void> {
  await fs.readFile(service.sourceWrapperPath, "utf8");
  await fs.readFile(service.sourceSupervisorPath, "utf8");

  const plistContent = renderLaunchdPlist(service);
  await fs.mkdir(path.dirname(service.installedPlistPath), { recursive: true });
  await fs.writeFile(service.installedPlistPath, plistContent, "utf8");
  await fs.chmod(service.installedPlistPath, 0o600);
}
