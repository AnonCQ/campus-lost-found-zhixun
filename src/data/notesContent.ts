/**
 * Structured Engineering Notes & Platform Substitutions for In-App Admin Inspection
 */

export const NOTES_SECTIONS = {
  substitutions: [
    {
      module: '前端框架 (Frontend)',
      targetSpec: 'Vue 3 + TypeScript + Vite',
      currentBuild: 'React 19 + TypeScript + Vite (Apple-Minimal Liquid-Glass)',
      note: 'AI Studio Web 容器原生运行 React 技术栈；页面结构、组件边界与交互逻辑严格对齐规格书，便于后续在 Antigravity 迁移至 Vue 3。',
    },
    {
      module: '后端服务 (Backend)',
      targetSpec: 'Python + FastAPI + Pydantic',
      currentBuild: 'Node.js + Express (server.ts) + Firebase Admin SDK',
      note: '按 Routes / Services / Models 同构分层，服务端统一校验 Firebase Auth ID Token 并提供异步任务、特征编码与基准比对接口。',
    },
    {
      module: '物品识别 (P0-1)',
      targetSpec: 'Ultralytics YOLO26n (yolo26n.pt)',
      currentBuild: "Gemini Vision (统一模型常量 GEMINI_MODEL = 'gemini-4-carbon')",
      note: '输出原始类别、置信度、边界框与推理耗时，通过可配置 MODEL_TO_CAMPUS_CATEGORY_MAP 映射至 8 大校园标准类别；低置信度或未登录类别返回 unknown 并支持人工纠错，前端不做虚假 YOLO/CLIP 宣称。',
    },
    {
      module: '特征缓存与相似度检索 (P0-2)',
      targetSpec: 'CLIP ViT-B/32 + Firestore Index',
      currentBuild: 'Gemini Embedding 2 (gemini-embedding-2, 3072D) + SHA-256 去重缓存 + 有界 Top-K 余弦检索 (上限 100)',
      note: '服务端 (/api/embeddings/encode 与 /api/seed) 读取真实图像字节调用 generativelanguage.googleapis.com 的 models/gemini-embedding-2:embedContent 生成真实 3072 维多模态特征编码并做 L2 归一化，以 (sha256, modelVersion="gemini-embedding-2") 为唯一键通过 getDeterministicEmbeddingId 持久化至 image_embeddings，同图首次发布即 100% 命中缓存且绝不回退伪特征。',
    },
    {
      module: '异步任务队列与下架治理 (P1-2)',
      targetSpec: 'Cloud Tasks + 独立 Cloud Run Python Worker',
      currentBuild: 'recognition_tasks 状态机 (pending/running/succeeded/failed) + 管理员专属下架 (delisted)',
      note: '完整支持幂等键 idempotencyKey、重试计数、错误记录、管理员手动重试，以及白名单管理员 (shx614519@gmail.com) 专属单条下架按钮（置为 delisted、移出在库统计与匹配候选池并记录 ITEM_DELIST 审计日志）。',
    },
  ],
  cloudStepsRequired: [
    '1. Firestore 复合与特征索引部署：项目已生成 firestore.indexes.json (含 3072 维 image_embeddings.vector 配置) 与 firestore.rules，生产环境执行 firebase deploy --only firestore:indexes,firestore:rules --project gen-lang-client-0274035340。',
    '2. Firebase Authentication 域名授权：若部署至自定义 Cloud Run 域名，请在 Firebase Console -> Authentication -> Settings -> Authorized domains 添加对应服务域名。',
    '3. Cloud Storage 权限检查：确保 Bucket (gen-lang-client-0274035340.firebasestorage.app) 允许已认证客户端上传 items/* 路径下的脱敏图片。',
    '4. 独立 Python Worker 部署（可选生产扩展）：按 NOTES.md 中的 Dockerfile 挂载官方 yolo26n.pt 权重并配置 YOLO_WEIGHTS_SHA256 与 Cloud Tasks 队列 recognition-tasks-queue。',
  ],
};
