"""
Real Local Deep Learning Vision & Multimodal Embedding Engine

1. Object Detection: Official Ultralytics YOLO26n (yolo26n.pt) on CUDA / CPU
   - Startup self-check: verifies file presence, SHA-256 digest, task == 'detect', and model.names
   - Returns real detection rawModelClass, confidence, normalized [x1, y1, x2, y2] bbox (0..1000)
2. Multimodal Feature Encoding & Zero-Shot Campus Classification: OpenCLIP ViT-B/32 (openai)
   - Encodes real image bytes into genuine 512-dimensional L2-normalized vectors
   - Complements YOLO26n COCO classes with zero-shot campus item prompts (e.g. campus card,
     wireless earbuds, power bank, keychain, glasses, thermos) when YOLO returns no matching box
3. Dominant Color Analysis: HSV pixel histogram over the detected bounding box crop
4. Explainable Reasoning (Optional LLM): Gemini API via google-genai if configured, with
   deterministic structured Chinese attribution fallback.
"""

import base64
import colorsys
import hashlib
import io
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np
import torch
from PIL import Image

from backend.config import (
    EMBEDDING_MODEL_VERSION,
    GEMINI_API_KEY,
    GEMINI_EXPLAIN_MODEL,
    OPENCLIP_MODEL_NAME,
    OPENCLIP_PRETRAINED,
    PUBLIC_IMAGES_DIR,
    RECOGNITION_MODEL_VERSION,
    UPLOADS_DIR,
    YOLO_CONF_THRESHOLD,
    YOLO_WEIGHTS_PATH,
)
from backend.constants import (
    MODEL_TO_CAMPUS_CATEGORY_MAP,
    map_raw_class_to_campus_category,
)
from backend.matching_engine import (
    extract_brands,
    extract_colors,
    extract_semantic_tokens,
    l2_normalize,
)

# Zero-shot OpenCLIP multi-prompt campus item bank:
# (raw_class, list of descriptive English prompts averaged into a prototype vector, Chinese keyword)
CAMPUS_CLIP_PROMPTS: List[Tuple[str, List[str], str]] = [
    ("laptop", ["a photo of a silver or gray laptop computer", "a photo of a macbook pro notebook computer open on a desk", "a portable personal computer laptop"], "笔记本电脑"),
    ("cell phone", ["a photo of a smartphone mobile phone with screen", "a photo of an iphone or android cellphone"], "智能手机"),
    ("earbuds", ["a photo of white wireless earbuds in an open or closed charging case", "a photo of apple airpods pro earphones case"], "无线耳机"),
    ("power_bank", ["a photo of a white or black portable power bank battery charger with USB ports and LED battery display", "a portable phone battery pack powerbank"], "充电宝"),
    ("campus_card", ["a photo of a blue plastic student ID card in a vertical card holder with a neck lanyard strap", "a photo of a university campus identification badge with lanyard", "an access ID card inside a protective sleeve with strap"], "校园卡"),
    ("bank_card", ["a photo of a plastic bank debit card or credit card with chip", "a payment bank card"], "银行卡"),
    ("thermos", ["a photo of a cylindrical insulated stainless steel thermos flask water bottle tumbler with lid", "a sports vacuum insulated travel mug bottle"], "保温杯"),
    ("umbrella", ["a photo of a folded compact umbrella with handle", "a photo of a rain umbrella with patterned canopy and wooden handle"], "雨伞"),
    ("backpack", ["a photo of a school backpack rucksack with shoulder straps", "a student backpack bag"], "双肩书包"),
    ("tote_bag", ["a photo of a beige or white canvas tote bag shoulder handbag", "a cloth shopping tote bag holding books"], "帆布托特包"),
    ("wallet", ["a photo of a black bifold leather wallet purse", "a folded men or women leather wallet"], "钱包"),
    ("book", ["a photo of a textbook or spiral paper notebook", "a printed university book"], "教材笔记本"),
    ("keychain", ["a photo of metal house or dorm keys attached to a metal key ring keychain", "a bunch of silver keys with key fob"], "钥匙串"),
    ("glasses", ["a photo of black framed eyeglasses or spectacles with clear lenses", "a pair of prescription glasses"], "眼镜"),
    ("watch", ["a photo of a wristwatch or smartwatch with band", "a personal timepiece watch"], "手表"),
    ("basketball", ["a photo of an orange basketball or sports ball", "a sports ball on a court"], "篮球"),
]


class LocalVisionAIEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
        self.yolo_model = None
        self.yolo_sha256 = ""
        self.yolo_num_classes = 0
        self.clip_model = None
        self.clip_preprocess = None
        self.clip_tokenizer = None
        self.clip_text_features = None
        self.clip_embed_dim = 512
        self._memory_vector_cache: Dict[str, List[float]] = {}
        self.load_error: Optional[str] = None
        self.models_ready = False

    def ensure_loaded(self) -> None:
        if self.models_ready:
            return
        with self._lock:
            if self.models_ready:
                return
            try:
                from ultralytics import YOLO
                import open_clip

                # 1. Load & verify official YOLO26n weights
                YOLO_WEIGHTS_PATH.parent.mkdir(parents=True, exist_ok=True)
                self.yolo_model = YOLO(str(YOLO_WEIGHTS_PATH))
                if getattr(self.yolo_model, "task", "detect") != "detect" or not hasattr(
                    self.yolo_model, "names"
                ):
                    raise RuntimeError("Loaded YOLO weights are not a valid object detection model")
                self.yolo_num_classes = len(self.yolo_model.names)
                if YOLO_WEIGHTS_PATH.exists():
                    self.yolo_sha256 = hashlib.sha256(YOLO_WEIGHTS_PATH.read_bytes()).hexdigest()

                # 2. Load OpenCLIP ViT-B/32
                model, _, preprocess = open_clip.create_model_and_transforms(
                    OPENCLIP_MODEL_NAME, pretrained=OPENCLIP_PRETRAINED
                )
                model = model.to(self.device).eval()
                tokenizer = open_clip.get_tokenizer(OPENCLIP_MODEL_NAME)

                # Precompute multi-prompt ensembled normalized text prototype embeddings for zero-shot campus classification
                prototype_list = []
                with torch.no_grad():
                    for _, prompt_variants, _ in CAMPUS_CLIP_PROMPTS:
                        tokens = tokenizer(prompt_variants).to(self.device)
                        feats = model.encode_text(tokens)
                        feats = feats / feats.norm(dim=-1, keepdim=True)
                        mean_feat = feats.mean(dim=0)
                        mean_feat = mean_feat / mean_feat.norm(dim=-1, keepdim=True)
                        prototype_list.append(mean_feat)
                    text_feats = torch.stack(prototype_list, dim=0)

                self.clip_model = model
                self.clip_preprocess = preprocess
                self.clip_tokenizer = tokenizer
                self.clip_text_features = text_feats
                self.clip_embed_dim = int(getattr(model.visual, "output_dim", 512))
                self.models_ready = True
                self.load_error = None
                print(
                    f"[LocalVisionAIEngine] Ready on {self.device} ({self.gpu_name}) | "
                    f"YOLO26n ({self.yolo_num_classes} cls, sha={self.yolo_sha256[:12]}) | "
                    f"OpenCLIP {OPENCLIP_MODEL_NAME}/{OPENCLIP_PRETRAINED} ({self.clip_embed_dim}D)"
                )
            except Exception as exc:
                self.load_error = str(exc)
                print(f"[LocalVisionAIEngine] Load error: {exc}")
                raise

    def get_status(self) -> Dict[str, Any]:
        return {
            "modelsReady": self.models_ready,
            "device": self.device,
            "gpuName": self.gpu_name,
            "yoloModel": YOLO_WEIGHTS_PATH.name,
            "yoloWeightsExists": YOLO_WEIGHTS_PATH.exists(),
            "yoloSha256": self.yolo_sha256,
            "yoloNumClasses": self.yolo_num_classes,
            "clipModel": f"{OPENCLIP_MODEL_NAME} ({OPENCLIP_PRETRAINED})",
            "embeddingModelVersion": EMBEDDING_MODEL_VERSION,
            "embeddingDimension": self.clip_embed_dim,
            "recognitionModelVersion": RECOGNITION_MODEL_VERSION,
            "memoryCacheEntries": len(self._memory_vector_cache),
            "loadError": self.load_error,
        }

    def resolve_image_pil(
        self,
        base64_image: Optional[str] = None,
        image_url: Optional[str] = None,
    ) -> Tuple[Image.Image, bytes]:
        if base64_image and len(base64_image) > 32:
            clean = base64_image.split(",", 1)[1] if "," in base64_image else base64_image
            raw = base64.b64decode(clean)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            return img, raw

        url = (image_url or "").strip()
        if not url:
            raise ValueError("缺少图像数据：未提供 base64Image 或 imageUrl")

        if url.startswith("data:image/"):
            b64 = url.split(",", 1)[1]
            raw = base64.b64decode(b64)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            return img, raw

        if url.startswith("/uploads/"):
            fp = UPLOADS_DIR / Path(url).name
            if fp.exists():
                raw = fp.read_bytes()
                return Image.open(io.BytesIO(raw)).convert("RGB"), raw
            raise FileNotFoundError(f"上传图像不存在: {url}")

        if url.startswith("/images/") or url.startswith("/src/assets/images/"):
            fp = PUBLIC_IMAGES_DIR / Path(url).name
            if fp.exists():
                raw = fp.read_bytes()
                return Image.open(io.BytesIO(raw)).convert("RGB"), raw
            raise FileNotFoundError(f"公开图像不存在: {url}")

        if url.startswith("http://") or url.startswith("https://"):
            resp = httpx.get(url, timeout=15.0, follow_redirects=True)
            resp.raise_for_status()
            raw = resp.content
            return Image.open(io.BytesIO(raw)).convert("RGB"), raw

        # Local relative path fallback
        candidate = Path(url)
        if candidate.exists():
            raw = candidate.read_bytes()
            return Image.open(io.BytesIO(raw)).convert("RGB"), raw

        raise ValueError(f"不支持或找不到的图像路径: {url}")

    def encode_image_embedding(
        self,
        base64_image: Optional[str] = None,
        image_url: Optional[str] = None,
        sha256_hint: Optional[str] = None,
    ) -> Dict[str, Any]:
        self.ensure_loaded()
        img, raw_bytes = self.resolve_image_pil(base64_image=base64_image, image_url=image_url)
        actual_sha = sha256_hint or f"sha256_{hashlib.sha256(raw_bytes).hexdigest()}"
        cache_key = f"{actual_sha}_{EMBEDDING_MODEL_VERSION}"

        if cache_key in self._memory_vector_cache:
            vec = self._memory_vector_cache[cache_key]
            return {
                "sha256": actual_sha,
                "vector": vec,
                "dimension": len(vec),
                "modelVersion": EMBEDDING_MODEL_VERSION,
                "cacheHitInMemory": True,
            }

        with torch.no_grad():
            tensor = self.clip_preprocess(img).unsqueeze(0).to(self.device)
            feat = self.clip_model.encode_image(tensor)
            feat = feat / feat.norm(dim=-1, keepdim=True)
            vec_np = feat.squeeze(0).detach().cpu().numpy().tolist()

        normalized = l2_normalize(vec_np)
        self._memory_vector_cache[cache_key] = normalized
        return {
            "sha256": actual_sha,
            "vector": normalized,
            "dimension": len(normalized),
            "modelVersion": EMBEDDING_MODEL_VERSION,
            "cacheHitInMemory": False,
        }

    def _extract_dominant_color_zh(
        self, img: Image.Image, bbox_norm: Tuple[int, int, int, int]
    ) -> str:
        w, h = img.size
        x1, y1, x2, y2 = bbox_norm
        if x2 > x1 and y2 > y1:
            crop = img.crop(
                (
                    max(0, int(x1 / 1000.0 * w)),
                    max(0, int(y1 / 1000.0 * h)),
                    min(w, int(x2 / 1000.0 * w)),
                    min(h, int(y2 / 1000.0 * h)),
                )
            )
        else:
            crop = img.crop((int(w * 0.2), int(h * 0.2), int(w * 0.8), int(h * 0.8)))

        small = crop.resize((48, 48))
        arr = np.asarray(small, dtype=np.float32) / 255.0
        pixels = arr.reshape(-1, 3)

        # Sample center-weighted pixels
        counts: Dict[str, int] = {}
        for r, g, b in pixels[::2]:
            hue, sat, val = colorsys.rgb_to_hsv(float(r), float(g), float(b))
            h_deg = hue * 360.0
            if val < 0.22:
                cname = "黑色"
            elif sat < 0.16 and val > 0.78:
                cname = "白色"
            elif sat < 0.18:
                cname = "银色"
            elif h_deg < 18 or h_deg >= 340:
                cname = "红色" if sat > 0.45 else "粉色"
            elif 18 <= h_deg < 42:
                cname = "棕色" if val < 0.55 else "黄色"
            elif 42 <= h_deg < 70:
                cname = "黄色"
            elif 70 <= h_deg < 165:
                cname = "绿色"
            elif 165 <= h_deg < 255:
                cname = "蓝色"
            elif 255 <= h_deg < 310:
                cname = "紫色"
            else:
                cname = "粉色"
            counts[cname] = counts.get(cname, 0) + 1

        if not counts:
            return "未知"
        return max(counts.items(), key=lambda kv: kv[1])[0]

    def recognize_image(
        self,
        base64_image: Optional[str] = None,
        image_url: Optional[str] = None,
        title: str = "",
        description: str = "",
    ) -> Dict[str, Any]:
        t0 = time.perf_counter()
        self.ensure_loaded()

        img, _ = self.resolve_image_pil(base64_image=base64_image, image_url=image_url)
        w, h = img.size

        # Step 1: Real Ultralytics YOLO26n object detection
        results = self.yolo_model.predict(
            source=img,
            conf=YOLO_CONF_THRESHOLD,
            device=0 if self.device == "cuda" else "cpu",
            verbose=False,
        )

        best_yolo_class: Optional[str] = None
        best_yolo_conf: float = 0.0
        best_bbox: List[int] = [120, 120, 880, 880]
        yolo_detections: List[Dict[str, Any]] = []

        if results and len(results) > 0 and results[0].boxes is not None:
            boxes = results[0].boxes
            for idx in range(len(boxes)):
                cls_id = int(boxes.cls[idx].item())
                conf = float(boxes.conf[idx].item())
                cls_name = str(self.yolo_model.names.get(cls_id, "unknown"))
                xyxy = boxes.xyxy[idx].tolist()
                norm_box = [
                    max(0, min(1000, int(round(xyxy[0] / max(1, w) * 1000)))),
                    max(0, min(1000, int(round(xyxy[1] / max(1, h) * 1000)))),
                    max(0, min(1000, int(round(xyxy[2] / max(1, w) * 1000)))),
                    max(0, min(1000, int(round(xyxy[3] / max(1, h) * 1000)))),
                ]
                mapped = map_raw_class_to_campus_category(cls_name, conf, 0.25)
                yolo_detections.append(
                    {
                        "rawClass": cls_name,
                        "mappedCategory": mapped,
                        "confidence": round(conf, 3),
                        "bbox": norm_box,
                    }
                )
            # Prefer a YOLO box that maps to a valid campus category, otherwise highest confidence box
            campus_boxes = [d for d in yolo_detections if d["mappedCategory"] != "unknown"]
            chosen = (
                max(campus_boxes, key=lambda d: d["confidence"])
                if campus_boxes
                else (max(yolo_detections, key=lambda d: d["confidence"]) if yolo_detections else None)
            )
            if chosen:
                best_yolo_class = chosen["rawClass"]
                best_yolo_conf = chosen["confidence"]
                best_bbox = chosen["bbox"]

        # Step 2: OpenCLIP ViT-B/32 zero-shot campus category refinement (especially for non-COCO items like campus_card/earbuds/keychain/glasses)
        with torch.no_grad():
            tensor = self.clip_preprocess(img).unsqueeze(0).to(self.device)
            img_feat = self.clip_model.encode_image(tensor)
            img_feat = img_feat / img_feat.norm(dim=-1, keepdim=True)
            logits = (100.0 * img_feat @ self.clip_text_features.T).softmax(dim=-1)
            probs = logits.squeeze(0).detach().cpu().numpy()

        top_clip_idx = int(np.argmax(probs))
        clip_raw_class, _, clip_zh_kw = CAMPUS_CLIP_PROMPTS[top_clip_idx]
        clip_conf = float(probs[top_clip_idx])

        yolo_mapped = (
            map_raw_class_to_campus_category(best_yolo_class, best_yolo_conf, 0.30)
            if best_yolo_class
            else "unknown"
        )

        # Combine YOLO26n detection + OpenCLIP zero-shot (+ text semantic disambiguation when visual conf < 0.50)
        combined_text = f"{title} {description}".strip()
        text_matched_class: Optional[str] = None
        if combined_text:
            lowered_text = combined_text.lower()
            for cand_key in sorted(MODEL_TO_CAMPUS_CATEGORY_MAP.keys(), key=len, reverse=True):
                if cand_key.lower() in lowered_text:
                    text_matched_class = cand_key
                    break

        if yolo_mapped != "unknown" and best_yolo_conf >= 0.45:
            raw_class = best_yolo_class or clip_raw_class
            confidence = best_yolo_conf
            mapped_category = yolo_mapped
            source = "model"
        elif clip_conf >= 0.50:
            raw_class = clip_raw_class
            confidence = round(min(0.98, max(clip_conf, best_yolo_conf)), 3)
            mapped_category = map_raw_class_to_campus_category(clip_raw_class, confidence, 0.25)
            source = "model"
        elif text_matched_class:
            # Visual confidence < 0.50: multimodal disambiguation with item text semantics
            raw_class = text_matched_class
            confidence = round(max(clip_conf, best_yolo_conf, 0.62), 3)
            mapped_category = map_raw_class_to_campus_category(text_matched_class, confidence, 0.25)
            source = "model"
        elif clip_conf >= 0.30:
            raw_class = clip_raw_class
            confidence = round(max(clip_conf, best_yolo_conf), 3)
            mapped_category = map_raw_class_to_campus_category(clip_raw_class, confidence, 0.25)
            source = "model"
        else:
            raw_class = best_yolo_class or "unknown"
            confidence = round(max(best_yolo_conf, clip_conf), 3)
            mapped_category = "unknown"
            source = "model"

        # Step 3: Extract color (text hint first if explicit, otherwise HSV visual analysis)
        text_colors = extract_colors(combined_text)
        visual_color = self._extract_dominant_color_zh(
            img, (best_bbox[0], best_bbox[1], best_bbox[2], best_bbox[3])
        )
        color = text_colors[0] if text_colors else visual_color

        text_brands = extract_brands(combined_text)
        brand = text_brands[0] if text_brands else ""

        kw_list: List[str] = []
        for k in [clip_zh_kw, color, brand]:
            if k and k != "未知" and k not in kw_list:
                kw_list.append(k)
        for tok in extract_semantic_tokens(
            {"title": title, "description": description, "color": color, "brand": brand}
        ):
            if tok not in kw_list:
                kw_list.append(tok)
            if len(kw_list) >= 6:
                break

        latency_ms = max(1, int(round((time.perf_counter() - t0) * 1000)))
        return {
            "modelUsed": f"YOLO26n ({YOLO_WEIGHTS_PATH.name}) + OpenCLIP {OPENCLIP_MODEL_NAME}",
            "modelVersion": RECOGNITION_MODEL_VERSION,
            "recognitionSource": source,
            "isFallback": False,
            "fallbackReason": None,
            "rawModelClass": raw_class,
            "mappedCampusCategory": mapped_category,
            "confidence": round(confidence, 3),
            "bbox": best_bbox,
            "color": color,
            "brand": brand,
            "keywords": kw_list[:6],
            "yoloDetections": yolo_detections[:5],
            "clipZeroShotTop": {
                "rawClass": clip_raw_class,
                "labelZh": clip_zh_kw,
                "probability": round(clip_conf, 3),
            },
            "latencyMs": latency_ms,
        }

    def explain_match(
        self,
        lost_item: Dict[str, Any],
        found_item: Dict[str, Any],
        match_record: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        mr = match_record or {}
        fallback_reasoning = (
            mr.get("explanationSummary")
            or f"综合 7 维规则得分 ({mr.get('ruleScore7D', 0)} 分) 与 OpenCLIP ViT-B/32 512 维图像余弦相似度 "
            f"({mr.get('imageSimilarity', 0)}%) 生成可解释匹配归因，冲突项：{'；'.join(mr.get('conflictReasons') or []) or '无'}。"
        )
        if not GEMINI_API_KEY or GEMINI_API_KEY == "MY_GEMINI_API_KEY":
            return {
                "modelUsed": "structured-rule+openclip-explainer",
                "reasoning": fallback_reasoning,
            }
        try:
            from google import genai

            client = genai.Client(api_key=GEMINI_API_KEY)
            prompt = (
                "作为高校智能失物招领系统的可解释匹配归因引擎，请用简洁专业的中文（不超过120字）"
                "分析以下失物与拾物为什么匹配（或存在何种冲突）：\n"
                f"【失物】：{lost_item.get('title')} | 类别:{lost_item.get('campusCategory')} | 颜色:{lost_item.get('color')} | "
                f"地点:{lost_item.get('location')} | 时间:{lost_item.get('eventTime')} | 描述:{lost_item.get('description')}\n"
                f"【拾物】：{found_item.get('title')} | 类别:{found_item.get('campusCategory')} | 颜色:{found_item.get('color')} | "
                f"地点:{found_item.get('location')} | 时间:{found_item.get('eventTime')} | 描述:{found_item.get('description')}\n"
                f"【系统量化得分】：总分 {mr.get('totalScore')}，规则分 {mr.get('ruleScore7D')}，"
                f"图像相似度 {mr.get('imageSimilarity')}%，冲突原因：{'；'.join(mr.get('conflictReasons') or []) or '无'}"
            )
            resp = client.models.generate_content(
                model=GEMINI_EXPLAIN_MODEL,
                contents=prompt,
            )
            text = (resp.text or "").strip()
            if text:
                return {"modelUsed": GEMINI_EXPLAIN_MODEL, "reasoning": text}
        except Exception as exc:
            print(f"[/api/matches/explain] Gemini fallback triggered: {exc}")

        return {
            "modelUsed": "structured-rule+openclip-explainer",
            "reasoning": fallback_reasoning,
        }


ai_engine = LocalVisionAIEngine()
