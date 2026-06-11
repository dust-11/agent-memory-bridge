/**
 * 记忆系统 — 删除保护模块
 *
 * 实现删除分级保护：
 *   小规模（单条/少量）→ 终端确认
 *   大规模（>10条）→ 手动审批
 *   安全锁保护 → 拒绝删除
 *
 * 所有删除先备份到回收站，可回溯。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getDb } = require('./db');

const RECYCLE_DIR = path.join(__dirname, '..', 'recycle');
const LARGE_THRESHOLD = 10;  // 超过10条为大规模

// 确保回收站目录存在
function ensureRecycleDir() {
  if (!fs.existsSync(RECYCLE_DIR)) {
    fs.mkdirSync(RECYCLE_DIR, { recursive: true });
  }
}

// ============================================================
// 一、单条删除
// ============================================================

/**
 * 删除单条记忆（走删除保护流程）
 *
 * @param {string} id - 记忆ID
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - 静默模式（不提示确认，用于程序内部调用）
 * @param {string}  [opts.reason=''] - 删除原因
 * @returns {{ success: boolean, reason?: string, backupPath?: string }}
 */
function deleteMemory(id, opts = {}) {
  const db = getDb();
  const record = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);

  if (!record) {
    return { success: false, reason: 'not_found' };
  }

  // ---- 安全锁保护 ----
  if (record.safety_lock === 1) {
    console.log(`🔒 记录「${record.summary}」受安全锁保护，拒绝删除`);
    return { success: false, reason: 'locked' };
  }

  // ---- 备份到回收站 ----
  ensureRecycleDir();
  const backupPath = backupToRecycle([record], opts.reason || '单条删除');

  // ---- 静默模式 ----
  if (opts.silent) {
    safeDeleteMemories(db, [id]);
    logDeletion([id], 'small', opts.reason || '静默删除', backupPath);
    console.log(`🗑️ 已删除记忆: ${record.summary}`);
    return { success: true, backupPath };
  }

  // ---- 交互确认 ----
  console.log(`\n⚠️  即将删除记忆：`);
  console.log(`  ID: ${id}`);
  console.log(`  摘要: ${record.summary}`);
  console.log(`  类型: ${record.type} / ${record.depth}`);
  console.log(`  该操作不可直接撤销，但可从回收站恢复\n`);

  // 返回一个 promise，让调用方 await 或用回调
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('  确认删除？(y/N): ', (answer) => {
      rl.close();

      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('  ❌ 已取消删除\n');
        resolve({ success: false, reason: 'cancelled' });
        return;
      }

      safeDeleteMemories(db, [id]);
      logDeletion([id], 'small', opts.reason || '用户确认删除', backupPath);
      console.log(`  ✅ 已删除: ${record.summary}\n`);
      resolve({ success: true, backupPath });
    });
  });
}

// ============================================================
// 二、批量删除
// ============================================================

/**
 * 批量删除多条记忆
 *
 * @param {string[]} ids - 要删除的记忆ID列表
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - 静默模式
 * @param {string}  [opts.reason=''] - 原因
 * @returns {{ success: boolean, deleted: number, locked: string[], backupPath?: string }}
 */
function batchDelete(ids, opts = {}) {
  const db = getDb();

  if (!ids || ids.length === 0) {
    return { success: false, deleted: 0, locked: [] };
  }

  // ---- 检查安全锁 ----
  const locked = ids.filter(id => {
    const r = db.prepare('SELECT safety_lock FROM memories WHERE id = ?').get(id);
    return r && r.safety_lock === 1;
  });

  if (locked.length > 0) {
    console.log(`🔒 ${locked.length} 条记录受安全锁保护，已跳过`);
    ids = ids.filter(id => !locked.includes(id));
  }

  if (ids.length === 0) {
    return { success: false, deleted: 0, locked };
  }

  // ---- 获取记录摘要 ----
  const records = ids.map(id => db.prepare('SELECT * FROM memories WHERE id = ?').get(id)).filter(Boolean);

  // ---- 备份所有记录 ----
  ensureRecycleDir();
  const backupPath = backupToRecycle(records, opts.reason || '批量删除');

  // ---- 判断规模 ----
  const isLarge = ids.length > LARGE_THRESHOLD;

  if (isLarge && !opts.silent) {
    // 大规模：必须手动确认
    console.log(`\n🚨 大规模删除操作：共 ${ids.length} 条记录`);
    console.log(`  · 类型分布: ${getTypeDistribution(records)}`);
    console.log(`  · 时间段: ${getTimeRange(records)}`);
    console.log(`  所有记录已备份至: ${backupPath}`);
    console.log(`  此操作不可直接撤销，但可从回收站恢复\n`);

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question('  确认执行大规模删除？(输入 yes 确认): ', (answer) => {
        rl.close();

        if (answer.trim().toLowerCase() !== 'yes') {
          console.log('  ❌ 已取消删除\n');
          resolve({ success: false, deleted: 0, locked, backupPath });
          return;
        }

        executeBatchDelete(db, ids, records, backupPath, opts);
        console.log(`  ✅ 已批量删除 ${ids.length} 条记录\n`);
        resolve({ success: true, deleted: ids.length, locked, backupPath });
      });
    });
  }

  // ---- 小规模：逐条确认或一次确认 ----
  if (opts.silent) {
    executeBatchDelete(db, ids, records, backupPath, opts);
    console.log(`🗑️ 已批量删除 ${ids.length} 条记忆`);
    return { success: true, deleted: ids.length, locked, backupPath };
  }

  // 小规模交互：一次确认
  console.log(`\n⚠️  即将删除 ${ids.length} 条记忆：`);
  records.slice(0, 5).forEach(r => console.log(`  · ${r.summary}`));
  if (records.length > 5) console.log(`  ... 还有 ${records.length - 5} 条`);
  console.log(`  所有记录已备份至: ${backupPath}\n`);

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('  确认删除？(y/N): ', (answer) => {
      rl.close();

      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('  ❌ 已取消删除\n');
        resolve({ success: false, deleted: 0, locked, backupPath });
        return;
      }

      executeBatchDelete(db, ids, records, backupPath, opts);
      console.log(`  ✅ 已批量删除 ${ids.length} 条记录\n`);
      resolve({ success: true, deleted: ids.length, locked, backupPath });
    });
  });
}

