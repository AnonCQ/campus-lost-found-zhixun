"""
Multi-Way Recall + 7-Dimension Explainable Reranking Engine (Python Backend)

Implements:
1. L2 vector normalization and cosine similarity over OpenCLIP ViT-B/32 512D embeddings
2. Three-way recall (Category/Family U Text Keyword U Unconstrained Top-K Image Vector)
3. Seven-dimension rule scoring (Category, Color, Quantity, Location, Condition, Keywords, Time)
4. Strong conflict penalties (Temporal inversion, Paper notebook vs Laptop, Brand conflict, Color conflict, Quantity conflict)
5. Deterministic match ID generation (match_${lostId}_${foundId})
"""

import math
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.constants import (
    ALGORITHM_VERSION,
    DEFAULT_MATCHING_CONFIG,
    MAX_VECTOR_CANDIDATES,
    get_deterministic_match_id,
)


def l2_normalize(vec: Sequence[float]) -> List[float]:
    if not vec:
        return []
    sum_sq = sum(float(v) * float(v) for v in vec)
    norm = math.sqrt(sum_sq)
    if norm < 1e-12:
        uniform = 1.0 / math.sqrt(len(vec))
        return [round(uniform, 8) for _ in vec]
    return [round(float(v) / norm, 8) for v in vec]


def raw_cosine_similarity(
    vec_a: Optional[Sequence[float]],
    vec_b: Optional[Sequence[float]],
) -> float:
    if not vec_a or not vec_b:
        return 0.0
    length = min(len(vec_a), len(vec_b))
    if length == 0:
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for i in range(length):
        a = float(vec_a[i])
        b = float(vec_b[i])
        dot += a * b
        norm_a += a * a
        norm_b += b * b
    denom = math.sqrt(norm_a) * math.sqrt(norm_b)
    if denom < 1e-12:
        return 0.0
    return round(dot / denom, 6)


def cosine_similarity(
    vec_a: Optional[Sequence[float]],
    vec_b: Optional[Sequence[float]],
) -> float:
    raw_cos = raw_cosine_similarity(vec_a, vec_b)
    return max(0.0, min(100.0, round(max(0.0, raw_cos) * 100.0, 2)))


CATEGORY_FAMILY_GROUPS: List[List[str]] = [
    ["数码电子", "笔记本电脑", "手机", "耳机", "平板电脑", "充电宝", "U盘", "鼠标", "数码产品"],
    ["证件卡类", "校园卡", "银行卡", "借记卡", "身份证", "学生证", "证件", "卡类"],
    ["水杯雨伞", "水杯", "保温杯", "雨伞", "晴雨伞", "水壶", "杯子"],
    ["箱包服饰", "书包", "双肩包", "帆布包", "托特包", "背包", "钱包", "卡包", "外套", "衣服"],
    ["图书文具", "笔记本", "纸质笔记本", "书籍", "教材", "课本", "文具", "笔袋", "钢笔", "计算器"],
    ["钥匙配饰", "钥匙", "钥匙串", "门禁卡", "眼镜", "手表", "手链", "耳机壳", "配饰"],
    ["运动生活", "篮球", "羽毛球拍", "网球拍", "乒乓球拍", "运动器材", "生活用品"],
]


def are_categories_same_family(cat_a: str, cat_b: str) -> Tuple[bool, bool]:
    a = (cat_a or "").strip()
    b = (cat_b or "").strip()
    if not a or not b:
        return False, False
    if a == b:
        return True, True
    for group in CATEGORY_FAMILY_GROUPS:
        a_in = any(g in a or a in g for g in group)
        b_in = any(g in b or b in g for g in group)
        if a_in and b_in:
            return False, True
    return False, False


