import { spawn } from "node:child_process";
import electron from "electron";
const launchEnv = { ...process.env };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], {
  windowsHide: false,
  stdio: "inherit",
  env: launchEnv,
});
child.on("exit", (code) => process.exit(code || 0));
