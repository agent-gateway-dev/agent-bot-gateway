import { initializeRuntimeContext } from "./bootstrapContext.js";
import { runBridgeProcess } from "./runBridgeProcess.js";

export async function startMainRuntime() {
  const context = await initializeRuntimeContext();
  await runBridgeProcess(context);
}
