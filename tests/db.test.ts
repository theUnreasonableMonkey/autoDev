import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Use an in-memory database for tests so they are isolated and fast
function createTestDb(): Database.Database {
  const db = new Database(":memory:");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS Habits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      created_at  DATETIME DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS Completions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id       INTEGER NOT NULL REFERENCES Habits(id) ON DELETE CASCADE,
      completed_date DATE    NOT NULL,
      UNIQUE (habit_id, completed_date)
    )
  `);

  return db;
}

describe("database schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  describe("Habits table", () => {
    it("creates a habit with required fields", () => {
      const stmt = db.prepare("INSERT INTO Habits (name) VALUES (?)");
      const result = stmt.run("Morning Run");
      expect(result.lastInsertRowid).toBe(1);
    });

    it("creates a habit with all fields", () => {
      const stmt = db.prepare(
        "INSERT INTO Habits (name, description) VALUES (?, ?)",
      );
      const result = stmt.run("Morning Run", "Run 5k every morning");
      expect(result.lastInsertRowid).toBe(1);

      const habit = db
        .prepare("SELECT * FROM Habits WHERE id = ?")
        .get(result.lastInsertRowid) as {
        id: number;
        name: string;
        description: string;
        created_at: string;
      };
      expect(habit.name).toBe("Morning Run");
      expect(habit.description).toBe("Run 5k every morning");
      expect(habit.created_at).toBeTruthy();
    });

    it("rejects a habit without a name", () => {
      const stmt = db.prepare("INSERT INTO Habits (description) VALUES (?)");
      expect(() => stmt.run("Some description")).toThrow();
    });

    it("auto-increments habit IDs", () => {
      const stmt = db.prepare("INSERT INTO Habits (name) VALUES (?)");
      const r1 = stmt.run("Habit A");
      const r2 = stmt.run("Habit B");
      expect(r2.lastInsertRowid).toBe(Number(r1.lastInsertRowid) + 1);
    });
  });

  describe("Completions table", () => {
    beforeEach(() => {
      // Seed a habit for each completion test
      db.prepare("INSERT INTO Habits (name) VALUES (?)").run("Exercise");
    });

    it("records a completion for a habit", () => {
      const stmt = db.prepare(
        "INSERT INTO Completions (habit_id, completed_date) VALUES (?, ?)",
      );
      const result = stmt.run(1, "2026-03-19");
      expect(result.lastInsertRowid).toBe(1);
    });

    it("enforces the unique constraint on (habit_id, completed_date)", () => {
      const stmt = db.prepare(
        "INSERT INTO Completions (habit_id, completed_date) VALUES (?, ?)",
      );
      stmt.run(1, "2026-03-19");
      expect(() => stmt.run(1, "2026-03-19")).toThrow(/UNIQUE constraint/i);
    });

    it("allows the same date for different habits", () => {
      db.prepare("INSERT INTO Habits (name) VALUES (?)").run("Reading");
      const stmt = db.prepare(
        "INSERT INTO Completions (habit_id, completed_date) VALUES (?, ?)",
      );
      expect(() => {
        stmt.run(1, "2026-03-19");
        stmt.run(2, "2026-03-19");
      }).not.toThrow();
    });

    it("allows the same habit on different dates", () => {
      const stmt = db.prepare(
        "INSERT INTO Completions (habit_id, completed_date) VALUES (?, ?)",
      );
      expect(() => {
        stmt.run(1, "2026-03-18");
        stmt.run(1, "2026-03-19");
      }).not.toThrow();
    });

    it("cascades delete when a habit is removed", () => {
      db.prepare(
        "INSERT INTO Completions (habit_id, completed_date) VALUES (?, ?)",
      ).run(1, "2026-03-19");

      db.prepare("DELETE FROM Habits WHERE id = ?").run(1);

      const completions = db
        .prepare("SELECT * FROM Completions WHERE habit_id = ?")
        .all(1);
      expect(completions).toHaveLength(0);
    });

    it("rejects a completion referencing a non-existent habit", () => {
      const stmt = db.prepare(
        "INSERT INTO Completions (habit_id, completed_date) VALUES (?, ?)",
      );
      expect(() => stmt.run(999, "2026-03-19")).toThrow(
        /FOREIGN KEY constraint/i,
      );
    });
  });

  describe("PRAGMAs", () => {
    // WAL mode only works on file-based databases, not :memory:
    it("has WAL journal mode enabled on a file-based database", () => {
      const tmpFile = path.join(os.tmpdir(), `test-habits-${Date.now()}.db`);
      try {
        const fileDb = new Database(tmpFile);
        fileDb.pragma("journal_mode = WAL");
        const mode = fileDb.pragma("journal_mode", { simple: true });
        fileDb.close();
        expect(mode).toBe("wal");
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        const walFile = `${tmpFile}-wal`;
        const shmFile = `${tmpFile}-shm`;
        if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
        if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
      }
    });

    it("has foreign keys enabled", () => {
      const row = db.pragma("foreign_keys", { simple: true });
      expect(row).toBe(1);
    });
  });
});
