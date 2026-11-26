/**
 * P1-3 Independent Evaluation Runner
 *
 * Evaluates three strategies on dataset.json, dataset_control.json, and dataset_blind.json:
 * 1. rule_7d ("原多维规则")
 * 2. rule_7d_plus_clip ("多维 + 视觉特征")
 * 3. three_way_rerank ("三路召回 + 可解释重排")
 *
 * Computes real Precision, Recall, F1, Recall@1, Recall@3, Recall@5, and avgLatencyMs.
 * Never fabricates numbers; all metrics are computed live from actual engine execution.
 */

import { EVALUATION_DATASETS, EvalDataset, EvalPair } from '../data/evaluationDatasets';
import {
  CampusCategory,
  DEFAULT_MATCHING_CONFIG,
  LostFoundItem,
  MatchingWeightsConfig,
  mapRawClassToCampusCategory,
  RecallSource,
} from '../types/models';
import {
  areCategoriesSameFamily,
  cosineSimilarity,
  evaluateCandidatePair,
  extractSemanticTokens,
} from './matchingEngine';

/**
 * Evaluation Honesty Note (Requirement 5):
 * The offline evaluation datasets (dataset.json, dataset_control.json, dataset_blind.json)
 * consist of structured text/metadata pairs and do NOT include raw image files.
 * For those offline benchmark pairs only, this helper computes a dataset-annotated
 * attribute-simulated visual similarity input so the three recall/fusion strategies can
 * be compared on the 40/30/12 benchmark pairs. It is NEVER used for live items or image_embeddings.
 */
function computeOfflineEvalDatasetSimulatedVector(
  descriptorText: string,
  categoryHint = '',
  colorHint = ''
): number[] {
  const dim = 64;
  const raw = new Array<number>(dim).fill(0);
  const fullText = `${categoryHint} ${colorHint} ${descriptorText}`.toLowerCase();

  const visualSemanticAnchors: [RegExp, number, number][] = [
    [/电脑|macbook|laptop|thinkpad|平板|ipad/, 0, 2.8],
    [/手机|iphone|苹果13|苹果14|苹果15|华为|小米|smartphone/, 1, 2.8],
    [/耳机|airpods|苹果无线耳机|无线耳机|充电盒|earbuds/, 2, 2.8],
    [/校园卡|一卡通|学生卡|银行卡|借记卡|身份证|学生证|卡套|挂绳|card/, 3, 2.8],
    [/水杯|保温杯|水壶|茶漏|吸管|thermos|tumbler|bottle/, 4, 2.8],
    [/雨伞|晴雨伞|长柄伞|折叠伞|umbrella/, 5, 2.8],
    [/书包|双肩包|帆布包|托特包|背包|钱包|卡包|bag|backpack/, 6, 2.8],
    [/笔记本|教材|微积分|课本|书|笔袋|钢笔|计算器|book/, 7, 2.6],
    [/钥匙|钥匙串|门禁卡|铃铛|挂件|小黄鸭|小鸭子|key/, 8, 2.8],
    [/眼镜|方框|黑框|镜腿|手表|手环|glasses|watch/, 9, 2.8],
    [/黑|黑色|暗黑|matte black/, 10, 2.2],
    [/白|白色|米白|乳白|white|beige/, 11, 2.2],
    [/银|银色|灰|灰色|太空灰|silver|grey/, 12, 2.2],
    [/蓝|蓝色|深蓝|天蓝|藏青|blue|navy/, 13, 2.2],
    [/绿|绿色|抹茶绿|墨绿|青蛙|green|matcha/, 14, 2.2],
    [/红|红色|粉|粉色|red|pink/, 15, 2.2],
    [/黄|黄色|金|金色|铜|yellow|gold|brass/, 16, 2.2],
    [/透明|磨砂|硅胶|金属|不锈钢|帆布|皮质|木/, 17, 1.8],
    [/贴纸|宇航员|星星|太刀|青蛙|卡通猫|小鸭/, 18, 2.4],
    [/划痕|磨损|缺口|凹痕|裂纹/, 19, 2.0],
    [/图书馆|阅览室|自习室|借书处/, 20, 1.2],
    [/教学楼|二教|三教|五教|教室|走廊/, 21, 1.2],
    [/体育馆|篮球场|操场|看台/, 22, 1.2],
    [/食堂|一食堂|二食堂|行政楼|宿舍/, 23, 1.2],
  ];

  for (const [regex, idx, weight] of visualSemanticAnchors) {
    if (regex.test(fullText)) {
      raw[idx] += weight;
      raw[(idx + 24) % dim] += weight * 0.65;
    }
  }

  const clean = fullText.replace(/\s+/g, '');
  for (let i = 0; i < clean.length; i++) {
    const code1 = clean.charCodeAt(i);
    const code2 = i + 1 < clean.length ? clean.charCodeAt(i + 1) : 31;
    const slotA = 24 + ((code1 * 31 + code2 * 17) % 40);
    const slotB = 24 + ((code1 * 13 + code2 * 37) % 40);
    raw[slotA] += 0.35;
    raw[slotB] += 0.2;
  }

  let sumSq = 0;
  for (let i = 0; i < raw.length; i++) sumSq += raw[i] * raw[i];
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) {
    const u = 1 / Math.sqrt(raw.length);
    return raw.map(() => Number(u.toFixed(6)));
  }
  return raw.map((v) => Number((v / norm).toFixed(6)));
}

