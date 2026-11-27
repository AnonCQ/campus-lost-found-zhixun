"""
Campus Lost & Found Tool-Calling AI Agent Service

Supports:
1. OpenAI-Compatible Chat Completions with Function Calling (DeepSeek / Qwen / SiliconFlow / OpenAI / Ollama)
2. Google Gemini Native Function Calling (gemini-3.5-flash via google-genai)
3. Automatic Local Agentic Fallback (executes the exact same 5 SQLite/Matching tools offline)

Exposed Agent Tools:
- search_campus_items    : Semantic/keyword/category/location lookup over live SQLite items
- match_item_description : Runs 7D rule + semantic matching engine to find opposite-type leads
- draft_publish_form     : Extracts structured Lost/Found publish draft for 1-click form autofill
- get_user_status        : Queries current user's posts, claims, handover progress & wallet
- get_campus_stats       : Queries campus lost/found analytics, hotspots & YOLO/CLIP status
"""

import json
import re
import time
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from backend.ai_engine import ai_engine
from backend.config import (
    GEMINI_API_KEY,
    GEMINI_EXPLAIN_MODEL,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MODEL,
)
from backend.constants import (
    CAMPUS_CATEGORIES,
    DEFAULT_MATCHING_CONFIG,
    resolve_claim_role_actors,
)
from backend.matching_engine import (
    evaluate_candidate_pair,
    extract_brands,
    extract_colors,
    extract_semantic_tokens,
)
from backend.models import ClaimModel, ItemModel, MatchModel, UserModel
from backend.rag_service import rag_service

CAMPUS_AREAS = [
    "1号教学楼", "2号教学楼", "3号教学楼", "宿舍楼", "图书馆",
    "食堂", "操场", "体育馆", "实验楼", "校门口", "其他",
]

SYSTEM_PROMPT = """你是「智寻校园」高校智能失物招领平台的官方 AI 寻物助手（RAG + Tool-Calling Agent）。
你可以调用真实工具：检索校园失物招领规章与指引知识库（RAG）、查询实时 SQLite 失物招领库、执行 7 维规则+OpenCLIP 跨模态视觉检索、起草结构化发帖表单、查询当前用户认领与交接进度，以及统计校园高频丢物数据。

行为准则：
1. 当用户咨询失物招领流程、一卡通/银行卡挂失补办、各楼宇暂存点、贵重物品应急处理、6 位交接码/防冒领规则、悬赏结算、保管期限、隐私保护或本系统技术原理时，必须优先调用 `retrieve_campus_knowledge` 从校园 RAG 知识库中检索权威依据并引用回答。
2. 当用户描述丢了/捡到某件物品并想找线索时，优先调用 `match_item_description`（内置 7 维规则 + OpenCLIP 文搜图跨模态检索）或 `search_campus_items` 查询真实在库记录，绝不编造不存在的帖子或物品。
3. 当用户想发帖、起草寻物启事/招领启事、或者想把口语描述整理成发布表单时，调用 `draft_publish_form` 生成结构化草稿，方便用户在界面一键填入发布页。
4. 当用户询问“我的认领进度”“我的帖子”“我的钱包/交接码”时，调用 `get_user_status`。注意保护隐私与角色隔离，不泄露他人敏感信息。
5. 当用户询问“学校哪里最容易丢东西”“目前找回率”“有哪些分类”“系统用了什么模型”时，调用 `get_campus_stats`。
6. 回复简洁、专业、友善，使用清晰的中文要点总结查询或知识库检索结果，并引导用户点击下方生成的物品卡片、知识库引用来源或“一键填入发布页”按钮完成后续操作。"""


def get_agent_provider_status() -> Dict[str, Any]:
    if LLM_API_KEY and LLM_BASE_URL:
        return {
            "configured": True,
            "provider": "openai-compatible",
            "model": LLM_MODEL,
            "baseUrl": LLM_BASE_URL,
            "toolCalling": True,
        }
    if GEMINI_API_KEY and GEMINI_API_KEY != "MY_GEMINI_API_KEY":
        return {
            "configured": True,
            "provider": "google-gemini",
            "model": GEMINI_EXPLAIN_MODEL,
            "toolCalling": True,
        }
    return {
        "configured": False,
        "provider": "local-tool-fallback",
        "model": "local-rule-agent",
        "toolCalling": True,
    }


# =========================================================================
# Real Tool Execution Layer (SQLite + Matching Engine)
# =========================================================================

