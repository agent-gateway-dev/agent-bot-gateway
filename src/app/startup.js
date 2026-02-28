export async function startBridgeRuntime({
  codex,
  fs,
  generalChannelCwd,
  discord,
  discordToken,
  waitForDiscordReady,
  maybeCompletePendingRestartNotice,
  turnRecoveryStore,
  safeSendToChannel,
  bootstrapChannelMappings,
  getMappedChannelCount,
  startHeartbeatLoop
}) {
  await codex.start();
  await fs.mkdir(generalChannelCwd, { recursive: true }).catch((error) => {
    console.warn(`failed to ensure general cwd at ${generalChannelCwd}: ${error.message}`);
  });
  await discord.login(discordToken);
  await discord.application?.fetch().catch(() => null);
  await waitForDiscordReady(discord);
  await maybeCompletePendingRestartNotice();
  try {
    const recovery = await turnRecoveryStore.reconcilePending({
      discord,
      codex,
      safeSendToChannel
    });
    if (recovery.reconciled > 0) {
      console.log(
        `turn recovery complete (reconciled=${recovery.reconciled}, resumed_known=${recovery.resumedKnown}, missing_thread=${recovery.missingThread}, skipped=${recovery.skipped})`
      );
    }
  } catch (error) {
    console.error(`turn recovery failed: ${error.message}`);
  }
  try {
    const bootstrapSummary = await bootstrapChannelMappings();
    console.log(
      `channel bootstrap complete (discovered=${bootstrapSummary.discoveredCwds}, created=${bootstrapSummary.createdChannels}, moved=${bootstrapSummary.movedChannels}, pruned=${bootstrapSummary.prunedBindings}, mapped=${getMappedChannelCount()})`
    );
  } catch (error) {
    console.error(`channel bootstrap failed: ${error.message}`);
  }
  startHeartbeatLoop();
}