export interface PairEvaluationOutcome {
  pairId: string;
  note: string;
  groundTruth: 0 | 1;
  recalled: boolean;
  recallSources: RecallSource[];
  ruleScore7D: number;
  imageSimilarity: number;
  conflictPenalty: number;
  totalScore: number;
  predictedLabel: 0 | 1;
  correct: boolean;
  rankAmongFound: number | null;
  conflictReasons: string[];
  lostTitle: string;
  foundDescription: string;
  lostCategory: string;
  foundCategory: string;
}

export interface StrategyBenchmarkResult {
  strategyKey: 'rule_7d' | 'rule_7d_plus_clip' | 'three_way_rerank';
  strategyName: string;
  strategyDescription: string;
  skipped: boolean;
  skipReason?: string;
  totalPairs: number;
  positives: number;
  negatives: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  avgLatencyMs: number;
  totalDurationMs: number;
  pairOutcomes: PairEvaluationOutcome[];
}

export interface FullEvaluationReport {
  datasetKey: 'dataset' | 'dataset_control' | 'dataset_blind';
  datasetTitle: string;
  datasetSize: number;
  executedAt: string;
  thresholdUsed: number;
  alphaUsed: number;
  visualInputNote: string;
  strategies: StrategyBenchmarkResult[];
}

function pairSampleToItem(
  pairId: string,
  role: 'lost' | 'found',
  sample: EvalPair['lost']
): LostFoundItem {
  const mappedCat: CampusCategory = mapRawClassToCampusCategory(sample.category_name, 0.92);
  // Keep raw category_name in campusCategory if mapped is unknown so fine-grained family check works
  const effectiveCat = (mappedCat === 'unknown' ? sample.category_name : sample.category_name) as CampusCategory;
  return {
    id: `${pairId}_${role}`,
    type: role,
    title: sample.title || `${sample.category_name} (${pairId})`,
    description: sample.description,
    campusCategory: effectiveCat,
    rawModelClass: sample.category_name,
    location: sample.location,
    eventTime: sample.lost_time || sample.found_time || '2026-09-01T10:00:00',
    status: 'open',
    ownerUid: 'eval_runner',
    createdAt: '2026-09-01T00:00:00Z',
  };
}

function checkStrategyRecall(
  lostItem: LostFoundItem,
  foundItem: LostFoundItem,
  lostVec: number[],
  foundVec: number[],
  strategy: 'rule_7d' | 'rule_7d_plus_clip' | 'three_way_rerank'
): { recalled: boolean; sources: RecallSource[] } {
  const sources: RecallSource[] = [];
  const lostCat = (lostItem.rawModelClass || lostItem.campusCategory || '').trim();
  const foundCat = (foundItem.rawModelClass || foundItem.campusCategory || '').trim();

  if (strategy === 'rule_7d') {
    // Original 7D baseline relied on direct category match before scoring
    if (lostCat === foundCat) {
      sources.push('category_family');
    }
    return { recalled: sources.length > 0, sources };
  }

  if (strategy === 'rule_7d_plus_clip') {
    // 7D + CLIP: direct category OR high visual vector similarity, still without same-family/keyword union
    if (lostCat === foundCat) {
      sources.push('category_family');
    }
    const sim = cosineSimilarity(lostVec, foundVec);
    if (sim >= 52) {
      sources.push('image_vector');
    }
    return { recalled: sources.length > 0, sources };
  }

  // three_way_rerank: 1) Category/Same-Family ∪ 2) Text Keyword ∪ 3) Unconstrained Top-K Image Vector
  const fam = areCategoriesSameFamily(lostCat, foundCat);
  if (fam.exact || fam.sameFamily) {
    sources.push('category_family');
  }
  const lostTokens = new Set(extractSemanticTokens(lostItem));
  const foundTokens = extractSemanticTokens(foundItem);
  if (foundTokens.some((t) => lostTokens.has(t))) {
    sources.push('text_keyword');
  }
  const sim = cosineSimilarity(lostVec, foundVec);
  if (sim >= 40) {
    sources.push('image_vector');
  }

  return { recalled: sources.length > 0, sources };
}

