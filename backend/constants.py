"""
Core Domain Constants, Configurable YOLO/CLIP -> Campus Category Mapping,
and Deterministic ID Generators.
"""

import re
from typing import Dict, List, Optional

from backend.config import (
    ADMIN_WHITELIST_EMAIL,
    ALGORITHM_VERSION,
    DEFAULT_TOP_K,
    EMBEDDING_MODEL_VERSION,
    MAX_VECTOR_CANDIDATES,
    RECOGNITION_MODEL_VERSION,
)

CAMPUS_CATEGORIES: List[str] = [
    "数码电子",
    "证件卡类",
    "水杯雨伞",
    "箱包服饰",
    "图书文具",
    "钥匙配饰",
    "运动生活",
    "unknown",
]

# Configurable Model Class (COCO YOLO26n + OpenCLIP Zero-Shot + Chinese Aliases) -> Campus Category Map
MODEL_TO_CAMPUS_CATEGORY_MAP: Dict[str, str] = {
    # 数码电子
    "laptop": "数码电子",
    "notebook_computer": "数码电子",
    "macbook": "数码电子",
    "cell phone": "数码电子",
    "cell_phone": "数码电子",
    "smartphone": "数码电子",
    "mobile_phone": "数码电子",
    "iphone": "数码电子",
    "earbuds": "数码电子",
    "airpods": "数码电子",
    "headphones": "数码电子",
    "earphones": "数码电子",
    "tablet": "数码电子",
    "ipad": "数码电子",
    "power_bank": "数码电子",
    "power bank": "数码电子",
    "charger": "数码电子",
    "usb_drive": "数码电子",
    "mouse": "数码电子",
    "keyboard": "数码电子",
    "remote": "数码电子",
    "tv": "数码电子",
    "笔记本电脑": "数码电子",
    "手机": "数码电子",
    "耳机": "数码电子",
    "平板电脑": "数码电子",
    "充电宝": "数码电子",
    # 证件卡类
    "campus_card": "证件卡类",
    "student_id": "证件卡类",
    "id_card": "证件卡类",
    "bank_card": "证件卡类",
    "debit_card": "证件卡类",
    "credit_card": "证件卡类",
    "smart_card": "证件卡类",
    "badge": "证件卡类",
    "校园卡": "证件卡类",
    "校园一卡通": "证件卡类",
    "一卡通": "证件卡类",
    "银行卡": "证件卡类",
    "借记卡": "证件卡类",
    "身份证": "证件卡类",
    "学生证": "证件卡类",
    # 水杯雨伞
    "bottle": "水杯雨伞",
    "water_bottle": "水杯雨伞",
    "thermos": "水杯雨伞",
    "tumbler": "水杯雨伞",
    "cup": "水杯雨伞",
    "mug": "水杯雨伞",
    "wine glass": "水杯雨伞",
    "umbrella": "水杯雨伞",
    "水杯": "水杯雨伞",
    "保温杯": "水杯雨伞",
    "雨伞": "水杯雨伞",
    # 箱包服饰
    "backpack": "箱包服饰",
    "handbag": "箱包服饰",
    "tote_bag": "箱包服饰",
    "canvas_bag": "箱包服饰",
    "suitcase": "箱包服饰",
    "wallet": "箱包服饰",
    "purse": "箱包服饰",
    "jacket": "箱包服饰",
    "coat": "箱包服饰",
    "hat": "箱包服饰",
    "tie": "箱包服饰",
    "书包": "箱包服饰",
    "双肩包": "箱包服饰",
    "帆布包": "箱包服饰",
    "钱包": "箱包服饰",
    "服饰": "箱包服饰",
    # 图书文具
    "book": "图书文具",
    "textbook": "图书文具",
    "paper_notebook": "图书文具",
    "pencil_case": "图书文具",
    "pen": "图书文具",
    "calculator": "图书文具",
    "scissors": "图书文具",
    "笔记本": "图书文具",
    "书籍": "图书文具",
    "教材": "图书文具",
    "文具盒": "图书文具",
    "笔袋": "图书文具",
    # 钥匙配饰
    "keys": "钥匙配饰",
    "keychain": "钥匙配饰",
    "key_ring": "钥匙配饰",
    "access_fob": "钥匙配饰",
    "glasses": "钥匙配饰",
    "eyeglasses": "钥匙配饰",
    "sunglasses": "钥匙配饰",
    "watch": "钥匙配饰",
    "wristwatch": "钥匙配饰",
    "clock": "钥匙配饰",
    "钥匙": "钥匙配饰",
    "钥匙串": "钥匙配饰",
    "眼镜": "钥匙配饰",
    "手表": "钥匙配饰",
    # 运动生活
    "sports ball": "运动生活",
    "sports_ball": "运动生活",
    "basketball": "运动生活",
    "tennis racket": "运动生活",
    "tennis_racket": "运动生活",
    "badminton_racket": "运动生活",
    "baseball bat": "运动生活",
    "frisbee": "运动生活",
    "bowl": "运动生活",
    "篮球": "运动生活",
    "球拍": "运动生活",
}

