# NOTES & PRODUCTION DEPLOYMENT GUIDE — 智能失物招领与图像匹配系统 (B-20)

- **Owner Account**: `shx614519@gmail.com`
- **Google Cloud / Firebase Project**: `course-design-app` (`gen-lang-client-0274035340`)
- **Runtime Vision & Reasoning Model Constant**: `GEMINI_MODEL = 'gemini-4-carbon'` (`RECOGNITION_MODEL_VERSION = 'gemini-4-carbon-vision-v1'`, strictly enforced across all vision recognition `/api/tasks/recognize` and explainable reasoning `/api/matches/explain` calls)
- **Model Pin Record (2026-11-13)**: Pinned runtime generation/recognition model to **Gemini 4 Carbon** (`gemini-4-carbon`, recognition version `gemini-4-carbon-vision-v1`) on `2026-11-13` per owner's decision that Carbon is better than Argon ("carbon比argon更好，把模型固定为carbon").
- **Runtime Real Image Embedding Model Constant**: `EMBEDDING_MODEL_VERSION = 'gemini-embedding-2'` (called server-side via `@google/genai` `ai.models.embedContent` on `generativelanguage.googleapis.com` with raw image bytes `inlineData`, returning real **3072-dimensional** L2-normalized multimodal vectors)

---

## 1. SUBSTITUTIONS (平台替换对照说明与已修复缺陷记录)

根据平台运行环境限制与《Platform-Substitution Addendum》授权规范，本系统在 Google AI Studio Web 容器中的等效替换与工程契约保持如下：

| 模块维度 | 原始规格书目标 (Production Spec) | AI Studio 运行时等效实现 (Current Build) | 契约一致性与后续迁移说明 |
| :--- | :--- | :--- | :--- |
| **前端框架** | Vue 3 + TypeScript + Vite | **React 19 + TypeScript + Vite** | 页面路由、组件拆分、Apple 极简液态毛玻璃（Liquid-Glass）交互与状态流转完全一致；可在本地 Antigravity 环境按相同组件边界平滑迁移至 Vue 3。 |
| **后端服务** | Python + FastAPI + Pydantic | **Node.js + Express (`server.ts`)** | 采用相同的分层架构（Routes / Services / Models），通过 `firebase-admin` 校验 Firebase Auth ID Token，并提供 `/api/tasks/recognize`、`/api/embeddings/encode`、`/api/matches/explain`、`/api/eval/run` 标准 REST 接口。 |
| **目标检测 (P0-1)** | Ultralytics YOLO26n (`yolo26n.pt`) | **Gemini Vision (`gemini-4-carbon`)** | Web 容器为 Node 环境且参考项目未附带权重文件。后端通过 `GEMINI_MODEL = 'gemini-4-carbon'` 输出原始检测类别 `rawModelClass`、置信度 `confidence`、边界框 `bbox`、颜色与品牌属性及耗时 `latencyMs`，经由可配置映射表 `MODEL_TO_CAMPUS_CATEGORY_MAP` 转换为校园标准类别；置信度不足或不在映射表内统一返回 `unknown` 并支持人工纠错，严禁伪造识别结果。前端 UI 不做虚假 YOLO/CLIP 宣称。 |
| **图像特征向量 (P0-2)** | CLIP ViT-B/32 (PyTorch) | **Gemini 多模态真实图像嵌入 (`gemini-embedding-2`, 3072维 L2 归一化向量)** | 服务端 (`server.ts` `/api/embeddings/encode` 与 `/api/seed`) 读取图像真实字节（本地 `/images/item_*.jpg` 或拉取 Cloud Storage 远程图像），调用 `generativelanguage.googleapis.com` 的 `models/gemini-embedding-2:embedContent` 接口生成真实 **3072 维**多模态向量并执行 L2 归一化，以 `(sha256, modelVersion="gemini-embedding-2")` 为唯一键通过 `getDeterministicEmbeddingId(imageHash, modelVersion)` 写入 Firestore `image_embeddings` 集合。若嵌入接口发生瞬态错误（如 429），识别任务直接标记为 `failed` 并记录错误原因支持重试，**严禁静默回退至哈希或文本伪向量**。 |
| **向量索引检索** | Firestore 原生 Vector Index | **有界候选集 Top-K 余弦检索 (`MAX_VECTOR_CANDIDATES = 100`) + `firestore.indexes.json` 向量索引配置** | 匹配时直接复用 `image_embeddings` 中已缓存的 3072 维归一化真实图像向量，严禁静默无上限全表扫描，并在界面显式展示向量索引状态与候选扫描上限。 |
| **异步任务队列与下架治理 (P1-2)** | Cloud Tasks + 独立 Cloud Run Python Worker | **`recognition_tasks` 集合完整状态机 (`pending/running/succeeded/failed`) + 管理员专属单条下架 (`delisted`)** | 完整实现重试计数 (`retryCount`)、幂等键 (`idempotencyKey`)、错误日志记录 (`errorMessage`)、管理后台手动重试按钮，以及仅对白名单管理员 (`shx614519@gmail.com`) 可见的失物大厅卡片「下架」按钮（将状态置为 `delisted`、移出大厅检索/在库统计/匹配候选池，并写入 `ITEM_DELIST` 审计日志）；生产级 Cloud Tasks + Python Worker 部署脚本见下文第 3 节。 |

