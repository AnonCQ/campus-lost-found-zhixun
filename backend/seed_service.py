"""
Deterministic Idempotent Database Seeder & Reset Service
Populates the SQLite/MySQL database with:
- 5 preset campus users (4 students + 1 whitelisted admin)
- 16 deterministic demo items (8 lost + 8 found: 6 matched pairs + 4 singletons)
- Real 512D L2-normalized OpenCLIP ViT-B/32 visual embeddings computed from actual public/images/* files
- Recognition tasks, initial 3-way recall matches, claims, messages, and audit logs
"""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.ai_engine import ai_engine
from backend.config import (
    DATA_DIR,
    EMBEDDING_MODEL_VERSION,
    PUBLIC_IMAGES_DIR,
    RECOGNITION_MODEL_VERSION,
)
from backend.constants import (
    get_deterministic_embedding_id,
    get_deterministic_match_id,
    resolve_claim_role_actors,
)
from backend.matching_engine import evaluate_candidate_pair
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

SEED_BUNDLE_PATH = DATA_DIR / "seed_bundle.json"


def _load_seed_bundle() -> Dict[str, Any]:
    return json.loads(SEED_BUNDLE_PATH.read_text(encoding="utf-8"))


def _upsert_user(db: Session, u: Dict[str, Any]) -> None:
    obj = db.get(UserModel, u["uid"]) or UserModel(uid=u["uid"])
    obj.email = u["email"]
    obj.display_name = u["displayName"]
    obj.role = u.get("role", "student")
    obj.phone = u.get("phone")
    obj.student_id = u.get("studentId")
    obj.department = u.get("department")
    obj.class_name = u.get("className")
    obj.bio = u.get("bio")
    obj.birthday = u.get("birthday")
    obj.avatar_url = u.get("avatarUrl")
    obj.browsed_item_ids = u.get("browsedItemIds") or []
    obj.read_notification_ids = u.get("readNotificationIds") or []
    obj.dark_mode = bool(u.get("darkMode", False))
    obj.push_notify_enabled = True if u.get("pushNotifyEnabled") is None else bool(u.get("pushNotifyEnabled"))
    obj.wallet_balance = float(u.get("walletBalance", 85))
    obj.wallet_transactions = u.get("walletTransactions") or []
    obj.reviews = u.get("reviews") or []
    obj.is_demo_role = True
    obj.created_at = u.get("createdAt") or datetime.now(timezone.utc).isoformat()
    obj.updated_at = u.get("updatedAt")
    db.merge(obj)


