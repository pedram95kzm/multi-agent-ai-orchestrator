import { dialog, shell, type BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync, watch } from "node:fs";
import {
  hash,
  validateInstructions,
} from "../../../packages/agent-instructions/instructions";
import type { Orchestrator } from "../../../packages/orchestration/core";
import type { Store } from "../../../packages/orchestration/store";
import type { Action } from "../../../packages/shared/actions";

export class InstructionFiles {
  private watcher?: ReturnType<typeof watch>;
  constructor(
    private readonly core: Orchestrator,
    private readonly store: Store,
  ) {}
  upgradeDefault(
    bundled: string,
    previousVersions = [
      "c8aebc84098cb47b838a620ae0196d3d8cf31f8ba3464ca67beedc1415f27992",
      "8574dcdcbc79c59c1adcb9c998eaee69142a837d7347803757b8d0e4db9c103a",
      "b020b445b13a4c9a7c007f4e195b4d355b09c513d7ae576e6ebeeb3aae7f7203",
      "bbe989585c317f8fa5a9a1cf6a1475dd56a66151b5574d8ed7a2a437fa5602fb",
      "e997ddc85b17e2afe995f7b80119fce374fa918d819e08147f9c3afa5ed04afd",
      "6e886c3519012c45f17b5c910dbc617033dba4e5f2422836b57331036b69a7b2",
      "ae54b3381cd2ca7119b14ec1ee395b962fd0dd2643de8f1fb65e4fb3bdcd86cc",
      "6eea3cf763ae0709eefa7d96fcd311f9092d07aed0fdadb9b07deeb94b4946db",
      "1db5d54b636169e33be8878f33a804484e0130acae9a3f2589ba9d2487c4f171",
      "a1cbb602c1c1bb1d13d43bbccc7ce7cd66ebe4f409ba5e39ca7d1284f09aaa69",
      "0f6fc17a1f96692a7ca280f09780af55a5efd890654c8e1498ef60f10b8a1615",
    ],
  ) {
    const current = this.core.state.instructions;
    if (!previousVersions.includes(current.hash) || !existsSync(current.path))
      return;
    const disk = readFileSync(current.path, "utf8");
    if (hash(disk) !== current.hash) return;
    validateInstructions(bundled);
    const backup = `${current.path}.before-tools-update.bak`;
    if (!existsSync(backup)) writeFileSync(backup, disk, "utf8");
    writeFileSync(current.path, bundled, "utf8");
    this.activate(current.path, bundled);
  }
  verify() {
    try {
      const disk = readFileSync(this.core.state.instructions.path, "utf8");
      if (validateInstructions(disk) !== this.core.state.instructions.hash)
        this.core.state.instructions.changed = true;
      this.store.saveInstructions(
        this.core.state.instructions.hash,
        this.core.state.instructions.text,
      );
    } catch (error) {
      this.core.state.instructions.error = String(error);
    }
  }
  observe() {
    this.watcher?.close();
    try {
      this.watcher = watch(this.core.state.instructions.path, () => {
        this.core.state.instructions.changed = true;
        this.core.changed();
      });
    } catch (error) {
      this.core.state.instructions.error = String(error);
    }
  }
  private activate(path: string, content: string) {
    const hash = validateInstructions(content);
    // Existing messages and exact command reviews retain their recorded instruction version.
    this.store.saveInstructions(hash, content);
    this.core.state.instructions = { path, text: content, hash };
    this.core.changed();
    this.observe();
  }
  async handle(
    action: Extract<Action, { type: "instructions" }>,
    win: BrowserWindow,
  ) {
    try {
      if (action.operation === "open") {
        const error = await shell.openPath(this.core.state.instructions.path);
        if (error) throw new Error(error);
      }
      if (action.operation === "choose") {
        const picked = await dialog.showOpenDialog(win!, {
          filters: [{ name: "Markdown", extensions: ["md"] }],
          properties: ["openFile"],
        });
        if (picked.filePaths[0])
          this.activate(
            picked.filePaths[0],
            readFileSync(picked.filePaths[0], "utf8"),
          );
      }
      if (action.operation === "reload")
        this.activate(
          this.core.state.instructions.path,
          readFileSync(this.core.state.instructions.path, "utf8"),
        );
      if (action.operation === "save") {
        validateInstructions(action.content ?? "");
        writeFileSync(
          `${this.core.state.instructions.path}.bak`,
          this.core.state.instructions.text,
        );
        writeFileSync(
          this.core.state.instructions.path,
          action.content!,
          "utf8",
        );
        this.activate(this.core.state.instructions.path, action.content!);
      }
    } catch (error) {
      this.core.state.instructions.error = String(error);
      this.core.changed();
      throw error;
    }
  }
  close() {
    this.watcher?.close();
  }
}
