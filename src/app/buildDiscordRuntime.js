import { resolveRepoContext } from "../channels/context.js";
import { buildCommandTextFromInteraction, syncSlashCommands } from "../commands/slashCommands.js";
import { parseApprovalButtonCustomId } from "../codex/approvalPayloads.js";
import { createDiscordRuntime } from "./discordRuntime.js";

export function buildDiscordRuntime(deps) {
  const {
    MessageFlags,
    discord,
    config,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    runManagedRouteCommand,
    runtimeAdapters,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    approvalButtonPrefix,
    pendingApprovals,
    safeReply
  } = deps;

  return createDiscordRuntime({
    discord,
    config,
    resolveRepoContext,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    runManagedRouteCommand,
    shouldHandleAsSelfRestartRequest: runtimeAdapters.shouldHandleAsSelfRestartRequest,
    requestSelfRestartFromDiscord: runtimeAdapters.requestSelfRestartFromDiscord,
    collectImageAttachments: runtimeAdapters.collectImageAttachments,
    buildTurnInputFromMessage: runtimeAdapters.buildTurnInputFromMessage,
    enqueuePrompt: runtimeAdapters.enqueuePrompt,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    buildCommandTextFromInteraction,
    registerSlashCommands: async () => await syncSlashCommands({ discord }),
    parseApprovalButtonCustomId,
    approvalButtonPrefix,
    pendingApprovals,
    applyApprovalDecision: runtimeAdapters.applyApprovalDecision,
    safeReply,
    MessageFlags
  });
}
