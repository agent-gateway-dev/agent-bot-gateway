import fs from "node:fs/promises";
import path from "node:path";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveCliRuntimePaths } from "../paths.js";

export async function runReloadCommand(args: string[], context: CliContext): Promise<CliCommandResult> {
  const reason = args.join(" ").trim() || "manual reload requested from CLI";
  const paths = resolveCliRuntimePaths(context.cwd);
  const payload = {
    requestedAt: context.now.toISOString(),
    requestedBy: "cli",
    pid: process.pid,
    cwd: context.cwd,
    reason
  };

  await fs.mkdir(path.dirname(paths.restartRequestPath), { recursive: true });
  await fs.writeFile(paths.restartRequestPath, JSON.stringify(payload, null, 2), "utf8");

  return {
    ok: true,
    message: "reload request written",
    details: {
      restartRequestPath: paths.restartRequestPath,
      reason
    }
  };
}
