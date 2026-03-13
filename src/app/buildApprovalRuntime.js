import { createServerRequestRuntime } from "../approvals/serverRequestRuntime.js";
import { isGeneralChannel } from "../channels/context.js";
import { buildApprovalActionRows, buildResponseForServerRequest, describeToolRequestUserInput } from "../codex/approvalPayloads.js";
import { extractThreadId } from "../codex/eventUtils.js";
import { truncateForDiscordMessage } from "../render/messageRenderer.js";
import { truncateStatusText } from "../turns/turnFormatting.js";

export function buildApprovalRuntime(deps) {
  const { codex, state, activeTurns, pendingApprovals, approvalButtonPrefix, safeSendToChannel, createApprovalToken, fetchChannelByRouteId } =
    deps;

  return createServerRequestRuntime({
    codex,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    isGeneralChannel,
    fetchChannelByRouteId,
    extractThreadId,
    describeToolRequestUserInput,
    buildApprovalActionRows,
    buildResponseForServerRequest,
    truncateStatusText,
    truncateForDiscordMessage,
    safeSendToChannel,
    createApprovalToken
  });
}
