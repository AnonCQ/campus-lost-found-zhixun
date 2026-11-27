"""
Smart Campus Lost & Found System — FastAPI Backend Entry Point

Implements complete layered architecture (FastAPI Routes / Services / SQLAlchemy ORM):
- SQLite (default) / MySQL relational persistence across 9 core tables
- Local GPU/CPU Ultralytics YOLO26n (yolo26n.pt) object detection
- Local GPU/CPU OpenCLIP ViT-B/32 512D L2-normalized image embedding & SHA-256 deduplication
- Multi-way recall (Category/Family U Text Keyword U Image Vector Top-K) & 7D explainable reranking
- Independent 3-strategy offline evaluation benchmark (dataset / dataset_control / dataset_blind)
- Data visualization & analytics aggregation endpoint (/api/analytics/overview)
- Full claim review, 6-digit handover verification, dual-sided bounty settlement, & mutual review loop
"""

import base64
import hashlib
import random
import re
import secrets
import time
from collections import Counter, defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend.agent_service import get_agent_provider_status, run_campus_agent_chat
from backend.ai_engine import ai_engine
from backend.rag_service import rag_service
from backend.auth_service import (
    get_smtp_status,
    send_email_verification_code,
    verify_email_code_login,
    verify_password_login,
)
from backend.config import (
    ADMIN_WHITELIST_EMAIL,
    ALGORITHM_VERSION,
    DATABASE_URL,
    DIST_DIR,
    EMBEDDING_MODEL_VERSION,
    PUBLIC_IMAGES_DIR,
    RECOGNITION_MODEL_VERSION,
    UPLOADS_DIR,
)
from backend.constants import (
    DEFAULT_MATCHING_CONFIG,
    MODEL_TO_CAMPUS_CATEGORY_MAP,
    compose_campus_location,
    get_deterministic_embedding_id,
    get_deterministic_match_id,
    resolve_claim_role_actors,
)
from backend.database import SessionLocal, get_db, init_db
from backend.evaluation_service import run_dataset_evaluation
from backend.matching_engine import execute_three_way_recall_and_rerank, l2_normalize
from backend.models import (
    AuditLogModel,
    ClaimModel,
    ImageEmbeddingModel,
    ItemModel,
    MatchFeedbackModel,
    MatchModel,
    MessageModel,
    RecognitionTaskModel,
    UserModel,
)
from backend.seed_service import execute_deterministic_seed


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_name(name: Optional[str]) -> str:
    return re.sub(r"\s*\(.*?\)", "", name or "").strip() or "校园用户"


def _add_audit_log(
    db: Session,
    actor: Optional[Dict[str, Any]],
    action: str,
    target_id: str,
    detail: str,
) -> AuditLogModel:
    actor = actor or {}
    entry = AuditLogModel(
        id=f"audit_{int(time.time() * 1000)}_{secrets.token_hex(3)}",
        actor_uid=str(actor.get("uid") or "system"),
        actor_name=str(actor.get("displayName") or "系统"),
        actor_role=str(actor.get("role") or "student"),
        action=action[:64],
        target_id=str(target_id)[:250],
        detail=str(detail)[:950],
        created_at=_now_iso(),
    )
    db.add(entry)
    return entry


def _get_or_encode_embedding(
    db: Session,
    *,
    sha256: str,
    item_id: Optional[str] = None,
    base64_image: Optional[str] = None,
    image_url: Optional[str] = None,
    title: str = "",
    description: str = "",
    category_hint: str = "",
    color_hint: str = "",
) -> Dict[str, Any]:
    clean_sha = (sha256 or "").strip()
    emb_id = get_deterministic_embedding_id(clean_sha, EMBEDDING_MODEL_VERSION) if clean_sha else ""

    if emb_id:
        existing = db.get(ImageEmbeddingModel, emb_id)
        if existing:
            return {"embedding": existing.to_dict(), "cacheHit": True}
        existing_pair = (
            db.query(ImageEmbeddingModel)
            .filter(
                ImageEmbeddingModel.sha256 == clean_sha,
                ImageEmbeddingModel.model_version == EMBEDDING_MODEL_VERSION,
            )
            .first()
        )
        if existing_pair:
            return {"embedding": existing_pair.to_dict(), "cacheHit": True}

    encoded = ai_engine.encode_image_embedding(
        base64_image=base64_image,
        image_url=image_url,
        sha256_hint=clean_sha or None,
    )
    final_sha = encoded["sha256"]
    final_id = get_deterministic_embedding_id(final_sha, encoded["modelVersion"])

    existing_after = db.get(ImageEmbeddingModel, final_id)
    if existing_after:
        return {"embedding": existing_after.to_dict(), "cacheHit": True}

    vec = l2_normalize(encoded["vector"])
    summary = f"{category_hint} {color_hint} {title} {description}".strip()[:200]
    row = ImageEmbeddingModel(
        id=final_id,
        sha256=final_sha,
        model_version=encoded["modelVersion"],
        dimension=len(vec),
        vector=vec,
        item_id=item_id,
        visual_summary=summary,
        created_at=_now_iso(),
    )
    db.add(row)
    db.flush()
    return {"embedding": row.to_dict(), "cacheHit": False}