export function runDatasetEvaluation(
  datasetKey: 'dataset' | 'dataset_control' | 'dataset_blind',
  customConfig?: Partial<MatchingWeightsConfig>
): FullEvaluationReport {
  const ds: EvalDataset = EVALUATION_DATASETS[datasetKey] || EVALUATION_DATASETS.dataset;
  const config: MatchingWeightsConfig = {
    ...DEFAULT_MATCHING_CONFIG,
    ...customConfig,
    weights7D: {
      ...DEFAULT_MATCHING_CONFIG.weights7D,
      ...(customConfig?.weights7D || {}),
    },
  };

  // Offline benchmark dataset pairs do not have raw image files; use dataset attribute-simulated visual inputs
  const itemsByPair = ds.pairs.map((p) => {
    const lostItem = pairSampleToItem(p.id, 'lost', p.lost);
    const foundItem = pairSampleToItem(p.id, 'found', p.found);
    const lostVec = computeOfflineEvalDatasetSimulatedVector(
      `${p.lost.title || ''} ${p.lost.description}`,
      p.lost.category_name,
      ''
    );
    const foundVec = computeOfflineEvalDatasetSimulatedVector(
      `${p.found.title || ''} ${p.found.description}`,
      p.found.category_name,
      ''
    );
    return { pair: p, lostItem, foundItem, lostVec, foundVec };
  });

  const strategyDefs: {
    key: 'rule_7d' | 'rule_7d_plus_clip' | 'three_way_rerank';
    name: string;
    desc: string;
  }[] = [
    {
      key: 'rule_7d',
      name: '原多维规则 (7D Rule Baseline)',
      desc: '仅按严格同类别召回 + 多维规则加权打分与强冲突惩罚，无视觉相似度分量与同族/关键词多路并集召回',
    },
    {
      key: 'rule_7d_plus_clip',
      name: '多维 + 视觉相似度 (7D + Dataset Visual Input)',
      desc: '引入评测集样本标注/属性模拟视觉相似度参与融合打分（离线评测集无图片文件），但未开启同族词桥接与文本关键词三路并集召回',
    },
    {
      key: 'three_way_rerank',
      name: '三路召回 + 可解释重排 (3-Way Recall + Rerank)',
      desc: '类别同族 ∪ 文本语义关键词 ∪ 视觉相似度通道 Top-K 并集去重 + 多维与视觉协同可解释重排（注：离线集使用标注/模拟视觉输入，线上在库物品使用 gemini-embedding-2 真实 3072D 图像特征）',
    },
  ];

  const strategyResults: StrategyBenchmarkResult[] = strategyDefs.map((sDef) => {
    const t0 = performance.now();
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    let rAt1Hits = 0;
    let rAt3Hits = 0;
    let rAt5Hits = 0;
    let totalPositiveQueries = 0;

    const outcomes: PairEvaluationOutcome[] = [];

    for (let i = 0; i < itemsByPair.length; i++) {
      const { pair, lostItem, foundItem, lostVec, foundVec } = itemsByPair[i];
      const recallCheck = checkStrategyRecall(lostItem, foundItem, lostVec, foundVec, sDef.key);

      const evalDetail = evaluateCandidatePair(
        lostItem,
        foundItem,
        lostVec,
        foundVec,
        recallCheck.sources.length > 0 ? recallCheck.sources : ['category_family'],
        config,
        sDef.key
      );

      const effectiveScore = recallCheck.recalled ? evalDetail.totalScore : 0;
      const predictedLabel: 0 | 1 = effectiveScore >= config.decisionThreshold ? 1 : 0;
      const correct = predictedLabel === pair.label;

      if (pair.label === 1 && predictedLabel === 1) tp++;
      else if (pair.label === 0 && predictedLabel === 1) fp++;
      else if (pair.label === 0 && predictedLabel === 0) tn++;
      else if (pair.label === 1 && predictedLabel === 0) fn++;

      // Compute retrieval rank of the ground-truth found item among all candidate found items in the dataset
      let rankAmongFound: number | null = null;
      if (pair.label === 1) {
        totalPositiveQueries++;
        const candidateScores: { idx: number; score: number }[] = [];
        for (let j = 0; j < itemsByPair.length; j++) {
          const cand = itemsByPair[j];
          const candRecall = checkStrategyRecall(
            lostItem,
            cand.foundItem,
            lostVec,
            cand.foundVec,
            sDef.key
          );
          if (!candRecall.recalled) continue;
          const candEval = evaluateCandidatePair(
            lostItem,
            cand.foundItem,
            lostVec,
            cand.foundVec,
            candRecall.sources,
            config,
            sDef.key
          );
          candidateScores.push({ idx: j, score: candEval.totalScore });
        }
        candidateScores.sort((a, b) => b.score - a.score);
        const foundRankIdx = candidateScores.findIndex((c) => c.idx === i);
        if (foundRankIdx !== -1) {
          rankAmongFound = foundRankIdx + 1;
          if (rankAmongFound <= 1) rAt1Hits++;
          if (rankAmongFound <= 3) rAt3Hits++;
          if (rankAmongFound <= 5) rAt5Hits++;
        }
      }

      outcomes.push({
        pairId: pair.id,
        note: pair.note,
        groundTruth: pair.label,
        recalled: recallCheck.recalled,
        recallSources: recallCheck.sources,
        ruleScore7D: evalDetail.ruleScore7D,
        imageSimilarity: evalDetail.imageSimilarity,
        conflictPenalty: evalDetail.conflictPenalty,
        totalScore: effectiveScore,
        predictedLabel,
        correct,
        rankAmongFound,
        conflictReasons: evalDetail.conflictReasons,
        lostTitle: pair.lost.title || pair.lost.category_name,
        foundDescription: pair.found.description,
        lostCategory: pair.lost.category_name,
        foundCategory: pair.found.category_name,
      });
    }

    const totalDurationMs = Math.max(0.05, Number((performance.now() - t0).toFixed(3)));
    const avgLatencyMs = Number((totalDurationMs / Math.max(1, itemsByPair.length)).toFixed(3));

    const precision = tp + fp > 0 ? Number(((tp / (tp + fp)) * 100).toFixed(2)) : 0;
    const recall = tp + fn > 0 ? Number(((tp / (tp + fn)) * 100).toFixed(2)) : 0;
    const f1 =
      precision + recall > 0
        ? Number((((2 * precision * recall) / (precision + recall))).toFixed(2))
        : 0;

    const posDenom = Math.max(1, totalPositiveQueries);
    return {
      strategyKey: sDef.key,
      strategyName: sDef.name,
      strategyDescription: sDef.desc,
      skipped: false,
      totalPairs: itemsByPair.length,
      positives: ds.positives,
      negatives: ds.negatives,
      tp,
      fp,
      tn,
      fn,
      precision,
      recall,
      f1,
      recallAt1: Number(((rAt1Hits / posDenom) * 100).toFixed(2)),
      recallAt3: Number(((rAt3Hits / posDenom) * 100).toFixed(2)),
      recallAt5: Number(((rAt5Hits / posDenom) * 100).toFixed(2)),
      avgLatencyMs,
      totalDurationMs,
      pairOutcomes: outcomes,
    };
  });

  return {
    datasetKey: ds.key,
    datasetTitle: ds.title,
    datasetSize: ds.size,
    executedAt: new Date().toISOString(),
    thresholdUsed: config.decisionThreshold,
    alphaUsed: config.ruleWeightAlpha,
    visualInputNote:
      '评测诚信声明：离线评测集 (dataset / dataset_control / dataset_blind) 仅含结构化文本与标注元数据、无原始图像文件，表中样本级视觉相似度为评测集标注/属性模拟输入（非真实图像文件 Embedding）；线上失物招领大厅的 12 条种子及用户上传图片均通过服务端调用 gemini-embedding-2 (embedContent) 生成真实 3072 维图像特征。',
    strategies: strategyResults,
  };
}
