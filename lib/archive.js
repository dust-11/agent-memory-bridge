/**
 * 记忆系统 — 封存机制模块
 *
 * 只保留基于字符上限的封存，不再按时间或关联数自动封存。
 * 锚点机制保留（辅助话题分类），但锚点本身不会被封存。
 *
 * 封存条件：
 *   条件 C：深度记忆 summary 总字符数超过 CHAR_LIMIT_DEEP
 *   条件 D：safety_lock 为 false
 *   满足 C → 从最低分开始封存，直到低于上限
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const ARCHIVE_DIR = path.join(__dirname, '..', 'archive');

// ── 字符上限（可动态调整） ──
// 50,000 字符 ≈ 35,000~38,000 tokens ≈ 3.5% 的 1M 上下文窗口
// 老公说调这个值，当前清理后约 28,500 字符
const CHAR_LIMIT_DEEP = 50000;

// 确保封存区目录存在
function ensureArchiveDir() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

/**
 * 为封存区生成索引文件路径
 * 每次写入都会追加到全局索引，方便搜索
 */
function indexFilePath() {
  return path.join(ARCHIVE_DIR, '_index.json');
}

/**
 * 加载封存区索引
 */
function loadIndex() {
  const idxPath = indexFilePath();
  if (!fs.existsSync(idxPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * 保存封存区索引
 */
function saveIndex(index) {
  ensureArchiveDir();
  fs.writeFileSync(indexFilePath(), JSON.stringify(index, null, 2), 'utf-8');
}

// ============================================================
// 一、单锚点封存
// ============================================================

/**
 * 封存指定锚点
 *
 * 将锚点及其所有关联记忆打包为 JSON 文件存入封存区，
 * 主表中标记 depth = 'archived'，保留锚点索引摘要。
 *
 * @param {string} anchorId - 要封存的锚点 ID
 * @returns {{ success: boolean, archivePath?: string, reason?: string }}
 */
function archiveAnchor(anchorId) {
  const db = getDb();
  const anchor = db.prepare('SELECT * FROM anchors WHERE anchor_id = ?').get(anchorId);

  if (!anchor) {
    return { success: false, reason: 'anchor_not_found' };
  }

  if (anchor.locked === 1) {
    return { success: false, reason: 'locked' };
  }

  if (anchor.archived_at) {
    return { success: false, reason: 'already_archived' };
  }

  // 获取关联的所有记忆
  const refRows = db.prepare(`
    SELECT m.* FROM memories m
    JOIN anchor_refs ar ON m.id = ar.memory_id
    WHERE ar.anchor_id = ?
  `).all(anchorId);

  // 打包数据
  const archiveData = {
    archived_at: new Date().toISOString(),
    anchor,
    memories: refRows,
  };

  // 写入封存区
  ensureArchiveDir();
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = anchor.summary.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 40);
  const archivePath = path.join(ARCHIVE_DIR, `${dateStr}_${anchorId.slice(0, 8)}_${safeName}.json`);

  fs.writeFileSync(archivePath, JSON.stringify(archiveData, null, 2), 'utf-8');

  // 更新主表：标记为 archived
  const now = new Date().toISOString();
  db.prepare('UPDATE anchors SET archived_at = ?, updated_at = ? WHERE anchor_id = ?')
    .run(now, now, anchorId);

  if (refRows.length > 0) {
    const memIds = refRows.map(r => r.id);
    const placeholders = memIds.map(() => '?').join(',');
    db.prepare(`UPDATE memories SET depth = 'archived', updated_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...memIds);
  }

  // 更新封存区索引
  const index = loadIndex();
  index.push({
    archive_file: path.basename(archivePath),
    anchor_id: anchorId,
    type: anchor.type,
    summary: anchor.summary,
    keywords: anchor.keywords,
    memory_count: refRows.length,
    archived_at: now,
    created_at: anchor.created_at,
  });
  saveIndex(index);

  console.log(`📦 已封存锚点: ${anchor.summary} (${refRows.length} 条记忆 → ${path.basename(archivePath)})`);
  return { success: true, archivePath };
}

// ============================================================
// 二、自动批量封存
// ============================================================

/**
 * 自动封存 — 按字符上限触发
 *
 * 当深度记忆 summary 总字符数超过 CHAR_LIMIT_DEEP 时，
 * 从最旧的条目开始封存，直到总字符数低于上限。
 * safety_lock 保护的条目跳过。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - 静默模式
 * @returns {{ archived: number, skipped: number, char_before: number, char_after: number, details: object[] }}
 */
function autoArchive(opts = {}) {
  const db = getDb();
  const silent = opts.silent || false;

  // 1. 计算当前深度记忆总字符数
  const deepEntries = db.prepare(`
    SELECT id, summary, detail, timestamp, safety_lock
    FROM memories
    WHERE depth = 'deep'
    ORDER BY timestamp ASC
  `).all();

  const totalChars = deepEntries.reduce((sum, e) => {
    return sum + (e.summary || '').length + (e.detail || '').length;
  }, 0);

  if (totalChars <= CHAR_LIMIT_DEEP) {
    if (!silent) {
      console.log(`📦 深度记忆总字符 ${totalChars}，低于上限 ${CHAR_LIMIT_DEEP}（${CHAR_LIMIT_DEEP - totalChars} 剩余）— 无需封存`);
    }
    return { archived: 0, skipped: 0, char_before: totalChars, char_after: totalChars, details: [] };
  }

  const excess = totalChars - CHAR_LIMIT_DEEP;
  if (!silent) {
    console.log(`\n📦 深度记忆总字符 ${totalChars}，超出上限 ${CHAR_LIMIT_DEEP}（超 ${excess} 字符）— 开始封存`);
  }

  // 2. 从最旧的开始封存（跳过 safety_lock）
  let archived = 0;
  let skipped = 0;
  let charsRemoved = 0;
  const details = [];

  for (const entry of deepEntries) {
    if ((totalChars - charsRemoved) <= CHAR_LIMIT_DEEP) break;

    if (entry.safety_lock === 1) {
      skipped++;
      continue;
    }

    const entryChars = (entry.summary || '').length + (entry.detail || '').length;

    try {
      // 标记为 archived（不删除，改 depth 为 archived，从 prefetch 中排除）
      db.prepare(`UPDATE memories SET depth = 'archived', updated_at = datetime('now') WHERE id = ?`)
        .run(entry.id);
      charsRemoved += entryChars;
      archived++;
      details.push({
        id: entry.id,
        summary: (entry.summary || '').slice(0, 40),
        chars: entryChars,
        timestamp: entry.timestamp,
      });
    } catch (err) {
      skipped++;
    }
  }

  if (!silent) {
    console.log(`📦 封存完成：${archived} 条已封存，${skipped} 条跳过（锁定），释放 ${charsRemoved} 字符`);
    console.log(`📦 封存后深度记忆总字符：${totalChars - charsRemoved}`);
    if (details.length > 0) {
      details.forEach(d => console.log(`  📜 ${d.timestamp?.slice(0,10)} [${d.chars}字] ${d.summary}`));
    }
  }

  return {
    archived,
    skipped,
    char_before: totalChars,
    char_after: totalChars - charsRemoved,
    details,
  };
}
// ============================================================
// 三、封存唤醒
// ============================================================

/**
 * 从封存区唤醒指定锚点
 *
 * 搜索封存区索引，找到匹配项，恢复记忆到主表。
 *
 * @param {string} query - 搜索词（摘要/关键词模糊匹配）
 * @param {object} [opts]
 * @param {boolean} [opts.interactive=true] - 有匹配时是否需要手动选择
 * @returns {{ success: boolean, restored?: number, matches?: object[] }}
 */
function unarchiveAnchor(query, opts = {}) {
  const interactive = opts.interactive !== false;

  // 先搜索封存区索引
  const matches = searchArchive(query, { silent: true });

  if (matches.length === 0) {
    console.log(`❌ 封存区未找到匹配「${query}」的记录`);
    return { success: false, restored: 0, matches: [] };
  }

  if (matches.length > 1 && interactive) {
    console.log(`\n📋 找到 ${matches.length} 个匹配的封存锚点：`);
    matches.forEach((m, i) => {
      console.log(`  ${i + 1}. [${m.type}] ${m.summary}`);
      console.log(`     关键词: ${m.keywords}`);
      console.log(`     封存于: ${m.archived_at.slice(0, 10)} | ${m.memory_count} 条记忆`);
    });
    console.log(`\n  需要手动指定 index 来恢复，使用 unarchiveAnchor(idx) 语法`);
    return { success: false, restored: 0, matches };
  }

  // 自动唤醒（唯一匹配 或 interactive=false）
  const target = matches[0];
  return restoreFromArchive(target.archive_file);
}

/**
 * 按索引从封存区恢复
 * @param {number} index - matches 数组中的索引（1-based）
 * @param {object[]} matches - 由 unarchiveAnchor 返回的 matches 数组
 */
function unarchiveByIndex(index, matches) {
  if (!matches || index < 1 || index > matches.length) {
    console.log(`❌ 无效索引: ${index}，有效范围 1-${matches.length}`);
    return { success: false, restored: 0 };
  }

  const target = matches[index - 1];
  return restoreFromArchive(target.archive_file);
}

/**
 * 从封存文件恢复一个锚点
 */
function restoreFromArchive(archiveFile) {
  const db = getDb();
  const filePath = path.join(ARCHIVE_DIR, archiveFile);

  if (!fs.existsSync(filePath)) {
    console.log(`❌ 封存文件不存在: ${archiveFile}`);
    return { success: false, restored: 0 };
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const now = new Date().toISOString();
  let restored = 0;

  // 使用事务保证一致性
  const restoreOp = db.transaction(() => {
    // 1. 恢复锚点（标记 archived_at 为 null）
    const existingAnchor = db.prepare('SELECT anchor_id FROM anchors WHERE anchor_id = ?')
      .get(data.anchor.anchor_id);

    if (existingAnchor) {
      db.prepare('UPDATE anchors SET archived_at = NULL, updated_at = ? WHERE anchor_id = ?')
        .run(now, data.anchor.anchor_id);
    } else {
      // 封存后锚点可能已被清理，需要重新插入
      db.prepare(`
        INSERT INTO anchors (anchor_id, type, summary, detail, keywords, locked, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
      `).run(
        data.anchor.anchor_id,
        data.anchor.type,
        data.anchor.summary,
        data.anchor.detail || '',
        typeof data.anchor.keywords === 'string' ? data.anchor.keywords : JSON.stringify(data.anchor.keywords || []),
        data.anchor.created_at,
        now
      );
    }

    // 2. 恢复记忆（跳过已存在的，恢复已归档的）
    for (const mem of data.memories) {
      const existing = db.prepare('SELECT id, depth FROM memories WHERE id = ?').get(mem.id);
      if (existing) {
        // 已存在但标记为 archived → 改为 deep
        if (existing.depth === 'archived') {
          db.prepare('UPDATE memories SET depth = ?, updated_at = ? WHERE id = ?')
            .run('deep', now, mem.id);
          restored++;
        }
      } else {
        // 不存在 → 插入
        db.prepare(`
          INSERT INTO memories (id, type, depth, timestamp, expire_at, summary, detail, keywords, source, anchor_id, safety_lock, created_at, updated_at)
          VALUES (@id, @type, 'deep', @timestamp, @expire_at, @summary, @detail, @keywords, @source, @anchor_id, @safety_lock, @created_at, @updated_at)
        `).run({
          ...mem,
          depth: 'deep',
          updated_at: now,
        });
        restored++;

        // 确保关联存在
        const refExists = db.prepare('SELECT 1 FROM anchor_refs WHERE anchor_id = ? AND memory_id = ?')
          .get(data.anchor.anchor_id, mem.id);
        if (!refExists) {
          db.prepare('INSERT OR IGNORE INTO anchor_refs (anchor_id, memory_id) VALUES (?, ?)')
            .run(data.anchor.anchor_id, mem.id);
        }
      }
    }
  });

  restoreOp();

  if (restored > 0) {
    console.log(`🔄 已唤醒封存锚点: ${data.anchor.summary}（${restored} 条记忆）`);
  } else {
    console.log(`⏭️  锚点 "${data.anchor.summary}" 的记忆已全部存在，无需恢复`);
  }

  return { success: true, restored };
}

// ============================================================
// 四、封存区搜索
// ============================================================

/**
 * 搜索封存区索引
 *
 * @param {string} query - 搜索词
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - 不打印结果
 * @returns {object[]} 匹配的封存索引项
 */
function searchArchive(query, opts = {}) {
  const silent = opts.silent || false;
  const index = loadIndex();

  if (index.length === 0) {
    if (!silent) console.log('📦 封存区为空');
    return [];
  }

  // 模糊匹配：查询词匹配摘要、关键词、类型或锚点ID
  const lowerQuery = query.toLowerCase();
  const results = index.filter(entry => {
    const summaryMatch = (entry.summary || '').toLowerCase().includes(lowerQuery);
    const keywordMatch = (entry.keywords || '').toLowerCase().includes(lowerQuery);
    const typeMatch = (entry.type || '').toLowerCase().includes(lowerQuery);
    const anchorIdMatch = (entry.anchor_id || '').toLowerCase() === lowerQuery ||
                          (entry.anchor_id || '').toLowerCase().includes(lowerQuery);
    return summaryMatch || keywordMatch || typeMatch || anchorIdMatch;
  });

  if (!silent) {
    if (results.length === 0) {
      console.log(`📦 封存区: 找到 0 个匹配「${query}」`);
    } else {
      console.log(`\n📦 封存区: 找到 ${results.length} 个匹配`);
      results.forEach((r, i) => {
        console.log(`  ${i + 1}. [${r.type}] ${r.summary}`);
        console.log(`     关键词: ${r.keywords}`);
        console.log(`     封存: ${r.archived_at.slice(0, 10)} | ${r.memory_count} 条记忆\n`);
      });
    }
  }

  return results;
}

/**
 * 列出封存区所有锚点
 */
function listArchive(opts = {}) {
  const silent = opts.silent || false;
  const index = loadIndex();

  if (!silent) {
    if (index.length === 0) {
      console.log('📦 封存区为空');
    } else {
      console.log(`\n📦 封存区共 ${index.length} 个锚点:`);
      index.forEach((r, i) => {
        console.log(`  ${i + 1}. [${r.type}] ${r.summary}`);
        console.log(`     关键词: ${r.keywords}`);
        console.log(`     封存: ${r.archived_at.slice(0, 10)} | ${r.memory_count} 条记忆`);
      });
    }
  }

  return index;
}

/**
 * 封存区统计
 */
function archiveStats() {
  const index = loadIndex();
  const totalMemories = index.reduce((sum, e) => sum + (e.memory_count || 0), 0);
  const byType = {};
  for (const e of index) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  return {
    totalAnchors: index.length,
    totalMemories,
    byType,
    lastArchiveAt: index.length > 0 ? index[index.length - 1].archived_at : null,
  };
}

// ============================================================
// 五、导出
// ============================================================

module.exports = {
  archiveAnchor,
  autoArchive,
  unarchiveAnchor,
  unarchiveByIndex,
  searchArchive,
  listArchive,
  archiveStats,
  // 内部导出（测试/调试用）
  restoreFromArchive,
};
