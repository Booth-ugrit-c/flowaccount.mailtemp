import { DatabaseSync } from "node:sqlite";

export function openSeen(path, maxAgeDays = 8) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS seen (capture_id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  db.prepare("DELETE FROM seen WHERE at < ?").run(Date.now() - maxAgeDays * 86400000);
  const has = db.prepare("SELECT 1 FROM seen WHERE capture_id = ?");
  const add = db.prepare("INSERT OR IGNORE INTO seen (capture_id, at) VALUES (?, ?)");
  return {
    has: (id) => has.get(id) !== undefined,
    add: (id) => { add.run(id, Date.now()); },
  };
}
