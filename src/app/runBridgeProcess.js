import { waitForDiscordReady } from "./runtimeUtils.js";
import { createShutdownHandler } from "./shutdown.js";
import { registerShutdownSignals } from "./signalHandlers.js";
import { startBridgeRuntime } from "./startup.js";
import { wireBridgeListeners } from "./wireListeners.js";
import { createRuntimeOpsContext } from "./createRuntimeOpsContext.js";
import { attachBuiltRuntimes } from "./attachBuiltRuntimes.js";

export async function runBridgeProcess(context) {
  const {
    fs,
    path,
    runtimeEnv,
    discordToken,
    debugLog,
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
  const { generalChannelCwd } = runtimeEnv;

  wireBridgeListeners({
    codex,
    discord,
    handleNotification: runtimeAdapters.handleNotification,
    handleServerRequest: runtimeAdapters.handleServerRequest,
    handleMessage: runtimeAdapters.handleMessage,
    handleInteraction: runtimeAdapters.handleInteraction
  });

  refs.runtimeOps = createRuntimeOpsContext({
    fs,
    path,
    debugLog,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    safeReply,
    safeSendToChannel,
    refs,
    runtimeEnv
  });

  const { bootstrapChannelMappings } = attachBuiltRuntimes({
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
  });

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
