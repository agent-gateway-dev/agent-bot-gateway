import { ChannelType, MessageFlags } from "discord.js";
import { buildBridgeRuntimes } from "./buildRuntimes.js";
import { isDiscordMissingPermissionsError } from "./runtimeUtils.js";

export function attachBuiltRuntimes(params) {
  const {
    context,
    runtimeEnv,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    refs
  } = params;
  const {
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    config,
    state,
    activeTurns,
    pendingApprovals
  } = context;
  const {
    approvalButtonPrefix,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    renderVerbosity,
    generalChannelId,
    generalChannelName,
    generalChannelCwd
  } = runtimeEnv;

  const { bootstrapChannelMappings, notificationRuntime, serverRequestRuntime, discordRuntime } = buildBridgeRuntimes({
    ChannelType,
    MessageFlags,
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    config,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    renderVerbosity,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    sendChunkedToChannel: runtimeAdapters.sendChunkedToChannel
  });

  refs.notificationRuntime = notificationRuntime;
  refs.serverRequestRuntime = serverRequestRuntime;
  refs.discordRuntime = discordRuntime;

  return { bootstrapChannelMappings };
}