DEFAULT_MATCHING_CONFIG = {
    "weights7D": {
        "category": 0.22,
        "color": 0.14,
        "quantity": 0.06,
        "location": 0.16,
        "condition": 0.08,
        "keywords": 0.19,
        "time": 0.15,
    },
    "ruleWeightAlpha": 0.68,
    "decisionThreshold": 58.0,
    "topK": DEFAULT_TOP_K,
}


def map_raw_class_to_campus_category(
    raw_class: Optional[str],
    confidence: float = 1.0,
    min_confidence_threshold: float = 0.35,
) -> str:
    if not raw_class or confidence < min_confidence_threshold:
        return "unknown"
    lowered = raw_class.strip().lower()
    normalized = re.sub(r"[\s-]+", "_", lowered)
    if normalized in MODEL_TO_CAMPUS_CATEGORY_MAP:
        return MODEL_TO_CAMPUS_CATEGORY_MAP[normalized]
    if lowered in MODEL_TO_CAMPUS_CATEGORY_MAP:
        return MODEL_TO_CAMPUS_CATEGORY_MAP[lowered]
    for key, cat in MODEL_TO_CAMPUS_CATEGORY_MAP.items():
        if key in normalized or normalized in key:
            return cat
    return "unknown"


def get_deterministic_embedding_id(
    image_hash: str,
    model_version: str = EMBEDDING_MODEL_VERSION,
) -> str:
    clean_hash = re.sub(r"[^a-zA-Z0-9_-]", "", (image_hash or "").strip())
    clean_ver = re.sub(r"[^a-zA-Z0-9_.-]", "", (model_version or "").strip())
    return f"emb_{clean_hash}_{clean_ver}"


def get_deterministic_match_id(lost_id: str, found_id: str) -> str:
    clean_lost = re.sub(r"[^a-zA-Z0-9_-]", "_", lost_id)
    clean_found = re.sub(r"[^a-zA-Z0-9_-]", "_", found_id)
    return f"match_{clean_lost}_{clean_found}"


def compose_campus_location(area: str, detail: Optional[str] = "") -> str:
    clean_area = (area or "").strip()
    clean_detail = (detail or "").strip()
    if not clean_area:
        return clean_detail
    return f"{clean_area} · {clean_detail}" if clean_detail else clean_area


def resolve_claim_role_actors(claim: dict, item: Optional[dict] = None) -> dict:
    claim_type = claim.get("claimType") or (
        "return_lost" if item and item.get("type") == "lost" else "claim_found"
    )
    loser_uid = claim.get("loserUid") or (
        (item.get("ownerUid", "") if item else "")
        if claim_type == "return_lost"
        else claim.get("claimantUid", "")
    )
    finder_uid = claim.get("finderUid") or (
        (item.get("ownerUid", "") if item else "")
        if claim_type == "claim_found"
        else claim.get("claimantUid", "")
    )
    return {
        "claimType": claim_type,
        "loserUid": loser_uid,
        "finderUid": finder_uid,
    }


__all__ = [
    "ADMIN_WHITELIST_EMAIL",
    "ALGORITHM_VERSION",
    "CAMPUS_CATEGORIES",
    "DEFAULT_MATCHING_CONFIG",
    "DEFAULT_TOP_K",
    "EMBEDDING_MODEL_VERSION",
    "MAX_VECTOR_CANDIDATES",
    "MODEL_TO_CAMPUS_CATEGORY_MAP",
    "RECOGNITION_MODEL_VERSION",
    "compose_campus_location",
    "get_deterministic_embedding_id",
    "get_deterministic_match_id",
    "map_raw_class_to_campus_category",
    "resolve_claim_role_actors",
]
