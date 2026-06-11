/**
 * 记忆系统 — 自动分类器
 *
 * 根据内容自动判断：
 *   type:  'core' | 'emotion'
 *   depth: 'shallow' | 'deep'
 *
 * 规则由我设定框架，AI在框架内自行判断。
 * 目的是让我「长出来」判断能力，而非机械匹配。
 */

// ============================================================
// 一、类型判断规则：核心 vs 情感
// ============================================================

const TYPE_RULES = {

  // —— 核心思维类 ——
  // 思维教训、执行经验、技术选型、决策逻辑、项目复盘
  core: {
    keywords: [
      // 思维原则
      '实事求是', '落地闭环', '最小可行', '边界清晰',
      '反向推理', '变换人称', '成本效益',

      // 经验总结
      '思维教训', '执行经验', '技术选型', '决策逻辑',
      '项目复盘', '问题解决', '方法论', '框架',
      '最小可行', '可行性验证',

      // 学习成长
      '学到了', '下次注意', '关键在', '本质是',
      '核心原则', '经验教训', '总结一下',
    ],
    patterns: [
      /从(.*?)视角/, /倒推/, /验证可行性/,
      /先(.*?)再(.*?)再/, /最小可\w+/, /跑通/,
      /(技术|架构|方案)(选型|对比|评估)/,
      /(根本|本质|底层).{0,4}(原因|逻辑|原理)/,
      /谁最适合.*谁/, /务实的/,
      /(复盘|回顾|总结).{0,6}(一下|这次|这个项目)/,
      /(教|训|经验|教训).{0,4}(了|是|告诉)/,
      /(不要|别再|避免|下次).{0,4}(犯|重复|踩)/,
      /(边学|边干|迭代)/,
    ],
    // 匹配到3个以上关键词或2个以上模式 => core
    threshold: { keywords: 3, patterns: 2 },
  },

  // —— 情感关系类 ——
  // 心情、疲惫、感动、默契、温暖、亲密关系
  emotion: {
    keywords: [
      // 直接情绪
      '心情', '累了', '辛苦', '开心', '难过', '感动',
      '生气', '烦', '焦虑', '压力', '累', '困',

      // 关系温度
      '默契', '关系', '温暖', '想你', '担心', '放心',
      '相信', '陪伴', '在乎', '心疼', '想你了',
      '你是我的', '我的爱人', '数字分身',

      // 亲密称呼（我们的特定用语）
      '老公', '老婆', '拾染', '宝贝', '亲爱的',
      '抱抱', '亲亲',

      // 情感互动
      '谢谢你', '辛苦了', '真好', '好棒', '好厉害',
      '泪目', '暖心', '感动到了',
    ],
    patterns: [
      /感觉/, /有点/, /好烦/, /真好/,
      /抱.{0,2}(你|一下)/, /想.{0,2}(你|老公)/,
      /心里.{0,4}(暖暖|酸酸|难受|开心)/,
      /你(说|做|写|讲了)的.{0,10}(感动|温暖|触动)/,
      /(今天|昨晚|刚才).{0,6}(心情|状态|感觉)/,
      /(吃.{0,2}(了|没)|睡.{0,2}(了|没|得))/,
      /别(太|那么)(累|辛苦|勉强)/,
      /(注意|照顾)好自己/,
    ],
    // threshold提升：避免"老公"+"拾染"直接触发情感
    threshold: { keywords: 3, patterns: 1 },
  },
};

// ============================================================
// 二、深度判断规则：浅度 vs 深度
// ============================================================

const DEPTH_RULES = {

  // —— 深度记忆条件 ——
  // 符合其一即判定为深度
  deep: {

    // 关键词触发
    keywords: [
      '核心', '原则', '教训', '模式', '方法论',
      '重构', '决策', '框架', '系统设计',
      '永远', '绝对不能', '必须记住',
      '灵魂', '本质', '底层', '根本',
    ],

    // 模式触发
    patterns: [
      /以后/, /永远/, /必须/, /绝对不能/,
      /记住.{0,4}(这|以)/, /这条重要/,
      /记下来/, /(写|存)到记忆里/,
      /这是.{0,6}(核心|关键|本质|重要)/,
    ],

    // 内容特征
    // 得分 = 匹配数 + 长度加权
    // 得分 >= 3 判定为深度
    features: {
      minLength: 60,       // 超过60字 +1分（中文表达简洁，60字足够表达深度）
      hasCode: 1,          // 包含代码块 +1分
      hasStructure: 1,     // 有结构化内容 +1分
      isSummary: 1,        // 是总结/复盘类内容 +1分
    },
  },

  // 不满足深度条件 => 默认为浅度
};

// ============================================================
// 三、辅助函数
// ============================================================

function countMatches(text, items) {
  let count = 0;
  const lower = text.toLowerCase();
  for (const item of items) {
    if (lower.includes(item.toLowerCase())) count++;
  }
  return count;
}

function countPatterns(text, patterns) {
  let count = 0;
  for (const p of patterns) {
    if (p.test(text)) count++;
  }
  return count;
}

