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

interface ProcessEntry {
  pid: number;
  ppid: number | null;
  command: string;
}

type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;
type ProcessManager = {
  list: () => Promise<ProcessEntry[]>;
  kill: (pid: number, signal?: NodeJS.Signals) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export async function runStartCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl,
  processManager: ProcessManager = createDefaultProcessManager()
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
  const cleanup = await cleanupConflictingRuntimeProcesses(service, processManager);
  const prepareResult = await prepareLaunchdService(service, runner);
  if (prepareResult) {
    return prepareResult;
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
      sourcePlistPath: service.sourcePlistPath,
      reclaimedPids: cleanup
    }
  };
}

export async function runRestartCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl,
  processManager: ProcessManager = createDefaultProcessManager()
): Promise<CliCommandResult> {
  if (args.length > 0) {
    return {
      ok: false,
      message: "restart command does not accept arguments",
      details: {
        usage: "restart"
      }
    };
  }

  const service = resolveLaunchdServiceInfo(context.cwd);
  const bootout = await runner(["bootout", service.serviceTarget]);
  if (bootout.code !== 0 && !isAlreadyStopped(bootout.stderr)) {
    return failure("failed to stop launchd service before restart", service, bootout);
  }

  const cleanup = await cleanupConflictingRuntimeProcesses(service, processManager);
  const prepareResult = await prepareLaunchdService(service, runner);
  if (prepareResult) {
    return prepareResult;
  }

  const kickstart = await runner(["kickstart", "-k", service.serviceTarget]);
  const kickstartRecovered = kickstart.code !== 0 && (await isLoadedService(service, runner));
  if (kickstart.code !== 0 && !kickstartRecovered) {
    return failure("failed to restart launchd service", service, kickstart);
  }

  return {
    ok: true,
    message: "service restarted",
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.installedPlistPath,
      sourcePlistPath: service.sourcePlistPath,
      reclaimedPids: cleanup
    }
  };
}

async function prepareLaunchdService(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  runner: LaunchctlRunner
): Promise<CliCommandResult | null> {
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

  const enable = await runner(["enable", service.serviceTarget]);
  if (enable.code !== 0) {
    return failure("failed to enable launchd service", service, enable);
  }

  const bootstrap = await runner(["bootstrap", service.domain, service.installedPlistPath]);
  const alreadyLoaded = bootstrap.code !== 0 && (isAlreadyLoaded(bootstrap.stderr) || (await isLoadedService(service, runner)));
  if (bootstrap.code !== 0 && !alreadyLoaded) {
    return failure("failed to bootstrap launchd service", service, bootstrap);
  }

  return null;
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
  runner: LaunchctlRunner = runLaunchctl,
  processManager: ProcessManager = createDefaultProcessManager()
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
  const cleanup = await cleanupConflictingRuntimeProcesses(service, processManager);

  return {
    ok: true,
    message: "service stopped",
    details: {
      serviceTarget: service.serviceTarget,
      reclaimedPids: cleanup
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

function createDefaultProcessManager(): ProcessManager {
  return {
    list: async () => await listProcesses(),
    kill: async (pid, signal = "SIGTERM") => {
      process.kill(pid, signal);
    },
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
}

async function listProcesses(): Promise<ProcessEntry[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,ppid=,command="], {
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
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ps exited with code ${String(code)}`));
        return;
      }
      resolve(parseProcessList(stdout));
    });
  });
}

function parseProcessList(stdout: string): ProcessEntry[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      if (!Number.isFinite(pid)) {
        return null;
      }
      return {
        pid,
        ppid: Number.isFinite(ppid) ? ppid : null,
        command: match[3]
      };
    })
    .filter((entry) => entry !== null);
}

async function cleanupConflictingRuntimeProcesses(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  processManager: ProcessManager
): Promise<number[]> {
  const roots = findConflictingRuntimeProcessRoots(service, await processManager.list());
  if (roots.length === 0) {
    return [];
  }

  for (const pid of roots) {
    await processManager.kill(pid, "SIGTERM").catch(() => {});
  }
  await processManager.sleep(500);

  const stillRunningAfterTerm = new Set(findConflictingRuntimeProcessRoots(service, await processManager.list()));
  for (const pid of roots) {
    if (stillRunningAfterTerm.has(pid)) {
      await processManager.kill(pid, "SIGKILL").catch(() => {});
    }
  }
  await processManager.sleep(250);

  return roots;
}

function findConflictingRuntimeProcessRoots(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  entries: ProcessEntry[]
): number[] {
  const processMap = new Map(entries.map((entry) => [entry.pid, entry]));
  const matching = entries.filter((entry) => isManagedRuntimeProcess(entry, service));
  const roots = new Set<number>();

  for (const entry of matching) {
    let current = entry;
    while (current.ppid !== null) {
      const parent = processMap.get(current.ppid);
      if (!parent || !isManagedRuntimeProcess(parent, service)) {
        break;
      }
      current = parent;
    }
    roots.add(current.pid);
  }

  return [...roots].sort((left, right) => left - right);
}

function isManagedRuntimeProcess(entry: ProcessEntry, service: ReturnType<typeof resolveLaunchdServiceInfo>): boolean {
  const command = String(entry?.command ?? "");
  if (!command) {
    return false;
  }
  if (command.includes(service.entryScriptPath)) {
    return true;
  }
  if (command.includes(service.runtimeRoot) && /restart-supervisor/i.test(command)) {
    return true;
  }
  return false;
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
