import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";
console.log("Building Relay...");
const build = spawn(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
const code = await new Promise((resolve) => build.on("exit", resolve));
if (code !== 0) process.exit(Number(code) || 1);
const server = await createServer({
  root: "apps/desktop/renderer",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
await server.listen();
server.printUrls();
console.log("Starting Relay desktop. Press Ctrl+C to stop.");
const launchEnv = { ...process.env, RELAY_DEV: "1" };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], {
  stdio: "inherit",
  windowsHide: false,
  env: launchEnv,
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code || 0);
});
process.on("SIGINT", () => child.kill());
