/**
 * Multi-Way Recall + 7-Dimension Explainable Reranking Engine (P0-2 & P1-1)
 *
 * Implements:
 * 1. L2 vector normalization and cosine similarity over cached image_embeddings
 * 2. Three-way recall (Category/Family ∪ Text Keyword ∪ Unconstrained Top-K Image Vector)
 * 3. Seven-dimension rule scoring (Category, Color, Quantity, Location, Condition, Keywords, Time)
 * 4. Strong conflict penalties (Temporal inversion, Brand conflict, Color conflict, Quantity conflict)
 * 5. Deterministic match ID generation (match_${lostId}_${foundId})
 */

import {
  ALGORITHM_VERSION,
  CampusCategory,
  DEFAULT_MATCHING_CONFIG,
  ImageEmbedding,
  LostFoundItem,
  MatchingWeightsConfig,
  MatchRecord,
  MAX_VECTOR_CANDIDATES,
  RecallSource,
  SevenDimensionScores,
} from '../types/models';

export function getDeterministicMatchId(lostId: string, foundId: string): string {
  const cleanLost = lostId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanFound = foundId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `match_${cleanLost}_${cleanFound}`;
}

export function l2Normalize(vec: number[]): number[] {
  if (!vec || vec.length === 0) return [];
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) {
    const uniform = 1 / Math.sqrt(vec.length);
    return vec.map(() => Number(uniform.toFixed(8)));
  }
  return vec.map((v) => Number((v / norm).toFixed(8)));
}

export function rawCosineSimilarity(
  vecA: number[] | undefined,
  vecB: number[] | undefined
): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  const len = Math.min(vecA.length, vecB.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-12) return 0;
  return Number((dot / denom).toFixed(6));
}

export function cosineSimilarity(vecA: number[] | undefined, vecB: number[] | undefined): number {
  const rawCos = rawCosineSimilarity(vecA, vecB);
  // Map [0, 1] cosine into percentage [0, 100]
  return Math.max(0, Math.min(100, Number((Math.max(0, rawCos) * 100).toFixed(2))));
}

// Same-family category groups for P1-1 Multi-Way Recall
const CATEGORY_FAMILY_GROUPS: string[][] = [
  ['数码电子', '笔记本电脑', '手机', '耳机', '平板电脑', '充电宝', 'U盘', '鼠标', '数码产品'],
  ['证件卡类', '校园卡', '银行卡', '借记卡', '身份证', '学生证', '证件', '卡类'],
  ['水杯雨伞', '水杯', '保温杯', '雨伞', '晴雨伞', '水壶', '杯子'],
  ['箱包服饰', '书包', '双肩包', '帆布包', '托特包', '背包', '钱包', '卡包', '外套', '衣服'],
  ['图书文具', '笔记本', '纸质笔记本', '书籍', '教材', '课本', '文具', '笔袋', '钢笔', '计算器'],
  ['钥匙配饰', '钥匙', '钥匙串', '门禁卡', '眼镜', '手表', '手链', '耳机壳', '配饰'],
  ['运动生活', '篮球', '羽毛球拍', '网球拍', '乒乓球拍', '运动器材', '生活用品'],
];

export function areCategoriesSameFamily(catA: string, catB: string): { exact: boolean; sameFamily: boolean } {
  const a = (catA || '').trim();
  const b = (catB || '').trim();
  if (!a || !b) return { exact: false, sameFamily: false };
  if (a === b) return { exact: true, sameFamily: true };
  for (const group of CATEGORY_FAMILY_GROUPS) {
    const aIn = group.some((g) => a.includes(g) || g.includes(a));
    const bIn = group.some((g) => b.includes(g) || g.includes(b));
    if (aIn && bIn) {
      return { exact: false, sameFamily: true };
    }
  }
  return { exact: false, sameFamily: false };
}

