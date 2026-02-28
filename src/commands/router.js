export function createCommandRouter(deps) {
  const {
    ChannelType,
    isGeneralChannel,
    fs,
    path,
    execFileAsync,
    repoRootPath,
    managedChannelTopicPrefix,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    config,
    state,
    codex,
    pendingApprovals,
    makeChannelName,
    collectImageAttachments,
    buildTurnInputFromMessage,
    enqueuePrompt,
    getQueue,
    findActiveTurnByRepoChannel,
    requestSelfRestartFromDiscord,
    findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision,
    safeReply,
    getChannelSetups,
    setChannelSetups
  } = deps;

  async function handleCommand(message, content, context) {
    const [commandRaw, ...restParts] = content.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const rest = restParts.join(" ").trim();

    if (command === "!help") {
      await safeReply(
        message,
        [
          "Commands:",
          "`!initrepo [force]` create/bind repo for this channel using channel name",
          "`!ask <prompt>` send prompt in this repo channel",
          "`!status` show queue/thread status for this channel",
          "`!new` reset Codex thread binding for this channel",
          "`!restart [reason]` request host-managed restart and confirm when back",
          "`!interrupt` interrupt current turn in this channel",
          "`!where` show bot runtime paths and binding details",
          "`!approve [id]` approve the latest (or specified) pending request",
          "`!decline [id]` decline the latest (or specified) pending request",
          "`!cancel [id]` cancel the latest (or specified) pending request",
          "`!resync` non-destructive sync with Codex projects",
          "`!rebuild` destructive rebuild of managed channels",
          "Tip: use the Approve/Decline/Cancel buttons on approval messages",
          "Model: one repo text channel = one persistent Codex thread",
          "Also supported in #general: plain chat and !commands (read-only, no file writes)"
        ].join("\n")
      );
      return;
    }

    if (command === "!ask") {
      const imageAttachments = collectImageAttachments(message);
      if (!rest && imageAttachments.length === 0) {
        await safeReply(message, "Usage: `!ask <prompt>`");
        return;
      }
      const inputItems = await buildTurnInputFromMessage(message, rest, imageAttachments, context.setup);
      if (inputItems.length === 0) {
        await safeReply(message, "No usable text or image attachment found for `!ask`.");
        return;
      }
      enqueuePrompt(context.repoChannelId, {
        inputItems,
        message,
        setup: context.setup,
        repoChannelId: context.repoChannelId
      });
      return;
    }

    if (command === "!status") {
      const queue = getQueue(context.repoChannelId);
      const binding = state.getBinding(context.repoChannelId);
      const codexThreadId = binding?.codexThreadId ?? null;
      const activeTurn = findActiveTurnByRepoChannel(context.repoChannelId);
      const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
      const modeLabel = context.setup.mode === "general" ? "general" : "repo channel";
      const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
      await safeReply(
        message,
        [
          `cwd: \`${context.setup.cwd}\``,
          `mode: ${modeLabel}`,
          `approval policy: \`${config.approvalPolicy}\``,
          `sandbox mode: \`${sandboxMode}\``,
          `file writes: ${fileWrites}`,
          `codex thread: ${codexThreadId ? `\`${codexThreadId}\`` : "none"}`,
          `queue depth: ${queue.jobs.length}`,
          `active turn: ${activeTurn ? "yes" : "no"}`
        ].join("\n")
      );
      return;
    }

    if (command === "!new") {
      state.clearBinding(context.repoChannelId);
      await state.save();
      await safeReply(message, "Cleared Codex thread binding for this channel. Next prompt starts a new Codex thread.");
      return;
    }

    if (command === "!restart") {
      await requestSelfRestartFromDiscord(message, rest || "manual restart requested from Discord command");
      return;
    }

    if (command === "!interrupt") {
      const threadId = state.getBinding(context.repoChannelId)?.codexThreadId;
      if (!threadId) {
        await safeReply(message, "No Codex thread is bound to this channel yet.");
        return;
      }
      try {
        await codex.request("turn/interrupt", { threadId });
        await safeReply(message, "Interrupt requested.");
      } catch (error) {
        await safeReply(message, `Interrupt failed: ${error.message}`);
      }
      return;
    }

    if (command === "!where") {
      const threadId = state.getBinding(context.repoChannelId)?.codexThreadId;
      const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
      const modeLabel = context.setup.mode === "general" ? "general" : "repo channel";
      const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
      const lines = [
        `codex bin: \`${codexBin}\``,
        `CODEX_HOME: \`${codexHomeEnv ?? "(unset; codex default path)"}\``,
        `state file: \`${statePath}\``,
        `channel config: \`${configPath}\``,
        `channel mode: \`${modeLabel}\``,
        `channel cwd: \`${context.setup.cwd}\``,
        `repo channel: \`${context.repoChannelId}\``,
        `approval policy: \`${config.approvalPolicy}\``,
        `sandbox mode: \`${sandboxMode}\``,
        `file writes: \`${fileWrites}\``,
        `codex thread: ${threadId ? `\`${threadId}\`` : "none"}`
      ];
      await safeReply(message, lines.join("\n"));
      return;
    }

    if (command === "!approve" || command === "!decline" || command === "!cancel") {
      let token = rest;
      if (!token) {
        token = findLatestPendingApprovalTokenForChannel(message.channelId);
        if (!token) {
          await safeReply(message, `No pending approvals in this channel. Usage: \`${command} <id>\``);
          return;
        }
      }
      const approval = pendingApprovals.get(token);
      if (!approval) {
        await safeReply(message, `No pending approval with id \`${token}\`.`);
        return;
      }
      if (approval.repoChannelId !== message.channelId) {
        await safeReply(message, "That approval belongs to a different channel.");
        return;
      }
      const decision = command === "!approve" ? "accept" : command === "!cancel" ? "cancel" : "decline";
      const result = await applyApprovalDecision(token, decision, `<@${message.author.id}>`);
      if (!result.ok) {
        await safeReply(message, `Failed to send approval response: ${result.error}`);
        return;
      }
      await safeReply(message, `${decision} sent for approval \`${token}\`.`);
      return;
    }

    await safeReply(message, "Unknown command. Use `!help`.");
  }

  async function handleInitRepoCommand(message, rest) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, "`!initrepo` is only available in server text channels.");
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, "`!initrepo` is disabled in #general (read-only channel).");
      return;
    }
    if (!repoRootPath) {
      await safeReply(message, "Set `DISCORD_REPO_ROOT` in `.env` before using `!initrepo`.");
      return;
    }

    const force = rest.toLowerCase() === "force";
    const repoName = makeChannelName(message.channel.name);
    const repoPath = path.join(repoRootPath, repoName);
    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[message.channelId];

    if (existingSetup && existingSetup.cwd !== repoPath && !force) {
      await safeReply(
        message,
        `This channel is already bound to \`${existingSetup.cwd}\`. Use \`!initrepo force\` to rebind.`
      );
      return;
    }

    await fs.mkdir(repoRootPath, { recursive: true });
    const repoExists = await pathExists(fs, repoPath);
    if (repoExists && !force && (!existingSetup || existingSetup.cwd !== repoPath)) {
      await safeReply(
        message,
        `Repo path already exists: \`${repoPath}\`. Rename channel or run \`!initrepo force\`.`
      );
      return;
    }

    await fs.mkdir(repoPath, { recursive: true });
    await execFileAsync("git", ["-C", repoPath, "init"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });

    const nextSetups = { ...channelSetups };
    nextSetups[message.channelId] = {
      cwd: repoPath,
      model: config.defaultModel
    };
    setChannelSetups(nextSetups);
    state.clearBinding(message.channelId);
    await state.save();

    const nextTopic = upsertTopicTag(message.channel.topic, managedChannelTopicPrefix, repoPath);
    if (nextTopic !== message.channel.topic) {
      await message.channel.setTopic(nextTopic).catch((error) => {
        console.warn(`failed setting channel topic for ${message.channelId}: ${error.message}`);
      });
    }

    await safeReply(
      message,
      `Initialized repo \`${repoName}\` at \`${repoPath}\` and bound this channel.`
    );
  }

  return {
    handleCommand,
    handleInitRepoCommand
  };
}

function upsertTopicTag(topic, prefix, value) {
  const safeValue = String(value ?? "").trim();
  if (!safeValue) {
    return typeof topic === "string" ? topic : "";
  }
  const lines = typeof topic === "string" && topic.trim() ? topic.split(/\n+/).map((line) => line.trim()) : [];
  const kept = lines.filter((line) => !line.startsWith(prefix));
  kept.push(`${prefix}${safeValue}`);
  return kept.join("\n").trim();
}

async function pathExists(fsModule, targetPath) {
  try {
    await fsModule.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
