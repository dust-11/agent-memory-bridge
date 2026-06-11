/**
 * 记忆系统 — 数据库初始化
 * 
 * 创建 memory.db 及所有表结构
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'memory.db');

let db = null;

function getDb() {
  if (db) return db;
  
  db = new Database(DB_PATH);
  
  // 开启 WAL 模式（支持读写并发，两个AI共用）
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  initSchema(db);
  return db;
}

function initSchema(db) {
  // 检查是否需要迁移旧 schema（source 字段 CHECK 约束变动）
  const oldTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get();
  if (oldTable && !oldTable.sql.includes("'test'")) {
    // 旧 schema 存在且不包含 'test'，迁移
    db.exec(`DROP TABLE IF EXISTS anchor_refs; DROP TABLE IF EXISTS delete_log; DROP TABLE IF EXISTS anchors; DROP TABLE IF EXISTS memories;`);
  }

  db.exec(`
    -- 记忆主表
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('core', 'emotion')),
      depth TEXT NOT NULL CHECK(depth IN ('shallow', 'deep', 'archived')),
      timestamp TEXT NOT NULL,
      expire_at TEXT,
      summary TEXT NOT NULL,
      detail TEXT DEFAULT '',
      keywords TEXT DEFAULT '[]',
      source TEXT DEFAULT 'openclaw' CHECK(source IN ('openclaw', 'hermes', 'manual', 'test')),
      anchor_id TEXT,
      safety_lock INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 锚点索引表
    CREATE TABLE IF NOT EXISTS anchors (
      anchor_id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('core', 'emotion')),
      summary TEXT NOT NULL,
      detail TEXT DEFAULT '',
      keywords TEXT DEFAULT '[]',
      locked INTEGER DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 锚点-记忆关联表
    CREATE TABLE IF NOT EXISTS anchor_refs (
      anchor_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      PRIMARY KEY (anchor_id, memory_id),
      FOREIGN KEY (anchor_id) REFERENCES anchors(anchor_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    );

    -- 删除操作日志表
    CREATE TABLE IF NOT EXISTS delete_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_ids TEXT NOT NULL,
      scale TEXT CHECK(scale IN ('small', 'large', 'auto')),
      reason TEXT DEFAULT '',
      operator TEXT DEFAULT 'auto',
      backed_up_to TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_depth ON memories(depth);
    CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_expire ON memories(expire_at);
    CREATE INDEX IF NOT EXISTS idx_anchors_type ON anchors(type);
  `);

  console.error('[memory] 数据库初始化完成:', DB_PATH);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, close, DB_PATH };
