import { DatabaseSync } from "node:sqlite";
import type { AppState } from "../shared/types";

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instruction_versions (hash TEXT PRIMARY KEY, content TEXT NOT NULL, activated TEXT NOT NULL);
      DROP TABLE IF EXISTS secrets;
    `);
  }
  load(): AppState | undefined {
    const row = this.db.prepare("SELECT json FROM state WHERE id=1").get() as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  save(state: AppState) {
    this.db
      .prepare(
        "INSERT INTO state VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(JSON.stringify(state));
  }
  saveInstructions(hash: string, content: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO instruction_versions VALUES(?,?,?)")
      .run(hash, content, new Date().toISOString());
  }
  event(id: string): unknown {
    const row = this.db
      .prepare("SELECT result FROM events WHERE id=?")
      .get(id) as { result: string } | undefined;
    return row ? JSON.parse(row.result) : undefined;
  }
  record(id: string, result: unknown) {
    this.db
      .prepare("INSERT OR IGNORE INTO events VALUES(?,?)")
      .run(id, JSON.stringify(result));
  }
  close() {
    this.db.close();
  }
}
