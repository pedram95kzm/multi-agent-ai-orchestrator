import { build as bundle } from "esbuild";
import { build as viteBuild } from "vite";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const protocol = await readFile("agent.md", "utf8");
const validator = await bundle({
  entryPoints: ["packages/agent-instructions/instructions.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { validateInstructions } = await import(
  `data:text/javascript;base64,${Buffer.from(validator.outputFiles[0].contents).toString("base64")}`
);
validateInstructions(protocol);
await mkdir("dist/chrome-extension", { recursive: true });
await bundle({
  entryPoints: [
    "apps/chrome-extension/background.ts",
    "apps/chrome-extension/popup.ts",
  ],
  outdir: "dist/chrome-extension",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome116",
});
for (const file of ["manifest.json", "popup.html", "popup.css"])
  await copyFile(
    `apps/chrome-extension/${file}`,
    `dist/chrome-extension/${file}`,
  );
await mkdir("dist/electron", { recursive: true });
await bundle({
  entryPoints: ["apps/desktop/electron/main.ts"],
  outfile: "dist/electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "node:sqlite"],
  target: "node24",
  sourcemap: true,
});
await bundle({
  entryPoints: ["apps/desktop/electron/preload.ts"],
  outfile: "dist/electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node24",
});
await viteBuild({
  root: "apps/desktop/renderer",
  base: "./",
  build: { outDir: resolve("dist/desktop"), emptyOutDir: true },
  logLevel: "warn",
});
console.log(
  "Built Relay desktop, Electron app, and Chrome extension in dist/.",
);