---

## 2. SOURCES & EVALUATION ATTRIBUTION (评测数据集来源与协议声明)

本系统 P1-3 独立评测模块(`src/data/evaluationDatasets.ts`)导入了以下三个公开评测数据集：
- `dataset.json`（标准主评测集 v1，40 对样本：20 正例 + 20 负例）
- `dataset_control.json`（控制变量测试集 v2，8 组共 30 对单维度变量样本）
- `dataset_blind.json`（冻结盲测集 v1，12 对样本：6 正例 + 6 负例）
- 来源仓库：`https://github.com/chtgogogo/campus-lost-found-system/tree/master/evaluation`
- 开源协议：**MIT License** (`Copyright (c) 2026 CaoHT`)。按规范仅在代码文件头部注释与本 `NOTES.md` 中保留完整署名与协议声明，**绝不在前端 UI 界面展示参考仓库名称或链接**。

---

## 3. PRODUCTION DEPLOYMENT GUIDE (独立 Python AI Worker 与 Cloud Tasks 生产部署步骤)

当您将本项目的 AI 推理任务独立部署至 Google Cloud Run (`gen-lang-client-0274035340`) 时，请按以下步骤执行：

### 3.1 独立 Python AI Worker `Dockerfile`

```dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制模型权重与校验脚本（启动时强制检查 yolo26n.pt 存在性、SHA-256、model.names 与 PyTorch 兼容性）
COPY models/yolo26n.pt /app/models/yolo26n.pt
COPY worker_main.py /app/worker_main.py

ENV PORT=8080
ENV YOLO_WEIGHTS_PATH="/app/models/yolo26n.pt"
ENV YOLO_DEVICE="cpu"
ENV CLIP_MODEL_NAME="ViT-B/32"

CMD ["uvicorn", "worker_main:app", "--host", "0.0.0.0", "--port", "8080"]
```

### 3.2 启动自检与 YOLO26n + CLIP 推理核心逻辑 (`worker_main.py` 摘要)

```python
import hashlib
import os
import time
import torch
import clip
from ultralytics import YOLO
from fastapi import FastAPI, HTTPException

app = FastAPI(title="Campus Lost & Found AI Worker")

YOLO_PATH = os.environ.get("YOLO_WEIGHTS_PATH", "/app/models/yolo26n.pt")
EXPECTED_SHA256 = os.environ.get("YOLO_WEIGHTS_SHA256", "")
DEVICE = "cuda" if torch.cuda.is_available() and os.environ.get("YOLO_DEVICE") == "gpu" else "cpu"

def verify_and_load_models():
    if not os.path.exists(YOLO_PATH):
        raise RuntimeError(f"[P0-1 Startup Error] Missing official YOLO26n weights at {YOLO_PATH}. Please mount yolo26n.pt.")
    with open(YOLO_PATH, "rb") as f:
        actual_sha = hashlib.sha256(f.read()).hexdigest()
    if EXPECTED_SHA256 and actual_sha != EXPECTED_SHA256:
        raise RuntimeError(f"[P0-1 SHA-256 Mismatch] Expected {EXPECTED_SHA256}, got {actual_sha}")
    yolo_model = YOLO(YOLO_PATH)
    # 严禁混用分类权重：确认任务类型为 detect 且具备 model.names
    if getattr(yolo_model, "task", "detect") != "detect" or not hasattr(yolo_model, "names"):
        raise RuntimeError("[P0-1 Task Error] Loaded weights are not an object detection model.")
    clip_model, clip_preprocess = clip.load("ViT-B/32", device=DEVICE)
    return yolo_model, clip_model, clip_preprocess
```

### 3.3 尚需项目所有者 (`shx614519@gmail.com`) 在 GCP 控制台执行的配置步骤