def _tool_search_campus_items(
    db: Session,
    *,
    query: str = "",
    item_type: str = "all",
    category: str = "",
    location_area: str = "",
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    rows = db.query(ItemModel).order_by(ItemModel.created_at.desc()).all()
    active = [r.to_dict() for r in rows if r.status != "delisted"]

    if item_type in ("lost", "found"):
        active = [it for it in active if it["type"] == item_type]
    if category and category in CAMPUS_CATEGORIES and category != "unknown":
        active = [it for it in active if it.get("campusCategory") == category]
    if location_area:
        active = [
            it
            for it in active
            if location_area in (it.get("location") or "")
            or location_area in (it.get("locationArea") or "")
        ]

    q = (query or "").strip().lower()
    if q:
        q_tokens = extract_semantic_tokens({"title": q, "description": q})
        scored = []
        for it in active:
            hay = f"{it.get('title', '')} {it.get('description', '')} {it.get('campusCategory', '')} {it.get('color', '')} {it.get('brand', '')} {it.get('location', '')}".lower()
            score = 0
            if q in hay:
                score += 10
            for tok in q_tokens:
                if tok in hay:
                    score += 3
            if score > 0:
                scored.append((score, it))
        scored.sort(key=lambda x: x[0], reverse=True)
        matched = [x[1] for x in scored[:5]]
    else:
        matched = active[:5]

    compact = [
        {
            "id": it["id"],
            "type": it["type"],
            "title": it["title"],
            "campusCategory": it["campusCategory"],
            "color": it.get("color"),
            "location": it["location"],
            "eventTime": it["eventTime"],
            "rewardAmount": it.get("rewardAmount", 0),
            "status": it["status"],
            "ownerName": it.get("ownerName"),
        }
        for it in matched
    ]
    return {"count": len(compact), "items": compact}, matched


def _tool_match_item_description(
    db: Session,
    *,
    item_type: str = "lost",
    description: str = "",
    location: str = "",
    color: str = "",
    category: str = "",
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    source_type = "found" if item_type == "found" else "lost"
    target_type = "lost" if source_type == "found" else "found"

    rows = (
        db.query(ItemModel)
        .filter(ItemModel.type == target_type)
        .order_by(ItemModel.created_at.desc())
        .all()
    )
    candidates = [r.to_dict() for r in rows if r.status not in ("delisted", "returned")]

    inferred_colors = extract_colors(f"{color} {description}")
    inferred_brands = extract_brands(description)
    pseudo_item = {
        "id": "agent_query_item",
        "type": source_type,
        "title": description[:60] or "查询物品",
        "description": description,
        "campusCategory": category if category in CAMPUS_CATEGORIES else "unknown",
        "color": color or (inferred_colors[0] if inferred_colors else ""),
        "brand": inferred_brands[0] if inferred_brands else "",
        "location": location,
        "eventTime": "",
        "status": "open",
    }

    scored = []
    for cand in candidates:
        lost_it = pseudo_item if source_type == "lost" else cand
        found_it = cand if source_type == "lost" else pseudo_item
        ev = evaluate_candidate_pair(
            lost_it,
            found_it,
            None,
            None,
            ["category_family", "text_keyword"],
            DEFAULT_MATCHING_CONFIG,
            "rule_7d",
        )
        scored.append((ev, cand))

    scored.sort(key=lambda x: x[0]["totalScore"], reverse=True)
    top_pairs = [x for x in scored[:4] if x[0]["totalScore"] >= 38.0]

    # Also execute Cross-Modal OpenCLIP Text-to-Image RAG over cached 512D image_embeddings
    visual_hits = rag_service.cross_modal_text_to_image_search(
        db, description, top_k=3, item_type=target_type
    )
    existing_ids = {cand["id"] for _, cand in top_pairs}
    cross_modal_added = []
    for vh in visual_hits:
        v_item = vh["item"]
        if v_item["id"] not in existing_ids and len(top_pairs) + len(cross_modal_added) < 5:
            cross_modal_added.append((vh, v_item))
            existing_ids.add(v_item["id"])

    result_list = []
    cards = []
    for ev, cand in top_pairs:
        cards.append(cand)
        result_list.append(
            {
                "itemId": cand["id"],
                "title": cand["title"],
                "type": cand["type"],
                "location": cand["location"],
                "campusCategory": cand["campusCategory"],
                "matchScore": ev["totalScore"],
                "ruleScore7D": ev["ruleScore7D"],
                "conflictReasons": ev["conflictReasons"],
                "explanation": ev["explanationSummary"],
                "ownerName": cand.get("ownerName"),
                "recallChannel": "7D语义规则匹配",
            }
        )
    for vh, v_item in cross_modal_added:
        cards.append(v_item)
        result_list.append(
            {
                "itemId": v_item["id"],
                "title": v_item["title"],
                "type": v_item["type"],
                "location": v_item["location"],
                "campusCategory": v_item["campusCategory"],
                "matchScore": round(vh["clipTextImageCosine"] * 220, 1),
                "clipTextImageCosine": vh["clipTextImageCosine"],
                "explanation": f"OpenCLIP 跨模态文搜图命中（余弦相似度 {vh['clipTextImageCosine']}）",
                "ownerName": v_item.get("ownerName"),
                "recallChannel": "OpenCLIP跨模态RAG",
            }
        )
    return {
        "searchedOppositeType": target_type,
        "candidatePoolSize": len(candidates),
        "crossModalVisualHits": len(visual_hits),
        "topMatches": result_list,
    }, cards


def _tool_draft_publish_form(
    *,
    item_type: str = "lost",
    title: str = "",
    description: str = "",
    campus_category: str = "数码电子",
    color: str = "",
    brand: str = "",
    location_area: str = "图书馆",
    location_detail: str = "",
    reward_amount: int = 0,
    verification_question: str = "",
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    clean_type = "found" if item_type == "found" else "lost"
    clean_cat = campus_category if campus_category in CAMPUS_CATEGORIES and campus_category != "unknown" else "数码电子"
    clean_area = location_area if location_area in CAMPUS_AREAS else "其他"
    draft = {
        "type": clean_type,
        "title": (title or description[:24] or "待补充物品标题").strip()[:80],
        "description": (description or title).strip()[:500],
        "campusCategory": clean_cat,
        "color": (color or "").strip()[:30],
        "brand": (brand or "").strip()[:40],
        "locationArea": clean_area,
        "locationDetail": (location_detail or "").strip()[:80],
        "rewardAmount": max(0, min(500, int(reward_amount or 0))) if clean_type == "lost" else 0,
        "verificationQuestion": (
            verification_question
            or ("请描述物品独有特征（如贴纸、划痕或内部物品）：" if clean_type == "found" else "请描述拾获物品的独有特征以便核实：")
        ).strip()[:200],
    }
    return {"ok": True, "draft": draft}, draft


def _tool_get_user_status(
    db: Session, current_user: Dict[str, Any]
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    uid = str(current_user.get("uid") or "")
    user_row = db.get(UserModel, uid)
    user_dict = user_row.to_dict() if user_row else current_user

    my_items = [
        i.to_dict()
        for i in db.query(ItemModel)
        .filter(ItemModel.owner_uid == uid)
        .order_by(ItemModel.created_at.desc())
        .all()
    ]
    all_items_by_id = {i.id: i.to_dict() for i in db.query(ItemModel).all()}

    my_claims = []
    for c_row in db.query(ClaimModel).order_by(ClaimModel.created_at.desc()).all():
        c = c_row.to_dict()
        it = all_items_by_id.get(c["itemId"])
        roles = resolve_claim_role_actors(c, it)
        if uid in (c["claimantUid"], roles["loserUid"], roles["finderUid"]) or user_dict.get("role") == "admin":
            # Respect voucher isolation: only show handoverCode to loserUid
            can_see_code = c["status"] == "approved_handover" and uid == roles["loserUid"]
            my_claims.append(
                {
                    "claimId": c["id"],
                    "itemTitle": c.get("itemTitle") or c["itemId"],
                    "status": c["status"],
                    "claimType": roles["claimType"],
                    "reviewNote": c.get("reviewNote"),
                    "handoverCodeVisibleToYou": c["handoverCode"] if can_see_code else None,
                }
            )

    my_item_ids = {it["id"] for it in my_items}
    related_matches = []
    for m_row in db.query(MatchModel).order_by(MatchModel.total_score.desc()).all():
        m = m_row.to_dict()
        if m["lostItemId"] in my_item_ids or m["foundItemId"] in my_item_ids:
            other_id = m["foundItemId"] if m["lostItemId"] in my_item_ids else m["lostItemId"]
            other = all_items_by_id.get(other_id)
            related_matches.append(
                {
                    "matchId": m["id"],
                    "score": m["totalScore"],
                    "status": m["status"],
                    "matchedItemTitle": other["title"] if other else other_id,
                    "matchedItemLocation": other["location"] if other else "",
                }
            )

    return {
        "displayName": user_dict.get("displayName"),
        "role": user_dict.get("role"),
        "walletBalance": user_dict.get("walletBalance", 85),
        "myPostsCount": len(my_items),
        "myPosts": [
            {"id": i["id"], "type": i["type"], "title": i["title"], "status": i["status"], "location": i["location"]}
            for i in my_items[:5]
        ],
        "myClaims": my_claims[:5],
        "myHighScoreMatches": related_matches[:4],
    }, my_items[:3]


def _tool_get_campus_stats(db: Session) -> Dict[str, Any]:
    items = [i.to_dict() for i in db.query(ItemModel).all() if i.status != "delisted"]
    lost_cnt = sum(1 for i in items if i["type"] == "lost")
    found_cnt = sum(1 for i in items if i["type"] == "found")
    ret_cnt = sum(1 for i in items if i["status"] == "returned")
    area_cnt = Counter(
        (i.get("locationArea") or i.get("location", "其他").split("·")[0].strip()) for i in items
    )
    cat_cnt = Counter(i.get("campusCategory") or "unknown" for i in items)
    return {
        "totalActiveItems": len(items),
        "lostCount": lost_cnt,
        "foundCount": found_cnt,
        "returnedCount": ret_cnt,
        "recoveryRatePercent": round(ret_cnt / max(1, len(items)) * 100, 1),
        "topLocations": [{"area": k, "count": v} for k, v in area_cnt.most_common(5)],
        "topCategories": [{"category": k, "count": v} for k, v in cat_cnt.most_common(5)],
        "visionStack": ai_engine.get_status(),
    }


def _execute_tool(
    name: str,
    args: Dict[str, Any],
    db: Session,
    current_user: Dict[str, Any],
    collected_cards: Dict[str, Dict[str, Any]],
    collected_drafts: List[Dict[str, Any]],
    collected_rag_sources: Dict[str, Dict[str, Any]],
) -> Tuple[Dict[str, Any], str]:
    if name == "retrieve_campus_knowledge":
        q = str(args.get("query") or "")
        top_k = int(args.get("top_k") or 3)
        hits = rag_service.retrieve_knowledge(q, top_k=top_k)
        for h in hits:
            collected_rag_sources[h["id"]] = h
        return {"query": q, "hitCount": len(hits), "chunks": hits}, f"RAG 检索校园知识库 · 命中 {len(hits)} 条规章"

    if name == "search_campus_items":
        res, cards = _tool_search_campus_items(
            db,
            query=str(args.get("query") or ""),
            item_type=str(args.get("item_type") or "all"),
            category=str(args.get("category") or ""),
            location_area=str(args.get("location_area") or ""),
        )
        for c in cards:
            collected_cards[c["id"]] = c
        return res, f"检索在库物品 · 命中 {res['count']} 条"

    if name == "match_item_description":
        res, cards = _tool_match_item_description(
            db,
            item_type=str(args.get("item_type") or "lost"),
            description=str(args.get("description") or ""),
            location=str(args.get("location") or ""),
            color=str(args.get("color") or ""),
            category=str(args.get("category") or ""),
        )
        for c in cards:
            collected_cards[c["id"]] = c
        return res, f"执行 7 维智能匹配引擎 · 找到 {len(res['topMatches'])} 条疑似线索"

    if name == "draft_publish_form":
        res, draft = _tool_draft_publish_form(
            item_type=str(args.get("item_type") or "lost"),
            title=str(args.get("title") or ""),
            description=str(args.get("description") or ""),
            campus_category=str(args.get("campus_category") or "数码电子"),
            color=str(args.get("color") or ""),
            brand=str(args.get("brand") or ""),
            location_area=str(args.get("location_area") or "图书馆"),
            location_detail=str(args.get("location_detail") or ""),
            reward_amount=int(args.get("reward_amount") or 0),
            verification_question=str(args.get("verification_question") or ""),
        )
        collected_drafts.append(draft)
        return res, f"生成结构化{'失物' if draft['type'] == 'lost' else '拾物'}发布草稿"

    if name == "get_user_status":
        res, cards = _tool_get_user_status(db, current_user)
        for c in cards:
            collected_cards[c["id"]] = c
        return res, f"查询当前账号进度 · {res['myPostsCount']} 帖 / {len(res['myClaims'])} 认领单"

    if name == "get_campus_stats":
        res = _tool_get_campus_stats(db)
        return res, f"聚合校园统计与模型指标 · 在库 {res['totalActiveItems']} 件"

    return {"error": f"Unknown tool: {name}"}, f"未知工具 {name}"


# =========================================================================
# Tool Schemas (OpenAI & Gemini Compatible)
# =========================================================================

OPENAI_TOOLS_SPEC = [
    {
        "type": "function",
        "function": {
            "name": "retrieve_campus_knowledge",
            "description": "从校园失物招领 RAG 知识库中检索规章制度与办事指南（如失物招领中心办公地址/时间、一卡通和银行卡挂失补办、贵重电子设备应急流程、各楼宇暂存点、6位交接码与防冒领规则、悬赏结算、保管期限、隐私保护、系统 YOLO26n/OpenCLIP 技术原理等）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "需要检索的校园规章、流程或技术问题"},
                    "top_k": {"type": "integer", "description": "返回最相关的知识库切片数量，默认 3"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_campus_items",
            "description": "按关键词、失物/拾物类型、校园类别或地点区域检索当前在库的失物招领记录。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词，如 MacBook、耳机、校园卡、雨伞、保温杯"},
                    "item_type": {"type": "string", "enum": ["all", "lost", "found"], "description": "筛选失物(lost)、拾物(found)或全部(all)"},
                    "category": {"type": "string", "description": "校园标准类别，如 数码电子、证件卡类、水杯雨伞、箱包服饰、图书文具、钥匙配饰、运动生活"},
                    "location_area": {"type": "string", "description": "校园大体区域，如 图书馆、食堂、3号教学楼、操场、体育馆"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "match_item_description",
            "description": "当用户描述自己丢失或捡到的物品特征时，调用 7 维规则+语义匹配引擎在相反类型库中检索最相似的疑似线索。",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_type": {"type": "string", "enum": ["lost", "found"], "description": "用户当前发布/描述的是失物(lost)还是拾物(found)"},
                    "description": {"type": "string", "description": "物品详细描述、特征、品牌、型号"},
                    "location": {"type": "string", "description": "丢失或拾获地点"},
                    "color": {"type": "string", "description": "主要颜色"},
                    "category": {"type": "string", "description": "校园标准类别"},
                },
                "required": ["item_type", "description"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draft_publish_form",
            "description": "根据用户口语化描述，抽取结构化失物/拾物发布表单草稿（标题、类别、颜色、品牌、地点、悬赏、核验问题），供用户一键填入发布页。",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_type": {"type": "string", "enum": ["lost", "found"]},
                    "title": {"type": "string", "description": "简洁规范的物品标题"},
                    "description": {"type": "string", "description": "完整清晰的物品描述"},
                    "campus_category": {"type": "string", "enum": ["数码电子", "证件卡类", "水杯雨伞", "箱包服饰", "图书文具", "钥匙配饰", "运动生活"]},
                    "color": {"type": "string"},
                    "brand": {"type": "string"},
                    "location_area": {"type": "string", "enum": CAMPUS_AREAS},
                    "location_detail": {"type": "string"},
                    "reward_amount": {"type": "integer", "description": "仅失物可填悬赏金额（0/10/20/50）"},
                    "verification_question": {"type": "string", "description": "用于防止冒领的特征核验问题"},
                },
                "required": ["item_type", "title", "description", "campus_category", "location_area"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_user_status",
            "description": "查询当前登录用户的发帖列表、认领审核状态、可用交接码、高分匹配提醒与钱包余额。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_campus_stats",
            "description": "查询全校失物招领统计数据、高频丢物区域排行、类别分布、找回率及本地 YOLO26n/OpenCLIP 模型状态。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


# =========================================================================
# Execution Runners: OpenAI-Compatible / Gemini Native / Local Fallback
# =========================================================================

def _run_openai_compatible_agent(
    messages: List[Dict[str, str]],
    db: Session,
    current_user: Dict[str, Any],
) -> Dict[str, Any]:
    t0 = time.perf_counter()
    tool_traces: List[Dict[str, Any]] = []
    collected_cards: Dict[str, Dict[str, Any]] = {}
    collected_drafts: List[Dict[str, Any]] = []
    collected_rag_sources: Dict[str, Dict[str, Any]] = {}

    api_messages: List[Dict[str, Any]] = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT
            + f"\n当前登录用户：{current_user.get('displayName', '同学')}（角色：{current_user.get('role', 'student')}）。",
        }
    ]
    for m in messages[-10:]:
        role = "assistant" if m.get("role") == "assistant" else "user"
        api_messages.append({"role": role, "content": str(m.get("content") or "")})

    endpoint = LLM_BASE_URL.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {LLM_API_KEY}", "Content-Type": "application/json"}

    reply_text = ""
    for _ in range(3):
        resp = httpx.post(
            endpoint,
            headers=headers,
            json={
                "model": LLM_MODEL,
                "messages": api_messages,
                "tools": OPENAI_TOOLS_SPEC,
                "tool_choice": "auto",
                "temperature": 0.3,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        msg = data["choices"][0]["message"]
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            reply_text = (msg.get("content") or "").strip()
            break

        api_messages.append(msg)
        for tc in tool_calls:
            fn_name = tc["function"]["name"]
            fn_args = json.loads(tc["function"].get("arguments") or "{}")
            t_tool = time.perf_counter()
            tool_res, summary = _execute_tool(
                fn_name, fn_args, db, current_user, collected_cards, collected_drafts, collected_rag_sources
            )
            tool_traces.append(
                {
                    "tool": fn_name,
                    "summary": summary,
                    "latencyMs": max(1, int(round((time.perf_counter() - t_tool) * 1000))),
                }
            )
            api_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": json.dumps(tool_res, ensure_ascii=False),
                }
            )

    return {
        "reply": reply_text or "已完成查询，请查看下方的匹配结果卡片。",
        "provider": "openai-compatible",
        "model": LLM_MODEL,
        "toolTraces": tool_traces,
        "ragSources": list(collected_rag_sources.values())[:4],
        "recommendedItems": list(collected_cards.values())[:5],
        "publishDraft": collected_drafts[-1] if collected_drafts else None,
        "latencyMs": max(1, int(round((time.perf_counter() - t0) * 1000))),
    }


def _run_gemini_agent(
    messages: List[Dict[str, str]],
    db: Session,
    current_user: Dict[str, Any],
) -> Dict[str, Any]:
    from google import genai
    from google.genai import types

    t0 = time.perf_counter()
    tool_traces: List[Dict[str, Any]] = []
    collected_cards: Dict[str, Dict[str, Any]] = {}
    collected_drafts: List[Dict[str, Any]] = []
    collected_rag_sources: Dict[str, Dict[str, Any]] = {}

    client = genai.Client(api_key=GEMINI_API_KEY)

    fn_declarations = []
    for spec in OPENAI_TOOLS_SPEC:
        fn = spec["function"]
        fn_declarations.append(
            types.FunctionDeclaration(
                name=fn["name"],
                description=fn["description"],
                parameters_json_schema=fn["parameters"],
            )
        )
    tool_obj = types.Tool(function_declarations=fn_declarations)

    contents: List[types.Content] = []
    for m in messages[-10:]:
        role = "model" if m.get("role") == "assistant" else "user"
        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=str(m.get("content") or ""))]))

    config = types.GenerateContentConfig(
        system_instruction=(
            SYSTEM_PROMPT
            + f"\n当前登录用户：{current_user.get('displayName', '同学')}（角色：{current_user.get('role', 'student')}）。"
        ),
        tools=[tool_obj],
        temperature=0.3,
    )

    reply_text = ""
    for _ in range(3):
        response = client.models.generate_content(
            model=GEMINI_EXPLAIN_MODEL,
            contents=contents,
            config=config,
        )
        fn_calls = response.function_calls or []
        if not fn_calls:
            reply_text = (response.text or "").strip()
            break

        # Append model's tool-call turn
        if response.candidates and response.candidates[0].content:
            contents.append(response.candidates[0].content)

        response_parts = []
        for fc in fn_calls:
            fn_name = fc.name
            fn_args = dict(fc.args or {})
            t_tool = time.perf_counter()
            tool_res, summary = _execute_tool(
                fn_name, fn_args, db, current_user, collected_cards, collected_drafts, collected_rag_sources
            )
            tool_traces.append(
                {
                    "tool": fn_name,
                    "summary": summary,
                    "latencyMs": max(1, int(round((time.perf_counter() - t_tool) * 1000))),
                }
            )
            response_parts.append(
                types.Part.from_function_response(name=fn_name, response=tool_res)
            )
        contents.append(types.Content(role="user", parts=response_parts))

    return {
        "reply": reply_text or "已完成检索，请点击下方物品卡片或发布草稿继续操作。",
        "provider": "google-gemini",
        "model": GEMINI_EXPLAIN_MODEL,
        "toolTraces": tool_traces,
        "ragSources": list(collected_rag_sources.values())[:4],
        "recommendedItems": list(collected_cards.values())[:5],
        "publishDraft": collected_drafts[-1] if collected_drafts else None,
        "latencyMs": max(1, int(round((time.perf_counter() - t0) * 1000))),
    }


def _run_local_tool_fallback_agent(
    messages: List[Dict[str, str]],
    db: Session,
    current_user: Dict[str, Any],
    fallback_reason: str = "",
) -> Dict[str, Any]:
    t0 = time.perf_counter()
    last_user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "").strip()
    tool_traces: List[Dict[str, Any]] = []
    collected_cards: Dict[str, Dict[str, Any]] = {}
    collected_drafts: List[Dict[str, Any]] = []
    collected_rag_sources: Dict[str, Dict[str, Any]] = {}

    # 0. Campus policy / RAG knowledge base intent
    if re.search(r"挂失|补办|怎么办|流程|规章|服务台|暂存|交接码|悬赏|保管|隐私|原理|申诉|时间|地址|105", last_user):
        res, summary = _execute_tool(
            "retrieve_campus_knowledge",
            {"query": last_user, "top_k": 3},
            db,
            current_user,
            collected_cards,
            collected_drafts,
            collected_rag_sources,
        )
        tool_traces.append({"tool": "retrieve_campus_knowledge", "summary": summary, "latencyMs": 3})
        if res["chunks"]:
            top_doc = res["chunks"][0]
            reply = f"根据校园知识库《{top_doc['title']}》为您检索到如下指引：\n\n{top_doc['content']}"
            if len(res["chunks"]) > 1:
                reply += f"\n\n另可参考：《{res['chunks'][1]['title']}》（详见下方 RAG 引用来源）。"
        else:
            reply = "暂未在校园知识库中找到完全匹配的条款，建议联系大学生活动中心 105 室失物招领中心张老师。"
    # 1. Draft publish intent
    elif re.search(r"起草|草稿|帮我写|发布|发帖|帮我发", last_user):
        is_found = bool(re.search(r"捡到|拾获|捡了", last_user))
        colors = extract_colors(last_user)
        brands = extract_brands(last_user)
        area = next((a for a in CAMPUS_AREAS if a in last_user), "图书馆")
        cat = "数码电子"
        if re.search(r"校园卡|一卡通|身份证|银行卡|学生证", last_user):
            cat = "证件卡类"
        elif re.search(r"杯|水壶|伞", last_user):
            cat = "水杯雨伞"
        elif re.search(r"包|钱包|外套", last_user):
            cat = "箱包服饰"
        elif re.search(r"钥匙|眼镜|手表", last_user):
            cat = "钥匙配饰"
        elif re.search(r"书|教材|笔记|笔袋", last_user):
            cat = "图书文具"
        res, summary = _execute_tool(
            "draft_publish_form",
            {
                "item_type": "found" if is_found else "lost",
                "title": f"{colors[0] if colors else ''}{brands[0] + ' ' if brands else ''}{cat}（{area}）",
                "description": last_user,
                "campus_category": cat,
                "color": colors[0] if colors else "",
                "brand": brands[0] if brands else "",
                "location_area": area,
                "reward_amount": 0 if is_found else 10,
            },
            db,
            current_user,
            collected_cards,
            collected_drafts,
            collected_rag_sources,
        )
        tool_traces.append({"tool": "draft_publish_form", "summary": summary, "latencyMs": 3})
        reply = (
            f"已根据您的描述整理好一条**{'招领' if is_found else '寻物'}发布草稿**（分类：{cat}，地点：{area}）。\n"
            f"点击下方「一键填入发布页」即可自动填充表单并上传照片进行 YOLO26n + OpenCLIP 智能匹配！"
        )
    # 2. User personal status / claims / wallet intent
    elif re.search(r"我的|认领|交接|进度|余额|钱包", last_user):
        res, summary = _execute_tool(
            "get_user_status", {}, db, current_user, collected_cards, collected_drafts, collected_rag_sources
        )
        tool_traces.append({"tool": "get_user_status", "summary": summary, "latencyMs": 4})
        claims_desc = (
            "；".join(f"《{c['itemTitle'][:16]}》({c['status']})" for c in res["myClaims"][:3])
            if res["myClaims"]
            else "暂无进行中的认领单"
        )
        reply = (
            f"您好，{res['displayName']}！已为您查询实时账号状态：\n"
            f"- 个人发帖：**{res['myPostsCount']} 条**，钱包可用余额：**¥{res['walletBalance']}**\n"
            f"- 认领与交接进度：{claims_desc}\n"
            f"- 高分匹配提醒：**{len(res['myHighScoreMatches'])} 条**"
        )
    # 3. Campus statistics / analytics intent
    elif re.search(r"哪里|统计|数据|找回率|高频|最多|模型|架构", last_user):
        res, summary = _execute_tool(
            "get_campus_stats", {}, db, current_user, collected_cards, collected_drafts, collected_rag_sources
        )
        tool_traces.append({"tool": "get_campus_stats", "summary": summary, "latencyMs": 5})
        top_loc = "、".join(f"{x['area']}({x['count']}件)" for x in res["topLocations"][:3])
        reply = (
            f"当前校园失物招领实时数据概览：\n"
            f"- 在库活跃物品 **{res['totalActiveItems']} 件**（失物 {res['lostCount']} / 拾物 {res['foundCount']}，已归还 {res['returnedCount']}）\n"
            f"- 高频区域排行：**{top_loc}**\n"
            f"- 本地视觉引擎：Ultralytics **{res['visionStack']['yoloModel']}** + OpenCLIP **{res['visionStack']['clipModel']}**（{res['visionStack']['gpuName']} 加速）"
        )
    # 4. Default: smart matching & cross-modal OpenCLIP RAG search
    else:
        is_found = bool(re.search(r"捡到|拾获|捡了", last_user))
        res, summary = _execute_tool(
            "match_item_description",
            {"item_type": "found" if is_found else "lost", "description": last_user},
            db,
            current_user,
            collected_cards,
            collected_drafts,
            collected_rag_sources,
        )
        tool_traces.append({"tool": "match_item_description", "summary": summary, "latencyMs": 6})
        if res["topMatches"]:
            lines = [
                f"- 《{m['title']}》（{m['location']} · 匹配度 **{m['matchScore']} 分** · {m.get('recallChannel', '')}）"
                for m in res["topMatches"][:3]
            ]
            reply = "已调用 7 维智能匹配引擎 + OpenCLIP 跨模态检索，为您找到以下高度疑似线索：\n" + "\n".join(lines) + "\n\n点击下方物品卡片即可直接查看详情、发起认领或联系发布者。"
        else:
            reply = "暂未在当前库中检索到高分匹配物品。您可以回复「帮我起草寻物启事：...」让我一键生成发布草稿，并上传实物照片开启 OpenCLIP 图像向量追踪。"

    return {
        "reply": reply,
        "provider": "local-tool-fallback",
        "model": "local-rule-agent",
        "fallbackReason": fallback_reason or None,
        "toolTraces": tool_traces,
        "ragSources": list(collected_rag_sources.values())[:4],
        "recommendedItems": list(collected_cards.values())[:5],
        "publishDraft": collected_drafts[-1] if collected_drafts else None,
        "latencyMs": max(1, int(round((time.perf_counter() - t0) * 1000))),
    }


def run_campus_agent_chat(
    messages: List[Dict[str, str]],
    db: Session,
    current_user: Dict[str, Any],
) -> Dict[str, Any]:
    if not messages:
        return {
            "reply": "您好！我是「智寻校园」AI 寻物助手。您可以直接告诉我丢失/拾获的物品特征、让我帮您起草发布表单，或查询认领与校园丢物统计。",
            "provider": get_agent_provider_status()["provider"],
            "model": get_agent_provider_status()["model"],
            "toolTraces": [],
            "recommendedItems": [],
            "publishDraft": None,
            "latencyMs": 1,
        }

    # Priority 1: OpenAI-compatible API (DeepSeek / Qwen / SiliconFlow / Ollama / OpenAI)
    if LLM_API_KEY and LLM_BASE_URL:
        try:
            return _run_openai_compatible_agent(messages, db, current_user)
        except Exception as exc:
            print(f"[CampusAgent] OpenAI-compatible error, falling back: {exc}")
            return _run_local_tool_fallback_agent(messages, db, current_user, str(exc)[:180])

    # Priority 2: Google Gemini Native Function Calling (gemini-3.5-flash)
    if GEMINI_API_KEY and GEMINI_API_KEY != "MY_GEMINI_API_KEY":
        try:
            return _run_gemini_agent(messages, db, current_user)
        except Exception as exc:
            print(f"[CampusAgent] Gemini error, falling back: {exc}")
            return _run_local_tool_fallback_agent(messages, db, current_user, str(exc)[:180])

    # Priority 3: Local Agentic Tool Execution
    return _run_local_tool_fallback_agent(messages, db, current_user)
