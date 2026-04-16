/**
 * @rolldown/browser bundling functionality.
 *
 * Rolldown is imported lazily because `@rolldown/browser` eagerly initializes a
 * WASM module at import time. Keeping the import dynamic avoids paying that
 * cost until the first bundle is requested, and prevents crashes in host
 * environments where the initializer is never reached.
 *
 * Upstream `@rolldown/browser` loads its binding WASM by calling `fetch()`
 * on a `file://` URL derived from `import.meta.url`. Workerd rejects
 * `file://` fetches, so we stage the binding WASM next to this file and
 * hand it to rolldown as a pre-compiled `WebAssembly.Module` via
 * `globalThis.__ROLLDOWN_WASM__`. The corresponding patch-package patch
 * for `@rolldown/browser` reads that global before falling back to `fetch`.
 */

import type { InputOptions, Plugin } from "@rolldown/browser";

import rolldownWasm from "./vendor/rolldown.wasm";
import { resolveModule } from "./resolver";
import type { FileSystem } from "./file-system";
import type { CreateWorkerResult, Modules } from "./types";

const VIRTUAL_PREFIX = "\0virtual:";

type TransformOptions = NonNullable<InputOptions["transform"]>;

type RolldownGlobal = {
  __ROLLDOWN_WASM__?: WebAssembly.Module | BufferSource;
};

let rolldownPromise: Promise<typeof import("@rolldown/browser")> | null = null;

function loadRolldown(): Promise<typeof import("@rolldown/browser")> {
  if (rolldownPromise === null) {
    (globalThis as RolldownGlobal).__ROLLDOWN_WASM__ = rolldownWasm;
    rolldownPromise = import("@rolldown/browser");
  }
  return rolldownPromise;
}

/**
 * Bundle files using @rolldown/browser
 */
export async function bundleWithRolldown(
  files: FileSystem,
  entryPoint: string,
  externals: string[],
  _target: string,
  minify: boolean,
  sourcemap: boolean,
  nodejsCompat: boolean,
  plugins: Plugin[] = [],
  jsx?: TransformOptions["jsx"],
  jsxImportSource?: string,
  define?: Record<string, string>
): Promise<CreateWorkerResult> {
  const isExternal = (id: string): boolean =>
    externals.includes(id) ||
    externals.some((e) => id.startsWith(`${e}/`) || id.startsWith(e));

  const virtualFsPlugin: Plugin = {
    name: "virtual-fs",
    resolveId(source, importer, { isEntry }) {
      // Handle entry point — it's passed directly without ./ prefix.
      if (isEntry) {
        const normalized = source.startsWith("/") ? source.slice(1) : source;
        if (files.read(normalized) !== null) {
          return VIRTUAL_PREFIX + normalized;
        }
        return null;
      }

      // Handle relative imports
      if (source.startsWith(".")) {
        const importerPath = importer?.startsWith(VIRTUAL_PREFIX)
          ? importer.slice(VIRTUAL_PREFIX.length)
          : "";
        const lastSlash = importerPath.lastIndexOf("/");
        const dir = lastSlash >= 0 ? importerPath.slice(0, lastSlash) : "";
        const resolved = resolveRelativePath(dir, source, files);
        if (resolved) {
          return VIRTUAL_PREFIX + resolved;
        }
        return null;
      }

      // Handle bare imports (npm packages)
      if (!source.startsWith("/")) {
        if (isExternal(source)) {
          return { id: source, external: true };
        }

        try {
          const result = resolveModule(source, { files });
          if (!result.external) {
            return VIRTUAL_PREFIX + result.path;
          }
        } catch {
          // Resolution failed — fall through to external
        }

        return { id: source, external: true };
      }

      // Absolute paths in virtual fs
      const normalizedPath = source.slice(1);
      if (files.read(normalizedPath) !== null) {
        return VIRTUAL_PREFIX + normalizedPath;
      }

      return { id: source, external: true };
    },

    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const path = id.slice(VIRTUAL_PREFIX.length);
      const content = files.read(path);
      if (content === null) {
        this.error(`File not found: ${path}`);
      }
      return {
        code: content,
        moduleType: getModuleType(path)
      };
    }
  };

  const transformOptions: TransformOptions = {};
  if (jsxImportSource) {
    const base =
      jsx && typeof jsx === "object"
        ? jsx
        : {
            runtime:
              jsx === "react" ? ("classic" as const) : ("automatic" as const)
          };
    transformOptions.jsx = { ...base, importSource: jsxImportSource };
  } else if (jsx !== undefined) {
    transformOptions.jsx = jsx;
  }
  if (define) {
    transformOptions.define = define;
  }

  const { rolldown } = await loadRolldown();

  const bundle = await rolldown({
    input: entryPoint,
    platform: nodejsCompat ? "node" : "browser",
    plugins: [...plugins, virtualFsPlugin],
    ...(Object.keys(transformOptions).length > 0
      ? { transform: transformOptions }
      : {})
  });

  try {
    const result = await bundle.generate({
      format: "esm",
      sourcemap: sourcemap ? "inline" : false,
      minify,
      file: "bundle.js"
    });

    const chunk = result.output.find((o) => o.type === "chunk");
    if (!chunk) {
      throw new Error("No output generated from rolldown");
    }

    const modules: Modules = {
      "bundle.js": chunk.code
    };

    // rolldown surfaces build-time warnings through the onLog hook rather than
    // the build result, so there are no inline warnings to return here.
    return { mainModule: "bundle.js", modules };
  } finally {
    await bundle.close();
  }
}

// Kept for backwards-compatible import paths inside this package.
export { bundleWithRolldown as bundleWithEsbuild };

/**
 * Resolve a relative path against a directory within the virtual filesystem.
 */
function resolveRelativePath(
  resolveDir: string,
  relativePath: string,
  files: FileSystem
): string | undefined {
  const dir = resolveDir.replace(/^\//, "");

  const parts = dir ? dir.split("/") : [];
  const relParts = relativePath.split("/");

  for (const part of relParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  const resolved = parts.join("/");

  if (files.read(resolved) !== null) {
    return resolved;
  }

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
  for (const ext of extensions) {
    if (files.read(resolved + ext) !== null) {
      return resolved + ext;
    }
  }

  for (const ext of extensions) {
    const indexPath = `${resolved}/index${ext}`;
    if (files.read(indexPath) !== null) {
      return indexPath;
    }
  }

  return undefined;
}

function getModuleType(
  path: string
): "js" | "ts" | "tsx" | "jsx" | "json" | "css" {
  if (path.endsWith(".ts") || path.endsWith(".mts")) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  return "js";
}
