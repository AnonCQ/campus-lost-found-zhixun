"""
Backend Configuration Module
Supports SQLite (default local) and MySQL (via DATABASE_URL env var),
official Ultralytics YOLO26n weights, OpenCLIP ViT-B/32 visual encoder,
and optional Gemini API for explainable match reasoning.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent

# Load project .env if present
load_dotenv(BASE_DIR / ".env")

DATA_DIR = BACKEND_DIR / "data"
MODELS_DIR = BACKEND_DIR / "models"
UPLOADS_DIR = BACKEND_DIR / "uploads"
PUBLIC_IMAGES_DIR = BASE_DIR / "public" / "images"
DIST_DIR = BASE_DIR / "dist"

for _d in (DATA_DIR, MODELS_DIR, UPLOADS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# Database configuration: defaults to local SQLite; set DATABASE_URL for MySQL
# e.g. DATABASE_URL="mysql+pymysql://root:password@127.0.0.1:3306/campus_lost_found?charset=utf8mb4"
DEFAULT_SQLITE_PATH = DATA_DIR / "campus_lost_found.db"
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}",
)

# Model configuration
YOLO_WEIGHTS_PATH = Path(
    os.getenv("LOCAL_YOLO_WEIGHTS_PATH", str(MODELS_DIR / "yolo26n.pt"))
)
YOLO_MODEL_NAME = "yolo26n.pt"
YOLO_CONF_THRESHOLD = float(os.getenv("YOLO_CONF_THRESHOLD", "0.25"))

OPENCLIP_MODEL_NAME = os.getenv("OPENCLIP_MODEL_NAME", "ViT-B-32")
OPENCLIP_PRETRAINED = os.getenv("OPENCLIP_PRETRAINED", "openai")
EMBEDDING_MODEL_VERSION = "openclip-vit-b-32"
RECOGNITION_MODEL_VERSION = "yolo26n+openclip-v1"
ALGORITHM_VERSION = "v2.4-hybrid-3way"

# LLM Agent & Explainable Reasoning (Supports Gemini native API & OpenAI-compatible APIs like DeepSeek/Qwen/Ollama)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_EXPLAIN_MODEL = os.getenv("GEMINI_EXPLAIN_MODEL", "gemini-3.5-flash").strip()
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat").strip()

# Admin & Security
ADMIN_WHITELIST_EMAIL = os.getenv("ADMIN_WHITELIST_EMAIL", "shx614519@gmail.com").strip()

# SMTP Email OTP (optional)
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com").strip() or "smtp.gmail.com"
SMTP_PORT = int(os.getenv("SMTP_PORT", "465") or 465)
SMTP_USER = os.getenv("SMTP_USER", "").strip()
SMTP_PASS = os.getenv("SMTP_PASS", "").strip()

# Proxy (optional, e.g. http://127.0.0.1:7890)
HTTP_PROXY = os.getenv("HTTP_PROXY", "").strip()
HTTPS_PROXY = os.getenv("HTTPS_PROXY", "").strip()

MAX_VECTOR_CANDIDATES = 100
DEFAULT_TOP_K = 5
