/**
 * 记忆系统 — 写入管道
 *
 * 核心写入逻辑，自动完成：
 *   感知 → 分类 → 写入 → 锚点关联
 *
 * 当前阶段重点：核心·深度记忆的写入
 */

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { classify } = require('./classifier');

// ============================================================
// 零、内容过滤（是否值得写入记忆）
// ============================================================

/**
 * 判断一段内容是否值得写入记忆
 * 基于语义判断，而非硬编码关键词列表
 *
 * @param {string} content - 要写入的内容
 * @param {object} [options]
 * @param {boolean} [options.forceWrite] - 跳过过滤，强制写入
 * @returns {{ shouldWrite: boolean, reason: string }}
 */
function shouldWrite(content, options = {}) {
  if (options.forceWrite) {
    return { shouldWrite: true, reason: 'forceWrite' };
  }

  const text = content.trim();

  // 1. 空内容或极短（<30字）→ 跳过
  if (text.length < 30) {
    return { shouldWrite: false, reason: '内容过短(<30字)' };
  }

  // 2. 用分类器判断内容实质
  const classification = classify(text, {});
  const { type, depth, scores } = classification;

  // 如果分类器判定为 deep → 有实质信息，写入
  if (depth === 'deep') {
    return { shouldWrite: true, reason: '分类器判定为深度记忆' };
  }

  // 如果 core 或 emotion 置信度 >= 分类器默认阈值 → 有实质，写入
  const coreConf = scores.core.confidence || 0;
  const emoConf = scores.emotion.confidence || 0;
  const maxConf = Math.max(coreConf, emoConf);

  // 阈值逻辑（基于前向兼容测试调整）：
  // - classifier 关键词列表偏方法论类，纯技术描述可能不命中
  // - 长内容（>=40字）→ 有足够信息量，低阈值0.3即可放行
  // - 中等内容（20-39字）→ 中等阈值0.5
  // - classifier 关键词偏方法论，纯技术描述可能不命中
  // - 长内容（>=40字）→ 有足够信息量，低阈值0.3即可放行
  // - 其余（>=30字<40且能走到这）→ 中等阈值0.5
  let threshold;
  if (text.length >= 40) {
    threshold = 0.3;
  } else {
    threshold = 0.5;
  }

  if (maxConf >= threshold) {
    return { shouldWrite: true, reason: `有实质内容(最大置信度${maxConf.toFixed(2)}≥阈值${threshold}，长度${text.length})` };
  }

  // 3. 内容充分长（>=50字）且有信息量 → 兜底写入
  // classifier 关键词偏方法论，纯技术描述可能不命中
  // 此时内容本身的长度是信息量的可靠信号
  if (text.length >= 50) {
    return { shouldWrite: true, reason: `长内容兜底(长度${text.length}>=50，直接放行)` };
  }

  // 4. 其余情况 → 跳过
  return { shouldWrite: false, reason: `无实质内容(最大置信度${maxConf.toFixed(2)}<阈值${threshold}，长度${text.length})` };
}

// ============================================================
// 一、写入一条记忆
// ============================================================

/**
 * 写入一条记忆记录（自动分类 + 自动锚点关联 + 内容过滤）
 *
 * @param {object} input
 * @param {string} input.content         - 要记录的文本内容
 * @param {string} [input.summary]       - 可选：人工指定摘要
 * @param {string} [input.source]        - 'openclaw' | 'hermes' | 'manual'
 * @param {object} [input.options]       - 覆写选项 { forceType, forceDepth, forceWrite }
 * @param {boolean} [input.safetyLock]   - 是否加安全锁
 * @returns {{ record, classification, anchor, filtered }}
 */
