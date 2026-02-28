import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveCliRuntimePaths } from "../paths.js";

export async function runConfigValidateCommand(_args: string[], context: CliContext): Promise<CliCommandResult> {
  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const paths = resolveCliRuntimePaths(context.cwd);
    const config = await loadConfig(paths.configPath, {
      defaultModel: "gpt-5.3-codex",
      defaultEffort: "medium"
    });
    const channels =
      config && typeof config.channels === "object" && config.channels ? Object.keys(config.channels).length : 0;

    return {
      ok: true,
      message: "config validate: ok",
      details: {
        configPath: paths.configPath,
        channels,
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        approvalPolicy: config.approvalPolicy,
        sandboxMode: config.sandboxMode,
        allowedUserIds: Array.isArray(config.allowedUserIds) ? config.allowedUserIds.length : 0
      }
    };
  } catch (error) {
    return {
      ok: false,
      message: "config validate: failed",
      details: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}