const COLOR_GROUPS: { name: string; patterns: RegExp }[] = [
  { name: '黑色', patterns: /黑色|纯黑|暗黑|黑框|黑伞|黑皮|黑壳|(?<!水|墨)黑/ },
  { name: '白色', patterns: /白色|纯白|米白|乳白|白壳/ },
  { name: '银灰色', patterns: /银色|深空灰|太空灰|灰色|银灰|银白/ },
  { name: '蓝色', patterns: /蓝色|深蓝|天蓝|浅蓝|藏青|蓝卡/ },
  { name: '绿色', patterns: /绿色|抹茶绿|墨绿|浅绿|军绿|青色|绿卡/ },
  { name: '红色', patterns: /红色|大红|酒红|深红|红书包/ },
  { name: '粉色', patterns: /粉色|粉红|樱花粉/ },
  { name: '黄色', patterns: /黄色|金黄|金色|小黄鸭|黄色小鸭|铜色/ },
  { name: '紫色', patterns: /紫色|香芋紫|深紫/ },
  { name: '棕色', patterns: /棕色|褐色|卡其色|驼色/ },
];

export function extractColors(text: string): string[] {
  const found: string[] = [];
  for (const cg of COLOR_GROUPS) {
    if (cg.patterns.test(text)) {
      found.push(cg.name);
    }
  }
  return found;
}

const BRAND_GROUPS: { canonical: string; patterns: RegExp }[] = [
  { canonical: 'Apple', patterns: /apple|iphone|macbook|airpods|ipad|苹果/i },
  { canonical: 'Huawei', patterns: /huawei|matebook|freebuds|华为/i },
  { canonical: 'Xiaomi', patterns: /xiaomi|redmi|小米|红米/i },
  { canonical: 'Sony', patterns: /sony|索尼/i },
  { canonical: 'Lenovo', patterns: /lenovo|thinkpad|联想/i },
  { canonical: 'CCB', patterns: /建设银行|建行/i },
  { canonical: 'ICBC', patterns: /工商银行|工行/i },
  { canonical: 'ABC', patterns: /农业银行|农行/i },
  { canonical: 'BOC', patterns: /中国银行|中行/i },
  { canonical: 'CMB', patterns: /招商银行|招行/i },
];

export function extractBrands(text: string): string[] {
  const brands: string[] = [];
  for (const bg of BRAND_GROUPS) {
    if (bg.patterns.test(text)) {
      brands.push(bg.canonical);
    }
  }
  return brands;
}

export function extractQuantity(text: string, explicitQty?: number): number | null {
  if (typeof explicitQty === 'number' && explicitQty > 0) return explicitQty;
  const cnMap: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const matchArabic = text.match(/(\d+)\s*(个|把|张|部|台|本|串|副|只|支)/);
  if (matchArabic) return parseInt(matchArabic[1], 10);
  const matchCn = text.match(/([一二两三四五六])\s*(个|把|张|部|台|本|串|副|只|支|钥匙)/);
  if (matchCn && cnMap[matchCn[1]]) return cnMap[matchCn[1]];
  return null;
}

const CAMPUS_ZONES: { zone: string; patterns: RegExp }[] = [
  { zone: '图书馆', patterns: /图书馆|阅览室|自习室|借书处/ },
  { zone: '第一教学楼', patterns: /1号教学楼|第一教学楼|一教|1教/ },
  { zone: '第二教学楼', patterns: /2号教学楼|第二教学楼|二教|2教/ },
  { zone: '第三教学楼', patterns: /3号教学楼|第三教学楼|三教|3教/ },
  { zone: '第四教学楼', patterns: /4号教学楼|第四教学楼|四教|4教/ },
  { zone: '第五教学楼', patterns: /5号教学楼|第五教学楼|五教|5教/ },
  { zone: '体育馆', patterns: /体育馆|篮球场|羽毛球馆|室内球场/ },
  { zone: '操场', patterns: /操场|田径场|看台|足球场/ },
  { zone: '第一食堂', patterns: /第一食堂|一食堂|1食堂/ },
  { zone: '第二食堂', patterns: /第二食堂|二食堂|2食堂/ },
  { zone: '行政楼', patterns: /行政楼|办公楼|服务台/ },
  { zone: '宿舍区', patterns: /宿舍|公寓|竹园|松园|梅园/ },
];