/**
 * 执行批量删除（内部）
 */
function executeBatchDelete(db, ids, records, backupPath, opts) {
  safeDeleteMemories(db, ids);

  const scale = ids.length > LARGE_THRESHOLD ? 'large' : 'small';
  logDeletion(ids, scale, opts.reason || '批量删除', backupPath);
}

// ============================================================
// 三、过期自动清理
// ============================================================

/**
 * 清理所有过期的浅度记忆
 * 每天凌晨运行（定时任务）
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent=true] - 静默模式（自动任务默认静默）
 * @returns {{ expired: number, backupPath: string }}
 */
function expireShallow(opts = {}) {
  const db = getDb();
  const silent = opts.silent !== false; // 默认静默

  const expired = db.prepare(`
    SELECT * FROM memories
    WHERE depth = 'shallow'
      AND expire_at IS NOT NULL
      AND expire_at < datetime('now')
  `).all();

  if (expired.length === 0) {
    if (!silent) console.log('[memory] 没有过期的浅度记忆');
    return { expired: 0, backupPath: '' };
  }

  if (!silent) console.log(`[memory] 发现 ${expired.length} 条过期浅度记忆`);

  // 备份到回收站
  ensureRecycleDir();
  const backupPath = backupToRecycle(expired, '自动过期清理');

  // 从主表删除
  const ids = expired.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
  cleanupOrphanRefs();

  // 记录日志
  logDeletion(ids, 'auto', '自动过期清理', backupPath);

  if (!silent) console.log(`[memory] 已清理 ${expired.length} 条过期记忆 → ${backupPath}`);
  return { expired: expired.length, backupPath };
}

// ============================================================
// 四、回收站管理
// ============================================================

/**
 * 列出回收站内容
 * @returns {object[]} [{ file, date, count, size }]
 */
function listRecycle() {
  ensureRecycleDir();
  const files = fs.readdirSync(RECYCLE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(file => {
    const filePath = path.join(RECYCLE_DIR, file);
    const stat = fs.statSync(filePath);
    let count = 0;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      count = data.records ? data.records.length : (data.length || 1);
    } catch {}
    return {
      file,
      date: file.replace(/^\d{4}-\d{2}-\d{2}/, '').replace(/\..*$/, ''),
      count,
      size: `${(stat.size / 1024).toFixed(1)}KB`,
    };
  });
}

/**
 * 从回收站恢复指定记录
 * @param {string} recycleFile - 回收站文件名
 * @param {string[]} recordIds - 要恢复的记录ID
 * @returns {{ success: boolean, restored: number }}
 */
