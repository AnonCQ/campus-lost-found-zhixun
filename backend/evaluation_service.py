"""
P1-3 Independent Evaluation Runner (Python Backend)
Evaluates three strategies on dataset.json (40 pairs), dataset_control.json (30 pairs),
and dataset_blind.json (12 pairs):
  1. rule_7d            ("原多维规则")
  2. rule_7d_plus_clip  ("多维 + 视觉特征")
  3. three_way_rerank   ("三路召回 + 可解释重排")
Computes Precision, Recall, F1, Recall@1, Recall@3, Recall@5, TP/FP/TN/FN, and avgLatencyMs.
"""

import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.config import DATA_DIR
from backend.constants import DEFAULT_MATCHING_CONFIG, map_raw_class_to_campus_category
from backend.matching_engine import (
    are_categories_same_family,
    cosine_similarity,
    evaluate_candidate_pair,
    extract_semantic_tokens,
)

EVAL_DATASETS_PATH = DATA_DIR / "evaluation_datasets.json"

_VISUAL_SEMANTIC_ANCHORS: List[Tuple[re.Pattern, int, float]] = [
    (re.compile(r"电脑|macbook|laptop|thinkpad|平板|ipad", re.I), 0, 2.8),
    (re.compile(r"手机|iphone|苹果13|苹果14|苹果15|华为|小米|smartphone", re.I), 1, 2.8),
    (re.compile(r"耳机|airpods|苹果无线耳机|无线耳机|充电盒|earbuds", re.I), 2, 2.8),
    (re.compile(r"校园卡|一卡通|学生卡|银行卡|借记卡|身份证|学生证|卡套|挂绳|card", re.I), 3, 2.8),
    (re.compile(r"水杯|保温杯|水壶|茶漏|吸管|thermos|tumbler|bottle", re.I), 4, 2.8),
    (re.compile(r"雨伞|晴雨伞|长柄伞|折叠伞|umbrella", re.I), 5, 2.8),
    (re.compile(r"书包|双肩包|帆布包|托特包|背包|钱包|卡包|bag|backpack", re.I), 6, 2.8),
    (re.compile(r"笔记本|教材|微积分|课本|书|笔袋|钢笔|计算器|book", re.I), 7, 2.6),
    (re.compile(r"钥匙|钥匙串|门禁卡|铃铛|挂件|小黄鸭|小鸭子|key", re.I), 8, 2.8),
    (re.compile(r"眼镜|方框|黑框|镜腿|手表|手环|glasses|watch", re.I), 9, 2.8),
    (re.compile(r"黑|黑色|暗黑|matte black", re.I), 10, 2.2),
    (re.compile(r"白|白色|米白|乳白|white|beige", re.I), 11, 2.2),
    (re.compile(r"银|银色|灰|灰色|太空灰|silver|grey", re.I), 12, 2.2),
    (re.compile(r"蓝|蓝色|深蓝|天蓝|藏青|blue|navy", re.I), 13, 2.2),
    (re.compile(r"绿|绿色|抹茶绿|墨绿|青蛙|green|matcha", re.I), 14, 2.2),
    (re.compile(r"红|红色|粉|粉色|red|pink", re.I), 15, 2.2),
    (re.compile(r"黄|黄色|金|金色|铜|yellow|gold|brass", re.I), 16, 2.2),
    (re.compile(r"透明|磨砂|硅胶|金属|不锈钢|帆布|皮质|木", re.I), 17, 1.8),
    (re.compile(r"贴纸|宇航员|星星|太刀|青蛙|卡通猫|小鸭", re.I), 18, 2.4),
    (re.compile(r"划痕|磨损|缺口|凹痕|裂纹", re.I), 19, 2.0),
    (re.compile(r"图书馆|阅览室|自习室|借书处", re.I), 20, 1.2),
    (re.compile(r"教学楼|二教|三教|五教|教室|走廊", re.I), 21, 1.2),
    (re.compile(r"体育馆|篮球场|操场|看台", re.I), 22, 1.2),
    (re.compile(r"食堂|一食堂|二食堂|行政楼|宿舍", re.I), 23, 1.2),
]

_cached_datasets: Optional[Dict[str, Any]] = None


def load_evaluation_datasets() -> Dict[str, Any]:
    global _cached_datasets
    if _cached_datasets is not None:
        return _cached_datasets
    if not EVAL_DATASETS_PATH.exists():
        raise FileNotFoundError(f"Offline evaluation dataset JSON not found: {EVAL_DATASETS_PATH}")
    _cached_datasets = json.loads(EVAL_DATASETS_PATH.read_text(encoding="utf-8"))
    return _cached_datasets


