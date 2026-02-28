import { createRuntimeOps } from "./runtimeOps.js";
import { truncateStatusText } from "../turns/turnFormatting.js";

export function createRuntimeOpsContext(params) {
  const {
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
  } = params;
  const { heartbeatPath, restartRequestPath, restartAckPath, restartNoticePath, heartbeatIntervalMs, exitOnRestartAck } =
    runtimeEnv;

  return createRuntimeOps({
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
}
