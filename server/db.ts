import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = path.join(__dirname, "..", "habits.db");

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Enforce foreign key constraints
db.pragma("foreign_keys = ON");

// Create Habits table
db.exec(`
  CREATE TABLE IF NOT EXISTS Habits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    created_at  DATETIME DEFAULT (datetime('now'))
  )
`);

// Create Completions table with FK → Habits and unique constraint
db.exec(`
  CREATE TABLE IF NOT EXISTS Completions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id       INTEGER NOT NULL REFERENCES Habits(id) ON DELETE CASCADE,
    completed_date DATE    NOT NULL,
    UNIQUE (habit_id, completed_date)
  )
`);

export default db;
