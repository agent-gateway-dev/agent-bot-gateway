import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { parsePathListEnv, resolveCliRuntimePaths } from "../paths.js";

export async function runDoctorCommand(_args: string[], context: CliContext): Promise<CliCommandResult> {
  const paths = resolveCliRuntimePaths(context.cwd);
  const checks = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  const hasDiscordToken = Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_BOT_TOKEN.trim());
  const hasFeishuAppId = Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_ID.trim());
  const hasFeishuAppSecret = Boolean(process.env.FEISHU_APP_SECRET && process.env.FEISHU_APP_SECRET.trim());
  const hasFeishuCredentials = hasFeishuAppId && hasFeishuAppSecret;
  checks.push({ name: "DISCORD_BOT_TOKEN", ok: hasDiscordToken });
  checks.push({ name: "FEISHU_APP_ID", ok: hasFeishuAppId });
  checks.push({ name: "FEISHU_APP_SECRET", ok: hasFeishuAppSecret });
  if (!hasDiscordToken && !hasFeishuCredentials) {
    failures.push("Missing chat platform credentials: set DISCORD_BOT_TOKEN or FEISHU_APP_ID + FEISHU_APP_SECRET");
  }

  const codexBin = process.env.CODEX_BIN ?? "codex";
  checks.push({ name: "CODEX_BIN", ok: true, value: codexBin });

  const stateDirOk = await ensureDirectory(path.dirname(paths.statePath));
  checks.push({ name: "state_dir_writable", ok: stateDirOk, value: path.dirname(paths.statePath) });
  if (!stateDirOk) {
    failures.push(`State directory not writable: ${path.dirname(paths.statePath)}`);
  }

  const attachmentRoots = parsePathListEnv(process.env.DISCORD_ATTACHMENT_ROOTS);
  const attachmentRootChecks = [];
  for (const root of attachmentRoots) {
    const exists = await canAccess(root);
    attachmentRootChecks.push({ root, exists });
    if (!exists) {
      warnings.push(`Attachment root missing or inaccessible: ${root}`);
    }
  }
  checks.push({ name: "attachment_roots", ok: true, value: attachmentRootChecks });

  const generalCwd = path.resolve(process.env.DISCORD_GENERAL_CWD ?? path.join("/tmp", "codex-discord-bridge", "general"));
  const generalCwdOk = await ensureDirectory(generalCwd);
  checks.push({ name: "general_cwd_writable", ok: generalCwdOk, value: generalCwd });
  if (!generalCwdOk) {
    warnings.push(`General channel cwd not writable: ${generalCwd}`);
  }

  const ok = failures.length === 0;
  return {
    ok,
    message: ok ? "doctor: ok" : "doctor: failed",
    details: {
      checks,
      failures,
      warnings,
      configPath: paths.configPath,
      statePath: paths.statePath,
      heartbeatPath: paths.heartbeatPath,
      restartRequestPath: paths.restartRequestPath,
      restartAckPath: paths.restartAckPath
    }
  };
}

async function canAccess(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(target: string): Promise<boolean> {
  try {
    await fs.mkdir(target, { recursive: true });
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
