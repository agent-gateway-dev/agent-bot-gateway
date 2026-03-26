import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const MIN_REQUEST_TIMEOUT_MS = 1000;

function parseRequestTimeout() {
  const raw = process.env.CODEX_RPC_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_REQUEST_TIMEOUT_MS) {
    console.warn(
      `Invalid CODEX_RPC_REQUEST_TIMEOUT_MS '${raw}', using default ${DEFAULT_REQUEST_TIMEOUT_MS}ms`
    );
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

const REQUEST_TIMEOUT_MS = parseRequestTimeout();

function validateMessageShape(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { valid: false, reason: "Message must be a plain object" };
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const hasMethod = typeof message.method === "string";
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");

  if (hasId && hasMethod && !hasResult && !hasError) {
    // Server request: { id, method, params? }
    if (typeof message.id !== "string" && typeof message.id !== "number") {
      return { valid: false, reason: "Server request 'id' must be string or number" };
    }
    if (message.params !== undefined && typeof message.params !== "object") {
      return { valid: false, reason: "Server request 'params' must be an object if present" };
    }
    return { valid: true, type: "serverRequest" };
  }

  if (hasId && (hasResult || hasError)) {
    // Response: { id, result? } | { id, error? }
    if (typeof message.id !== "string" && typeof message.id !== "number") {
      return { valid: false, reason: "Response 'id' must be string or number" };
    }
    if (hasError) {
      if (message.error === null || typeof message.error !== "object") {
        return { valid: false, reason: "Response 'error' must be an object" };
      }
      if (typeof message.error.message !== "string") {
        return { valid: false, reason: "Response error must have string 'message'" };
      }
    }
    return { valid: true, type: "response" };
  }

  if (hasMethod && !hasId) {
    // Notification: { method, params? }
    if (message.params !== undefined && typeof message.params !== "object") {
      return { valid: false, reason: "Notification 'params' must be an object if present" };
    }
    return { valid: true, type: "notification" };
  }

  return { valid: false, reason: "Unrecognized message structure" };
}

export class CodexRpcClient extends EventEmitter {
  #codexBin;
  #configOverrides;
  #proc;
  #nextId;
  #pending;
  #stdoutRl;
  #stderrRl;
  #requestTimeoutMs;

  constructor(options = {}) {
    super();
    this.#codexBin = options.codexBin || "codex";
    this.#configOverrides = Array.isArray(options.configOverrides)
      ? options.configOverrides.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [];
    this.#proc = null;
    this.#nextId = 1;
    this.#pending = new Map();
    this.#stdoutRl = null;
    this.#stderrRl = null;
    this.#requestTimeoutMs =
      typeof options.requestTimeoutMs === "number" && options.requestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS
        ? options.requestTimeoutMs
        : REQUEST_TIMEOUT_MS;
  }

  async start() {
    if (this.#proc) {
      throw new Error("Codex client already started");
    }

    const args = ["app-server"];
    for (const override of this.#configOverrides) {
      args.push("-c", override);
    }

    this.#proc = spawn(this.#codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.#proc.on("close", (code, signal) => {
      const error = new Error(`codex app-server exited (code=${code}, signal=${signal ?? "none"})`);
      for (const { reject, timeoutId } of this.#pending.values()) {
        clearTimeout(timeoutId);
        reject(error);
      }
      this.#pending.clear();
      this.emit("exit", { code, signal });
      this.#proc = null;
    });

    this.#proc.on("error", (error) => {
      this.emit("error", error);
    });

    this.#stdoutRl = readline.createInterface({ input: this.#proc.stdout });
    this.#stderrRl = readline.createInterface({ input: this.#proc.stderr });

    this.#stdoutRl.on("line", (line) => {
      this.#onLine(line);
    });
    this.#stderrRl.on("line", (line) => {
      this.emit("stderr", line);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_discord_bridge",
        title: "Discord Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
  }

  async stop() {
    if (!this.#proc) {
      return;
    }
    this.#stdoutRl?.close();
    this.#stderrRl?.close();
    this.#stdoutRl = null;
    this.#stderrRl = null;
    this.#proc.kill("SIGTERM");
  }

  async request(method, params = {}, options = {}) {
    const id = String(this.#nextId++);
    const payload = { method, id, params };
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs >= MIN_REQUEST_TIMEOUT_MS
        ? options.timeoutMs
        : this.#requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      try {
        this.#send(payload);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondWithError(id, code, message) {
    this.#send({ id, error: { code, message } });
  }

  #send(message) {
    if (!this.#proc || !this.#proc.stdin.writable) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("malformedMessage", line);
      return;
    }

    const validation = validateMessageShape(message);
    if (!validation.valid) {
      this.emit("invalidMessage", { raw: line, reason: validation.reason });
      console.warn(`Codex RPC validation failed: ${validation.reason}`);
      return;
    }

    if (validation.type === "serverRequest") {
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        params: message.params ?? {}
      });
      return;
    }

    if (validation.type === "response") {
      const pending = this.#pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.#pending.delete(String(message.id));
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        pending.reject(
          new Error(
            typeof message.error?.message === "string" ? message.error.message : "Codex request failed"
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (validation.type === "notification") {
      this.emit("notification", {
        method: message.method,
        params: message.params ?? {}
      });
    }
  }
}