def _compute_offline_simulated_vector(descriptor_text: str, category_hint: str = "") -> List[float]:
    dim = 64
    raw = [0.0] * dim
    full_text = f"{category_hint} {descriptor_text}".lower()
    for regex, idx, weight in _VISUAL_SEMANTIC_ANCHORS:
        if regex.search(full_text):
            raw[idx] += weight
            raw[(idx + 24) % dim] += weight * 0.65

    clean = re.sub(r"\s+", "", full_text)
    for i, ch in enumerate(clean):
        c1 = ord(ch)
        c2 = ord(clean[i + 1]) if i + 1 < len(clean) else 31
        raw[24 + ((c1 * 31 + c2 * 17) % 40)] += 0.35
        raw[24 + ((c1 * 13 + c2 * 37) % 40)] += 0.2

    norm = math.sqrt(sum(v * v for v in raw))
    if norm < 1e-12:
        u = 1.0 / math.sqrt(dim)
        return [round(u, 6)] * dim
    return [round(v / norm, 6) for v in raw]


def _pair_sample_to_item(pair_id: str, role: str, sample: Dict[str, Any]) -> Dict[str, Any]:
    _ = map_raw_class_to_campus_category(sample.get("category_name"), 0.92)
    return {
        "id": f"{pair_id}_{role}",
        "type": role,
        "title": sample.get("title") or f"{sample.get('category_name', '')} ({pair_id})",
        "description": sample.get("description", ""),
        "campusCategory": sample.get("category_name", "unknown"),
        "rawModelClass": sample.get("category_name", "unknown"),
        "location": sample.get("location", ""),
        "eventTime": sample.get("lost_time") or sample.get("found_time") or "2026-09-01T10:00:00",
        "status": "open",
        "ownerUid": "eval_runner",
        "createdAt": "2026-09-01T00:00:00Z",
    }


def _check_strategy_recall(
    lost_item: Dict[str, Any],
    found_item: Dict[str, Any],
    lost_vec: List[float],
    found_vec: List[float],
    strategy: str,
) -> Tuple[bool, List[str]]:
    sources: List[str] = []
    lost_cat = (lost_item.get("rawModelClass") or lost_item.get("campusCategory") or "").strip()
    found_cat = (found_item.get("rawModelClass") or found_item.get("campusCategory") or "").strip()

    if strategy == "rule_7d":
        if lost_cat == found_cat:
            sources.append("category_family")
        return len(sources) > 0, sources

    if strategy == "rule_7d_plus_clip":
        if lost_cat == found_cat:
            sources.append("category_family")
        if cosine_similarity(lost_vec, found_vec) >= 52.0:
            sources.append("image_vector")
        return len(sources) > 0, sources

    exact, same_fam = are_categories_same_family(lost_cat, found_cat)
    if exact or same_fam:
        sources.append("category_family")
    lost_tokens = set(extract_semantic_tokens(lost_item))
    found_tokens = extract_semantic_tokens(found_item)
    if any(t in lost_tokens for t in found_tokens):
        sources.append("text_keyword")
    if cosine_similarity(lost_vec, found_vec) >= 40.0:
        sources.append("image_vector")
    return len(sources) > 0, sources


