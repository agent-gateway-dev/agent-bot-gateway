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
    setChannelSetups,
    getPlatformRegistry
  } = deps;

  async function handleCommand(message, content, context) {
    const [commandRaw, ...restParts] = content.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const rest = restParts.join(" ").trim();

    if (command === "!help") {
      await safeReply(message, getHelpText({ platformId: inferPlatformId(message) }));
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

    if (command === "!setpath") {
      await handleSetPathCommand(message, rest, context);
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

  async function runManagedRouteCommand(message, options = {}) {
    const { forceRebuild = false } = options;
    const registry = resolvePlatformRegistry();
    if (!registry?.anyPlatformSupports?.("supportsAutoDiscovery")) {
      await safeReply(message, "No configured platform currently supports managed route sync.");
      return;
    }

    try {
      const summaries = await registry.bootstrapRoutes({ forceRebuild });
      const primary = summaries.find((summary) => summary?.platformId === "discord") ?? summaries[0] ?? null;
      if (!primary) {
        await safeReply(message, "No managed route changes were needed.");
        return;
      }
      await safeReply(message, formatManagedRouteSummary(primary, Object.keys(getChannelSetups()).length, forceRebuild));
    } catch (error) {
      await safeReply(message, `${forceRebuild ? "Rebuild" : "Resync"} failed: ${error.message}`);
    }
  }

  function getHelpText(options = {}) {
    const platformId = String(options.platformId ?? "discord").trim() || "discord";
    const registry = resolvePlatformRegistry();
    const prefix = platformId === "feishu" ? "/" : "!";
    const capabilities = registry?.getCapabilities?.(platformId) ?? {};
    const supportsSlashCommands = capabilities.supportsSlashCommands === true;
    const supportsButtons = capabilities.supportsButtons === true;
    const supportsRepoBootstrap = capabilities.supportsRepoBootstrap === true;
    const supportsAutoDiscovery = registry?.anyPlatformSupports?.("supportsAutoDiscovery") ?? platformId === "discord";

    const lines = [
      supportsSlashCommands ? "Commands (use `!command` or `/command`):" : `Commands (use \`${prefix}command\`):`
    ];

    if (supportsRepoBootstrap) {
      lines.push(`\`${prefix}initrepo [force]\` create/bind repo for this channel using channel name`);
    }
    lines.push(`\`${prefix}setpath <abs-path>\` bind this chat to an existing repo path`);
    lines.push(`\`${prefix}ask <prompt>\` send prompt in this repo channel`);
    lines.push(`\`${prefix}status\` show queue/thread status for this channel`);
    lines.push(`\`${prefix}new\` reset Codex thread binding for this channel`);
    lines.push(`\`${prefix}restart [reason]\` request host-managed restart and confirm when back`);
    lines.push(`\`${prefix}interrupt\` interrupt current turn in this channel`);
    lines.push(`\`${prefix}where\` show bot runtime paths and binding details`);
    lines.push(`\`${prefix}approve [id]\` approve the latest (or specified) pending request`);
    lines.push(`\`${prefix}decline [id]\` decline the latest (or specified) pending request`);
    lines.push(`\`${prefix}cancel [id]\` cancel the latest (or specified) pending request`);
    if (supportsAutoDiscovery) {
      lines.push(`\`${prefix}resync\` non-destructive sync with managed project routes`);
      lines.push(`\`${prefix}rebuild\` destructive rebuild of managed project routes`);
    }
    if (supportsButtons) {
      lines.push("Tip: use the Approve/Decline/Cancel buttons on approval messages");
    }
    lines.push("Model: one chat route = one persistent Codex thread");
    lines.push("Also supported in #general-style chats: plain chat and commands (read-only, no file writes)");

    if (!supportsRepoBootstrap && platformId === "feishu") {
      lines.push("Feishu repo chat bindings are config-driven via `config/channels.json` keys like `feishu:oc_xxx`.");
    }
    if (platformId === "feishu") {
      lines.push("Group chats default to command messages or messages that @mention the bot.");
    }

    return lines.join("\n");
  }

  function isCommandSupportedForPlatform(commandName, platformId) {
    const normalizedCommandName = String(commandName ?? "").trim().toLowerCase();
    const normalizedPlatformId = String(platformId ?? "").trim().toLowerCase();
    const registry = resolvePlatformRegistry();
    if (!registry) {
      return true;
    }

    if (normalizedCommandName === "initrepo") {
      return registry.platformSupports?.(normalizedPlatformId, "supportsRepoBootstrap") ?? false;
    }
    if (normalizedCommandName === "resync" || normalizedCommandName === "rebuild") {
      return registry.anyPlatformSupports?.("supportsAutoDiscovery") ?? false;
    }
    return true;
  }

  function resolvePlatformRegistry() {
    return typeof getPlatformRegistry === "function" ? getPlatformRegistry() : null;
  }

  function inferPlatformId(message) {
    return String(message?.platform ?? "discord").trim() || "discord";
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

  async function handleSetPathCommand(message, rest, context = null) {
    const routeId = String(message?.channelId ?? "").trim();
    if (!routeId) {
      await safeReply(message, "Unable to determine the current chat route.");
      return;
    }

    const rawPath = String(rest ?? "").trim();
    if (!rawPath) {
      await safeReply(message, "Usage: `!setpath /absolute/path/to/repo`");
      return;
    }

    const targetPath = path.resolve(rawPath);
    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      await safeReply(message, `Path does not exist: \`${targetPath}\``);
      return;
    }
    if (typeof stats?.isDirectory === "function" && !stats.isDirectory()) {
      await safeReply(message, `Path is not a directory: \`${targetPath}\``);
      return;
    }

    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[routeId] ?? null;
    if (existingSetup?.cwd === targetPath) {
      await safeReply(message, `This chat is already bound to \`${targetPath}\`.`);
      return;
    }

    const nextSetup = {
      cwd: targetPath,
      model:
        existingSetup?.model ??
        config.channels?.[routeId]?.model ??
        context?.setup?.model ??
        config.defaultModel
    };

    const nextSetups = {
      ...channelSetups,
      [routeId]: nextSetup
    };
    setChannelSetups(nextSetups);
    await persistRouteSetup(routeId, nextSetup);

    if (config.channels && typeof config.channels === "object") {
      config.channels[routeId] = { ...nextSetup };
    }

    state.clearBinding(routeId);
    await state.save();

    if (
      message?.channel?.type === ChannelType.GuildText &&
      typeof message?.channel?.setTopic === "function" &&
      managedChannelTopicPrefix
    ) {
      const nextTopic = upsertTopicTag(message.channel.topic, managedChannelTopicPrefix, targetPath);
      if (nextTopic !== message.channel.topic) {
        await message.channel.setTopic(nextTopic).catch((error) => {
          console.warn(`failed setting channel topic for ${routeId}: ${error.message}`);
        });
      }
    }

    await safeReply(
      message,
      [
        `Bound this chat to \`${targetPath}\`.`,
        "Cleared the existing Codex thread binding.",
        "Next prompt will start a new Codex thread in the new working path."
      ].join("\n")
    );
  }

  async function persistRouteSetup(routeId, setup) {
    let parsed = {};
    try {
      const raw = await fs.readFile(configPath, "utf8");
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      parsed = {};
    }
    if (!parsed.channels || typeof parsed.channels !== "object" || Array.isArray(parsed.channels)) {
      parsed.channels = {};
    }

    parsed.channels[routeId] = {
      cwd: setup.cwd,
      model: setup.model
    };

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(`${configPath}.tmp`, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(`${configPath}.tmp`, configPath);
  }

  return {
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand
  };
}

function formatManagedRouteSummary(summary, mappedCount, forceRebuild) {
  if (forceRebuild) {
    return `Rebuilt channels. nuked_channels=${summary.deletedChannels}, nuked_categories=${summary.deletedCategories}, cleared_bindings=${summary.clearedBindings}, discovered=${summary.discoveredCwds}, created=${summary.createdChannels}, moved=${summary.movedChannels}, pruned=${summary.prunedBindings}, mapped=${mappedCount}`;
  }
  return `Resynced channels. discovered=${summary.discoveredCwds}, created=${summary.createdChannels}, moved=${summary.movedChannels}, pruned=${summary.prunedBindings}, mapped=${mappedCount}`;
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