def _recompute_and_persist_matches_for_item(
    db: Session,
    target_item: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    cfg = config or DEFAULT_MATCHING_CONFIG
    if target_item.get("status") in ("delisted", "returned"):
        return {
            "updatedMatches": [],
            "recallStats": {
                "category_family": 0,
                "text_keyword": 0,
                "image_vector": 0,
                "union_deduped": 0,
                "scannedEmbeddingCount": 0,
            },
        }

    all_items = [it.to_dict() for it in db.query(ItemModel).all()]
    all_embs = {e.id: e.vector for e in db.query(ImageEmbeddingModel).all()}
    existing_matches = {m.id: m for m in db.query(MatchModel).all()}

    opposite_items = [
        it
        for it in all_items
        if it["type"] != target_item["type"] and it["status"] not in ("delisted", "returned")
    ]
    emb_by_item_id: Dict[str, List[float]] = {}
    for it in all_items:
        eid = it.get("embeddingId")
        if eid and eid in all_embs:
            emb_by_item_id[it["id"]] = all_embs[eid]

    recall_res = execute_three_way_recall_and_rerank(
        target_item,
        opposite_items,
        emb_by_item_id,
        cfg,
        "three_way_rerank",
    )

    min_threshold = float(cfg.get("decisionThreshold", 58.0))
    now = _now_iso()
    persisted: List[Dict[str, Any]] = []
    persisted_ids = set()

    for ev in recall_res["matches"]:
        if ev["totalScore"] < min_threshold:
            continue
        m_id = get_deterministic_match_id(ev["lostItemId"], ev["foundItemId"])
        prev = existing_matches.get(m_id)
        row = prev or MatchModel(id=m_id, created_at=now, status="candidate")
        row.lost_item_id = ev["lostItemId"]
        row.found_item_id = ev["foundItemId"]
        row.total_score = ev["totalScore"]
        row.rule_score_7d = ev["ruleScore7D"]
        row.image_similarity = ev["imageSimilarity"]
        row.conflict_penalty = ev["conflictPenalty"]
        row.dimension_scores = ev["dimensionScores"]
        row.recall_sources = ev["recallSources"]
        row.conflict_reasons = ev["conflictReasons"]
        row.explanation_summary = ev["explanationSummary"]
        row.algorithm_version = ALGORITHM_VERSION
        row.updated_at = now
        db.merge(row)
        persisted_ids.add(m_id)
        persisted.append(row.to_dict())

    # Remove stale or sub-threshold matches involving target_item
    for m_id, m_row in existing_matches.items():
        if m_row.lost_item_id == target_item["id"] or m_row.found_item_id == target_item["id"]:
            if m_id not in persisted_ids or m_row.total_score < min_threshold:
                db.delete(m_row)

    db.flush()
    return {
        "updatedMatches": persisted,
        "recallStats": {
            **recall_res["recallChannelCounts"],
            "scannedEmbeddingCount": recall_res["scannedEmbeddingCount"],
        },
    }


def _record_wallet_tx(
    db: Session,
    user: UserModel,
    *,
    title: str,
    tx_type: str,
    amount: float,
    item_id: Optional[str] = None,
    counterparty_name: str = "同学",
) -> UserModel:
    clean_amount = max(1, round(float(amount or 0)))
    prev_balance = float(user.wallet_balance if user.wallet_balance is not None else 85)
    if tx_type == "expense" and prev_balance < clean_amount:
        raise HTTPException(
            status_code=400,
            detail=f"钱包可用余额不足（当前 ¥{int(prev_balance)}，需支付 ¥{clean_amount}）",
        )
    next_balance = prev_balance + clean_amount if tx_type == "income" else max(0.0, prev_balance - clean_amount)
    now = _now_iso()
    new_tx = {
        "id": f"tx_{int(time.time() * 1000)}_{secrets.token_hex(2)}",
        "title": title.strip()[:140],
        "type": tx_type,
        "amount": clean_amount,
        "itemId": item_id,
        "counterpartyName": (counterparty_name or "同学")[:60],
        "createdAt": now,
    }
    prev_list = list(user.wallet_transactions or [])
    user.wallet_balance = next_balance
    user.wallet_transactions = [new_tx, *prev_list][:40]
    user.updated_at = now
    db.add(user)
    return user


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    try:
        ai_engine.ensure_loaded()
        with SessionLocal() as db:
            res = execute_deterministic_seed(db, mode="if_empty")
            print(f"[FastAPI Startup] Seed check complete: {res}")
    except Exception as exc:
        print(f"[FastAPI Startup] Warning during startup init: {exc}")
    yield


app = FastAPI(
    title="智寻校园 · 智能失物招领与图像匹配系统 API",
    description="FastAPI + SQLAlchemy(SQLite/MySQL) + Ultralytics YOLO26n + OpenCLIP ViT-B/32",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================================
# 1. Health & Bundle & Seed
# =========================================================================

@app.get("/api/health")
def get_health(db: Session = Depends(get_db)):
    ai_status = ai_engine.get_status()
    return {
        "status": "ok",
        "backendFramework": "FastAPI + SQLAlchemy",
        "databaseEngine": "SQLite" if DATABASE_URL.startswith("sqlite") else "MySQL",
        "mappingTableSize": len(MODEL_TO_CAMPUS_CATEGORY_MAP),
        "itemCount": db.query(ItemModel).count(),
        "embeddingCount": db.query(ImageEmbeddingModel).count(),
        **ai_status,
    }


@app.get("/api/bundle")
def get_full_bundle(db: Session = Depends(get_db)):
    users = [u.to_dict() for u in db.query(UserModel).all()]
    items = [
        i.to_dict()
        for i in db.query(ItemModel).order_by(ItemModel.created_at.desc()).all()
    ]
    embeddings = [e.to_dict() for e in db.query(ImageEmbeddingModel).all()]
    tasks = [
        t.to_dict()
        for t in db.query(RecognitionTaskModel)
        .order_by(RecognitionTaskModel.created_at.desc())
        .all()
    ]
    matches = [
        m.to_dict()
        for m in db.query(MatchModel).order_by(MatchModel.total_score.desc()).all()
    ]
    feedbacks = [
        f.to_dict()
        for f in db.query(MatchFeedbackModel)
        .order_by(MatchFeedbackModel.created_at.desc())
        .all()
    ]
    claims = [
        c.to_dict()
        for c in db.query(ClaimModel).order_by(ClaimModel.created_at.desc()).all()
    ]
    messages = [
        m.to_dict()
        for m in db.query(MessageModel).order_by(MessageModel.created_at.asc()).all()
    ]
    audit_logs = [
        a.to_dict()
        for a in db.query(AuditLogModel)
        .order_by(AuditLogModel.created_at.desc())
        .all()
    ]
    return {
        "users": users,
        "items": items,
        "embeddings": embeddings,
        "tasks": tasks,
        "matches": matches,
        "feedbacks": feedbacks,
        "claims": claims,
        "messages": messages,
        "auditLogs": audit_logs,
    }


@app.post("/api/seed")
async def seed_database(request: Request, db: Session = Depends(get_db)):
    body = await request.json() if await request.body() else {}
    mode = "if_empty" if body.get("mode") == "if_empty" else "reset"
    actor = body.get("actor")
    result = execute_deterministic_seed(db, mode=mode, actor=actor)
    return {"ok": True, **result}


# =========================================================================
# 2. Authentication (Salted scrypt Password + Optional SMTP Email OTP)
# =========================================================================

@app.post("/api/auth/password-login")
async def auth_password_login(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    users = [u.to_dict() for u in db.query(UserModel).all()]
    res = verify_password_login(users, str(body.get("account", "")), str(body.get("password", "")))
    if not res["ok"]:
        return JSONResponse(status_code=res["status"], content=res)
    return {"ok": True, "user": res["user"]}


@app.get("/api/auth/email-status")
def auth_email_status():
    smtp = get_smtp_status()
    return {
        "ok": True,
        "configured": smtp["configured"],
        "message": "" if smtp["configured"] else "邮箱验证码暂未开通（邮件服务未配置）",
    }


@app.post("/api/auth/email-code")
async def auth_email_code(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    users = [u.to_dict() for u in db.query(UserModel).all()]
    res = send_email_verification_code(users, str(body.get("email", "")))
    if not res["ok"]:
        return JSONResponse(
            status_code=res["status"],
            content={**res, "configured": res.get("code") != "SMTP_NOT_CONFIGURED"},
        )
    return {**res, "configured": True}


@app.post("/api/auth/email-login")
async def auth_email_login(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    users = [u.to_dict() for u in db.query(UserModel).all()]
    res = verify_email_code_login(users, str(body.get("email", "")), str(body.get("code", "")))
    if not res["ok"]:
        return JSONResponse(status_code=res["status"], content=res)
    return {"ok": True, "user": res["user"]}


# =========================================================================
# 3. Local Image Upload Storage (Replaces Firebase Cloud Storage)
# =========================================================================

@app.post("/api/uploads/image")
async def upload_image_json_or_multipart(
    request: Request,
    file: Optional[UploadFile] = File(default=None),
):
    content_type = request.headers.get("content-type", "")
    if file is not None:
        raw_bytes = await file.read()
        sha = hashlib.sha256(raw_bytes).hexdigest()
        item_id = f"img_{int(time.time() * 1000)}"
    elif "application/json" in content_type:
        body = await request.json()
        b64 = str(body.get("base64Image") or "")
        if not b64:
            raise HTTPException(status_code=400, detail="缺少 base64Image 数据")
        clean_b64 = b64.split(",", 1)[1] if "," in b64 else b64
        raw_bytes = base64.b64decode(clean_b64)
        sha = str(body.get("sha256") or hashlib.sha256(raw_bytes).hexdigest())
        item_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(body.get("itemId") or f"img_{int(time.time()*1000)}"))
    else:
        raise HTTPException(status_code=400, detail="请以 multipart/form-data 或 JSON base64Image 上传图片")

    if len(raw_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片大小不能超过 10MB")

    clean_sha = re.sub(r"[^a-zA-Z0-9]", "", sha)[:24]
    filename = f"{item_id}_{clean_sha}.jpg"
    out_path = UPLOADS_DIR / filename
    out_path.write_bytes(raw_bytes)

    return {
        "storagePath": f"uploads/{filename}",
        "imageUrl": f"/uploads/{filename}",
        "sha256": sha,
        "uploadedToCloudStorage": True,
    }


# =========================================================================
# 4. AI Vision Recognition (YOLO26n + OpenCLIP), Embedding, Explain, Eval
# =========================================================================

@app.post("/api/tasks/recognize")
async def api_recognize_task(request: Request):
    body = await request.json()
    try:
        res = ai_engine.recognize_image(
            base64_image=body.get("base64Image"),
            image_url=body.get("imageUrl"),
            title=str(body.get("title") or ""),
            description=str(body.get("description") or ""),
        )
        return {
            "taskId": body.get("taskId"),
            "itemId": body.get("itemId"),
            **res,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"本地视觉模型推理失败: {exc}")


@app.post("/api/embeddings/encode")
async def api_encode_embedding(request: Request, db: Session = Depends(get_db)):
    t0 = time.perf_counter()
    body = await request.json()
    try:
        result = _get_or_encode_embedding(
            db,
            sha256=str(body.get("sha256") or ""),
            item_id=body.get("itemId"),
            base64_image=body.get("base64Image"),
            image_url=body.get("imageUrl"),
            title=str(body.get("title") or ""),
            description=str(body.get("description") or ""),
            category_hint=str(body.get("categoryHint") or ""),
            color_hint=str(body.get("colorHint") or ""),
        )
        db.commit()
        emb = result["embedding"]
        return {
            "sha256": emb["sha256"],
            "modelUsed": EMBEDDING_MODEL_VERSION,
            "modelVersion": emb["modelVersion"],
            "dimension": emb["dimension"],
            "vector": emb["vector"],
            "embedding": emb,
            "cacheHit": result["cacheHit"],
            "cacheHitInMemory": result["cacheHit"],
            "visualSummary": emb.get("visualSummary", ""),
            "latencyMs": max(1, int(round((time.perf_counter() - t0) * 1000))),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OpenCLIP 特征编码失败: {exc}")


@app.post("/api/matches/explain")
async def api_explain_match(request: Request):
    body = await request.json()
    lost_item = body.get("lostItem")
    found_item = body.get("foundItem")
    if not lost_item or not found_item:
        raise HTTPException(status_code=400, detail="缺少失物或拾物对比数据")
    return ai_engine.explain_match(lost_item, found_item, body.get("matchRecord"))


@app.post("/api/eval/run")
async def api_run_evaluation(request: Request):
    body = await request.json() if await request.body() else {}
    ds_key = body.get("datasetKey", "dataset")
    if ds_key not in ("dataset", "dataset_control", "dataset_blind"):
        ds_key = "dataset"
    return run_dataset_evaluation(ds_key, body.get("config"))


# =========================================================================
# 4b. Campus Lost & Found AI Agent (LLM Tool-Calling: Gemini / OpenAI-Compatible)
# =========================================================================

@app.get("/api/agent/status")
def api_agent_status():
    return {
        "ok": True,
        "ragDocumentsCount": len(rag_service.list_documents()),
        "ragEnabled": True,
        **get_agent_provider_status(),
    }


@app.get("/api/rag/documents")
def api_rag_documents():
    docs = rag_service.list_documents()
    return {"ok": True, "count": len(docs), "documents": docs}


@app.post("/api/rag/query")
async def api_rag_query(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    q = str(body.get("query") or "").strip()
    top_k = int(body.get("topK") or 3)
    kb_hits = rag_service.retrieve_knowledge(q, top_k=top_k)
    visual_hits = rag_service.cross_modal_text_to_image_search(db, q, top_k=3)
    return {
        "ok": True,
        "query": q,
        "knowledgeHits": kb_hits,
        "crossModalVisualHits": [
            {
                "itemId": h["item"]["id"],
                "title": h["item"]["title"],
                "type": h["item"]["type"],
                "location": h["item"]["location"],
                "clipTextImageCosine": h["clipTextImageCosine"],
                "visualPromptUsed": h["visualPromptUsed"],
            }
            for h in visual_hits
        ],
    }


@app.post("/api/agent/chat")
async def api_agent_chat(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    messages = body.get("messages") or []
    current_user = body.get("currentUser") or {"uid": "demo_student_li", "displayName": "李明轩", "role": "student"}
    return run_campus_agent_chat(messages, db, current_user)


# =========================================================================
# 5. Data Visualization & Analytics Dashboard API
# =========================================================================

@app.get("/api/analytics/overview")
def api_analytics_overview(db: Session = Depends(get_db)):
    items = [i.to_dict() for i in db.query(ItemModel).all()]
    tasks = [t.to_dict() for t in db.query(RecognitionTaskModel).all()]
    matches = [m.to_dict() for m in db.query(MatchModel).all()]
    claims = [c.to_dict() for c in db.query(ClaimModel).all()]
    embeddings = db.query(ImageEmbeddingModel).all()

    active_items = [i for i in items if i["status"] != "delisted"]
    lost_items = [i for i in active_items if i["type"] == "lost"]
    found_items = [i for i in active_items if i["type"] == "found"]
    returned_items = [i for i in active_items if i["status"] == "returned"]

    # Category breakdown
    cat_map: Dict[str, Dict[str, int]] = defaultdict(lambda: {"lost": 0, "found": 0, "returned": 0})
    for it in active_items:
        c = it.get("campusCategory") or "unknown"
        if it["type"] == "lost":
            cat_map[c]["lost"] += 1
        else:
            cat_map[c]["found"] += 1
        if it["status"] == "returned":
            cat_map[c]["returned"] += 1
    category_dist = [
        {"category": k, **v, "total": v["lost"] + v["found"]}
        for k, v in sorted(cat_map.items(), key=lambda kv: kv[1]["lost"] + kv[1]["found"], reverse=True)
    ]

    # Campus location hotspots
    loc_map: Dict[str, Dict[str, int]] = defaultdict(lambda: {"lost": 0, "found": 0})
    for it in active_items:
        area = it.get("locationArea") or (it.get("location", "其他").split("·")[0].strip()) or "其他"
        if it["type"] == "lost":
            loc_map[area]["lost"] += 1
        else:
            loc_map[area]["found"] += 1
    location_hotspots = [
        {"area": k, **v, "total": v["lost"] + v["found"]}
        for k, v in sorted(loc_map.items(), key=lambda kv: kv[1]["lost"] + kv[1]["found"], reverse=True)
    ]

    # Status funnel
    status_labels = {
        "open": "待匹配",
        "matching": "智能匹配中",
        "claiming": "认领审核中",
        "handover": "待当面交接",
        "returned": "已归还闭环",
        "delisted": "已下架",
    }
    status_counts = Counter(i["status"] for i in items)
    status_funnel = [
        {"status": st, "label": label, "count": status_counts.get(st, 0)}
        for st, label in status_labels.items()
    ]

    # Daily trend
    daily_map: Dict[str, Dict[str, int]] = defaultdict(lambda: {"lost": 0, "found": 0, "returned": 0})
    for it in active_items:
        day = str(it.get("eventTime") or it.get("createdAt") or "")[:10]
        if not day:
            continue
        if it["type"] == "lost":
            daily_map[day]["lost"] += 1
        else:
            daily_map[day]["found"] += 1
        if it["status"] == "returned":
            daily_map[day]["returned"] += 1
    daily_trend = [{"date": d, **v} for d, v in sorted(daily_map.items())]

    # AI telemetry
    succeeded_tasks = [t for t in tasks if t["status"] == "succeeded"]
    latencies = [t["latencyMs"] for t in succeeded_tasks if isinstance(t.get("latencyMs"), (int, float))]
    confs = [t["confidence"] for t in succeeded_tasks if isinstance(t.get("confidence"), (int, float))]
    cache_hits = sum(1 for t in tasks if t.get("cacheHit"))

    eval_report = run_dataset_evaluation("dataset")
    eval_summary = [
        {
            "strategyKey": s["strategyKey"],
            "strategyName": s["strategyName"].split(" (")[0],
            "precision": s["precision"],
            "recall": s["recall"],
            "f1": s["f1"],
            "recallAt1": s["recallAt1"],
            "recallAt3": s["recallAt3"],
            "recallAt5": s["recallAt5"],
            "avgLatencyMs": s["avgLatencyMs"],
        }
        for s in eval_report["strategies"]
    ]

    return {
        "summary": {
            "totalItems": len(active_items),
            "lostCount": len(lost_items),
            "foundCount": len(found_items),
            "returnedCount": len(returned_items),
            "recoveryRate": round(len(returned_items) / max(1, len(active_items)) * 100, 1),
            "totalMatches": len(matches),
            "highScoreMatches": sum(1 for m in matches if m["totalScore"] >= 75),
            "confirmedMatches": sum(1 for m in matches if m["status"] == "confirmed"),
            "totalClaims": len(claims),
            "completedClaims": sum(1 for c in claims if c["status"] == "completed"),
            "totalEmbeddings": len(embeddings),
            "totalTasks": len(tasks),
            "succeededTasks": len(succeeded_tasks),
            "failedTasks": sum(1 for t in tasks if t["status"] == "failed"),
            "cacheHitRate": round(cache_hits / max(1, len(tasks)) * 100, 1),
            "avgLatencyMs": round(sum(latencies) / max(1, len(latencies)), 1) if latencies else 0,
            "avgConfidence": round(sum(confs) / max(1, len(confs)) * 100, 1) if confs else 0,
        },
        "categoryDistribution": category_dist,
        "locationHotspots": location_hotspots,
        "statusFunnel": status_funnel,
        "dailyTrend": daily_trend,
        "aiTelemetry": ai_engine.get_status(),
        "evaluationSummary": eval_summary,
    }


# =========================================================================
# 6. Users CRUD, Preferences, Browsing History, Wallet & Reviews
# =========================================================================

@app.put("/api/users/{uid}")
async def upsert_user(uid: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    now = _now_iso()
    user = db.get(UserModel, uid)
    if not user:
        user = UserModel(
            uid=uid,
            email=str(body.get("email") or "user@campus.edu.cn"),
            display_name=str(body.get("displayName") or "同学"),
            role=str(body.get("role") or "student"),
            created_at=str(body.get("createdAt") or now),
        )
    if "displayName" in body and body["displayName"]:
        user.display_name = str(body["displayName"]).strip()[:90]
    if "email" in body and body["email"]:
        user.email = str(body["email"]).strip()[:240]
    if "phone" in body:
        user.phone = str(body["phone"] or "").strip()[:30]
    if "studentId" in body:
        user.student_id = str(body["studentId"] or "").strip()[:60]
    if "department" in body:
        user.department = str(body["department"] or "").strip()[:120]
    if "className" in body:
        user.class_name = str(body["className"] or "").strip()[:120]
    if "bio" in body:
        user.bio = str(body["bio"] or "").strip()[:280]
    if "birthday" in body:
        user.birthday = str(body["birthday"] or "").strip()[:30]
    if "avatarUrl" in body and body["avatarUrl"]:
        user.avatar_url = str(body["avatarUrl"]).strip()[:1000]
    user.updated_at = now
    db.add(user)

    if body.get("recordAudit"):
        _add_audit_log(
            db,
            user.to_dict(),
            "USER_PROFILE_UPDATE",
            uid,
            f"用户更新个人资料：昵称=[{user.display_name}]，院校班级=[{user.department or ''} {user.class_name or ''}]",
        )
    db.commit()
    return user.to_dict()


@app.post("/api/users/{uid}/browsing-history")
async def add_browsing_history(uid: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    item_id = str(body.get("itemId") or "").strip()
    user = db.get(UserModel, uid)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    prev = list(user.browsed_item_ids or [])
    user.browsed_item_ids = [item_id, *[x for x in prev if x != item_id]][:30]
    user.updated_at = _now_iso()
    db.add(user)
    db.commit()
    return user.to_dict()


@app.delete("/api/users/{uid}/browsing-history")
def clear_browsing_history(uid: str, db: Session = Depends(get_db)):
    user = db.get(UserModel, uid)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    user.browsed_item_ids = []
    user.updated_at = _now_iso()
    db.add(user)
    db.commit()
    return user.to_dict()


@app.post("/api/users/{uid}/read-notifications")
async def mark_notifications_read(uid: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    incoming = [str(x).strip() for x in (body.get("notificationIds") or []) if str(x).strip()]
    user = db.get(UserModel, uid)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    prev = list(user.read_notification_ids or [])
    merged = list(dict.fromkeys([*prev, *incoming]))[-180:]
    user.read_notification_ids = merged
    user.updated_at = _now_iso()
    db.add(user)
    db.commit()
    return user.to_dict()


@app.patch("/api/users/{uid}/preferences")
async def update_user_preferences(uid: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    user = db.get(UserModel, uid)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if "darkMode" in body:
        user.dark_mode = bool(body["darkMode"])
    if "pushNotifyEnabled" in body:
        user.push_notify_enabled = bool(body["pushNotifyEnabled"])
    user.updated_at = _now_iso()
    db.add(user)
    db.commit()
    return user.to_dict()


@app.post("/api/users/{uid}/wallet/transactions")
async def create_wallet_tx(uid: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    user = db.get(UserModel, uid)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    _record_wallet_tx(
        db,
        user,
        title=str(body.get("title") or "校园悬赏流水"),
        tx_type=str(body.get("type") or "income"),
        amount=float(body.get("amount") or 0),
        item_id=body.get("itemId"),
        counterparty_name=str(body.get("counterpartyName") or "同学"),
    )
    db.commit()
    return user.to_dict()


@app.post("/api/users/{uid}/reviews")
async def add_user_review(uid: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    user = db.get(UserModel, uid)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    now = _now_iso()
    new_rev = {
        "id": f"rev_{int(time.time() * 1000)}_{secrets.token_hex(2)}",
        "reviewerName": str(body.get("reviewerName") or "热心同学").strip()[:50],
        "roleTag": str(body.get("roleTag") or "失主评价"),
        "rating": str(body.get("rating") or "好评"),
        "content": str(body.get("content") or "").strip()[:300],
        "itemTitle": str(body.get("itemTitle") or "").strip()[:120],
        "createdAt": now,
    }
    user.reviews = [new_rev, *(user.reviews or [])][:40]
    user.updated_at = now
    db.add(user)
    db.commit()
    return user.to_dict()


# =========================================================================
# 7. Items Publish (YOLO26n + OpenCLIP + 3-Way Match), Edit, Delist, Retry
# =========================================================================

@app.post("/api/items/publish")
async def publish_item_workflow(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    actor = body.get("actor") or {}
    item_type = "found" if body.get("type") == "found" else "lost"
    planned_reward = (
        max(0, min(9999, round(float(body.get("rewardAmount") or 0))))
        if item_type == "lost"
        else 0
    )

    owner_row = db.get(UserModel, actor.get("uid", ""))
    if item_type == "lost" and planned_reward > 0 and owner_row:
        avail = float(owner_row.wallet_balance if owner_row.wallet_balance is not None else 85)
        if planned_reward > avail:
            raise HTTPException(
                status_code=400,
                detail=f"悬赏金额（¥{planned_reward}）超出当前钱包可用余额（¥{int(avail)}），请调低悬赏金额后再发布",
            )

    now = _now_iso()
    clean_title = str(body.get("title") or "").strip()[:190]
    draft_id = str(body.get("draftItemId") or "").strip()
    item_id = (
        draft_id
        if draft_id and re.fullmatch(r"[a-zA-Z0-9_-]+", draft_id)
        else f"item_{item_type}_{int(time.time() * 1000)}"
    )

    existing_item = db.get(ItemModel, item_id)
    if existing_item and existing_item.recognition_status == "succeeded":
        existing_task = db.get(RecognitionTaskModel, existing_item.recognition_task_id or f"task_{item_id}")
        return {
            "item": existing_item.to_dict(),
            "task": existing_task.to_dict() if existing_task else None,
            "cacheHit": True,
        }

    task_id = f"task_{item_id}"
    sha = str(body.get("imageSha256") or f"sha256_text_{item_id}")
    idem_key = f"idem_{item_id}_{sha[:24]}"
    clean_area = str(body.get("locationArea") or "").strip()[:60]
    clean_detail = str(body.get("locationDetail") or "").strip()[:140]
    composed_loc = compose_campus_location(clean_area, clean_detail) if clean_area else str(body.get("location") or "")[:190]

    user_cat = str(body.get("campusCategory") or "数码电子")
    user_manual_cat = bool(body.get("userManuallySelectedCategory", False))
    base64_img = body.get("base64Image")
    image_url = str(body.get("imageUrl") or "")
    has_image = bool(base64_img or image_url)

    item_row = ItemModel(
        id=item_id,
        type=item_type,
        title=clean_title,
        description=str(body.get("description") or "")[:1900],
        campus_category=user_cat,
        color=str(body.get("color") or "未知")[:60],
        quantity=int(body.get("quantity") or 1),
        brand=str(body.get("brand") or "")[:100],
        reward_amount=planned_reward,
        location_area=clean_area or None,
        location_detail=clean_detail or None,
        location=composed_loc[:190],
        event_time=str(body.get("eventTime") or now[:16]),
        condition_text=str(body.get("conditionText") or "正常")[:120],
        keywords=[],
        image_url=image_url,
        storage_path=str(body.get("storagePath") or ""),
        image_sha256=sha,
        recognition_task_id=task_id,
        recognition_status="running",
        model_version=RECOGNITION_MODEL_VERSION,
        status="open",
        owner_uid=str(actor.get("uid") or "demo_student_li"),
        owner_name=str(actor.get("displayName") or "同学"),
        owner_email=str(actor.get("email") or ""),
        verification_question=str(body.get("verificationQuestion") or "")[:280] or None,
        verification_answer_hint=str(body.get("verificationAnswerHint") or "")[:280] or None,
        is_seeded_demo=False,
        created_at=now,
        updated_at=now,
    )
    task_row = RecognitionTaskModel(
        id=task_id,
        item_id=item_id,
        item_title=clean_title[:180],
        idempotency_key=idem_key,
        status="running",
        retry_count=0,
        max_retries=3,
        model_version=RECOGNITION_MODEL_VERSION,
        created_at=now,
        updated_at=now,
    )
    db.merge(item_row)
    db.merge(task_row)
    db.flush()

    t0 = time.perf_counter()
    cache_hit = False
    try:
        recog_data: Dict[str, Any] = {
            "rawModelClass": "unknown",
            "mappedCampusCategory": user_cat,
            "confidence": 0.0,
            "bbox": [0, 0, 0, 0],
            "color": item_row.color or "未知",
            "brand": item_row.brand or "",
            "keywords": [],
            "latencyMs": 1,
            "recognitionSource": "model",
            "isFallback": False,
        }
        emb_id: Optional[str] = None

        if has_image:
            recog_data = ai_engine.recognize_image(
                base64_image=base64_img,
                image_url=image_url,
                title=clean_title,
                description=item_row.description,
            )
            emb_res = _get_or_encode_embedding(
                db,
                sha256=sha,
                item_id=item_id,
                base64_image=base64_img,
                image_url=image_url,
                title=clean_title,
                description=item_row.description,
                category_hint=recog_data.get("mappedCampusCategory", user_cat),
                color_hint=recog_data.get("color", item_row.color or ""),
            )
            emb_id = emb_res["embedding"]["id"]
            cache_hit = emb_res["cacheHit"]

        mapped_cat = recog_data.get("mappedCampusCategory") or user_cat
        final_cat = (
            mapped_cat
            if (not user_manual_cat and mapped_cat and mapped_cat != "unknown")
            else (user_cat if user_cat != "unknown" else (mapped_cat if mapped_cat != "unknown" else "数码电子"))
        )
        latency_ms = int(recog_data.get("latencyMs") or round((time.perf_counter() - t0) * 1000))
        done_iso = _now_iso()

        task_row.status = "succeeded"
        task_row.raw_model_class = recog_data.get("rawModelClass", "unknown")
        task_row.mapped_campus_category = mapped_cat
        task_row.confidence = float(recog_data.get("confidence", 0.0))
        task_row.bbox = recog_data.get("bbox", [0, 0, 0, 0])
        task_row.extracted_color = recog_data.get("color") or item_row.color
        task_row.extracted_brand = recog_data.get("brand") or item_row.brand
        task_row.extracted_keywords = recog_data.get("keywords") or []
        task_row.latency_ms = latency_ms
        task_row.cache_hit = cache_hit
        task_row.embedding_id = emb_id
        task_row.recognition_source = recog_data.get("recognitionSource", "model")
        task_row.is_fallback = bool(recog_data.get("isFallback", False))
        task_row.updated_at = done_iso

        item_row.campus_category = final_cat
        item_row.raw_model_class = task_row.raw_model_class
        if not item_row.color or item_row.color == "未知":
            item_row.color = task_row.extracted_color or "未知"
        if not item_row.brand:
            item_row.brand = task_row.extracted_brand or ""
        item_row.keywords = task_row.extracted_keywords
        item_row.embedding_id = emb_id
        item_row.recognition_status = "succeeded"
        item_row.recognition_source = task_row.recognition_source
        item_row.is_fallback = task_row.is_fallback
        item_row.confidence = task_row.confidence
        item_row.bbox = task_row.bbox
        item_row.latency_ms = latency_ms
        item_row.status = "matching"
        item_row.updated_at = done_iso

        db.merge(task_row)
        db.merge(item_row)
        db.flush()

        match_res = _recompute_and_persist_matches_for_item(db, item_row.to_dict())

        _add_audit_log(
            db,
            actor,
            "ITEM_PUBLISH_AND_RECOGNIZE",
            item_id,
            (
                f"发布{'失物' if item_type == 'lost' else '拾物'} [{item_row.title}]，"
                f"YOLO26n+OpenCLIP 识别原始类 [{task_row.raw_model_class}] -> 校园类 [{item_row.campus_category}]，"
                f"置信度={(task_row.confidence or 0)*100:.1f}%，特征缓存命中={cache_hit}，耗时={latency_ms}ms"
            ),
        )
        db.commit()
        return {
            "item": item_row.to_dict(),
            "task": task_row.to_dict(),
            "cacheHit": cache_hit,
            "matchStats": match_res["recallStats"],
        }
    except Exception as exc:
        err_msg = str(exc)[:450]
        fail_iso = _now_iso()
        task_row.status = "failed"
        task_row.error_message = err_msg
        task_row.latency_ms = int(round((time.perf_counter() - t0) * 1000))
        task_row.updated_at = fail_iso
        item_row.recognition_status = "failed"
        item_row.updated_at = fail_iso
        db.merge(task_row)
        db.merge(item_row)
        db.commit()
        raise HTTPException(status_code=500, detail=f"发布处理异常：{err_msg}")


@app.put("/api/items/{item_id}")
async def update_item(item_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    updates = body.get("updates") or body
    actor = body.get("actor") or {}
    item = db.get(ItemModel, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="物品不存在")

    now = _now_iso()
    clean_area = str(updates.get("locationArea") or item.location_area or "").strip()[:60]
    clean_detail = str(updates.get("locationDetail") if "locationDetail" in updates else (item.location_detail or "")).strip()[:140]
    composed = compose_campus_location(clean_area, clean_detail) if clean_area else item.location

    final_reward = item.reward_amount or 0
    if item.type == "lost" and "rewardAmount" in updates and updates["rewardAmount"] is not None:
        final_reward = max(0, min(9999, round(float(updates["rewardAmount"]))))
        if final_reward > 0:
            owner_row = db.get(UserModel, actor.get("uid", item.owner_uid or ""))
            avail = float(owner_row.wallet_balance if owner_row and owner_row.wallet_balance is not None else 85)
            max_allowed = max(avail, float(item.reward_amount or 0))
            if final_reward > max_allowed:
                raise HTTPException(
                    status_code=400,
                    detail=f"悬赏金额（¥{final_reward}）超出当前钱包可用余额（¥{int(avail)}），请调低悬赏金额后再保存",
                )

    if updates.get("title"):
        item.title = str(updates["title"]).strip()[:190]
    if updates.get("description"):
        item.description = str(updates["description"]).strip()[:1900]
    if updates.get("campusCategory"):
        item.campus_category = str(updates["campusCategory"])
    if "color" in updates:
        item.color = str(updates["color"] or "").strip()[:60]
    if "brand" in updates:
        item.brand = str(updates["brand"] or "").strip()[:100]
    item.reward_amount = final_reward
    item.location_area = clean_area
    item.location_detail = clean_detail
    item.location = composed[:190]
    if "conditionText" in updates:
        item.condition_text = str(updates["conditionText"] or "").strip()[:120]
    if "verificationQuestion" in updates:
        item.verification_question = str(updates["verificationQuestion"] or "").strip()[:280]
    item.updated_at = now
    db.add(item)
    db.flush()

    if item.status not in ("delisted", "returned"):
        _recompute_and_persist_matches_for_item(db, item.to_dict())

    _add_audit_log(
        db,
        actor,
        "ITEM_EDIT",
        item_id,
        f"用户 [{actor.get('displayName', '同学')}] 编辑帖子 [{item.title}]，地点=[{item.location}]，悬赏=[¥{int(item.reward_amount or 0)}]",
    )
    db.commit()
    return item.to_dict()


@app.patch("/api/items/{item_id}/status")
async def toggle_item_status(item_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    next_status = "delisted" if body.get("nextStatus") == "delisted" else "open"
    actor = body.get("actor") or {}
    item = db.get(ItemModel, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="物品不存在")

    item.status = next_status
    item.updated_at = _now_iso()
    db.add(item)

    if next_status == "delisted":
        db.query(MatchModel).filter(
            (MatchModel.lost_item_id == item_id) | (MatchModel.found_item_id == item_id)
        ).delete()
    else:
        db.flush()
        _recompute_and_persist_matches_for_item(db, item.to_dict())

    _add_audit_log(
        db,
        actor,
        "ITEM_USER_DELIST" if next_status == "delisted" else "ITEM_USER_RELIST",
        item_id,
        f"用户 [{actor.get('displayName', '同学')}] 将帖子 [{item.title}] 状态变更为 {next_status}",
    )
    db.commit()
    return item.to_dict()


@app.post("/api/items/{item_id}/delist")
async def admin_delist_item(item_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    actor = body.get("actor") or {}
    is_admin = (
        actor.get("role") == "admin"
        and str(actor.get("email") or "").lower() == ADMIN_WHITELIST_EMAIL.lower()
    )
    if not is_admin:
        raise HTTPException(
            status_code=403,
            detail=f"权限不足：仅管理员白名单账号 ({ADMIN_WHITELIST_EMAIL}) 可执行物品下架操作",
        )
    item = db.get(ItemModel, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="物品不存在")
    now = _now_iso()
    item.status = "delisted"
    item.updated_at = now
    db.add(item)
    db.query(MatchModel).filter(
        (MatchModel.lost_item_id == item_id) | (MatchModel.found_item_id == item_id)
    ).delete()
    _add_audit_log(
        db,
        actor,
        "ITEM_DELIST",
        item_id,
        f"管理员 [{actor.get('email')}] 下架物品 [ID={item_id}，标题={item.title}]，状态设为 delisted 并移出匹配候选池。",
    )
    db.commit()
    return item.to_dict()


@app.post("/api/items/{item_id}/correct-category")
async def correct_item_category(item_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    new_cat = str(body.get("newCategory") or "数码电子")
    actor = body.get("actor") or {}
    item = db.get(ItemModel, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="物品不存在")
    old_cat = item.campus_category
    now = _now_iso()
    item.campus_category = new_cat
    item.manual_category_override = new_cat
    item.updated_at = now
    db.add(item)

    fb = MatchFeedbackModel(
        id=f"fb_cat_{item_id}_{int(time.time() * 1000)}",
        match_id=f"item_override_{item_id}",
        item_id=item_id,
        user_uid=str(actor.get("uid") or "system"),
        user_name=str(actor.get("displayName") or "管理员"),
        action="correct_category",
        corrected_category=new_cat,
        reason=f"人工将物品类别从 [{old_cat}] 修正为 [{new_cat}]",
        created_at=now,
    )
    db.add(fb)
    _add_audit_log(
        db,
        actor,
        "CATEGORY_MANUAL_OVERRIDE",
        item_id,
        f"人工纠错物品 [{item.title}] 类别：{old_cat} -> {new_cat}",
    )
    db.flush()
    _recompute_and_persist_matches_for_item(db, item.to_dict())
    db.commit()
    return item.to_dict()


@app.post("/api/items/{item_id}/rematch")
async def rematch_item(item_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json() if await request.body() else {}
    item = db.get(ItemModel, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="物品不存在")
    res = _recompute_and_persist_matches_for_item(db, item.to_dict(), body.get("config"))
    db.commit()
    return res


@app.post("/api/tasks/{task_id}/retry")
async def retry_task(task_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json() if await request.body() else {}
    actor = body.get("actor") or {}
    task = db.get(RecognitionTaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="识别任务不存在")
    item = db.get(ItemModel, task.item_id)
    if not item:
        raise HTTPException(status_code=404, detail="关联物品不存在")

    task.retry_count = (task.retry_count or 0) + 1
    task.status = "running"
    task.error_message = ""
    task.updated_at = _now_iso()
    db.add(task)
    db.flush()

    t0 = time.perf_counter()
    try:
        recog = ai_engine.recognize_image(
            image_url=item.image_url,
            title=item.title,
            description=item.description,
        )
        emb_res = None
        if item.image_url:
            emb_res = _get_or_encode_embedding(
                db,
                sha256=item.image_sha256 or f"sha256_item_{item.id}",
                item_id=item.id,
                image_url=item.image_url,
                title=item.title,
                description=item.description,
                category_hint=recog.get("mappedCampusCategory", item.campus_category),
                color_hint=item.color or "",
            )
        now = _now_iso()
        task.status = "succeeded"
        task.model_version = recog["modelVersion"]
        task.recognition_source = recog["recognitionSource"]
        task.is_fallback = False
        task.raw_model_class = recog["rawModelClass"]
        task.mapped_campus_category = recog["mappedCampusCategory"]
        task.confidence = recog["confidence"]
        task.bbox = recog["bbox"]
        task.latency_ms = recog["latencyMs"]
        task.cache_hit = bool(emb_res["cacheHit"]) if emb_res else task.cache_hit
        task.embedding_id = emb_res["embedding"]["id"] if emb_res else item.embedding_id
        task.updated_at = now

        item.raw_model_class = task.raw_model_class
        if task.mapped_campus_category and task.mapped_campus_category != "unknown":
            item.campus_category = task.mapped_campus_category
        item.embedding_id = task.embedding_id
        item.recognition_status = "succeeded"
        item.confidence = task.confidence
        item.bbox = task.bbox
        item.latency_ms = task.latency_ms
        item.updated_at = now
        db.add(task)
        db.add(item)
        _add_audit_log(
            db,
            actor,
            "TASK_MANUAL_RETRY",
            task_id,
            f"管理员手动重试识别任务 [{task_id}] (第 {task.retry_count} 次) 成功，耗时 {task.latency_ms}ms。",
        )
        db.commit()
        return task.to_dict()
    except Exception as exc:
        task.status = "failed"
        task.error_message = str(exc)[:450]
        task.latency_ms = int(round((time.perf_counter() - t0) * 1000))
        task.updated_at = _now_iso()
        item.recognition_status = "failed"
        db.add(task)
        db.add(item)
        db.commit()
        return task.to_dict()


# =========================================================================
# 8. Match Feedback
# =========================================================================

@app.post("/api/matches/{match_id}/feedback")
async def match_feedback(match_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    action = str(body.get("action") or "confirm")
    reason = str(body.get("reason") or "")[:400]
    actor = body.get("actor") or {}
    match = db.get(MatchModel, match_id)
    if not match:
        raise HTTPException(status_code=404, detail="匹配记录不存在")

    new_status = "confirmed" if action == "confirm" else ("excluded" if action == "exclude" else "candidate")
    now = _now_iso()
    match.status = new_status
    match.updated_at = now
    db.add(match)

    fb = MatchFeedbackModel(
        id=f"fb_{match_id}_{int(time.time() * 1000)}",
        match_id=match_id,
        item_id=match.lost_item_id,
        user_uid=str(actor.get("uid") or "system"),
        user_name=str(actor.get("displayName") or "同学"),
        action=action,
        reason=reason,
        created_at=now,
    )
    db.add(fb)
    _add_audit_log(
        db,
        actor,
        f"MATCH_{action.upper()}",
        match_id,
        f"用户对匹配记录 [{match_id}] 执行 {action} 操作，当前状态={new_status}。",
    )
    db.commit()
    return match.to_dict()


# =========================================================================
# 9. Claims, Admin Review, 6-Digit Handover Verification & Mutual Review
# =========================================================================

@app.post("/api/claims")
async def create_claim(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    actor = body.get("actor") or {}
    item_id = str(body.get("itemId") or "")
    item = db.get(ItemModel, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="目标物品不存在")
    if item.owner_uid == actor.get("uid"):
        raise HTTPException(status_code=400, detail="不能对本人发布的帖子提交认领或归还申请")
    if item.status in ("delisted", "returned", "handover"):
        raise HTTPException(status_code=400, detail="该物品当前状态不支持发起新的核验申请")

    clean_ans = str(body.get("verificationAnswer") or "").strip()[:480]
    if not clean_ans:
        raise HTTPException(status_code=400, detail="请填写物品细节特征回答")

    claim_id = f"claim_{item_id}_{actor.get('uid')}"
    existing = db.get(ClaimModel, claim_id)
    if existing:
        if existing.status in ("pending_review", "approved_handover"):
            raise HTTPException(
                status_code=400,
                detail="您已提交过该物品的核验申请，请在「我的 → 认领进度与交接码」查看审核与交接进度",
            )
        if existing.status == "completed":
            raise HTTPException(status_code=400, detail="该物品已完成当面交接归还，无需重复提交")

    now = _now_iso()
    claim_type = "return_lost" if item.type == "lost" else "claim_found"
    loser_uid = item.owner_uid if claim_type == "return_lost" else actor.get("uid")
    finder_uid = item.owner_uid if claim_type == "claim_found" else actor.get("uid")
    handover_code = str(random.randint(100000, 999999))

    row = existing or ClaimModel(id=claim_id, created_at=now)
    row.item_id = item_id
    row.item_title = item.title
    row.match_id = body.get("matchId") or row.match_id
    row.claim_type = claim_type
    row.loser_uid = loser_uid
    row.finder_uid = finder_uid
    row.claimant_uid = str(actor.get("uid"))
    row.claimant_name = str(actor.get("displayName") or "同学")
    row.claimant_email = str(actor.get("email") or "")
    row.verification_question = item.verification_question or "请描述物品独有特征（如贴纸、尾号、磨损位置）："
    row.verification_answer = clean_ans
    row.status = "pending_review"
    row.handover_code = handover_code
    row.qr_payload = handover_code
    row.updated_at = now
    db.merge(row)

    item.status = "claiming"
    item.updated_at = now
    db.add(item)

    _add_audit_log(
        db,
        actor,
        "CLAIM_RESUBMIT" if existing else "CLAIM_SUBMIT",
        claim_id,
        f"{'补充特征重新提交' if existing else '提交'}{'失物归还线索' if claim_type == 'return_lost' else '拾物认领申请'} [{item.title}]，等待管理员初审。",
    )
    db.commit()
    return row.to_dict()


@app.post("/api/claims/{claim_id}/review")
async def review_claim(claim_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    actor = body.get("actor") or {}
    decision = str(body.get("decision") or "rejected")
    review_note = str(body.get("reviewNote") or "")[:300]

    if actor.get("role") != "admin":
        raise HTTPException(status_code=403, detail="权限不足：仅失物招领中心管理员可执行认领审核操作")

    claim = db.get(ClaimModel, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="认领单不存在")
    item = db.get(ItemModel, claim.item_id)
    roles = resolve_claim_role_actors(claim.to_dict(), item.to_dict() if item else None)
    now = _now_iso()
    clean_reviewer = _clean_name(actor.get("displayName"))

    claim.claim_type = roles["claimType"]
    claim.loser_uid = roles["loserUid"]
    claim.finder_uid = roles["finderUid"]
    claim.status = decision
    claim.reviewed_by = clean_reviewer
    claim.review_note = review_note
    claim.updated_at = now
    db.add(claim)

    other_claims = (
        db.query(ClaimModel)
        .filter(ClaimModel.item_id == claim.item_id, ClaimModel.id != claim_id)
        .all()
    )

    if decision == "approved_handover":
        for oc in other_claims:
            if oc.status == "pending_review":
                oc.status = "rejected"
                oc.reviewed_by = clean_reviewer
                oc.review_note = "该物品已有其他申请人通过特征初审进入当面交接环节。"
                oc.updated_at = now
                db.add(oc)
        if item:
            item.status = "handover"
            item.updated_at = now
            db.add(item)
    elif item:
        has_approved = any(c.status == "approved_handover" for c in other_claims)
        has_pending = any(c.status == "pending_review" for c in other_claims)
        item.status = "handover" if has_approved else ("claiming" if has_pending else "matching")
        item.updated_at = now
        db.add(item)

    _add_audit_log(
        db,
        actor,
        "CLAIM_APPROVE" if decision == "approved_handover" else "CLAIM_REJECT",
        claim_id,
        f"管理员审核认领单 [{claim_id}] 结果：{'审核通过进入当面交接' if decision == 'approved_handover' else '驳回'}。备注：{review_note}",
    )
    db.commit()
    return claim.to_dict()


@app.post("/api/claims/{claim_id}/verify-handover")
async def verify_handover(claim_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    input_code = str(body.get("inputCode") or "").strip()
    actor = body.get("actor") or {}

    claim = db.get(ClaimModel, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="交接单不存在")
    if claim.status == "completed":
        raise HTTPException(status_code=400, detail="该交接单已完成核销，无需重复操作")

    target_item = db.get(ItemModel, claim.item_id)
    roles = resolve_claim_role_actors(claim.to_dict(), target_item.to_dict() if target_item else None)
    loser_uid = roles["loserUid"]
    finder_uid = roles["finderUid"]

    is_admin = actor.get("role") == "admin"
    can_verify = is_admin or (bool(finder_uid) and actor.get("uid") == finder_uid and actor.get("uid") != loser_uid)
    if not can_verify:
        raise HTTPException(status_code=403, detail="权限不足：仅实物持有人（拾主）或值班管理员可输入交接码完成核销")
    if input_code != claim.handover_code.strip():
        raise HTTPException(status_code=400, detail="输入的 6 位交接核验码不正确，请与失主当面核对后重试")

    now = _now_iso()
    paired_opposite: Optional[ItemModel] = None
    winning_match: Optional[MatchModel] = None
    related_matches: Dict[str, MatchModel] = {}

    if target_item:
        if target_item.type == "found":
            primary_ms = db.query(MatchModel).filter(MatchModel.found_item_id == target_item.id).all()
        else:
            primary_ms = db.query(MatchModel).filter(MatchModel.lost_item_id == target_item.id).all()
        for m in primary_ms:
            related_matches[m.id] = m
        if claim.match_id and claim.match_id not in related_matches:
            em = db.get(MatchModel, claim.match_id)
            if em:
                related_matches[em.id] = em

        valid_ms = sorted(
            [
                m
                for m in related_matches.values()
                if m.status != "excluded" and m.total_score >= DEFAULT_MATCHING_CONFIG["decisionThreshold"]
            ],
            key=lambda x: x.total_score,
            reverse=True,
        )
        expected_opp_owner = loser_uid if target_item.type == "found" else finder_uid
        for cm in valid_ms:
            opp_id = cm.lost_item_id if target_item.type == "found" else cm.found_item_id
            opp_item = db.get(ItemModel, opp_id)
            if opp_item and opp_item.owner_uid == expected_opp_owner:
                paired_opposite = opp_item
                winning_match = cm
                break

        if paired_opposite:
            sec_ms = (
                db.query(MatchModel)
                .filter(
                    (MatchModel.found_item_id == paired_opposite.id)
                    if paired_opposite.type == "found"
                    else (MatchModel.lost_item_id == paired_opposite.id)
                )
                .all()
            )
            for m in sec_ms:
                related_matches[m.id] = m

    # Dual-sided bounty settlement
    lost_for_bounty = target_item if (target_item and target_item.type == "lost") else paired_opposite
    real_reward = max(0, round(float(lost_for_bounty.reward_amount or 0))) if lost_for_bounty else 0
    if not claim.bounty_settled and real_reward > 0 and loser_uid and finder_uid and loser_uid != finder_uid:
        loser_user = db.get(UserModel, loser_uid)
        finder_user = db.get(UserModel, finder_uid)
        if not loser_user:
            raise HTTPException(status_code=400, detail="未找到失主账户资料，无法完成悬赏金扣款核销")
        _record_wallet_tx(
            db,
            loser_user,
            title=f"归还核销《{lost_for_bounty.title}》支付悬赏赏金",
            tx_type="expense",
            amount=real_reward,
            item_id=lost_for_bounty.id,
            counterparty_name=_clean_name(finder_user.display_name if finder_user else "拾主同学"),
        )
        if finder_user:
            _record_wallet_tx(
                db,
                finder_user,
                title=f"完成《{(target_item or lost_for_bounty).title}》当面归还领取悬赏赏金",
                tx_type="income",
                amount=real_reward,
                item_id=(target_item or lost_for_bounty).id,
                counterparty_name=_clean_name(loser_user.display_name),
            )

    claim.claim_type = roles["claimType"]
    claim.loser_uid = loser_uid
    claim.finder_uid = finder_uid
    claim.status = "completed"
    claim.bounty_settled = True
    claim.updated_at = now
    db.add(claim)

    if target_item:
        target_item.status = "returned"
        target_item.updated_at = now
        db.add(target_item)
    if paired_opposite and paired_opposite.id != (target_item.id if target_item else "") and paired_opposite.status not in ("delisted", "returned"):
        paired_opposite.status = "returned"
        paired_opposite.updated_at = now
        db.add(paired_opposite)

    for m in related_matches.values():
        if winning_match and m.id == winning_match.id:
            m.status = "confirmed"
            m.updated_at = now
            db.add(m)
        elif m.status == "candidate":
            db.delete(m)

    affected_ids = [x for x in {claim.item_id, paired_opposite.id if paired_opposite else None} if x]
    for aff_id in affected_ids:
        for oc in db.query(ClaimModel).filter(ClaimModel.item_id == aff_id, ClaimModel.id != claim.id).all():
            if oc.status in ("pending_review", "approved_handover"):
                oc.status = "rejected"
                oc.reviewed_by = "系统管理员"
                oc.review_note = "该物品已完成当面核验归还，其余申请自动关闭。"
                oc.updated_at = now
                db.add(oc)

    _add_audit_log(
        db,
        actor,
        "HANDOVER_COMPLETE",
        claim_id,
        f"凭 6 位交接码完成物品 [{claim.item_title or claim.item_id}] 当面归还核销"
        + (f"，同步完结关联配对帖 [{paired_opposite.title}]" if paired_opposite else "")
        + (f"，悬赏金 ¥{real_reward} 已双边闭环结算" if real_reward > 0 else "")
        + "。",
    )
    db.commit()
    return claim.to_dict()


@app.post("/api/claims/{claim_id}/mutual-review")
async def mutual_review_claim(claim_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    actor = body.get("actor") or {}
    rating = str(body.get("rating") or "好评")
    content = str(body.get("content") or "").strip()[:300]
    if not content:
        raise HTTPException(status_code=400, detail="请填写评价内容")

    claim = db.get(ClaimModel, claim_id)
    if not claim or claim.status != "completed":
        raise HTTPException(status_code=400, detail="仅已完成当面交接归还的记录可提交互评")

    item = db.get(ItemModel, claim.item_id)
    roles = resolve_claim_role_actors(claim.to_dict(), item.to_dict() if item else None)
    is_loser = bool(roles["loserUid"] and actor.get("uid") == roles["loserUid"])
    is_finder = bool(roles["finderUid"] and actor.get("uid") == roles["finderUid"])
    if not is_loser and not is_finder:
        raise HTTPException(status_code=403, detail="仅本次交接的失主或拾主双方可进行互评")

    target_uid = roles["finderUid"] if is_loser else roles["loserUid"]
    already = list(claim.reviewed_participant_uids or [])
    if actor.get("uid") in already:
        raise HTTPException(status_code=400, detail="您已完成本次交接的评价，请勿重复提交")

    target_user = db.get(UserModel, target_uid)
    if not target_user:
        raise HTTPException(status_code=404, detail="未找到对方账户资料")

    now = _now_iso()
    new_rev = {
        "id": f"rev_{int(time.time() * 1000)}_{secrets.token_hex(2)}",
        "reviewerName": _clean_name(actor.get("displayName"))[:50],
        "roleTag": "失主评价" if is_loser else "拾主评价",
        "rating": rating,
        "content": content,
        "itemTitle": (claim.item_title or (item.title if item else "校园失物招领物品"))[:120],
        "createdAt": now,
    }
    target_user.reviews = [new_rev, *(target_user.reviews or [])][:40]
    target_user.updated_at = now
    claim.reviewed_participant_uids = list(dict.fromkeys([*already, actor.get("uid")]))[:5]
    claim.updated_at = now
    db.add(target_user)
    db.add(claim)

    _add_audit_log(
        db,
        actor,
        "HANDOVER_MUTUAL_REVIEW",
        claim_id,
        f"交接互评：{actor.get('displayName')} 对 [{target_user.display_name}] 提交 {rating}（{new_rev['roleTag']}）",
    )
    db.commit()
    return {"ok": True, "claim": claim.to_dict()}


# =========================================================================
# 10. Messages & Audit Logs
# =========================================================================

@app.post("/api/messages")
async def send_message(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    actor = body.get("actor") or {}
    now = _now_iso()
    msg = MessageModel(
        id=f"msg_{int(time.time() * 1000)}_{secrets.token_hex(2)}",
        item_id=str(body.get("itemId") or ""),
        item_title=str(body.get("itemTitle") or "")[:150] or None,
        sender_uid=str(actor.get("uid") or "demo_student_li"),
        sender_name=_clean_name(actor.get("displayName")),
        sender_role=str(actor.get("role") or "student"),
        receiver_uid=str(body.get("receiverUid") or "admin_shx614519"),
        content=str(body.get("content") or "").strip()[:950],
        created_at=now,
    )
    db.add(msg)
    db.commit()
    return msg.to_dict()


@app.post("/api/audit-logs")
async def create_audit_log_endpoint(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    entry = _add_audit_log(
        db,
        body.get("actor"),
        str(body.get("action") or "SYSTEM_EVENT"),
        str(body.get("targetId") or ""),
        str(body.get("detail") or ""),
    )
    db.commit()
    return entry.to_dict()


# =========================================================================
# 11. Static Files (/images, /uploads, and production frontend dist/)
# =========================================================================

if PUBLIC_IMAGES_DIR.exists():
    app.mount("/images", StaticFiles(directory=str(PUBLIC_IMAGES_DIR)), name="images")
    app.mount("/src/assets/images", StaticFiles(directory=str(PUBLIC_IMAGES_DIR)), name="asset_images")

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

if DIST_DIR.exists() and (DIST_DIR / "index.html").exists():
    assets_dir = DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="dist_assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        candidate = DIST_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(DIST_DIR / "index.html"))