COLOR_GROUPS: List[Tuple[str, re.Pattern]] = [
    ("黑色", re.compile(r"黑色|纯黑|暗黑|黑框|黑伞|黑皮|黑壳|(?<![水墨])黑")),
    ("白色", re.compile(r"白色|纯白|米白|乳白|白壳")),
    ("银灰色", re.compile(r"银色|深空灰|太空灰|灰色|银灰|银白")),
    ("蓝色", re.compile(r"蓝色|深蓝|天蓝|浅蓝|藏青|蓝卡")),
    ("绿色", re.compile(r"绿色|抹茶绿|墨绿|浅绿|军绿|青色|绿卡")),
    ("红色", re.compile(r"红色|大红|酒红|深红|红书包")),
    ("粉色", re.compile(r"粉色|粉红|樱花粉")),
    ("黄色", re.compile(r"黄色|金黄|金色|小黄鸭|黄色小鸭|铜色")),
    ("紫色", re.compile(r"紫色|香芋紫|深紫")),
    ("棕色", re.compile(r"棕色|褐色|卡其色|驼色")),
]


def extract_colors(text: str) -> List[str]:
    found: List[str] = []
    for name, pattern in COLOR_GROUPS:
        if pattern.search(text or ""):
            found.append(name)
    return found


BRAND_GROUPS: List[Tuple[str, re.Pattern]] = [
    ("Apple", re.compile(r"apple|iphone|macbook|airpods|ipad|苹果", re.I)),
    ("Huawei", re.compile(r"huawei|matebook|freebuds|华为", re.I)),
    ("Xiaomi", re.compile(r"xiaomi|redmi|小米|红米", re.I)),
    ("Sony", re.compile(r"sony|索尼", re.I)),
    ("Lenovo", re.compile(r"lenovo|thinkpad|联想", re.I)),
    ("CCB", re.compile(r"建设银行|建行", re.I)),
    ("ICBC", re.compile(r"工商银行|工行", re.I)),
    ("ABC", re.compile(r"农业银行|农行", re.I)),
    ("BOC", re.compile(r"中国银行|中行", re.I)),
    ("CMB", re.compile(r"招商银行|招行", re.I)),
]


def extract_brands(text: str) -> List[str]:
    brands: List[str] = []
    for canonical, pattern in BRAND_GROUPS:
        if pattern.search(text or ""):
            brands.append(canonical)
    return brands


def extract_quantity(text: str, explicit_qty: Optional[int] = None) -> Optional[int]:
    if isinstance(explicit_qty, int) and explicit_qty > 0:
        return explicit_qty
    cn_map = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6}
    m_ar = re.search(r"(\d+)\s*(个|把|张|部|台|本|串|副|只|支)", text or "")
    if m_ar:
        return int(m_ar.group(1))
    m_cn = re.search(r"([一二两三四五六])\s*(个|把|张|部|台|本|串|副|只|支|钥匙)", text or "")
    if m_cn and m_cn.group(1) in cn_map:
        return cn_map[m_cn.group(1)]
    return None


CAMPUS_ZONES: List[Tuple[str, re.Pattern]] = [
    ("图书馆", re.compile(r"图书馆|阅览室|自习室|借书处")),
    ("第一教学楼", re.compile(r"1号教学楼|第一教学楼|一教|1教")),
    ("第二教学楼", re.compile(r"2号教学楼|第二教学楼|二教|2教")),
    ("第三教学楼", re.compile(r"3号教学楼|第三教学楼|三教|3教")),
    ("第四教学楼", re.compile(r"4号教学楼|第四教学楼|四教|4教")),
    ("第五教学楼", re.compile(r"5号教学楼|第五教学楼|五教|5教")),
    ("体育馆", re.compile(r"体育馆|篮球场|羽毛球馆|室内球场")),
    ("操场", re.compile(r"操场|田径场|看台|足球场")),
    ("第一食堂", re.compile(r"第一食堂|一食堂|1食堂")),
    ("第二食堂", re.compile(r"第二食堂|二食堂|2食堂")),
    ("行政楼", re.compile(r"行政楼|办公楼|服务台")),
    ("宿舍区", re.compile(r"宿舍|公寓|竹园|松园|梅园")),
]


def _norm_room(r: Optional[str]) -> Optional[str]:
    if not r:
        return None
    return (
        r.replace("一楼", "1楼")
        .replace("二楼", "2楼")
        .replace("三楼", "3楼")
        .replace("四楼", "4楼")
        .replace("五楼", "5楼")
        .replace("六楼", "6楼")
    )


