export function createDiscordPlatform(deps) {
  const { discord, discordToken, waitForDiscordReady, runtime, bootstrapChannelMappings } = deps;
  const enabled = Boolean(discordToken);

  return {
    platformId: "discord",
    enabled,
    capabilities: {
      supportsPlainMessages: true,
      supportsSlashCommands: true,
      supportsButtons: true,
      supportsAttachments: true,
      supportsRepoBootstrap: true,
      supportsAutoDiscovery: true,
      supportsWebhookIngress: false
    },
    canHandleRouteId(routeId) {
      const normalizedRouteId = String(routeId ?? "").trim();
      return normalizedRouteId.length > 0 && !normalizedRouteId.includes(":");
    },
    async fetchChannelByRouteId(routeId) {
      if (!enabled || !this.canHandleRouteId(routeId)) {
        return null;
      }
      return await discord.channels.fetch(routeId).catch(() => null);
    },
    async handleInboundMessage(message) {
      await runtime.handleMessage(message);
    },
    async handleInboundInteraction(interaction) {
      await runtime.handleInteraction(interaction);
    },
    async start() {
      if (!enabled) {
        return {
          platformId: "discord",
          started: false,
          commandRegistration: null,
          commandRegistrationError: null
        };
      }

      await discord.login(discordToken);
      await discord.application?.fetch().catch(() => null);
      await waitForDiscordReady(discord);

      let commandRegistration = null;
      let commandRegistrationError = null;
      if (typeof runtime.registerSlashCommands === "function") {
        try {
          commandRegistration = await runtime.registerSlashCommands();
        } catch (error) {
          commandRegistrationError = error;
        }
      }

      return {
        platformId: "discord",
        started: true,
        commandRegistration,
        commandRegistrationError
      };
    },
    async bootstrapRoutes(options = {}) {
      if (!enabled || typeof bootstrapChannelMappings !== "function") {
        return null;
      }
      return await bootstrapChannelMappings(options);
    }
  };
}
