import http from "node:http";

export function createBackendHttpRuntime(deps) {
  const {
    enabled,
    host,
    port,
    processStartedAt,
    activeTurns,
    pendingApprovals,
    getMappedChannelCount,
    platformRegistry,
    feishuRuntime
  } = deps;

  const httpPlatforms = platformRegistry ?? createLegacyPlatformRegistry(feishuRuntime);

  let server = null;
  let ready = false;

  async function start() {
    if (!enabled || server) {
      return;
    }
    server = http.createServer((request, response) => {
      void handleRequest(request, response);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = getAddress();
    const resolvedPort = typeof address?.port === "number" ? address.port : port;
    console.log(`backend http listening on http://${host}:${resolvedPort}`);
  }

  async function stop() {
    if (!server) {
      return;
    }
    const current = server;
    server = null;
    await new Promise((resolve) => {
      current.close(() => resolve());
    });
  }

  function setReady(nextReady) {
    ready = nextReady === true;
  }

  function getAddress() {
    return server?.address?.() ?? null;
  }

  async function handleRequest(request, response) {
    const method = String(request.method ?? "").toUpperCase();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (method === "GET" && pathname === "/healthz") {
      writeJson(response, 200, buildStatusPayload({ includeReady: true }));
      return;
    }
    if (method === "GET" && pathname === "/readyz") {
      writeJson(response, ready ? 200 : 503, buildStatusPayload({ includeReady: true }));
      return;
    }
    if (method === "GET" && pathname === "/") {
      writeJson(response, 200, {
        ok: true,
        service: "codex-chat-bridge",
        ready,
        endpoints: ["/healthz", "/readyz", ...(httpPlatforms?.getHttpEndpoints?.() ?? [])]
      });
      return;
    }

    const handledByPlatform = await httpPlatforms?.handleHttpRequest?.(request, response, { ready });
    if (handledByPlatform) {
      return;
    }

    writeJson(response, 404, { code: 404, msg: "not found" });
  }

  function buildStatusPayload(options = {}) {
    return {
      ok: true,
      ready: options.includeReady ? ready : undefined,
      startedAt: processStartedAt,
      activeTurns: activeTurns.size,
      pendingApprovals: pendingApprovals.size,
      mappedChannels: getMappedChannelCount()
    };
  }

  return {
    enabled,
    start,
    stop,
    setReady,
    getAddress
  };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function createLegacyPlatformRegistry(feishuRuntime) {
  if (!feishuRuntime?.enabled || !feishuRuntime?.webhookPath) {
    return null;
  }
  return {
    getHttpEndpoints() {
      return [feishuRuntime.webhookPath];
    },
    async handleHttpRequest(request, response, options = {}) {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== feishuRuntime.webhookPath) {
        return false;
      }
      await feishuRuntime.handleHttpRequest(request, response, options);
      return true;
    }
  };
}