1. **部署 Firestore 复合索引与原生向量索引**：
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes --project gen-lang-client-0274035340
   ```
   或使用 `gcloud firestore indexes composite create` 创建 `image_embeddings.vector`（模型 `gemini-embedding-2` 原生维度 `3072`，度量 `COSINE`）向量索引。
2. **启用 Firebase Storage 规则与 CORS 配置**：
   在 Firebase Console -> Storage 中确认 Bucket `gen-lang-client-0274035340.firebasestorage.app` 已开启认证用户读写权限。
3. **创建 Cloud Tasks 队列与最小权限服务账号（生产解耦部署时）**：
   ```bash
   gcloud tasks queues create recognition-tasks-queue \
     --location=us-east1 \
     --max-attempts=3 \
     --min-backoff=5s \
     --project=gen-lang-client-0274035340
   ```
4. **独立注意**：本应用 (`de88383b-4d6a-47d8-b3f7-d00ed62a9f61`) 完全独立构建，未触碰或修改任何既有应用或已有 Cloud Run 服务。

---

## 4. ROUND 12 SCENE PHOTO SOURCES (仅记录于 NOTES.md，绝不在前端展示)

演示种子照片于 2026-11-12 更换为真实照片（网络公开产品图，仅课程演示用），来源记录见项目外 SOURCES 清单
photo: Hajoon0102 / Wikimedia Commons, CC BY-SA 4.0

2026-11-13 Round 12 真实场景照片（每张照片文件名、SHA-256 与来源出处）：
- `tumbler-lost.jpg` — SHA-256 `e8d87700fcbdc9f812d5b9ecb169e2e166c5f51a1a5a1707e7390db38f72cd3f` — Walmart Canada lifestyle photo
- `tumbler-found.jpg` — SHA-256 `f3dea10adb0397d624f85002bab80579ed6ce9ccb404bdfe5f508cc627cc9123` — cleidebrindes product photo
- `tote-lost.jpg` — SHA-256 `92b8123e185c41ba625f70638dfd14bd53162528dca08ddbf4d201b1b2dd79e7` — Etsy listing photo
- `tote-found.jpg` — SHA-256 `130b4a0f4e81e2279c5d50c24cfb0a8b9f5ce705323fc7a75290bbc2d6a97c5b` — Etsy listing photo
- `keys-lost.jpg` — SHA-256 `58ec0712d74fd674afc1072c08d8230af2947de86470eb5cbc8b3e8cadec5731` — alklocksmith.com
- `keys-found.jpg` — SHA-256 `d3a8140e334007f3a51851140ad147410ebd3a5fa8ab769c92efb4b6603c0e92` — city of Épernay lost-and-found page photo
- `wallet-lost.jpg` — SHA-256 `50e4681b139a6ba62d7d200b0e4f7129a8e3e619299d824de1462e9b4f3ef80f` — Etsy
- `glasses-lost.jpg` — SHA-256 `5ec98c084fcb1c0e2f57864a2d1b9ef15e23131dd05e33bd979378c1381fa2c2` — ca-kk.ru
- `umbrella-found.jpg` — SHA-256 `13fd935045197a3e1c6e6404d7ea54d357849c4aecbffcb0505e4c71d2b19b87` — Ohouse snapshot
- `powerbank-found.jpg` — SHA-256 `16bd79a4a8d3f39f7ef928ba13acac38eba7215d548f36e3c03c833e8e3d02f3` — travel4you.tours

---

## 5. ROUND 16 LOGIN VERIFICATION SCHEME (内部文档，严禁在前端页面露出密码明文)

1. **账号密码登录 (`POST /api/auth/password-login`)**：
   - 5 个预设校园账号（李明轩 `2023010982`、陈思琪 `2023020416`、王浩然 `2022030819`、林晓雯 `2024010523`、张老师 `T2019008`）在「其他登录方式 → 账号密码」路径下共用统一演示密码：`cqca123456`。
   - 服务端 `server/authStore.ts` 仅存储每个账号独立 16 字节随机盐 + 64 字节 `scrypt` 派生哈希，使用 `crypto.timingSafeEqual` 进行恒定时间校验；前端页面与客户端代码均不含任何明文密码或哈希。
   - 暴力破解防护：同一账号连续 5 次密码校验失败触发 60 秒临时锁定（返回 HTTP 429 与剩余锁定秒数），校验成功后清零计数。
   - 快捷填入胶囊仅填充账号标识，绝不填充密码；底部快捷一键登录与 Google 管理员登录保持不变。

2. **邮箱验证码登录 (`POST /api/auth/email-code` & `POST /api/auth/email-login`)**：
   - 服务端使用 `crypto.randomInt` 生成 6 位验证码，仅在服务端内存 `activeEmailCodesByEmail` 中存储其加盐 `scrypt` 哈希（有效期 10 分钟、最多 5 次核验尝试、同一邮箱仅保留 1 条有效记录且重发立即作废旧码、核验成功后单次消费销毁）。
   - 邮件发送通过 `nodemailer` 读取以下 AI Studio Secrets：
     - `SMTP_HOST`（默认 `smtp.gmail.com`）
     - `SMTP_PORT`（默认 `465`）
     - `SMTP_USER`（发件邮箱账号）
     - `SMTP_PASS`（SMTP 授权码 / 应用专用密码）
   - 未配置 `SMTP_USER` / `SMTP_PASS` 时，接口诚实返回 HTTP 503 (`SMTP_NOT_CONFIGURED`)，前端提示「邮箱验证码暂未开通（邮件服务未配置）」，绝不伪造发送或前端展示验证码。

3. **未开通入口治理**：
   - 「手机号」与「人脸识别」在未对接真实短信通道与活体核验能力前，明确展示「暂未开通」且禁用登录提交。