export function evaluateLocationSimilarity(locA: string, locB: string): { score: number; conflict: boolean } {
  const a = (locA || '').trim();
  const b = (locB || '').trim();
  if (!a || !b) return { score: 60, conflict: false };
  if (a === b) return { score: 100, conflict: false };

  // Room / floor check (e.g., 201, 401, 三楼, 四楼, 3楼)
  const roomA = a.match(/([0-9]{3}|[一二三四五六1-6]楼)/)?.[1];
  const roomB = b.match(/([0-9]{3}|[一二三四五六1-6]楼)/)?.[1];

  // Normalize Chinese/Arabic floor strings so "3楼" and "三楼" match as the same floor
  const normRoom = (r?: string) =>
    r
      ? r
          .replace('一楼', '1楼')
          .replace('二楼', '2楼')
          .replace('三楼', '3楼')
          .replace('四楼', '4楼')
          .replace('五楼', '5楼')
          .replace('六楼', '6楼')
      : undefined;
  const nRoomA = normRoom(roomA);
  const nRoomB = normRoom(roomB);

  const zonesA = CAMPUS_ZONES.filter((z) => z.patterns.test(a)).map((z) => z.zone);
  const zonesB = CAMPUS_ZONES.filter((z) => z.patterns.test(b)).map((z) => z.zone);

  const sharedZone = zonesA.some((z) => zonesB.includes(z));
  if (sharedZone) {
    if (nRoomA && nRoomB) {
      return nRoomA === nRoomB ? { score: 100, conflict: false } : { score: 65, conflict: false };
    }
    return { score: 90, conflict: false };
  }

  // Also check structured "大体位置 · 详细位置" area prefix so any two items in the same
  // selectable area (e.g., 食堂, 实验楼, 校门口, 宿舍楼, 2号教学楼) are never treated as location-conflicting
  if (a.includes('·') || b.includes('·')) {
    const areaA = a.split('·')[0].trim();
    const areaB = b.split('·')[0].trim();
    if (areaA && areaB) {
      if (areaA === areaB) {
        if (nRoomA && nRoomB) {
          return nRoomA === nRoomB ? { score: 100, conflict: false } : { score: 65, conflict: false };
        }
        return { score: 90, conflict: false };
      }
      if (areaA !== '其他' && areaB !== '其他' && !sharedZone) {
        return { score: 20, conflict: true };
      }
    }
  }

  if (a.includes(b) || b.includes(a)) {
    return { score: 92, conflict: false };
  }

  // Check if both have explicit, completely different campus zones
  if (zonesA.length > 0 && zonesB.length > 0 && !sharedZone) {
    return { score: 20, conflict: true };
  }

  return { score: 45, conflict: false };
}

const DISTINCTIVE_FEATURE_TOKENS = [
  '太刀', '星星', '缺口', '微积分', '课表', '划痕', '星空', '透明壳', '透明手机壳',
  '茶漏', '小鸭子', '小黄鸭', '磨损', '方框', '卡通猫', '刺绣', '青蛙', '凹痕',
  '提绳', '吸管', '宇航员', '贴纸', '抹茶', '硅胶', '铜铃', '铃铛', '门禁',
  '挂绳', '卡套', '钢笔', '笔袋', '按钮开关', '长柄', '折叠',
];

export function extractSemanticTokens(item: {
  title?: string;
  description: string;
  campusCategory?: string;
  location?: string;
  color?: string;
  brand?: string;
  keywords?: string[];
}): string[] {
  const combined = `${item.title || ''} ${item.description || ''} ${item.campusCategory || ''} ${item.color || ''} ${item.brand || ''} ${(item.keywords || []).join(' ')}`.toLowerCase();
  const tokens = new Set<string>();

  for (const tok of DISTINCTIVE_FEATURE_TOKENS) {
    if (combined.includes(tok)) {
      tokens.add(tok);
    }
  }
  for (const b of extractBrands(combined)) {
    tokens.add(b.toLowerCase());
  }
  for (const c of extractColors(combined)) {
    tokens.add(c);
  }

  // Extract 2-character Chinese noun/feature bigrams after removing common stop words
  const cleaned = combined
    .replace(/捡到|丢了|丢失|拾获|一个|一把|一张|一部|一台|一本|一副|一串|今天|昨天|在|了|的|有|里|上|旁|边/g, ' ')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ');
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);
  for (const w of words) {
    if (/^[a-z0-9]+$/.test(w)) {
      tokens.add(w);
    } else {
      for (let i = 0; i <= w.length - 2; i++) {
        tokens.add(w.slice(i, i + 2));
      }
    }
  }
  return Array.from(tokens);
}

