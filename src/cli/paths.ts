import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const DEFAULT_LAUNCHD_LABEL = "com.agent.gateway";
const LEGACY_LAUNCHD_LABEL = "com.codex.discord.bridge";
const DEFAULT_SOURCE_PLIST_FILENAME = "com.agent.gateway.plist";
const LEGACY_SOURCE_PLIST_FILENAME = "com.codex.discord.bridge.plist";
const DEFAULT_STDOUT_LOG_PATH = "/tmp/agent-gateway.out.log";
const DEFAULT_STDERR_LOG_PATH = "/tmp/agent-gateway.err.log";

export interface CliRuntimePaths {
  configPath: string;
  statePath: string;
  heartbeatPath: string;
  restartRequestPath: string;
  restartAckPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface LaunchdServiceInfo {
  sourcePlistPath: string;
  installedPlistPath: string;
  label: string;
  domain: string;
  serviceTarget: string;
  runtimeRoot: string;
  sourceWrapperPath: string;
  supportRoot: string;
  managedWrapperPath: string;
  managedSupervisorPath: string;
  sourceSupervisorPath: string;
  nodeBinaryPath: string;
  entryScriptPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export function resolveCliRuntimePaths(cwd: string): CliRuntimePaths {
  const runtimeRoot = resolveRuntimeRoot(cwd);
  const plistLogPaths = readLaunchdLogPaths(runtimeRoot);
  const stdoutLogPath = resolveLogPath(
    process.env.DISCORD_STDOUT_LOG_PATH,
    plistLogPaths.stdoutLogPath,
    DEFAULT_STDOUT_LOG_PATH
  );
  const stderrLogPath = resolveLogPath(
    process.env.DISCORD_STDERR_LOG_PATH,
    plistLogPaths.stderrLogPath,
    DEFAULT_STDERR_LOG_PATH
  );

  return {
    configPath: path.resolve(runtimeRoot, process.env.CHANNEL_CONFIG_PATH ?? "config/channels.json"),
    statePath: path.resolve(runtimeRoot, process.env.STATE_PATH ?? "data/state.json"),
    heartbeatPath: path.resolve(runtimeRoot, process.env.DISCORD_HEARTBEAT_PATH ?? "data/bridge-heartbeat.json"),
    restartRequestPath: path.resolve(runtimeRoot, process.env.DISCORD_RESTART_REQUEST_PATH ?? "data/restart-request.json"),
    restartAckPath: path.resolve(runtimeRoot, process.env.DISCORD_RESTART_ACK_PATH ?? "data/restart-ack.json"),
    stdoutLogPath,
    stderrLogPath
  };
}

export function parsePathListEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

export function resolveLaunchdServiceInfo(cwd: string): LaunchdServiceInfo {
  const runtimeRoot = resolveRuntimeRoot(cwd);
  const sourcePlistPath = path.resolve(runtimeRoot, DEFAULT_SOURCE_PLIST_FILENAME);
  const sourceRaw = readLaunchdSourcePlistRaw(runtimeRoot);
  const labelFromPlist = sourceRaw ? extractPlistStringValue(sourceRaw, "Label") : null;
  const labelFromEnv = String(process.env.DISCORD_LAUNCHD_LABEL ?? "").trim();
  const label = labelFromEnv || labelFromPlist || DEFAULT_LAUNCHD_LABEL;
  const installedPlistPath = resolveInstalledLaunchdPlistPath(label);
  const uid = resolveUserId();
  const domain = `gui/${uid}`;
  const sourceWrapperPath = path.resolve(runtimeRoot, "scripts/launchd-wrapper.sh");
  const supportRoot = path.resolve(resolveHomeDirectory(), "Library/Application Support/AgentGateway", label);
  const managedWrapperPath = path.resolve(supportRoot, "launchd-wrapper.sh");
  const managedSupervisorPath = path.resolve(supportRoot, "restart-supervisor.sh");
  const sourceSupervisorPath = path.resolve(runtimeRoot, "scripts/restart-supervisor.sh");
  const nodeBinaryPath = resolveNodeBinaryPath();
  const entryScriptPath = path.resolve(runtimeRoot, "scripts/start-with-proxy.mjs");
  const plistLogPaths = readLaunchdLogPaths(runtimeRoot);
  const stdoutLogPath = resolveLogPath(
    process.env.DISCORD_STDOUT_LOG_PATH,
    plistLogPaths.stdoutLogPath,
    DEFAULT_STDOUT_LOG_PATH
  );
  const stderrLogPath = resolveLogPath(
    process.env.DISCORD_STDERR_LOG_PATH,
    plistLogPaths.stderrLogPath,
    DEFAULT_STDERR_LOG_PATH
  );
  return {
    sourcePlistPath,
    installedPlistPath,
    label,
    domain,
    serviceTarget: `${domain}/${label}`,
    runtimeRoot,
    sourceWrapperPath,
    supportRoot,
    managedWrapperPath,
    managedSupervisorPath,
    sourceSupervisorPath,
    nodeBinaryPath,
    entryScriptPath,
    stdoutLogPath,
    stderrLogPath
  };
}

function resolveLogPath(envValue: string | undefined, plistValue: string | null, fallback: string): string {
  const fromEnv = String(envValue ?? "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const fromPlist = String(plistValue ?? "").trim();
  if (fromPlist) {
    return path.resolve(fromPlist);
  }
  return path.resolve(fallback);
}

function resolveRuntimeRoot(cwd: string): string {
  const configured = String(process.env.DISCORD_BRIDGE_ROOT ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(cwd);
}

function readLaunchdLogPaths(cwd: string): { stdoutLogPath: string | null; stderrLogPath: string | null } {
  const raw = readLaunchdPlistRaw(cwd);
  if (!raw) {
    return { stdoutLogPath: null, stderrLogPath: null };
  }
  const stdoutLogPath = extractPlistStringValue(raw, "StandardOutPath");
  const stderrLogPath = extractPlistStringValue(raw, "StandardErrorPath");
  return { stdoutLogPath, stderrLogPath };
}

function readLaunchdSourcePlistRaw(cwd: string): string | null {
  const sourceCandidatePaths = [
    path.resolve(cwd, DEFAULT_SOURCE_PLIST_FILENAME),
    path.resolve(cwd, LEGACY_SOURCE_PLIST_FILENAME)
  ];
  for (const plistPath of sourceCandidatePaths) {
    const raw = safeReadFile(plistPath);
    if (raw) {
      return raw;
    }
  }
  return null;
}

function readLaunchdPlistRaw(cwd: string): string | null {
  const sourceCandidatePaths = [
    path.resolve(cwd, DEFAULT_SOURCE_PLIST_FILENAME),
    path.resolve(cwd, LEGACY_SOURCE_PLIST_FILENAME)
  ];
  const sourceRaw = readLaunchdSourcePlistRaw(cwd);
  const sourceLabel = sourceRaw ? extractPlistStringValue(sourceRaw, "Label") : null;
  const labelFromEnv = String(process.env.DISCORD_LAUNCHD_LABEL ?? "").trim();
  const preferredLabels = [
    labelFromEnv,
    sourceLabel,
    DEFAULT_LAUNCHD_LABEL,
    LEGACY_LAUNCHD_LABEL
  ].filter((value, index, entries): value is string => Boolean(value) && entries.indexOf(value) === index);
  const preferredPaths = [
    ...preferredLabels.map((label) => resolveInstalledLaunchdPlistPath(label)),
    ...sourceCandidatePaths
  ];
  for (const plistPath of preferredPaths) {
    const raw = safeReadFile(plistPath);
    if (raw) {
      return raw;
    }
  }
  return null;
}

export function renderLaunchdPlist(service: LaunchdServiceInfo): string {
  const launchPath = `${path.dirname(service.nodeBinaryPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const launchCommand = `cd ${shellQuote(service.runtimeRoot)} && exec ${shellQuote(service.nodeBinaryPath)} ${shellQuote("./scripts/start-with-proxy.mjs")}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${escapeXml(launchPath)}</string>`,
    "  </dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(service.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/bash</string>",
    "    <string>-lc</string>",
    `    <string>${escapeXml(launchCommand)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>15</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(service.stdoutLogPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(service.stderrLogPath)}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

export function renderManagedLaunchdWrapper(service: LaunchdServiceInfo): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `export PATH=${shellQuote(`${path.dirname(service.nodeBinaryPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}`,
    `cd ${shellQuote(service.runtimeRoot)}`,
    `exec ${shellQuote(service.managedSupervisorPath)} -- ${shellQuote(service.nodeBinaryPath)} ${shellQuote(service.entryScriptPath)}`,
    ""
  ].join("\n");
}

function escapeXml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function resolveInstalledLaunchdPlistPath(label: string): string {
  return path.resolve(resolveHomeDirectory(), "Library/LaunchAgents", `${label}.plist`);
}

function safeReadFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function resolveHomeDirectory(): string {
  const envHome = String(process.env.HOME ?? "").trim();
  if (envHome) {
    return path.resolve(envHome);
  }
  return os.homedir();
}

function resolveNodeBinaryPath(): string {
  const envValue = String(process.env.NODE_BIN ?? process.env.DISCORD_NODE_BIN ?? "").trim();
  if (envValue) {
    return path.resolve(envValue);
  }
  const resolved = spawnSync("which", ["node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const nodePath = String(resolved.stdout ?? "").trim();
  if (resolved.status === 0 && nodePath) {
    return path.resolve(nodePath);
  }
  return "/usr/bin/node";
}

function resolveUserId(): number {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }
  const rawUid = String(process.env.UID ?? "").trim();
  const parsed = Number.parseInt(rawUid, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function extractPlistStringValue(raw: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<string>([^<]+)<\\/string>`, "i");
  const match = raw.match(pattern);
  const value = String(match?.[1] ?? "").trim();
  return value || null;
}