def evaluate_location_similarity(loc_a: str, loc_b: str) -> Tuple[float, bool]:
    a = (loc_a or "").strip()
    b = (loc_b or "").strip()
    if not a or not b:
        return 60.0, False
    if a == b:
        return 100.0, False

    m_a = re.search(r"([0-9]{3}|[一二三四五六1-6]楼)", a)
    m_b = re.search(r"([0-9]{3}|[一二三四五六1-6]楼)", b)
    n_room_a = _norm_room(m_a.group(1) if m_a else None)
    n_room_b = _norm_room(m_b.group(1) if m_b else None)

    zones_a = [z for z, p in CAMPUS_ZONES if p.search(a)]
    zones_b = [z for z, p in CAMPUS_ZONES if p.search(b)]
    shared_zone = any(z in zones_b for z in zones_a)

    if shared_zone:
        if n_room_a and n_room_b:
            return (100.0, False) if n_room_a == n_room_b else (65.0, False)
        return 90.0, False

    if "·" in a or "·" in b:
        area_a = a.split("·")[0].strip()
        area_b = b.split("·")[0].strip()
        if area_a and area_b:
            if area_a == area_b:
                if n_room_a and n_room_b:
                    return (100.0, False) if n_room_a == n_room_b else (65.0, False)
                return 90.0, False
            if area_a != "其他" and area_b != "其他" and not shared_zone:
                return 20.0, True

    if a in b or b in a:
        return 92.0, False

    if zones_a and zones_b and not shared_zone:
        return 20.0, True

    return 45.0, False


DISTINCTIVE_FEATURE_TOKENS: List[str] = [
    "太刀", "星星", "缺口", "微积分", "课表", "划痕", "星空", "透明壳", "透明手机壳",
    "茶漏", "小鸭子", "小黄鸭", "磨损", "方框", "卡通猫", "刺绣", "青蛙", "凹痕",
    "提绳", "吸管", "宇航员", "贴纸", "抹茶", "硅胶", "铜铃", "铃铛", "门禁",
    "挂绳", "卡套", "钢笔", "笔袋", "按钮开关", "长柄", "折叠",
]


def extract_semantic_tokens(item: Dict[str, Any]) -> List[str]:
    keywords_str = " ".join(item.get("keywords") or [])
    combined = (
        f"{item.get('title', '')} {item.get('description', '')} "
        f"{item.get('campusCategory', '')} {item.get('color', '')} "
        f"{item.get('brand', '')} {keywords_str}"
    ).lower()

    tokens = set()
    for tok in DISTINCTIVE_FEATURE_TOKENS:
        if tok in combined:
            tokens.add(tok)
    for b in extract_brands(combined):
        tokens.add(b.lower())
    for c in extract_colors(combined):
        tokens.add(c)

    cleaned = re.sub(
        r"捡到|丢了|丢失|拾获|一个|一把|一张|一部|一台|一本|一副|一串|今天|昨天|在|了|的|有|里|上|旁|边",
        " ",
        combined,
    )
    cleaned = re.sub(r"[^\u4e00-\u9fa5a-z0-9]", " ", cleaned)
    for w in cleaned.split():
        if len(w) < 2:
            continue
        if re.fullmatch(r"[a-z0-9]+", w):
            tokens.add(w)
        else:
            for i in range(len(w) - 1):
                tokens.add(w[i : i + 2])
    return list(tokens)


def _parse_iso_ts(val: Optional[str]) -> Optional[float]:
    if not val:
        return None
    s = str(val).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        return dt.timestamp()
    except Exception:
        try:
            dt = datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
            return dt.timestamp()
        except Exception:
            return None


