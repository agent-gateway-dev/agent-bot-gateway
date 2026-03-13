import { afterEach, describe, expect, test } from "bun:test";
import { createBackendHttpRuntime } from "../src/backend/httpRuntime.js";

const runtimes = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    await runtime?.stop?.();
  }
});

describe("backend http runtime", () => {
  test("serves health and readiness endpoints", async () => {
    const runtime = createBackendHttpRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map([["thread-1", {}]]),
      pendingApprovals: new Map([["0001", {}]]),
      getMappedChannelCount: () => 3,
      feishuRuntime: { enabled: false }
    });
    runtimes.push(runtime);
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ok: true,
      ready: false,
      startedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: 1,
      pendingApprovals: 1,
      mappedChannels: 3
    });

    const readyBefore = await fetch(`${baseUrl}/readyz`);
    expect(readyBefore.status).toBe(503);

    runtime.setReady(true);
    const readyAfter = await fetch(`${baseUrl}/readyz`);
    expect(readyAfter.status).toBe(200);
    expect((await readyAfter.json()).ready).toBe(true);
  });

  test("delegates Feishu webhook requests to the Feishu runtime", async () => {
    const calls = [];
    const runtime = createBackendHttpRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      feishuRuntime: {
        enabled: true,
        webhookPath: "/feishu/events",
        async handleHttpRequest(_request, response, context) {
          calls.push(context);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: 0, delegated: true }));
        }
      }
    });
    runtimes.push(runtime);
    await runtime.start();
    runtime.setReady(true);
    const address = runtime.getAddress();

    const response = await fetch(`http://127.0.0.1:${address.port}/feishu/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, delegated: true });
    expect(calls).toEqual([{ ready: true }]);
  });
});
