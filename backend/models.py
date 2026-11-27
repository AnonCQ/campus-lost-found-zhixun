"""
SQLAlchemy ORM Models for the Smart Campus Lost & Found System (9 Core Tables)

Tables:
1. users              - Campus students & administrators, wallet balance, preferences, reviews
2. items              - Lost & found item posts, detection metadata, lifecycle status
3. image_embeddings   - Cached 512D L2-normalized OpenCLIP ViT-B/32 visual vectors keyed by (sha256, model_version)
4. recognition_tasks  - Async YOLO26n + OpenCLIP recognition state machine (pending/running/succeeded/failed)
5. matches            - Explainable 3-way recall & 7-dimension reranking match candidates
6. match_feedback     - User/admin match confirmation, exclusion, and manual category overrides
7. claims             - Verification claims, admin review, 6-digit handover codes, mutual reviews
8. messages           - Two-party campus in-site messages & admin service messages
9. audit_logs         - Complete security & operational audit trail
"""

from sqlalchemy import (
    Boolean,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from backend.database import Base


class UserModel(Base):
    __tablename__ = "users"

    uid = Column(String(128), primary_key=True, index=True)
    email = Column(String(256), nullable=False, index=True)
    display_name = Column(String(100), nullable=False)
    role = Column(String(20), nullable=False, default="student")
    phone = Column(String(32), nullable=True)
    student_id = Column(String(64), nullable=True, index=True)
    department = Column(String(128), nullable=True)
    class_name = Column(String(128), nullable=True)
    bio = Column(String(300), nullable=True)
    birthday = Column(String(32), nullable=True)
    avatar_url = Column(Text, nullable=True)
    browsed_item_ids = Column(JSON, nullable=True, default=list)
    read_notification_ids = Column(JSON, nullable=True, default=list)
    dark_mode = Column(Boolean, nullable=True, default=False)
    push_notify_enabled = Column(Boolean, nullable=True, default=True)
    wallet_balance = Column(Float, nullable=True, default=85.0)
    wallet_transactions = Column(JSON, nullable=True, default=list)
    reviews = Column(JSON, nullable=True, default=list)
    is_demo_role = Column(Boolean, nullable=True, default=True)
    created_at = Column(String(64), nullable=False)
    updated_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "uid": self.uid,
            "email": self.email,
            "displayName": self.display_name,
            "role": self.role,
            "phone": self.phone,
            "studentId": self.student_id,
            "department": self.department,
            "className": self.class_name,
            "bio": self.bio,
            "birthday": self.birthday,
            "avatarUrl": self.avatar_url,
            "browsedItemIds": self.browsed_item_ids or [],
            "readNotificationIds": self.read_notification_ids or [],
            "darkMode": bool(self.dark_mode) if self.dark_mode is not None else False,
            "pushNotifyEnabled": True if self.push_notify_enabled is None else bool(self.push_notify_enabled),
            "walletBalance": self.wallet_balance if self.wallet_balance is not None else 85,
            "walletTransactions": self.wallet_transactions or [],
            "reviews": self.reviews or [],
            "isDemoRole": bool(self.is_demo_role) if self.is_demo_role is not None else True,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class ItemModel(Base):
    __tablename__ = "items"

    id = Column(String(128), primary_key=True, index=True)
    type = Column(String(16), nullable=False, index=True)  # lost | found
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False)
    campus_category = Column(String(64), nullable=False, index=True)
    raw_model_class = Column(String(100), nullable=True)
    manual_category_override = Column(String(64), nullable=True)
    color = Column(String(64), nullable=True)
    quantity = Column(Integer, nullable=True, default=1)
    brand = Column(String(100), nullable=True)
    reward_amount = Column(Float, nullable=True, default=0.0)
    location_area = Column(String(64), nullable=True, index=True)
    location_detail = Column(String(160), nullable=True)
    location = Column(String(200), nullable=False)
    event_time = Column(String(64), nullable=False, index=True)
    condition_text = Column(String(160), nullable=True)
    keywords = Column(JSON, nullable=True, default=list)
    image_url = Column(Text, nullable=True)
    storage_path = Column(String(256), nullable=True)
    image_sha256 = Column(String(128), nullable=True, index=True)
    embedding_id = Column(String(256), nullable=True, index=True)
    recognition_task_id = Column(String(128), nullable=True)
    recognition_status = Column(String(32), nullable=True, default="succeeded")
    confidence = Column(Float, nullable=True)
    bbox = Column(JSON, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    model_version = Column(String(100), nullable=True)
    recognition_source = Column(String(32), nullable=True)
    is_fallback = Column(Boolean, nullable=True, default=False)
    fallback_reason = Column(Text, nullable=True)
    status = Column(String(32), nullable=False, default="open", index=True)
    owner_uid = Column(String(128), ForeignKey("users.uid", ondelete="SET NULL"), nullable=True, index=True)
    owner_name = Column(String(100), nullable=True)
    owner_email = Column(String(256), nullable=True)
    verification_question = Column(String(300), nullable=True)
    verification_answer_hint = Column(String(300), nullable=True)
    is_seeded_demo = Column(Boolean, nullable=True, default=False)
    created_at = Column(String(64), nullable=False, index=True)
    updated_at = Column(String(64), nullable=True)

    __table_args__ = (
        Index("idx_items_type_cat_time", "type", "campus_category", "event_time"),
        Index("idx_items_status_created", "status", "created_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "title": self.title,
            "description": self.description,
            "campusCategory": self.campus_category,
            "rawModelClass": self.raw_model_class,
            "manualCategoryOverride": self.manual_category_override,
            "color": self.color,
            "quantity": self.quantity if self.quantity is not None else 1,
            "brand": self.brand,
            "rewardAmount": self.reward_amount if self.reward_amount is not None else 0,
            "locationArea": self.location_area,
            "locationDetail": self.location_detail,
            "location": self.location,
            "eventTime": self.event_time,
            "conditionText": self.condition_text,
            "keywords": self.keywords or [],
            "imageUrl": self.image_url,
            "storagePath": self.storage_path,
            "imageSha256": self.image_sha256,
            "embeddingId": self.embedding_id,
            "recognitionTaskId": self.recognition_task_id,
            "recognitionStatus": self.recognition_status,
            "confidence": self.confidence,
            "bbox": self.bbox,
            "latencyMs": self.latency_ms,
            "modelVersion": self.model_version,
            "recognitionSource": self.recognition_source,
            "isFallback": bool(self.is_fallback) if self.is_fallback is not None else False,
            "fallbackReason": self.fallback_reason,
            "status": self.status,
            "ownerUid": self.owner_uid or "",
            "ownerName": self.owner_name,
            "ownerEmail": self.owner_email,
            "verificationQuestion": self.verification_question,
            "verificationAnswerHint": self.verification_answer_hint,
            "isSeededDemo": bool(self.is_seeded_demo) if self.is_seeded_demo is not None else False,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class ImageEmbeddingModel(Base):
    __tablename__ = "image_embeddings"

    id = Column(String(256), primary_key=True, index=True)
    sha256 = Column(String(128), nullable=False, index=True)
    model_version = Column(String(100), nullable=False, index=True)
    dimension = Column(Integer, nullable=False)
    vector = Column(JSON, nullable=False)
    item_id = Column(String(128), nullable=True)
    visual_summary = Column(String(256), nullable=True)
    created_at = Column(String(64), nullable=False)

    __table_args__ = (
        Index("idx_embeddings_sha_ver", "sha256", "model_version"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sha256": self.sha256,
            "modelVersion": self.model_version,
            "dimension": self.dimension,
            "vector": self.vector,
            "itemId": self.item_id,
            "visualSummary": self.visual_summary,
            "createdAt": self.created_at,
        }


class RecognitionTaskModel(Base):
    __tablename__ = "recognition_tasks"

    id = Column(String(128), primary_key=True, index=True)
    item_id = Column(String(128), ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True)
    item_title = Column(String(200), nullable=True)
    idempotency_key = Column(String(256), nullable=False, index=True)
    status = Column(String(32), nullable=False, index=True)  # pending | running | succeeded | failed
    retry_count = Column(Integer, nullable=False, default=0)
    max_retries = Column(Integer, nullable=True, default=3)
    model_version = Column(String(100), nullable=False)
    raw_model_class = Column(String(100), nullable=True)
    mapped_campus_category = Column(String(64), nullable=True)
    confidence = Column(Float, nullable=True)
    bbox = Column(JSON, nullable=True)
    extracted_color = Column(String(64), nullable=True)
    extracted_brand = Column(String(100), nullable=True)
    extracted_keywords = Column(JSON, nullable=True, default=list)
    latency_ms = Column(Integer, nullable=True)
    cache_hit = Column(Boolean, nullable=True, default=False)
    embedding_id = Column(String(256), nullable=True)
    recognition_source = Column(String(32), nullable=True)
    is_fallback = Column(Boolean, nullable=True, default=False)
    fallback_reason = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(String(64), nullable=False, index=True)
    updated_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "itemId": self.item_id,
            "itemTitle": self.item_title,
            "idempotencyKey": self.idempotency_key,
            "status": self.status,
            "retryCount": self.retry_count,
            "maxRetries": self.max_retries if self.max_retries is not None else 3,
            "modelVersion": self.model_version,
            "rawModelClass": self.raw_model_class,
            "mappedCampusCategory": self.mapped_campus_category,
            "confidence": self.confidence,
            "bbox": self.bbox,
            "extractedColor": self.extracted_color,
            "extractedBrand": self.extracted_brand,
            "extractedKeywords": self.extracted_keywords or [],
            "latencyMs": self.latency_ms,
            "cacheHit": bool(self.cache_hit) if self.cache_hit is not None else False,
            "embeddingId": self.embedding_id,
            "recognitionSource": self.recognition_source,
            "isFallback": bool(self.is_fallback) if self.is_fallback is not None else False,
            "fallbackReason": self.fallback_reason,
            "errorMessage": self.error_message,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class MatchModel(Base):
    __tablename__ = "matches"

    id = Column(String(256), primary_key=True, index=True)
    lost_item_id = Column(String(128), ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True)
    found_item_id = Column(String(128), ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True)
    total_score = Column(Float, nullable=False, index=True)
    rule_score_7d = Column(Float, nullable=False)
    image_similarity = Column(Float, nullable=False)
    conflict_penalty = Column(Float, nullable=True, default=0.0)
    dimension_scores = Column(JSON, nullable=True)
    recall_sources = Column(JSON, nullable=True, default=list)
    conflict_reasons = Column(JSON, nullable=True, default=list)
    explanation_summary = Column(Text, nullable=True)
    algorithm_version = Column(String(64), nullable=False)
    status = Column(String(32), nullable=False, default="candidate")  # candidate | confirmed | excluded
    created_at = Column(String(64), nullable=False)
    updated_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lostItemId": self.lost_item_id,
            "foundItemId": self.found_item_id,
            "totalScore": self.total_score,
            "ruleScore7D": self.rule_score_7d,
            "imageSimilarity": self.image_similarity,
            "conflictPenalty": self.conflict_penalty or 0,
            "dimensionScores": self.dimension_scores,
            "recallSources": self.recall_sources or [],
            "conflictReasons": self.conflict_reasons or [],
            "explanationSummary": self.explanation_summary,
            "algorithmVersion": self.algorithm_version,
            "status": self.status,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class MatchFeedbackModel(Base):
    __tablename__ = "match_feedback"

    id = Column(String(256), primary_key=True, index=True)
    match_id = Column(String(256), nullable=False, index=True)
    item_id = Column(String(128), nullable=True)
    user_uid = Column(String(128), nullable=False, index=True)
    user_name = Column(String(100), nullable=True)
    action = Column(String(32), nullable=False)  # confirm | exclude | restore | correct_category
    reason = Column(Text, nullable=True)
    corrected_category = Column(String(64), nullable=True)
    created_at = Column(String(64), nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "matchId": self.match_id,
            "itemId": self.item_id,
            "userUid": self.user_uid,
            "userName": self.user_name,
            "action": self.action,
            "reason": self.reason,
            "correctedCategory": self.corrected_category,
            "createdAt": self.created_at,
        }


class ClaimModel(Base):
    __tablename__ = "claims"

    id = Column(String(256), primary_key=True, index=True)
    item_id = Column(String(128), ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True)
    item_title = Column(String(200), nullable=True)
    match_id = Column(String(256), nullable=True)
    claim_type = Column(String(32), nullable=True)  # claim_found | return_lost
    loser_uid = Column(String(128), nullable=True, index=True)
    finder_uid = Column(String(128), nullable=True, index=True)
    claimant_uid = Column(String(128), nullable=False, index=True)
    claimant_name = Column(String(100), nullable=False)
    claimant_email = Column(String(256), nullable=True)
    verification_question = Column(String(300), nullable=True)
    verification_answer = Column(Text, nullable=False)
    status = Column(String(32), nullable=False, default="pending_review", index=True)
    handover_code = Column(String(16), nullable=False)
    qr_payload = Column(String(128), nullable=True)
    reviewed_by = Column(String(128), nullable=True)
    review_note = Column(Text, nullable=True)
    bounty_settled = Column(Boolean, nullable=True, default=False)
    reviewed_participant_uids = Column(JSON, nullable=True, default=list)
    created_at = Column(String(64), nullable=False)
    updated_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "itemId": self.item_id,
            "itemTitle": self.item_title,
            "matchId": self.match_id,
            "claimType": self.claim_type,
            "loserUid": self.loser_uid,
            "finderUid": self.finder_uid,
            "claimantUid": self.claimant_uid,
            "claimantName": self.claimant_name,
            "claimantEmail": self.claimant_email,
            "verificationQuestion": self.verification_question,
            "verificationAnswer": self.verification_answer,
            "status": self.status,
            "handoverCode": self.handover_code,
            "qrPayload": self.qr_payload,
            "reviewedBy": self.reviewed_by,
            "reviewNote": self.review_note,
            "bountySettled": bool(self.bounty_settled) if self.bounty_settled is not None else False,
            "reviewedParticipantUids": self.reviewed_participant_uids or [],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class MessageModel(Base):
    __tablename__ = "messages"

    id = Column(String(128), primary_key=True, index=True)
    item_id = Column(String(128), nullable=False, index=True)
    item_title = Column(String(200), nullable=True)
    sender_uid = Column(String(128), nullable=False, index=True)
    sender_name = Column(String(100), nullable=False)
    sender_role = Column(String(20), nullable=True)
    receiver_uid = Column(String(128), nullable=True, index=True)
    content = Column(Text, nullable=False)
    created_at = Column(String(64), nullable=False, index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "itemId": self.item_id,
            "itemTitle": self.item_title,
            "senderUid": self.sender_uid,
            "senderName": self.sender_name,
            "senderRole": self.sender_role,
            "receiverUid": self.receiver_uid,
            "content": self.content,
            "createdAt": self.created_at,
        }


class AuditLogModel(Base):
    __tablename__ = "audit_logs"

    id = Column(String(128), primary_key=True, index=True)
    actor_uid = Column(String(128), nullable=False, index=True)
    actor_name = Column(String(100), nullable=True)
    actor_role = Column(String(20), nullable=True)
    action = Column(String(64), nullable=False, index=True)
    target_id = Column(String(256), nullable=False)
    detail = Column(Text, nullable=False)
    created_at = Column(String(64), nullable=False, index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "actorUid": self.actor_uid,
            "actorName": self.actor_name,
            "actorRole": self.actor_role,
            "action": self.action,
            "targetId": self.target_id,
            "detail": self.detail,
            "createdAt": self.created_at,
        }
