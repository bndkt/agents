import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// `@rolldown/browser` initializes its WASM by calling `fetch()` on a
// `file://` URL at module-import time. Workerd rejects `file://` fetches, so
// we stage the binding WASM next to the source and hand it to rolldown as a
// pre-compiled `WebAssembly.Module` via `globalThis.__ROLLDOWN_WASM__`
// (see the patch-package patch for `@rolldown/browser`).

export function getRolldownWasmStagePath(packageRoot: string): string {
  return path.join(packageRoot, "src/vendor/rolldown.wasm");
}

export function stageRolldownWasm(packageRoot: string): string {
  const require = createRequire(path.join(packageRoot, "package.json"));
  // package.json `exports` don't publish the WASM subpath, so resolve via the
  // package.json location and join manually instead of `require.resolve`-ing
  // the WASM directly.
  const pkgJsonPath = require.resolve("@rolldown/browser/package.json");
  const wasmSource = path.join(
    path.dirname(pkgJsonPath),
    "dist/rolldown-binding.wasm32-wasi.wasm"
  );
  const wasmDest = getRolldownWasmStagePath(packageRoot);

  mkdirSync(path.dirname(wasmDest), { recursive: true });
  copyFileSync(wasmSource, wasmDest);

  return wasmDest;
}

export function removeStagedRolldownWasm(packageRoot: string): void {
  const wasmDest = getRolldownWasmStagePath(packageRoot);

  if (existsSync(wasmDest)) {
    rmSync(wasmDest);
  }
}
