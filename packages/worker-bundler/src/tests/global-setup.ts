import path from "node:path";
import {
  bundleTypeScriptForWorkers,
  removeBundledTypeScript
} from "../../scripts/typescript-browser-bundle";
import {
  stageRolldownWasm,
  removeStagedRolldownWasm
} from "../../scripts/rolldown-wasm-stage";

const packageRoot = path.resolve(import.meta.dirname, "../..");

export async function setup() {
  await bundleTypeScriptForWorkers(packageRoot);
  stageRolldownWasm(packageRoot);
}

export function teardown() {
  removeBundledTypeScript(packageRoot);
  removeStagedRolldownWasm(packageRoot);
}