function writeMemory(input) {
  const {
    content,
    summary: manualSummary,
    source = 'openclaw',
    options = {},
    safetyLock = false,
  } = input;

  if (!content || !content.trim()) {
    throw new Error('记忆内容不能为空');
  }

  // 0. 内容过滤：是否值得写入
  const filter = shouldWrite(content, options);
  if (!filter.shouldWrite) {
    console.error(`[memory] 🔇 过滤跳过: ${filter.reason}`);
    return {
      record: null,
      classification: null,
      anchor: null,
      filtered: true,
      filterReason: filter.reason,
    };
  }

  // 1. 分类
  const classification = classify(content, options);
  const { type, depth, reason } = classification;

  // 2. 生成摘要
  const summary = manualSummary || autoSummary(content, type, depth);

  // 3. 提取关键词
  const keywords = extractKeywords(content, type);

  // 4. 构造记录
  const now = new Date().toISOString();
  const record = {
    id: uuidv4(),
    type,
    depth,
    timestamp: now,
    expire_at: null,
    summary,
    detail: content,
    keywords: JSON.stringify(keywords),
    source,
    anchor_id: null,
    safety_lock: safetyLock ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  // 5. 写入数据库
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memories (id, type, depth, timestamp, expire_at, summary, detail, keywords, source, anchor_id, safety_lock, created_at, updated_at)
    VALUES (@id, @type, @depth, @timestamp, @expire_at, @summary, @detail, @keywords, @source, @anchor_id, @safety_lock, @created_at, @updated_at)
  `);
  stmt.run(record);

  // 6. 如果是深度记忆，自动关联/创建锚点
  let anchor = null;
  if (depth === 'deep') {
    anchor = ensureAnchor({ type, summary, keywords, memoryId: record.id });
    // 更新记忆的 anchor_id
    db.prepare('UPDATE memories SET anchor_id = ? WHERE id = ?').run(anchor.anchor_id, record.id);
    record.anchor_id = anchor.anchor_id;
  }

  console.error(`[memory] 已写入${depth}·${type}记忆: ${summary} | ${reason} | [过滤:${filter.reason}]`);

  return {
    record,
    classification: { type, depth, reason },
    anchor: anchor ? { id: anchor.anchor_id, summary: anchor.summary } : null,
    filtered: false,
  };
}

// ============================================================
// 二、锚点管理
// ============================================================

/**
 * 确保存在匹配的锚点，不存在则创建
 * 只查找同类型锚点
 */
function ensureAnchor({ type, summary, keywords, memoryId }) {
  const db = getDb();
  const now = new Date().toISOString();

  // 查找已有的同类型锚点（基于关键词重叠度）
  const existing = db.prepare(`
    SELECT * FROM anchors
    WHERE type = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(type);

  // 用关键词匹配找最相似的锚点
  let matchedAnchor = null;
  let bestScore = 0;

  for (const anchor of existing) {
    const anchorKws = JSON.parse(anchor.keywords || '[]');
    const overlap = keywords.filter(k => anchorKws.includes(k)).length;
    const score = overlap / Math.max(keywords.length, anchorKws.length);
    if (score > 0.4 && score > bestScore) {
      bestScore = score;
      matchedAnchor = anchor;
    }
  }

  if (matchedAnchor && !matchedAnchor.archived_at) {
    // 关联到已有锚点
    db.prepare(`
      INSERT OR IGNORE INTO anchor_refs (anchor_id, memory_id)
      VALUES (?, ?)
    `).run(matchedAnchor.anchor_id, memoryId);

    // 更新锚点的时间
    db.prepare('UPDATE anchors SET updated_at = ? WHERE anchor_id = ?').run(now, matchedAnchor.anchor_id);

    return matchedAnchor;
  }

  // 无匹配 → 创建新锚点
  const anchorId = uuidv4();
  db.prepare(`
    INSERT INTO anchors (anchor_id, type, summary, detail, keywords, locked, archived_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
  `).run(anchorId, type, summary, '', JSON.stringify(keywords), now, now);

  db.prepare(`
    INSERT INTO anchor_refs (anchor_id, memory_id)
    VALUES (?, ?)
  `).run(anchorId, memoryId);

  console.error(`[memory] 新建锚点: ${summary}`);

  return db.prepare('SELECT * FROM anchors WHERE anchor_id = ?').get(anchorId);
}

// ============================================================
// 三、辅助函数
// ============================================================

/**
 * 自动生成摘要：取内容的前两句话，不超过50字
 */
function autoSummary(content, type, depth) {
  // 先按句号、问号、感叹号、换行分割
  const sentences = content
    .replace(/\n+/g, '。')
    .split(/[。？！\n]+/)
    .filter(s => s.trim().length > 0);

  if (sentences.length === 0) return content.slice(0, 50);

  // 取第一句，如果太短则合并第二句
  let summary = sentences[0].trim();
  if (summary.length < 10 && sentences.length > 1) {
    summary += '。' + sentences[1].trim();
  }

  // 限制长度
  if (summary.length > 60) {
    summary = summary.slice(0, 57) + '...';
  }

  // 添加类型标签
  const tag = type === 'core' ? '💡' : '💗';
  return `${tag} ${summary}`;
}

/**
 * 提取关键词：取出现频次最高的有意义的词
 * 简单实现：取含2字以上、不在停用词表中的高频词
 */
function extractKeywords(text, type) {
  const stopWords = new Set([
    '可以', '一个', '这个', '那个', '什么', '怎么', '没有', '就是',
    '不是', '但是', '如果', '因为', '所以', '而且', '然后', '还是',
    '只是', '但是', '虽然', '不过', '或者', '还有', '已经', '时候',
    '我们', '你们', '他们', '自己', '这样', '那样', '知道', '觉得',
    '应该', '可能', '可以', '需要', '看到', '听到', '想到', '开始',
    '最后', '看到', '一些', '一个', '现在', '因为', '所以', '已经',
    '一下', '一直', '一样', '一起', '一点', '的话', '对吧', '好吧',
    '让', '把', '被', '跟', '在', '的', '了', '是', '有', '我', '你',
  ]);

  // 提取2~4字的词
  const words = [];
  const chars = text.replace(/[\s,，。.！？、；：""''（）()【】《》/\\|`~@#\$%\^&\*\+\-=\[\]{}<>]/g, '');
  
  for (let i = 0; i < chars.length - 1; i++) {
    // 2字词
    const w2 = chars.slice(i, i + 2);
    if (!stopWords.has(w2) && /^[\u4e00-\u9fff]{2}$/.test(w2)) words.push(w2);
    
    // 3字词
    if (i < chars.length - 2) {
      const w3 = chars.slice(i, i + 3);
      if (!stopWords.has(w3) && /^[\u4e00-\u9fff]{3}$/.test(w3)) words.push(w3);
    }
    
    // 4字词
    if (i < chars.length - 3) {
      const w4 = chars.slice(i, i + 4);
      if (!stopWords.has(w4) && /^[\u4e00-\u9fff]{4}$/.test(w4)) words.push(w4);
    }
  }

  // 统计词频
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  // 按频次排序取前8个
  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  // 去重（保留顺序）
  const unique = [...new Set(sorted)];
  return unique.slice(0, 5);
}

/**
 * 计算过期时间
 */
function expireTime(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ============================================================
// 四、导出
// ============================================================

module.exports = { writeMemory, autoSummary, extractKeywords, shouldWrite };