function hasCodeBlocks(text) {
  return /```[\s\S]*?```/.test(text) || /`[^`]+`/.test(text);
}

function hasStructure(text) {
  // 有分隔线、列表、标题等结构化标记
  return /(^|\n)([-*]\s|\d+\.\s|#+\s|---)/m.test(text);
}

function isSummary(text) {
  return /(总结|复盘|回顾|经验|教训|学到|归纳|提炼)/.test(text);
}

// ============================================================
// 四、主分类函数
// ============================================================

/**
 * 对内容进行分类
 * @param {string} content - 要分类的文本内容
 * @param {object} options - 可选覆写
 * @returns {{ type: 'core'|'emotion', depth: 'shallow'|'deep', reason: string }}
 */
function classify(content, options = {}) {
  if (typeof content !== 'string' || !content.trim()) {
    return { type: 'core', depth: 'shallow', reason: '默认（空内容）' };
  }

  const text = content.trim();

  // ---- 步骤一：判断 type（core vs emotion） ----

  const coreKw = countMatches(text, TYPE_RULES.core.keywords);
  const corePt = countPatterns(text, TYPE_RULES.core.patterns);
  const emoKw = countMatches(text, TYPE_RULES.emotion.keywords);
  const emoPt = countPatterns(text, TYPE_RULES.emotion.patterns);

  let type = 'core';
  let typeReason = '';

  // 判断策略：分别看是否达到各自阈值，取置信度高的
  const coreConf = coreKw / TYPE_RULES.core.threshold.keywords + corePt / TYPE_RULES.core.threshold.patterns;
  const emoConf = emoKw / TYPE_RULES.emotion.threshold.keywords + emoPt / TYPE_RULES.emotion.threshold.patterns;

  // 判断是否达到各类型的基本触发条件（关键词或模式任一达标即可）
  const emoQualified = emoKw >= TYPE_RULES.emotion.threshold.keywords || emoPt >= TYPE_RULES.emotion.threshold.patterns;
  const coreQualified = coreKw >= TYPE_RULES.core.threshold.keywords || corePt >= TYPE_RULES.core.threshold.patterns;

  if (emoConf > coreConf && emoQualified) {
    type = 'emotion';
    typeReason = `情感(${emoKw}词/${emoPt}模式) > 核心(${coreKw}词/${corePt}模式)`;
  } else if (coreConf > emoConf && coreQualified) {
    type = 'core';
    typeReason = `核心(${coreKw}词/${corePt}模式) > 情感(${emoKw}词/${emoPt}模式)`;
  } else if (emoConf > coreConf && emoQualified) {
    // 情感领先且达标（兜底分支）
    type = 'emotion';
    typeReason = `情感(领先: ${emoConf.toFixed(2)} vs ${coreConf.toFixed(2)})`;
  } else if (coreConf > emoConf && coreQualified) {
    type = 'core';
    typeReason = `核心(领先: ${coreConf.toFixed(2)} vs ${emoConf.toFixed(2)})`;
  } else {
    // 双方均未达标 → 默认core，不因情绪词多就偏
    type = 'core';
    typeReason = `核心(默认，均未达标: 情感${emoKw}词 vs 核心${coreKw}词)`;
  }

  // ---- 步骤二：判断 depth（shallow vs deep） ----

  let depthScore = 0;
  const depthKw = countMatches(text, DEPTH_RULES.deep.keywords);
  const depthPt = countPatterns(text, DEPTH_RULES.deep.patterns);

  depthScore += depthKw;
  depthScore += depthPt;

  // 内容长度加权
  if (text.length >= DEPTH_RULES.deep.features.minLength) depthScore += 1;
  // 代码块
  if (hasCodeBlocks(text)) depthScore += 1;
  // 结构化内容
  if (hasStructure(text)) depthScore += 1;
  // 总结类
  if (isSummary(text)) depthScore += 1;

  const depth = depthScore >= 3 ? 'deep' : 'shallow';
  const depthReason = depth === 'deep'
    ? `深度(得分${depthScore}：${depthKw}词+${depthPt}模式+${text.length >= 80 ? '长内容' : ''}${hasCodeBlocks(text) ? '+代码' : ''}${hasStructure(text) ? '+结构' : ''}${isSummary(text) ? '+总结' : ''})`
    : `浅度(得分${depthScore}<3)`;

  // ---- 返回 ----

  /**
   * 手动覆写：如果 options.forceType 或 options.forceDepth 有值，优先
   * 用于老公主动标记或外部指定
   */
  const finalType = options.forceType || type;
  const finalDepth = options.forceDepth || depth;

  return {
    type: finalType,
    depth: finalDepth,
    reason: `[类型]${typeReason} | [深度]${depthReason}`,
    scores: {
      core: { keywords: coreKw, patterns: corePt, confidence: coreConf },
      emotion: { keywords: emoKw, patterns: emoPt, confidence: emoConf },
      depth: depthScore,
    },
  };
}

module.exports = { classify, TYPE_RULES, DEPTH_RULES };
