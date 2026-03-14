import process from "node:process";

export function registerShutdownSignals(shutdown) {
  process.on("SIGINT", () => {
    void shutdown?.(0);
  });
  process.on("SIGTERM", () => {
    void shutdown?.(0);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[process] unhandledRejection: ${formatProcessError(reason)}`);
    if (!shouldGracefullyShutdownForRejection(reason)) {
      return;
    }
    void shutdown?.(1);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[process] uncaughtException: ${formatProcessError(error)}`);
    void shutdown?.(1);
  });
}

function shouldGracefullyShutdownForRejection(reason) {
  if (!(reason instanceof Error)) {
    return false;
  }

  // Abort 类 rejection 常见于取消/关闭流程，只记录，不再触发新的退出链路。
  return String(reason?.name ?? "") !== "AbortError" && String(reason?.code ?? "") !== "ABORT_ERR";
}

function formatProcessError(error) {
  if (error instanceof Error) {
    const lines = [error.stack || `${error.name}: ${error.message}`];
    const errorCode = String(error?.code ?? "").trim();
    if (errorCode) {
      lines.push(`code=${errorCode}`);
    }
    if (error.cause !== undefined) {
      lines.push(`cause=${formatProcessError(error.cause)}`);
    }
    return lines.join("\n");
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error ?? "unknown");
}
