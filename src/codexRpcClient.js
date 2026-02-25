import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexRpcClient extends EventEmitter {
  #codexBin;
  #configOverrides;
  #proc;
  #nextId;
  #pending;
  #stdoutRl;
  #stderrRl;

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
      for (const { reject } of this.#pending.values()) {
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

  async request(method, params = {}) {
    const id = String(this.#nextId++);
    const payload = { method, id, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send(payload);
      } catch (error) {
        this.#pending.delete(id);
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

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = typeof message.method === "string";
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");

    if (hasId && hasMethod && !hasResult && !hasError) {
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        params: message.params ?? {}
      });
      return;
    }

    if (hasId && (hasResult || hasError)) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.#pending.delete(String(message.id));
      if (hasError) {
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

    if (hasMethod && !hasId) {
      this.emit("notification", {
        method: message.method,
        params: message.params ?? {}
      });
    }
  }
}