def run_dataset_evaluation(
    dataset_key: str = "dataset",
    custom_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    datasets = load_evaluation_datasets()
    ds = datasets.get(dataset_key) or datasets["dataset"]

    cfg = {
        **DEFAULT_MATCHING_CONFIG,
        **(custom_config or {}),
        "weights7D": {
            **DEFAULT_MATCHING_CONFIG["weights7D"],
            **((custom_config or {}).get("weights7D") or {}),
        },
    }
    threshold = float(cfg["decisionThreshold"])
    alpha = float(cfg["ruleWeightAlpha"])

    items_by_pair = []
    for p in ds["pairs"]:
        lost_item = _pair_sample_to_item(p["id"], "lost", p["lost"])
        found_item = _pair_sample_to_item(p["id"], "found", p["found"])
        lost_vec = _compute_offline_simulated_vector(
            f"{p['lost'].get('title', '')} {p['lost'].get('description', '')}",
            p["lost"].get("category_name", ""),
        )
        found_vec = _compute_offline_simulated_vector(
            f"{p['found'].get('title', '')} {p['found'].get('description', '')}",
            p["found"].get("category_name", ""),
        )
        items_by_pair.append((p, lost_item, found_item, lost_vec, found_vec))

    strategy_defs = [
        (
            "rule_7d",
            "原多维规则 (7D Rule Baseline)",
            "仅按严格同类别召回 + 多维规则加权打分与强冲突惩罚，无视觉相似度分量与同族/关键词多路并集召回",
        ),
        (
            "rule_7d_plus_clip",
            "多维 + 视觉相似度 (7D + Visual Fusion)",
            "引入视觉相似度参与融合打分，但未开启同族词桥接与文本关键词三路并集召回",
        ),
        (
            "three_way_rerank",
            "三路召回 + 可解释重排 (3-Way Recall + Rerank)",
            "类别同族 ∪ 文本语义关键词 ∪ 视觉相似度通道 Top-K 并集去重 + 多维与视觉协同可解释重排（线上物品使用本地 GPU OpenCLIP ViT-B/32 512D 真实向量）",
        ),
    ]

    strategies_out = []
    for s_key, s_name, s_desc in strategy_defs:
        t0 = time.perf_counter()
        tp = fp = tn = fn = 0
        r1 = r3 = r5 = 0
        pos_queries = 0
        outcomes = []

        for i, (pair, lost_item, found_item, lost_vec, found_vec) in enumerate(items_by_pair):
            recalled, sources = _check_strategy_recall(
                lost_item, found_item, lost_vec, found_vec, s_key
            )
            ev = evaluate_candidate_pair(
                lost_item,
                found_item,
                lost_vec,
                found_vec,
                sources if sources else ["category_family"],
                cfg,
                s_key,
            )
            effective_score = ev["totalScore"] if recalled else 0.0
            pred = 1 if effective_score >= threshold else 0
            gt = int(pair["label"])
            if gt == 1 and pred == 1:
                tp += 1
            elif gt == 0 and pred == 1:
                fp += 1
            elif gt == 0 and pred == 0:
                tn += 1
            else:
                fn += 1

            rank_among_found: Optional[int] = None
            if gt == 1:
                pos_queries += 1
                cand_scores = []
                for j, (_, _, cand_found, _, cand_fvec) in enumerate(items_by_pair):
                    c_rec, c_src = _check_strategy_recall(
                        lost_item, cand_found, lost_vec, cand_fvec, s_key
                    )
                    if not c_rec:
                        continue
                    c_ev = evaluate_candidate_pair(
                        lost_item, cand_found, lost_vec, cand_fvec, c_src, cfg, s_key
                    )
                    cand_scores.append((j, c_ev["totalScore"]))
                cand_scores.sort(key=lambda x: x[1], reverse=True)
                for rank_idx, (orig_idx, _) in enumerate(cand_scores):
                    if orig_idx == i:
                        rank_among_found = rank_idx + 1
                        if rank_among_found <= 1:
                            r1 += 1
                        if rank_among_found <= 3:
                            r3 += 1
                        if rank_among_found <= 5:
                            r5 += 1
                        break

            outcomes.append(
                {
                    "pairId": pair["id"],
                    "note": pair.get("note", ""),
                    "groundTruth": gt,
                    "recalled": recalled,
                    "recallSources": sources,
                    "ruleScore7D": ev["ruleScore7D"],
                    "imageSimilarity": ev["imageSimilarity"],
                    "conflictPenalty": ev["conflictPenalty"],
                    "totalScore": effective_score,
                    "predictedLabel": pred,
                    "correct": pred == gt,
                    "rankAmongFound": rank_among_found,
                    "conflictReasons": ev["conflictReasons"],
                    "lostTitle": pair["lost"].get("title") or pair["lost"].get("category_name"),
                    "foundDescription": pair["found"].get("description", ""),
                    "lostCategory": pair["lost"].get("category_name", ""),
                    "foundCategory": pair["found"].get("category_name", ""),
                }
            )

        total_ms = max(0.05, round((time.perf_counter() - t0) * 1000.0, 3))
        avg_ms = round(total_ms / max(1, len(items_by_pair)), 3)
        precision = round((tp / (tp + fp)) * 100.0, 2) if (tp + fp) > 0 else 0.0
        recall = round((tp / (tp + fn)) * 100.0, 2) if (tp + fn) > 0 else 0.0
        f1 = (
            round((2.0 * precision * recall) / (precision + recall), 2)
            if (precision + recall) > 0
            else 0.0
        )
        denom = max(1, pos_queries)
        strategies_out.append(
            {
                "strategyKey": s_key,
                "strategyName": s_name,
                "strategyDescription": s_desc,
                "skipped": False,
                "totalPairs": len(items_by_pair),
                "positives": ds["positives"],
                "negatives": ds["negatives"],
                "tp": tp,
                "fp": fp,
                "tn": tn,
                "fn": fn,
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "recallAt1": round((r1 / denom) * 100.0, 2),
                "recallAt3": round((r3 / denom) * 100.0, 2),
                "recallAt5": round((r5 / denom) * 100.0, 2),
                "avgLatencyMs": avg_ms,
                "totalDurationMs": total_ms,
                "pairOutcomes": outcomes,
            }
        )

    return {
        "datasetKey": ds["key"],
        "datasetTitle": ds["title"],
        "datasetSize": ds["size"],
        "executedAt": datetime.now(timezone.utc).isoformat(),
        "thresholdUsed": threshold,
        "alphaUsed": alpha,
        "visualInputNote": (
            "评测说明：离线评测集 (dataset / dataset_control / dataset_blind) 为结构化文本与标注元数据（无原始图像文件），"
            "样本级视觉相似度由标注/属性向量计算；线上失物招领大厅的 16 条演示数据与用户上传图像均由本地 GPU 运行 "
            "Ultralytics YOLO26n + OpenCLIP ViT-B/32 生成真实 512 维图像特征向量。"
        ),
        "strategies": strategies_out,
    }
