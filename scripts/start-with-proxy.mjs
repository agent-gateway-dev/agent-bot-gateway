import "dotenv/config";
import process from "node:process";
import { createRequire } from "node:module";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  "";

if (proxyUrl) {
  const require = createRequire(import.meta.url);
  const originalWs = require("ws");
  const wsAgent = new HttpsProxyAgent(proxyUrl);

  class ProxyWebSocket extends originalWs {
    constructor(address, protocols, options) {
      super(address, protocols, { ...(options ?? {}), agent: wsAgent });
    }
  }

  ProxyWebSocket.WebSocket = ProxyWebSocket;
  ProxyWebSocket.WebSocketServer = originalWs.WebSocketServer;
  ProxyWebSocket.Server = originalWs.Server;
  ProxyWebSocket.Receiver = originalWs.Receiver;
  ProxyWebSocket.Sender = originalWs.Sender;
  ProxyWebSocket.createWebSocketStream = originalWs.createWebSocketStream;

  require.cache[require.resolve("ws")].exports = ProxyWebSocket;
  globalThis.WebSocket = ProxyWebSocket;
  setGlobalDispatcher(new ProxyAgent(proxyUrl));

  console.log(`[startup] proxy enabled: ${proxyUrl}`);
}

await import("../src/index.js");