def evaluate_candidate_pair(
    lost: Dict[str, Any],
    found: Dict[str, Any],
    lost_embedding: Optional[Sequence[float]],
    found_embedding: Optional[Sequence[float]],
    recall_sources: Optional[List[str]] = None,
    config: Optional[Dict[str, Any]] = None,
    strategy: str = "three_way_rerank",
) -> Dict[str, Any]:
    sources = recall_sources or ["category_family"]
    cfg = config or DEFAULT_MATCHING_CONFIG
    weights = cfg.get("weights7D", DEFAULT_MATCHING_CONFIG["weights7D"])
    alpha = float(cfg.get("ruleWeightAlpha", DEFAULT_MATCHING_CONFIG["ruleWeightAlpha"]))

    lost_text = (
        f"{lost.get('title', '')} {lost.get('description', '')} "
        f"{lost.get('color', '')} {lost.get('brand', '')} {lost.get('conditionText', '')}"
    )
    found_text = (
        f"{found.get('title', '')} {found.get('description', '')} "
        f"{found.get('color', '')} {found.get('brand', '')} {found.get('conditionText', '')}"
    )

    conflict_reasons: List[str] = []
    conflict_penalty = 0.0

    # 1. Category Dimension
    lost_eff_cat = lost.get("manualCategoryOverride") or lost.get("campusCategory") or "unknown"
    found_eff_cat = found.get("manualCategoryOverride") or found.get("campusCategory") or "unknown"
    exact_cat, same_fam = are_categories_same_family(lost_eff_cat, found_eff_cat)

    is_paper_vs_laptop = (
        bool(re.search(r"微积分|封皮|课表|纸质|几页", lost_text))
        and bool(re.search(r"macbook|电脑|14寸|内存|充电器", found_text, re.I))
    ) or (
        bool(re.search(r"微积分|封皮|课表|纸质|几页", found_text))
        and bool(re.search(r"macbook|电脑|14寸|内存|充电器", lost_text, re.I))
    )

    if is_paper_vs_laptop:
        category_score = 10.0
        conflict_penalty += 24.0
        conflict_reasons.append("核心物品属性冲突：纸质笔记本 vs 笔记本电脑")
    elif exact_cat and lost_eff_cat != "unknown":
        category_score = 100.0
    elif same_fam:
        category_score = 86.0
    elif lost_eff_cat == "unknown" or found_eff_cat == "unknown":
        category_score = 60.0
    else:
        category_score = 15.0
        conflict_penalty += 18.0
        conflict_reasons.append(f"类别跨族不符：{lost_eff_cat} vs {found_eff_cat}")

    # 2. Color Dimension
    lost_colors = extract_colors(lost_text)
    found_colors = extract_colors(found_text)
    color_score = 70.0
    if lost_colors and found_colors:
        if any(c in found_colors for c in lost_colors):
            color_score = 100.0
        else:
            color_score = 0.0
            conflict_penalty += 22.0
            conflict_reasons.append(
                f"主色调冲突：失物[{'/'.join(lost_colors)}] vs 拾物[{'/'.join(found_colors)}]"
            )
    elif not lost_colors and not found_colors:
        color_score = 72.0

    # 3. Quantity Dimension
    lost_qty = extract_quantity(lost_text, lost.get("quantity"))
    found_qty = extract_quantity(found_text, found.get("quantity"))
    quantity_score = 80.0
    if lost_qty is not None and found_qty is not None:
        if lost_qty == found_qty:
            quantity_score = 100.0
        else:
            quantity_score = 15.0
            conflict_penalty += 15.0
            conflict_reasons.append(f"数量特征不符：失物({lost_qty}) vs 拾物({found_qty})")

    # 4. Location Dimension
    location_score, loc_conflict = evaluate_location_similarity(
        lost.get("location", ""), found.get("location", "")
    )
    if loc_conflict:
        conflict_penalty += 12.0
        conflict_reasons.append(
            f"校园区域跨度较大：{lost.get('location', '')} vs {found.get('location', '')}"
        )

    # 5. Condition Dimension
    condition_score = 75.0
    cond_features = ["划痕", "磨损", "缺口", "凹痕", "贴纸", "全新", "九成新", "破损"]
    lost_conds = [f for f in cond_features if f in lost_text]
    found_conds = [f for f in cond_features if f in found_text]
    if ("全新" in lost_text and re.search(r"严重磨损|破损|很旧", found_text)) or (
        "全新" in found_text and re.search(r"严重磨损|破损|很旧", lost_text)
    ):
        condition_score = 15.0
        conflict_penalty += 15.0
        conflict_reasons.append("成色状态矛盾：全新 vs 明显磨损/旧物")
    elif lost_conds and found_conds:
        condition_score = 100.0 if any(c in found_conds for c in lost_conds) else 55.0

    # 6. Keywords & Brand Semantic Dimension
    lost_brands = extract_brands(lost_text)
    found_brands = extract_brands(found_text)
    brand_bonus = 0.0
    if lost_brands and found_brands:
        if any(b in found_brands for b in lost_brands):
            brand_bonus = 18.0
        else:
            conflict_penalty += 28.0
            conflict_reasons.append(
                f"品牌/发卡机构互斥：{'/'.join(lost_brands)} vs {'/'.join(found_brands)}"
            )

    lost_distinctive = [t for t in DISTINCTIVE_FEATURE_TOKENS if t in lost_text.lower()]
    found_distinctive = [t for t in DISTINCTIVE_FEATURE_TOKENS if t in found_text.lower()]
    shared_distinctive = [t for t in lost_distinctive if t in found_distinctive]

    lost_tokens = extract_semantic_tokens(lost)
    found_tokens = set(extract_semantic_tokens(found))
    overlap_count = sum(1 for t in lost_tokens if t in found_tokens)
    union_size = max(1, len(set(lost_tokens) | found_tokens))
    jaccard = overlap_count / union_size

    keywords_score = min(100.0, float(round(jaccard * 95 + len(shared_distinctive) * 22 + brand_bonus)))
    if len(shared_distinctive) >= 2:
        keywords_score = max(keywords_score, 92.0)

    # 7. Time Dimension
    time_score = 75.0
    t_lost = _parse_iso_ts(lost.get("eventTime"))
    t_found = _parse_iso_ts(found.get("eventTime"))
    if t_lost is not None and t_found is not None:
        diff_hours = (t_found - t_lost) / 3600.0
        if diff_hours < -12:
            time_score = 0.0
            conflict_penalty += 25.0
            conflict_reasons.append(
                f"时间逻辑倒挂：拾获时间早于丢失时间 {abs(round(diff_hours))} 小时"
            )
        elif diff_hours <= 12:
            time_score = 100.0
        elif diff_hours <= 48:
            time_score = 88.0
        elif diff_hours <= 168:
            time_score = 68.0
        else:
            time_score = 30.0
            if diff_hours > 360:
                conflict_penalty += 12.0
                conflict_reasons.append(f"时间跨度过大：间隔超过 {round(diff_hours / 24)} 天")

    dimension_scores = {
        "category": round(category_score, 1),
        "color": round(color_score, 1),
        "quantity": round(quantity_score, 1),
        "location": round(location_score, 1),
        "condition": round(condition_score, 1),
        "keywords": round(keywords_score, 1),
        "time": round(time_score, 1),
    }

    raw_7d = (
        dimension_scores["category"] * float(weights["category"])
        + dimension_scores["color"] * float(weights["color"])
        + dimension_scores["quantity"] * float(weights["quantity"])
        + dimension_scores["location"] * float(weights["location"])
        + dimension_scores["condition"] * float(weights["condition"])
        + dimension_scores["keywords"] * float(weights["keywords"])
        + dimension_scores["time"] * float(weights["time"])
    )
    rule_score_7d = max(0.0, min(100.0, round(raw_7d, 1)))

    image_similarity = round(cosine_similarity(lost_embedding, found_embedding), 1)

    if strategy == "rule_7d":
        fused = rule_score_7d - conflict_penalty
    else:
        fused = alpha * rule_score_7d + (1.0 - alpha) * image_similarity - conflict_penalty

    total_score = max(0.0, min(100.0, round(fused, 1)))

    label_map = {
        "category_family": "类别同族召回",
        "text_keyword": "文本语义召回",
        "image_vector": "视觉特征Top-K召回",
    }
    source_labels = [label_map.get(s, s) for s in sources]
    if conflict_reasons:
        explanation_summary = (
            f"触发强冲突惩罚 (-{int(conflict_penalty)}分)：{'；'.join(conflict_reasons)}。"
            f"召回通道：{' + '.join(source_labels)}。"
        )
    else:
        explanation_summary = (
            f"多维规则得分 {rule_score_7d}，OpenCLIP 视觉特征余弦相似度 {image_similarity}%，"
            f"经 [{' + '.join(source_labels)}] 联合召回无冲突。"
        )

    return {
        "lostItemId": lost["id"],
        "foundItemId": found["id"],
        "totalScore": total_score,
        "ruleScore7D": rule_score_7d,
        "imageSimilarity": image_similarity,
        "conflictPenalty": round(conflict_penalty, 1),
        "dimensionScores": dimension_scores,
        "recallSources": sources,
        "conflictReasons": conflict_reasons,
        "explanationSummary": explanation_summary,
        "algorithmVersion": ALGORITHM_VERSION,
    }


