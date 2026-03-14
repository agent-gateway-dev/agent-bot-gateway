import process from "node:process";

export function createRuntimeOps(deps) {
  const {
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
    fetchChannelByRouteId,
    truncateStatusText,
    shutdown
  } = deps;

  let heartbeatTimer = null;
  let restartAckHandled = false;
  let restartRequestHandled = false;
  const selfRestartOnRequestRaw = String(process.env.DISCORD_SELF_RESTART_ON_REQUEST ?? "").trim();
  const selfRestartOnRequest = selfRestartOnRequestRaw
    ? selfRestartOnRequestRaw !== "0"
    : !exitOnRestartAck;

  function startHeartbeatLoop() {
    void writeHeartbeatFile();
    void maybeHandleRestartAckSignal();
    void maybeHandleRestartRequestSignal();
    heartbeatTimer = setInterval(() => {
      void writeHeartbeatFile();
      void maybeHandleRestartAckSignal();
      void maybeHandleRestartRequestSignal();
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer?.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  function stopHeartbeatLoop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function writeHeartbeatFile() {
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        startedAt: processStartedAt,
        pid: process.pid,
        activeTurns: activeTurns.size,
        pendingApprovals: pendingApprovals.size,
        restartRequestPath,
        restartAckPath
      };
      await fs.mkdir(path.dirname(heartbeatPath), { recursive: true });
      const tempPath = `${heartbeatPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
      await fs.rename(tempPath, heartbeatPath);
    } catch (error) {
      debugLog("ops", "heartbeat write failed", { message: String(error?.message ?? error) });
    }
  }

  async function maybeHandleRestartAckSignal() {
    if (!exitOnRestartAck || restartAckHandled) {
      return;
    }
    try {
      const raw = await fs.readFile(restartAckPath, "utf8");
      const parsed = JSON.parse(raw);
      const acknowledgedAt = typeof parsed?.acknowledgedAt === "string" ? parsed.acknowledgedAt : "";
      if (!acknowledgedAt) {
        return;
      }
      if (new Date(acknowledgedAt).getTime() <= new Date(processStartedAt).getTime()) {
        return;
      }
      restartAckHandled = true;
      console.log(`restart ack detected at ${restartAckPath}; exiting for host-managed restart`);
      await shutdown(0);
    } catch {}
  }

  async function maybeHandleRestartRequestSignal() {
    if (!selfRestartOnRequest || restartRequestHandled) {
      return;
    }

    let parsed;
    try {
      const raw = await fs.readFile(restartRequestPath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const requestedAt = typeof parsed?.requestedAt === "string" ? parsed.requestedAt : "";
    if (!requestedAt) {
      return;
    }
    if (new Date(requestedAt).getTime() <= new Date(processStartedAt).getTime()) {
      return;
    }

    restartRequestHandled = true;
    console.log(`restart request detected at ${restartRequestPath}; exiting for launchd/self-managed restart`);

    await fs.mkdir(path.dirname(restartAckPath), { recursive: true }).catch(() => {});
    await fs
      .writeFile(
        restartAckPath,
        JSON.stringify(
          {
            acknowledgedAt: new Date().toISOString(),
            handledBy: "bridge-self",
            requestSource: typeof parsed?.requestedBy === "string" ? parsed.requestedBy : null,
            requestPid: Number.isFinite(Number(parsed?.pid)) ? Number(parsed.pid) : null
          },
          null,
          2
        ),
        "utf8"
      )
      .catch(() => {});
    await fs.unlink(restartRequestPath).catch(() => {});
    await shutdown(0);
  }

  async function requestSelfRestartFromDiscord(message, reason) {
    const status = await safeReply(message, "🔄 Restart requested. I will confirm here when I am back.");
    if (!status) {
      return;
    }
    const normalizedReason = truncateStatusText(typeof reason === "string" ? reason : "", 200) || "discord restart request";
    const requestPayload = {
      requestedAt: new Date().toISOString(),
      requestedBy: "discord",
      pid: process.pid,
      channelId: status.channelId,
      statusMessageId: status.id,
      reason: normalizedReason
    };
    await fs.mkdir(path.dirname(restartNoticePath), { recursive: true });
    await fs.writeFile(restartNoticePath, JSON.stringify(requestPayload, null, 2), "utf8");
    await fs.mkdir(path.dirname(restartRequestPath), { recursive: true });
    await fs.writeFile(restartRequestPath, JSON.stringify(requestPayload, null, 2), "utf8");
  }

  async function maybeCompletePendingRestartNotice() {
    let pending;
    try {
      const raw = await fs.readFile(restartNoticePath, "utf8");
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    const channelId = typeof pending?.channelId === "string" ? pending.channelId : "";
    const statusMessageId = typeof pending?.statusMessageId === "string" ? pending.statusMessageId : "";
    if (!channelId || !statusMessageId) {
      await fs.unlink(restartNoticePath).catch(() => {});
      return;
    }
    const channel = await fetchChannelByRouteId(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await fs.unlink(restartNoticePath).catch(() => {});
      return;
    }
    const notice = `✅ Restarted at ${new Date().toISOString()}`;
    try {
      const statusMessage = await channel.messages.fetch(statusMessageId);
      if (statusMessage) {
        await statusMessage.edit(notice);
        await fs.unlink(restartNoticePath).catch(() => {});
        return;
      }
    } catch {}
    await safeSendToChannel(channel, notice);
    await fs.unlink(restartNoticePath).catch(() => {});
  }

  function shouldHandleAsSelfRestartRequest(content) {
    const text = String(content ?? "").trim().toLowerCase();
    if (!text || text.startsWith("!")) {
      return false;
    }
    if (!/\brestart\b/.test(text)) {
      return false;
    }
    return (
      /\b(restart (yourself|the bot|bot)|please restart|restart with the cli|cli commands|dc-bridge restart)\b/.test(
        text
      ) && text.length <= 220
    );
  }

  return {
    startHeartbeatLoop,
    stopHeartbeatLoop,
    writeHeartbeatFile,
    maybeHandleRestartAckSignal,
    maybeHandleRestartRequestSignal,
    requestSelfRestartFromDiscord,
    maybeCompletePendingRestartNotice,
    shouldHandleAsSelfRestartRequest
  };
}
