import fs from "node:fs/promises";
import path from "node:path";
import { makeScopedRouteId, parseLegacyRouteId, parseScopedRouteId } from "./bots/scopedRoutes.js";

export class StateStore {
  #path;
  #state;
  #legacyThreadsDropped;
  #bots;

  constructor(filePath, options = {}) {
    this.#path = filePath;
    this.#state = {
      schemaVersion: 2,
      threadBindings: {}
    };
    this.#legacyThreadsDropped = 0;
    this.#bots = options.bots && typeof options.bots === "object" && !Array.isArray(options.bots) ? options.bots : {};
  }

  async load() {
    await fs.mkdir(path.dirname(this.#path), { recursive: true });
    try {
      const raw = await fs.readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw);
      const legacyThreads =
        parsed && typeof parsed.threads === "object" && parsed.threads !== null
          ? parsed.threads
          : {};
      this.#legacyThreadsDropped = Object.keys(legacyThreads).length;
      const rawThreadBindings =
        parsed && typeof parsed.threadBindings === "object" && parsed.threadBindings !== null
          ? parsed.threadBindings
          : parsed && typeof parsed.channelBindings === "object" && parsed.channelBindings !== null
            ? parsed.channelBindings
            : {};
      this.#state = {
        schemaVersion: 2,
        threadBindings: this.#normalizeThreadBindings(rawThreadBindings)
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
  }

  consumeLegacyDropCount() {
    const count = this.#legacyThreadsDropped;
    this.#legacyThreadsDropped = 0;
    return count;
  }

  async save() {
    const tempPath = `${this.#path}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.#state, null, 2), "utf8");
    await fs.rename(tempPath, this.#path);
  }

  getBinding(discordThreadChannelId) {
    return this.#state.threadBindings[discordThreadChannelId] ?? null;
  }

  setBinding(discordThreadChannelId, binding) {
    const scopedRoute = parseScopedRouteId(discordThreadChannelId);
    this.#state.threadBindings[discordThreadChannelId] = {
      ...binding,
      ...(scopedRoute
        ? {
            botId: binding?.botId ?? scopedRoute.botId,
            externalRouteId: binding?.externalRouteId ?? scopedRoute.externalRouteId,
            repoChannelId: binding?.repoChannelId ?? discordThreadChannelId
          }
        : {}),
      updatedAt: new Date().toISOString()
    };
  }

  clearBinding(discordThreadChannelId) {
    delete this.#state.threadBindings[discordThreadChannelId];
  }

  clearAllBindings() {
    this.#state.threadBindings = {};
  }

  /**
   * Find a thread binding by the agent thread/session ID.
   * Works for both Codex thread IDs and Claude session IDs.
   * @param {string} agentThreadId - The Codex thread ID or Claude session ID
   * @returns {string|null} The discord thread channel ID or null
   */
  findConversationChannelIdByAgentThreadId(agentThreadId) {
    for (const [discordThreadChannelId, binding] of Object.entries(this.#state.threadBindings)) {
      if (binding?.codexThreadId === agentThreadId) {
        return discordThreadChannelId;
      }
    }
    return null;
  }

  /**
   * @deprecated Use findConversationChannelIdByAgentThreadId instead
   */
  findConversationChannelIdByCodexThreadId(codexThreadId) {
    return this.findConversationChannelIdByAgentThreadId(codexThreadId);
  }

  countBindingsForRepoChannel(repoChannelId) {
    let count = 0;
    for (const binding of Object.values(this.#state.threadBindings)) {
      if (binding?.repoChannelId === repoChannelId) {
        count += 1;
      }
    }
    return count;
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  #normalizeThreadBindings(rawThreadBindings) {
    const normalizedBindings = {};
    const entries =
      rawThreadBindings && typeof rawThreadBindings === "object" && !Array.isArray(rawThreadBindings)
        ? Object.entries(rawThreadBindings)
        : [];

    for (const [routeId, binding] of entries) {
      const scopedRoute = parseScopedRouteId(routeId);
      if (scopedRoute) {
        normalizedBindings[routeId] = {
          ...(binding && typeof binding === "object" && !Array.isArray(binding) ? binding : {}),
          botId: binding?.botId ?? scopedRoute.botId,
          externalRouteId: binding?.externalRouteId ?? scopedRoute.externalRouteId,
          repoChannelId: binding?.repoChannelId ?? routeId
        };
        continue;
      }

      const legacyRoute = parseLegacyRouteId(routeId);
      if (!legacyRoute) {
        continue;
      }
      const candidateBotIds = this.#getCandidateBotIdsForPlatform(legacyRoute.platform);
      if (candidateBotIds.length === 0) {
        normalizedBindings[routeId] = binding;
        continue;
      }
      if (candidateBotIds.length > 1) {
        console.warn(`Dropped ambiguous legacy binding for ${routeId}; multiple ${legacyRoute.platform} bots are configured.`);
        continue;
      }

      const scopedRouteId = makeScopedRouteId(candidateBotIds[0], legacyRoute.externalRouteId);
      normalizedBindings[scopedRouteId] = {
        ...(binding && typeof binding === "object" && !Array.isArray(binding) ? binding : {}),
        botId: candidateBotIds[0],
        platform: legacyRoute.platform,
        externalRouteId: legacyRoute.externalRouteId,
        repoChannelId: scopedRouteId
      };
    }

    return normalizedBindings;
  }

  #getCandidateBotIdsForPlatform(platform) {
    return Object.entries(this.#bots)
      .filter(([, bot]) => String(bot?.platform ?? "").trim().toLowerCase() === platform)
      .map(([botId]) => botId);
  }
}