def execute_three_way_recall_and_rerank(
    target_item: Dict[str, Any],
    all_opposite_items: List[Dict[str, Any]],
    embeddings_by_item_id: Dict[str, List[float]],
    config: Optional[Dict[str, Any]] = None,
    strategy: str = "three_way_rerank",
) -> Dict[str, Any]:
    cfg = config or DEFAULT_MATCHING_CONFIG
    if target_item.get("status") in ("delisted", "returned"):
        active_opposite = []
    else:
        active_opposite = [
            it for it in all_opposite_items if it.get("status") not in ("delisted", "returned")
        ]

    recall_map: Dict[str, set] = {}
    target_cat = (
        target_item.get("manualCategoryOverride")
        or target_item.get("campusCategory")
        or "unknown"
    )
    target_tokens = set(extract_semantic_tokens(target_item))

    cat_count = 0
    kw_count = 0
    vec_count = 0

    # Channel 1: Category / Same-Family Recall
    for cand in active_opposite:
        cand_cat = cand.get("manualCategoryOverride") or cand.get("campusCategory") or "unknown"
        exact, same_fam = are_categories_same_family(target_cat, cand_cat)
        if exact or same_fam:
            recall_map.setdefault(cand["id"], set()).add("category_family")
            cat_count += 1

    # Channel 2: Text Keyword Recall
    if strategy in ("three_way_rerank", "rule_7d"):
        for cand in active_opposite:
            cand_tokens = extract_semantic_tokens(cand)
            if any(t in target_tokens for t in cand_tokens):
                recall_map.setdefault(cand["id"], set()).add("text_keyword")
                kw_count += 1

    # Channel 3: Real OpenCLIP Image Vector Top-K Recall (Unconstrained by category)
    target_emb = embeddings_by_item_id.get(target_item["id"])
    bounded = active_opposite[:MAX_VECTOR_CANDIDATES]
    if strategy != "rule_7d" and target_emb:
        scored = []
        for cand in bounded:
            cand_emb = embeddings_by_item_id.get(cand["id"])
            if cand_emb:
                sim = cosine_similarity(target_emb, cand_emb)
                scored.append((cand, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        top_k = max(int(cfg.get("topK", 5)), 6)
        for cand, sim in scored[:top_k]:
            if sim >= 35.0:
                recall_map.setdefault(cand["id"], set()).add("image_vector")
                vec_count += 1

    cand_by_id = {it["id"]: it for it in active_opposite}
    evaluations = []
    for cand_id, src_set in recall_map.items():
        cand = cand_by_id.get(cand_id)
        if not cand:
            continue
        lost = target_item if target_item["type"] == "lost" else cand
        found = target_item if target_item["type"] == "found" else cand
        ev = evaluate_candidate_pair(
            lost,
            found,
            embeddings_by_item_id.get(lost["id"]),
            embeddings_by_item_id.get(found["id"]),
            sorted(src_set),
            cfg,
            strategy,
        )
        evaluations.append(ev)

    evaluations.sort(key=lambda x: x["totalScore"], reverse=True)
    return {
        "matches": evaluations,
        "vectorIndexReady": True,
        "scannedEmbeddingCount": len(bounded),
        "candidateCap": MAX_VECTOR_CANDIDATES,
        "recallChannelCounts": {
            "category_family": cat_count,
            "text_keyword": kw_count,
            "image_vector": vec_count,
            "union_deduped": len(evaluations),
        },
    }
