import { isFeishuRouteId } from "../feishu/ids.js";
import { isFeishuWebhookTransport } from "../feishu/transport.js";

export function createFeishuPlatform(deps) {
  const { runtime } = deps;
  const enabled = runtime?.enabled === true;
  const supportsWebhookIngress = enabled && isFeishuWebhookTransport(runtime?.transport);

  return {
    platformId: "feishu",
    enabled,
    capabilities: {
      supportsPlainMessages: true,
      supportsSlashCommands: false,
      supportsButtons: false,
      supportsAttachments: true,
      supportsRepoBootstrap: false,
      supportsAutoDiscovery: false,
      supportsWebhookIngress
    },
    canHandleRouteId(routeId) {
      return isFeishuRouteId(routeId);
    },
    async fetchChannelByRouteId(routeId) {
      if (!enabled || !isFeishuRouteId(routeId)) {
        return null;
      }
      return await runtime.fetchChannelByRouteId(routeId);
    },
    getHttpEndpoints() {
      if (!supportsWebhookIngress || !runtime?.webhookPath) {
        return [];
      }
      return [runtime.webhookPath];
    },
    matchesHttpRequest({ pathname }) {
      return supportsWebhookIngress && pathname === runtime?.webhookPath;
    },
    async handleHttpRequest(request, response, options = {}) {
      await runtime.handleHttpRequest(request, response, options);
    },
    async start() {
      const summary = (await runtime?.start?.()) ?? {};
      return {
        platformId: "feishu",
        started: enabled,
        transport: runtime?.transport ?? null,
        ...summary
      };
    },
    async stop() {
      return await runtime?.stop?.();
    }
  };
}