function restoreFromRecycle(recycleFile, recordIds) {
  const filePath = path.join(RECYCLE_DIR, recycleFile);
  if (!fs.existsSync(filePath)) {
    console.log(`❌ 回收站文件不存在: ${recycleFile}`);
    return { success: false, restored: 0 };
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const records = data.records || [];
  const toRestore = records.filter(r => recordIds.includes(r.id));

  if (toRestore.length === 0) {
    console.log('❌ 未找到匹配的记录');
    return { success: false, restored: 0 };
  }

  const db = getDb();
  let restored = 0;

  for (const record of toRestore) {
    // 检查是否已存在（防止重复恢复）
    const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(record.id);
    if (existing) {
      console.log(`  ⏭️ 记录已存在: ${record.summary}`);
      continue;
    }

    db.prepare(`
      INSERT INTO memories (id, type, depth, timestamp, expire_at, summary, detail, keywords, source, anchor_id, safety_lock, created_at, updated_at)
      VALUES (@id, @type, @depth, @timestamp, @expire_at, @summary, @detail, @keywords, @source, @anchor_id, @safety_lock, @created_at, @updated_at)
    `).run(record);

    restored++;
    console.log(`  ✅ 已恢复: ${record.summary}`);
  }

  console.log(`\n📦 成功恢复 ${restored}/${toRestore.length} 条记忆`);
  return { success: true, restored };
}

/**
 * 清空回收站（需要确认令牌）
 * @param {string} confirmToken - 确认码（随机生成，需匹配）
 * @returns {{ success: boolean, deleted: number }}
 */
function clearRecycle(confirmToken) {
  ensureRecycleDir();

  const expectedToken = generateConfirmToken();
  if (confirmToken !== expectedToken) {
    console.log(`❌ 确认码不匹配`);
    console.log(`   如需清空回收站，请使用确认码: ${expectedToken}`);
    return { success: false, deleted: 0 };
  }

  const files = fs.readdirSync(RECYCLE_DIR).filter(f => f.endsWith('.json'));
  let deleted = 0;

  for (const file of files) {
    const filePath = path.join(RECYCLE_DIR, file);
    fs.unlinkSync(filePath);
    deleted++;
  }

  console.log(`🗑️ 已清空回收站（${deleted} 个文件）`);
  return { success: true, deleted };
}

// ============================================================
// 五、内部工具
// ============================================================

/**
 * 备份记录到回收站（JSON 格式，append-only）
 */
function backupToRecycle(records, reason) {
  ensureRecycleDir();

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const fileName = `${dateStr}_${reason.replace(/[^a-zA-Z\u4e00-\u9fff0-9_-]/g, '_').slice(0, 30)}_${timestamp}.json`;
  const filePath = path.join(RECYCLE_DIR, fileName);

  const backup = {
    backed_up_at: now.toISOString(),
    reason,
    records: records.map(r => ({
      ...r,
      keywords: typeof r.keywords === 'string' ? r.keywords : JSON.stringify(r.keywords || []),
    })),
  };

  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');
  return filePath;
}

/**
 * 安全删除单条/多条记忆（处理外键约束）
 * 先删 anchor_refs，再删 memories
 */
function safeDeleteMemories(db, ids) {
  const placeholders = ids.map(() => '?').join(',');

  // 使用事务保证一致性
  const deleteOp = db.transaction((ids) => {
    // 1. 先删关联引用（外键约束）
    db.prepare(`DELETE FROM anchor_refs WHERE memory_id IN (${placeholders})`).run(...ids);

    // 2. 再删记忆
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);

    // 3. 清理无引用的空锚点
    db.exec(`
      DELETE FROM anchors
      WHERE anchor_id NOT IN (SELECT anchor_id FROM anchor_refs)
        AND archived_at IS NULL
    `);
  });

  deleteOp(ids);
}

/**
 * 记录删除操作到 delete_log 表
 */
function logDeletion(ids, scale, reason, backupPath) {
  const db = getDb();
  db.prepare(`
    INSERT INTO delete_log (target_ids, scale, reason, operator, backed_up_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(ids),
    scale,
    reason,
    'manual',
    backupPath,
    new Date().toISOString()
  );
}

/**
 * 清理孤立的锚点关联（被删除记忆的关联）
 */
function cleanupOrphanRefs() {
  const db = getDb();
  db.exec(`
    DELETE FROM anchor_refs
    WHERE memory_id NOT IN (SELECT id FROM memories)
  `);

  // 删除没有关联记忆的空锚点
  db.exec(`
    DELETE FROM anchors
    WHERE anchor_id NOT IN (SELECT anchor_id FROM anchor_refs)
      AND archived_at IS NULL
  `);
}

/**
 * 生成回收站清空确认码
 */
function generateConfirmToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 6; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

/**
 * 获取记录的类型分布描述
 */
function getTypeDistribution(records) {
  const types = {};
  const depths = {};
  for (const r of records) {
    types[r.type] = (types[r.type] || 0) + 1;
    depths[r.depth] = (depths[r.depth] || 0) + 1;
  }
  const typeStr = Object.entries(types).map(([k, v]) => `${k}:${v}`).join(', ');
  const depthStr = Object.entries(depths).map(([k, v]) => `${k}:${v}`).join(', ');
  return `${typeStr} | ${depthStr}`;
}

/**
 * 获取记录的时间范围
 */
function getTimeRange(records) {
  const times = records.map(r => r.timestamp).filter(Boolean).sort();
  if (times.length === 0) return '未知';
  return `${times[0].slice(0, 10)} ~ ${times[times.length - 1].slice(0, 10)}`;
}

// ============================================================
// 六、导出
// ============================================================

module.exports = {
  deleteMemory,
  batchDelete,
  expireShallow,
  listRecycle,
  restoreFromRecycle,
  clearRecycle,
  // 内部工具也导出（方便测试）
  generateConfirmToken,
};