def execute_deterministic_seed(
    db: Session,
    mode: str = "if_empty",
    actor: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    bundle = _load_seed_bundle()
    seed_users: List[Dict[str, Any]] = bundle["users"]
    seed_items: List[Dict[str, Any]] = bundle["items"]
    seed_claims: List[Dict[str, Any]] = bundle["claims"]
    seed_messages: List[Dict[str, Any]] = bundle["messages"]
    seed_audit_logs: List[Dict[str, Any]] = bundle["auditLogs"]

    existing_items = db.query(ItemModel).all()
    existing_embs = db.query(ImageEmbeddingModel).all()

    if mode == "if_empty" and len(existing_items) >= len(seed_items) and len(existing_embs) > 0:
        valid_clip_embs = all(
            e.model_version == EMBEDDING_MODEL_VERSION and e.dimension >= 256
            for e in existing_embs
        )
        if valid_clip_embs:
            return {
                "seeded": False,
                "mode": mode,
                "itemCount": len(existing_items),
                "embeddingCount": len(existing_embs),
                "embeddingDimension": existing_embs[0].dimension,
                "embeddingModelVersion": EMBEDDING_MODEL_VERSION,
                "matchCount": db.query(MatchModel).count(),
                "engine": "fastapi-sqlalchemy-sqlite",
            }

    # Ensure YOLO26n + OpenCLIP ViT-B/32 are ready
    ai_engine.ensure_loaded()

    # Clear tables in FK-safe order
    for model_cls in (
        MatchFeedbackModel,
        MatchModel,
        ClaimModel,
        RecognitionTaskModel,
        MessageModel,
        AuditLogModel,
        ItemModel,
        ImageEmbeddingModel,
    ):
        db.query(model_cls).delete()
    db.flush()

    # 1. Users
    for u in seed_users:
        _upsert_user(db, u)
    db.flush()

    # 2. Compute genuine 512D OpenCLIP embeddings for each unique seed image
    vectors_by_sha: Dict[str, List[float]] = {}
    emb_records_by_id: Dict[str, ImageEmbeddingModel] = {}

    for item in seed_items:
        img_url = item.get("imageUrl") or ""
        sha_hint = item.get("imageSha256") or ""
        if img_url.startswith("/images/"):
            fp = PUBLIC_IMAGES_DIR / img_url.split("/")[-1]
            if fp.exists():
                actual_sha = f"sha256_{hashlib.sha256(fp.read_bytes()).hexdigest()}"
                if not sha_hint:
                    sha_hint = actual_sha
        emb_id = get_deterministic_embedding_id(sha_hint, EMBEDDING_MODEL_VERSION)
        item["imageSha256"] = sha_hint
        item["embeddingId"] = emb_id
        item["modelVersion"] = RECOGNITION_MODEL_VERSION

        if sha_hint not in vectors_by_sha:
            encoded = ai_engine.encode_image_embedding(
                image_url=img_url, sha256_hint=sha_hint
            )
            vectors_by_sha[sha_hint] = encoded["vector"]
            emb_records_by_id[emb_id] = ImageEmbeddingModel(
                id=emb_id,
                sha256=sha_hint,
                model_version=EMBEDDING_MODEL_VERSION,
                dimension=encoded["dimension"],
                vector=encoded["vector"],
                item_id=item["id"],
                visual_summary=f"{item.get('campusCategory', '')} · {item.get('color', '')} · {item.get('rawModelClass', '')}",
                created_at=item.get("createdAt") or datetime.now(timezone.utc).isoformat(),
            )

    for emb_obj in emb_records_by_id.values():
        db.add(emb_obj)

    # 3. Items & Recognition Tasks
    emb_by_item_id: Dict[str, List[float]] = {}
    for idx, item in enumerate(seed_items):
        db.add(
            ItemModel(
                id=item["id"],
                type=item["type"],
                title=item["title"],
                description=item["description"],
                campus_category=item["campusCategory"],
                raw_model_class=item.get("rawModelClass"),
                manual_category_override=item.get("manualCategoryOverride"),
                color=item.get("color"),
                quantity=item.get("quantity", 1),
                brand=item.get("brand"),
                reward_amount=item.get("rewardAmount", 0),
                location_area=item.get("locationArea"),
                location_detail=item.get("locationDetail"),
                location=item["location"],
                event_time=item["eventTime"],
                condition_text=item.get("conditionText"),
                keywords=item.get("keywords") or [],
                image_url=item.get("imageUrl"),
                storage_path=item.get("storagePath"),
                image_sha256=item.get("imageSha256"),
                embedding_id=item.get("embeddingId"),
                recognition_task_id=item.get("recognitionTaskId") or f"task_{item['id']}",
                recognition_status="succeeded",
                confidence=item.get("confidence", 0.94),
                bbox=item.get("bbox"),
                latency_ms=item.get("latencyMs", 45),
                model_version=RECOGNITION_MODEL_VERSION,
                recognition_source="model",
                is_fallback=False,
                fallback_reason=None,
                status=item.get("status", "open"),
                owner_uid=item.get("ownerUid"),
                owner_name=item.get("ownerName"),
                owner_email=item.get("ownerEmail"),
                verification_question=item.get("verificationQuestion"),
                verification_answer_hint=item.get("verificationAnswerHint"),
                is_seeded_demo=True,
                created_at=item["createdAt"],
                updated_at=item.get("updatedAt") or item["createdAt"],
            )
        )
        if item.get("imageSha256") in vectors_by_sha:
            emb_by_item_id[item["id"]] = vectors_by_sha[item["imageSha256"]]

        db.add(
            RecognitionTaskModel(
                id=item.get("recognitionTaskId") or f"task_{item['id']}",
                item_id=item["id"],
                item_title=item["title"],
                idempotency_key=f"idem_{item['id']}_{item.get('imageSha256', idx)}",
                status="succeeded",
                retry_count=0,
                max_retries=3,
                model_version=RECOGNITION_MODEL_VERSION,
                raw_model_class=item.get("rawModelClass") or "object",
                mapped_campus_category=item["campusCategory"],
                confidence=item.get("confidence", 0.94),
                bbox=item.get("bbox") or [100, 150, 800, 750],
                extracted_color=item.get("color") or "未知",
                extracted_brand=item.get("brand") or "",
                extracted_keywords=item.get("keywords") or [],
                latency_ms=item.get("latencyMs", 45),
                cache_hit=(item["type"] == "found"),
                embedding_id=item.get("embeddingId"),
                recognition_source="model",
                is_fallback=False,
                fallback_reason=None,
                created_at=item["createdAt"],
                updated_at=item.get("updatedAt") or item["createdAt"],
            )
        )

    db.flush()

    # 4. Matches for the 6 paired items (01..06) using REAL OpenCLIP 512D cosine similarity
    item_by_id = {it["id"]: it for it in seed_items}
    match_count = 0
    for idx, suffix in enumerate(["01", "02", "03", "04", "05", "06"]):
        lost = item_by_id.get(f"demo_lost_{suffix}")
        found = item_by_id.get(f"demo_found_{suffix}")
        if not lost or not found:
            continue
        ev = evaluate_candidate_pair(
            lost,
            found,
            emb_by_item_id.get(lost["id"]),
            emb_by_item_id.get(found["id"]),
            ["category_family", "text_keyword", "image_vector"],
        )
        m_id = get_deterministic_match_id(lost["id"], found["id"])
        db.add(
            MatchModel(
                id=m_id,
                lost_item_id=lost["id"],
                found_item_id=found["id"],
                total_score=ev["totalScore"],
                rule_score_7d=ev["ruleScore7D"],
                image_similarity=ev["imageSimilarity"],
                conflict_penalty=ev["conflictPenalty"],
                dimension_scores=ev["dimensionScores"],
                recall_sources=ev["recallSources"],
                conflict_reasons=ev["conflictReasons"],
                explanation_summary=ev["explanationSummary"],
                algorithm_version=ev["algorithmVersion"],
                status="confirmed" if idx in (1, 2) else "candidate",
                created_at=found["createdAt"],
                updated_at=found.get("updatedAt") or found["createdAt"],
            )
        )
        match_count += 1

    # 5. Claims
    for c in seed_claims:
        target_item = item_by_id.get(c["itemId"])
        roles = resolve_claim_role_actors(c, target_item)
        db.add(
            ClaimModel(
                id=c["id"],
                item_id=c["itemId"],
                item_title=c.get("itemTitle"),
                match_id=c.get("matchId"),
                claim_type=roles["claimType"],
                loser_uid=roles["loserUid"],
                finder_uid=roles["finderUid"],
                claimant_uid=c["claimantUid"],
                claimant_name=c["claimantName"],
                claimant_email=c.get("claimantEmail"),
                verification_question=c.get("verificationQuestion"),
                verification_answer=c["verificationAnswer"],
                status=c["status"],
                handover_code=c["handoverCode"],
                qr_payload=c.get("qrPayload") or c["handoverCode"],
                reviewed_by=c.get("reviewedBy"),
                review_note=c.get("reviewNote"),
                bounty_settled=bool(c.get("bountySettled", False)),
                reviewed_participant_uids=c.get("reviewedParticipantUids") or [],
                created_at=c["createdAt"],
                updated_at=c.get("updatedAt") or c["createdAt"],
            )
        )

    # 6. Messages
    for m in seed_messages:
        db.add(
            MessageModel(
                id=m["id"],
                item_id=m["itemId"],
                item_title=m.get("itemTitle"),
                sender_uid=m["senderUid"],
                sender_name=m["senderName"],
                sender_role=m.get("senderRole"),
                receiver_uid=m.get("receiverUid"),
                content=m["content"],
                created_at=m["createdAt"],
            )
        )

    # 7. Audit logs
    for log in seed_audit_logs:
        db.add(
            AuditLogModel(
                id=log["id"],
                actor_uid=log["actorUid"],
                actor_name=log.get("actorName"),
                actor_role=log.get("actorRole"),
                action=log["action"],
                target_id=log["targetId"],
                detail=log["detail"],
                created_at=log["createdAt"],
            )
        )

    if actor and mode == "reset":
        now_iso = datetime.now(timezone.utc).isoformat()
        db.add(
            AuditLogModel(
                id=f"audit_reset_{int(datetime.now().timestamp())}",
                actor_uid=actor.get("uid", "admin_shx614519"),
                actor_name=actor.get("displayName", "张老师"),
                actor_role=actor.get("role", "admin"),
                action="DEMO_DATA_RESET",
                target_id="items_16_deterministic",
                detail=(
                    f"FastAPI 服务端幂等重置完成：恢复 16 条初始物品（8 失物 + 8 拾物）及 "
                    f"{len(emb_records_by_id)} 条真实 OpenCLIP ViT-B/32 (512D) 图像特征向量。"
                ),
                created_at=now_iso,
            )
        )

    db.commit()
    return {
        "seeded": True,
        "mode": mode,
        "itemCount": len(seed_items),
        "embeddingCount": len(emb_records_by_id),
        "embeddingDimension": ai_engine.clip_embed_dim,
        "embeddingModelVersion": EMBEDDING_MODEL_VERSION,
        "matchCount": match_count,
        "engine": "fastapi-sqlalchemy-sqlite",
    }
