import { ChannelType, MessageFlags } from "discord.js";
import { buildBridgeRuntimes } from "./buildRuntimes.js";
import { initializeRuntimeContext } from "./bootstrapContext.js";
import { createRuntimeOps } from "./runtimeOps.js";
import { isDiscordMissingPermissionsError, waitForDiscordReady } from "./runtimeUtils.js";
import { registerShutdownSignals } from "./signalHandlers.js";
import { createShutdownHandler } from "./shutdown.js";
import { startBridgeRuntime } from "./startup.js";
import { wireBridgeListeners } from "./wireListeners.js";
import { truncateStatusText } from "../turns/turnFormatting.js";

export async function startMainRuntime() {
  const context = await initializeRuntimeContext();
  const {
    fs,
    path,
    execFileAsync,
    runtimeEnv,
    discordToken,
    debugLog,
    config,
    state,
    getChannelSetups,
    setChannelSetups,
    discord,
    codex,
    safeReply,
    safeSendToChannel,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    refs,
    runtimeAdapters,
    turnRecoveryStore,
    createApprovalToken
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
    generalChannelCwd,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    heartbeatIntervalMs,
    exitOnRestartAck
  } = runtimeEnv;

  wireBridgeListeners({
    codex,
    discord,
    handleNotification: runtimeAdapters.handleNotification,
    handleServerRequest: runtimeAdapters.handleServerRequest,
    handleMessage: runtimeAdapters.handleMessage,
    handleInteraction: runtimeAdapters.handleInteraction
  });

  refs.runtimeOps = createRuntimeOps({
    fs,
    path,
    debugLog,
    activeTurns,
    pendingApprovals,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    processStartedAt,
    heartbeatIntervalMs,
    exitOnRestartAck,
    safeReply,
    safeSendToChannel,
    truncateStatusText,
    shutdown: (...args) => refs.shutdown?.(...args)
  });

  const {
    bootstrapChannelMappings,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  } = buildBridgeRuntimes({
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

  refs.shutdown = createShutdownHandler({
    codex,
    discord,
    stopHeartbeatLoop: () => refs.runtimeOps?.stopHeartbeatLoop()
  });
  await startBridgeRuntime({
    codex,
    fs,
    generalChannelCwd,
    discord,
    discordToken,
    waitForDiscordReady,
    maybeCompletePendingRestartNotice: runtimeAdapters.maybeCompletePendingRestartNotice,
    turnRecoveryStore,
    safeSendToChannel,
    bootstrapChannelMappings,
    getMappedChannelCount: () => Object.keys(getChannelSetups()).length,
    startHeartbeatLoop: runtimeAdapters.startHeartbeatLoop
  });

  registerShutdownSignals(refs.shutdown);
}