export interface DetailedMatchEvaluation {
  lostItemId: string;
  foundItemId: string;
  totalScore: number;
  ruleScore7D: number;
  imageSimilarity: number;
  conflictPenalty: number;
  dimensionScores: SevenDimensionScores;
  recallSources: RecallSource[];
  conflictReasons: string[];
  explanationSummary: string;
  algorithmVersion: string;
}

/**
 * Computes the 7-dimension breakdown, conflict penalties, and hybrid score for a (lost, found) pair.
 */
export function evaluateCandidatePair(
  lost: LostFoundItem,
  found: LostFoundItem,
  lostEmbedding: number[] | undefined,
  foundEmbedding: number[] | undefined,
  recallSources: RecallSource[] = ['category_family'],
  config: MatchingWeightsConfig = DEFAULT_MATCHING_CONFIG,
  strategy: 'rule_7d' | 'rule_7d_plus_clip' | 'three_way_rerank' = 'three_way_rerank'
): DetailedMatchEvaluation {
  const lostText = `${lost.title || ''} ${lost.description || ''} ${lost.color || ''} ${lost.brand || ''} ${lost.conditionText || ''}`;
  const foundText = `${found.title || ''} ${found.description || ''} ${found.color || ''} ${found.brand || ''} ${found.conditionText || ''}`;

  const conflictReasons: string[] = [];
  let conflictPenalty = 0;

  // 1. Category Dimension
  const lostEffCat = lost.manualCategoryOverride || lost.campusCategory || 'unknown';
  const foundEffCat = found.manualCategoryOverride || found.campusCategory || 'unknown';
  const catRel = areCategoriesSameFamily(lostEffCat, foundEffCat);

  // Ambiguity check: Paper notebook ("笔记本" with pages/calculus) vs Laptop ("笔记本电脑" / MacBook)
  const isPaperVsLaptopConflict =
    (/微积分|封皮|课表|纸质|几页/.test(lostText) && /macbook|电脑|14寸|内存|充电器/i.test(foundText)) ||
    (/微积分|封皮|课表|纸质|几页/.test(foundText) && /macbook|电脑|14寸|内存|充电器/i.test(lostText));

  let categoryScore = 0;
  if (isPaperVsLaptopConflict) {
    categoryScore = 10;
    conflictPenalty += 24;
    conflictReasons.push('核心物品属性冲突：纸质笔记本 vs 笔记本电脑');
  } else if (catRel.exact && lostEffCat !== 'unknown') {
    categoryScore = 100;
  } else if (catRel.sameFamily) {
    categoryScore = 86;
  } else if (lostEffCat === 'unknown' || foundEffCat === 'unknown') {
    categoryScore = 60;
  } else {
    categoryScore = 15;
    conflictPenalty += 18;
    conflictReasons.push(`类别跨族不符：${lostEffCat} vs ${foundEffCat}`);
  }

  // 2. Color Dimension
  const lostColors = extractColors(lostText);
  const foundColors = extractColors(foundText);
  let colorScore = 70;
  if (lostColors.length > 0 && foundColors.length > 0) {
    const sharedColor = lostColors.some((c) => foundColors.includes(c));
    if (sharedColor) {
      colorScore = 100;
    } else {
      colorScore = 0;
      conflictPenalty += 22;
      conflictReasons.push(`主色调冲突：失物[${lostColors.join('/')}] vs 拾物[${foundColors.join('/')}]`);
    }
  } else if (lostColors.length === 0 && foundColors.length === 0) {
    colorScore = 72;
  }

  // 3. Quantity Dimension
  const lostQty = extractQuantity(lostText, lost.quantity);
  const foundQty = extractQuantity(foundText, found.quantity);
  let quantityScore = 80;
  if (lostQty !== null && foundQty !== null) {
    if (lostQty === foundQty) {
      quantityScore = 100;
    } else {
      quantityScore = 15;
      conflictPenalty += 15;
      conflictReasons.push(`数量特征不符：失物(${lostQty}) vs 拾物(${foundQty})`);
    }
  }

  // 4. Location Dimension
  const locEval = evaluateLocationSimilarity(lost.location, found.location);
  const locationScore = locEval.score;
  if (locEval.conflict) {
    conflictPenalty += 12;
    conflictReasons.push(`校园区域跨度较大：${lost.location} vs ${found.location}`);
  }

  // 5. Condition / Status Feature Dimension
  let conditionScore = 75;
  const condFeatures = ['划痕', '磨损', '缺口', '凹痕', '贴纸', '全新', '九成新', '破损'];
  const lostConds = condFeatures.filter((f) => lostText.includes(f));
  const foundConds = condFeatures.filter((f) => foundText.includes(f));
  if (
    (lostText.includes('全新') && /严重磨损|破损|很旧/.test(foundText)) ||
    (foundText.includes('全新') && /严重磨损|破损|很旧/.test(lostText))
  ) {
    conditionScore = 15;
    conflictPenalty += 15;
    conflictReasons.push('成色状态矛盾：全新 vs 明显磨损/旧物');
  } else if (lostConds.length > 0 && foundConds.length > 0) {
    const sharedCond = lostConds.some((c) => foundConds.includes(c));
    conditionScore = sharedCond ? 100 : 55;
  }

  // 6. Keywords & Brand Semantic Dimension
  const lostBrands = extractBrands(lostText);
  const foundBrands = extractBrands(foundText);
  let brandBonus = 0;
  if (lostBrands.length > 0 && foundBrands.length > 0) {
    const sharedBrand = lostBrands.some((b) => foundBrands.includes(b));
    if (sharedBrand) {
      brandBonus = 18;
    } else {
      conflictPenalty += 28;
      conflictReasons.push(`品牌/发卡机构互斥：${lostBrands.join('/')} vs ${foundBrands.join('/')}`);
    }
  }

  const lostDistinctive = DISTINCTIVE_FEATURE_TOKENS.filter((t) => lostText.toLowerCase().includes(t));
  const foundDistinctive = DISTINCTIVE_FEATURE_TOKENS.filter((t) => foundText.toLowerCase().includes(t));
  const sharedDistinctive = lostDistinctive.filter((t) => foundDistinctive.includes(t));

  const lostTokens = extractSemanticTokens(lost);
  const foundTokens = new Set(extractSemanticTokens(found));
  let overlapCount = 0;
  for (const t of lostTokens) {
    if (foundTokens.has(t)) overlapCount++;
  }
  const unionSize = Math.max(1, new Set([...lostTokens, ...foundTokens]).size);
  const jaccard = overlapCount / unionSize;

  let keywordsScore = Math.min(
    100,
    Math.round(jaccard * 95 + sharedDistinctive.length * 22 + brandBonus)
  );
  if (sharedDistinctive.length >= 2) {
    keywordsScore = Math.max(keywordsScore, 92);
  }

  // 7. Time Dimension
  let timeScore = 75;
  const tLost = Date.parse(lost.eventTime);
  const tFound = Date.parse(found.eventTime);
  if (!Number.isNaN(tLost) && !Number.isNaN(tFound)) {
    const diffHours = (tFound - tLost) / (1000 * 3600);
    if (diffHours < -12) {
      // Found more than 12 hours before item was lost
      timeScore = 0;
      conflictPenalty += 25;
      conflictReasons.push(`时间逻辑倒挂：拾获时间早于丢失时间 ${Math.abs(Math.round(diffHours))} 小时`);
    } else if (diffHours >= -12 && diffHours <= 12) {
      timeScore = 100;
    } else if (diffHours <= 48) {
      timeScore = 88;
    } else if (diffHours <= 168) {
      timeScore = 68;
    } else {
      timeScore = 30;
      if (diffHours > 360) {
        conflictPenalty += 12;
        conflictReasons.push(`时间跨度过大：间隔超过 ${Math.round(diffHours / 24)} 天`);
      }
    }
  }

  const dimensionScores: SevenDimensionScores = {
    category: Number(categoryScore.toFixed(1)),
    color: Number(colorScore.toFixed(1)),
    quantity: Number(quantityScore.toFixed(1)),
    location: Number(locationScore.toFixed(1)),
    condition: Number(conditionScore.toFixed(1)),
    keywords: Number(keywordsScore.toFixed(1)),
    time: Number(timeScore.toFixed(1)),
  };

  const w = config.weights7D;
  const raw7D =
    dimensionScores.category * w.category +
    dimensionScores.color * w.color +
    dimensionScores.quantity * w.quantity +
    dimensionScores.location * w.location +
    dimensionScores.condition * w.condition +
    dimensionScores.keywords * w.keywords +
    dimensionScores.time * w.time;

  const ruleScore7D = Math.max(0, Math.min(100, Number(raw7D.toFixed(1))));

  const vecA = lostEmbedding && lostEmbedding.length > 0 ? lostEmbedding : undefined;
  const vecB = foundEmbedding && foundEmbedding.length > 0 ? foundEmbedding : undefined;

  const imageSimilarity = Number(cosineSimilarity(vecA, vecB).toFixed(1));

  let fusedScore = ruleScore7D;
  if (strategy === 'rule_7d') {
    fusedScore = ruleScore7D - conflictPenalty;
  } else {
    // Both rule_7d_plus_clip and three_way_rerank use the exact documented fusion formula:
    // total = alpha * ruleScore7D + (1 - alpha) * imageSimilarity - conflictPenalty
    // (three_way_rerank differs in its 3-way candidate recall set, without adding an undocumented boost)
    fusedScore =
      config.ruleWeightAlpha * ruleScore7D +
      (1 - config.ruleWeightAlpha) * imageSimilarity -
      conflictPenalty;
  }

  const totalScore = Math.max(0, Math.min(100, Number(fusedScore.toFixed(1))));

  const sourceLabels = recallSources.map((s) =>
    s === 'category_family' ? '类别同族召回' : s === 'text_keyword' ? '文本语义召回' : '视觉特征Top-K召回'
  );
  const explanationSummary =
    conflictReasons.length > 0
      ? `触发强冲突惩罚 (-${conflictPenalty}分)：${conflictReasons.join('；')}。召回通道：${sourceLabels.join(' + ')}。`
      : `多维规则得分 ${ruleScore7D}，图像特征余弦相似度 ${imageSimilarity}%，经 [${sourceLabels.join(' + ')}] 联合召回无冲突。`;

  return {
    lostItemId: lost.id,
    foundItemId: found.id,
    totalScore,
    ruleScore7D,
    imageSimilarity,
    conflictPenalty,
    dimensionScores,
    recallSources,
    conflictReasons,
    explanationSummary,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

export interface ThreeWayRecallResult {
  matches: DetailedMatchEvaluation[];
  vectorIndexReady: boolean;
  scannedEmbeddingCount: number;
  candidateCap: number;
  recallChannelCounts: {
    category_family: number;
    text_keyword: number;
    image_vector: number;
    union_deduped: number;
  };
}

/**
 * Executes P1-1 Three-Way Recall (Category/Family ∪ Text Keyword ∪ Image Vector Top-K)
 * and Explainable Reranking for a target item against opposite-type candidate items.
 * Delisted items are strictly excluded from being recalled or matched.
 */
export function executeThreeWayRecallAndRerank(
  targetItem: LostFoundItem,
  allOppositeItems: LostFoundItem[],
  embeddingsByItemId: Map<string, ImageEmbedding>,
  config: MatchingWeightsConfig = DEFAULT_MATCHING_CONFIG,
  strategy: 'rule_7d' | 'rule_7d_plus_clip' | 'three_way_rerank' = 'three_way_rerank'
): ThreeWayRecallResult {
  const activeOppositeItems =
    targetItem.status === 'delisted' || targetItem.status === 'returned'
      ? []
      : allOppositeItems.filter(
          (it) => it.status !== 'delisted' && it.status !== 'returned'
        );
  const recallMap = new Map<string, Set<RecallSource>>();
  const targetCat = targetItem.manualCategoryOverride || targetItem.campusCategory || 'unknown';
  const targetTokens = new Set(extractSemanticTokens(targetItem));

  let catCount = 0;
  let kwCount = 0;
  let vecCount = 0;

  // Channel 1: Category / Same-Family Recall
  for (const cand of activeOppositeItems) {
    const candCat = cand.manualCategoryOverride || cand.campusCategory || 'unknown';
    const rel = areCategoriesSameFamily(targetCat, candCat);
    if (rel.exact || rel.sameFamily) {
      if (!recallMap.has(cand.id)) recallMap.set(cand.id, new Set());
      recallMap.get(cand.id)!.add('category_family');
      catCount++;
    }
  }

  // Channel 2: Text Keyword Recall
  if (strategy === 'three_way_rerank' || strategy === 'rule_7d') {
    for (const cand of activeOppositeItems) {
      const candTokens = extractSemanticTokens(cand);
      const shared = candTokens.filter((t) => targetTokens.has(t));
      if (shared.length >= 1) {
        if (!recallMap.has(cand.id)) recallMap.set(cand.id, new Set());
        recallMap.get(cand.id)!.add('text_keyword');
        kwCount++;
      }
    }
  }

  // Channel 3: Real Image Vector Top-K Recall (Unconstrained by predicted category!)
  const targetEmb = embeddingsByItemId.get(targetItem.id)?.vector;

  // Respect explicit MAX_VECTOR_CANDIDATES cap (never silent unbounded full-table scan)
  const boundedCandidates = activeOppositeItems.slice(0, MAX_VECTOR_CANDIDATES);
  if (strategy !== 'rule_7d' && targetEmb && targetEmb.length > 0) {
    const scoredVectors = boundedCandidates
      .map((cand) => {
        const candEmb = embeddingsByItemId.get(cand.id)?.vector;
        return {
          item: cand,
          sim: cosineSimilarity(targetEmb, candEmb),
        };
      })
      .sort((a, b) => b.sim - a.sim)
      .slice(0, Math.max(config.topK, 6));

    for (const sv of scoredVectors) {
      if (sv.sim >= 35) {
        if (!recallMap.has(sv.item.id)) recallMap.set(sv.item.id, new Set());
        recallMap.get(sv.item.id)!.add('image_vector');
        vecCount++;
      }
    }
  }

  const candidateById = new Map(activeOppositeItems.map((it) => [it.id, it]));
  const evaluations: DetailedMatchEvaluation[] = [];

  for (const [candId, sourcesSet] of recallMap.entries()) {
    const cand = candidateById.get(candId);
    if (!cand) continue;
    const lost = targetItem.type === 'lost' ? targetItem : cand;
    const found = targetItem.type === 'found' ? targetItem : cand;
    const lostVec = embeddingsByItemId.get(lost.id)?.vector;
    const foundVec = embeddingsByItemId.get(found.id)?.vector;

    const evalRes = evaluateCandidatePair(
      lost,
      found,
      lostVec,
      foundVec,
      Array.from(sourcesSet),
      config,
      strategy
    );
    evaluations.push(evalRes);
  }

  evaluations.sort((a, b) => b.totalScore - a.totalScore);

  return {
    matches: evaluations,
    vectorIndexReady: true,
    scannedEmbeddingCount: boundedCandidates.length,
    candidateCap: MAX_VECTOR_CANDIDATES,
    recallChannelCounts: {
      category_family: catCount,
      text_keyword: kwCount,
      image_vector: vecCount,
      union_deduped: evaluations.length,
    },
  };
}
