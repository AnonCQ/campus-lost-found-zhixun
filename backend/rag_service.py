"""
Hybrid RAG (Retrieval-Augmented Generation) Engine
Combines:
1. Domain Knowledge Base Retrieval (scikit-learn TF-IDF char n-gram 1..3 + cosine similarity)
   over campus_knowledge_base.json (policies, storage points, card loss guide, handover/bounty rules)
2. Cross-Modal Text-to-Image Vector Retrieval (OpenCLIP ViT-B/32 text encoder -> cosine similarity
   against live cached 512D image_embeddings in SQLite)
"""

import json
import threading
from typing import Any, Dict, List, Optional

import numpy as np
import torch
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import linear_kernel
from sqlalchemy.orm import Session

from backend.ai_engine import ai_engine
from backend.config import DATA_DIR
from backend.models import ImageEmbeddingModel, ItemModel

KB_PATH = DATA_DIR / "campus_knowledge_base.json"


class CampusRAGService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._docs: List[Dict[str, Any]] = []
        self._vectorizer: Optional[TfidfVectorizer] = None
        self._doc_matrix = None

    def _ensure_index(self) -> None:
        if self._vectorizer is not None and self._docs:
            return
        with self._lock:
            if self._vectorizer is not None and self._docs:
                return
            self._docs = json.loads(KB_PATH.read_text(encoding="utf-8"))
            corpus = [
                f"{d.get('title', '')} {d.get('category', '')} {d.get('content', '')}"
                for d in self._docs
            ]
            self._vectorizer = TfidfVectorizer(
                analyzer="char_wb",
                ngram_range=(1, 3),
                sublinear_tf=True,
            )
            self._doc_matrix = self._vectorizer.fit_transform(corpus)

    def list_documents(self) -> List[Dict[str, Any]]:
        self._ensure_index()
        return self._docs

    def retrieve_knowledge(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        self._ensure_index()
        clean_q = (query or "").strip()
        if not clean_q or not self._docs or self._vectorizer is None:
            return []

        q_vec = self._vectorizer.transform([clean_q])
        sims = linear_kernel(q_vec, self._doc_matrix).flatten()
        ranked_idx = np.argsort(sims)[::-1]

        hits: List[Dict[str, Any]] = []
        for idx in ranked_idx[: max(1, min(top_k, 6))]:
            score = float(sims[idx])
            if score < 0.04:
                continue
            doc = self._docs[int(idx)]
            hits.append(
                {
                    "id": doc["id"],
                    "category": doc["category"],
                    "title": doc["title"],
                    "source": doc["source"],
                    "content": doc["content"],
                    "score": round(score, 4),
                    "retrievalMethod": "TF-IDF char_wb(1-3) cosine",
                }
            )
        return hits

    def cross_modal_text_to_image_search(
        self,
        db: Session,
        query_en_or_zh: str,
        top_k: int = 4,
        item_type: str = "all",
    ) -> List[Dict[str, Any]]:
        """
        True Cross-Modal Visual RAG:
        Encodes a text query using OpenCLIP ViT-B/32 text encoder into the same 512D space
        as cached item image embeddings, returning visually relevant items even without keyword overlap.
        """
        ai_engine.ensure_loaded()
        clean_q = (query_en_or_zh or "").strip()
        if not clean_q or ai_engine.clip_model is None or ai_engine.clip_tokenizer is None:
            return []

        # Map common Chinese item words to concise English visual cues for stronger OpenCLIP ViT-B/32 alignment
        zh_to_en_hints = [
            ("电脑", "silver laptop macbook computer"),
            ("笔记本电脑", "laptop macbook computer"),
            ("耳机", "white wireless earbuds airpods case"),
            ("校园卡", "blue student ID card lanyard"),
            ("一卡通", "blue campus ID card holder"),
            ("水杯", "insulated thermos water bottle tumbler"),
            ("保温杯", "stainless steel thermos tumbler bottle"),
            ("帆布包", "beige canvas tote bag"),
            ("托特包", "canvas tote bag"),
            ("钥匙", "metal keys keychain"),
            ("钱包", "black leather wallet"),
            ("眼镜", "black eyeglasses spectacles"),
            ("雨伞", "folding umbrella"),
            ("充电宝", "white power bank battery charger"),
        ]
        visual_prompt = clean_q
        for zh, en in zh_to_en_hints:
            if zh in clean_q:
                visual_prompt = f"a photo of {en}"
                break

        with torch.no_grad():
            tokens = ai_engine.clip_tokenizer([visual_prompt]).to(ai_engine.device)
            text_feat = ai_engine.clip_model.encode_text(tokens)
            text_feat = text_feat / text_feat.norm(dim=-1, keepdim=True)
            q_vec = text_feat.squeeze(0).detach().cpu().numpy()

        items = [
            i.to_dict()
            for i in db.query(ItemModel).all()
            if i.status not in ("delisted", "returned")
            and (item_type == "all" or i.type == item_type)
        ]
        embs_by_id = {
            e.id: np.asarray(e.vector, dtype=np.float32)
            for e in db.query(ImageEmbeddingModel).all()
            if e.vector
        }

        scored = []
        for it in items:
            eid = it.get("embeddingId")
            if not eid or eid not in embs_by_id:
                continue
            ivec = embs_by_id[eid]
            if ivec.shape[0] != q_vec.shape[0]:
                continue
            cos = float(np.dot(q_vec, ivec))
            scored.append((cos, it))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [
            {
                "item": it,
                "clipTextImageCosine": round(score, 4),
                "visualPromptUsed": visual_prompt,
            }
            for score, it in scored[:top_k]
            if score >= 0.19
        ]


rag_service = CampusRAGService()
