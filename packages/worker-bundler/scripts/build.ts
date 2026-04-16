import { copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import {
  bundleTypeScriptForWorkers,
  removeBundledTypeScript
} from "./typescript-browser-bundle";
import {
  getRolldownWasmStagePath,
  removeStagedRolldownWasm,
  stageRolldownWasm
} from "./rolldown-wasm-stage";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

async function main() {
  await bundleTypeScriptForWorkers(packageRoot);
  stageRolldownWasm(packageRoot);

  try {
    await build({
      clean: true,
      dts: true,
      entry: ["src/index.ts", "src/typescript.ts"],
      deps: {
        skipNodeModulesBundle: true,
        neverBundle: ["cloudflare:workers", "./vendor/rolldown.wasm"]
      },
      format: "esm",
      sourcemap: true,
      fixedExtension: false,
      platform: "browser"
    });

    // Copy the staged rolldown WASM into dist/ so the emitted
    // `./vendor/rolldown.wasm` import resolves in consumers.
    const stagedWasm = getRolldownWasmStagePath(packageRoot);
    const distWasm = join(packageRoot, "dist/vendor/rolldown.wasm");
    mkdirSync(dirname(distWasm), { recursive: true });
    copyFileSync(stagedWasm, distWasm);

    // then run oxfmt on the generated .d.ts files
    execSync("oxfmt --write ./dist/*.d.ts");
  } finally {
    removeBundledTypeScript(packageRoot);
    removeStagedRolldownWasm(packageRoot);
  }
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
