import { createBackendHttpRuntime } from "../backend/httpRuntime.js";

export function buildBackendRuntime(deps) {
  return createBackendHttpRuntime(deps);
}
