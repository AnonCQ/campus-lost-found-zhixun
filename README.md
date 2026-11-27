# 智寻校园 · 智能失物招领与图像匹配系统

《智能系统设计与开发课程设计》综合实践项目（选题 20：智能失物招领与图像匹配系统）。

## 一、系统架构与技术栈

| 层次 | 技术实现 | 说明 |
| :--- | :--- | :--- |
| **Web 前端** | React 19 + TypeScript + Vite 8 + Tailwind CSS v4 + Recharts | 移动优先液态玻璃界面，含首页大厅、智能发帖匹配、消息中心、认领交接码、数据可视化与模型评测看板 |
| **Web 后端** | Python 3.12 + **FastAPI** + Uvicorn + Pydantic | 分层 REST API（健康检查、数据聚合、鉴权、本地图片存储、视觉推理、向量检索、认领闭环、离线评测、可视化统计） |
| **数据库管理** | **SQLAlchemy 2.0 + SQLite**（默认零配置，支持 `DATABASE_URL` 一键切换 **MySQL**） | 9 张规范化关系表：`users`、`items`、`image_embeddings`、`recognition_tasks`、`matches`、`match_feedback`、`claims`、`messages`、`audit_logs` |
| **目标检测（DL）** | 官方 **Ultralytics YOLO26n (`yolo26n.pt`)** | CUDA GPU 加速推理，输出原始检测类别、置信度、归一化边界框 `bbox`，结合 HSV 色彩提取与可配置校园类别映射表 |
| **视觉特征检索（DL+ML）** | **OpenCLIP ViT-B/32 (`openai`)** | 提取真实 512 维 L2 归一化图像向量，按 `(sha256, modelVersion)` 去重缓存；结合多模板 Prompt 集成实现校园长尾物品零样本识别 |
| **智能匹配与评测（ML）** | **三路召回 + 7 维可解释重排** + 独立 3 套离线评测基准 | 类别同族 ∪ 文本语义关键词 ∪ 512D 图像向量 Top-K 并集召回，融合 7 维规则与强冲突惩罚，支持在线复现 Precision / Recall / F1 / Recall@K |
| **RAG 与大模型 Agent** | **混合 RAG（TF-IDF 校园知识库 + OpenCLIP 文搜图）+ Tool-Calling AI 助手**（支持 Gemini 3.5 Flash 与 DeepSeek/Qwen 等 OpenAI 兼容 API） | 首页顶部「AI 助手」支持自然语言检索规章/挂失流程（展示引用依据）、跨模态搜线索、查询个人认领进度，并能结构化拟稿「一键填入发布页」 |

---

## 二、快速启动指南

### 1. Python 后端（FastAPI + YOLO26n + OpenCLIP）

推荐使用已安装 PyTorch CUDA + Ultralytics 的 `yolov11` Conda 环境（下载模型权重走 `7890` 代理）：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7890"
$env:HTTPS_PROXY="http://127.0.0.1:7890"
D:\DevTools\Anaconda3\envs\yolov11\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8088 --reload
```

- 后端 API 文档（Swagger UI）：http://127.0.0.1:8088/docs
- 健康检查与模型状态：http://127.0.0.1:8088/api/health

### 2. 前端开发服务器（Vite）

```powershell
npm install --legacy-peer-deps --proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890
npm run dev
```

- 前端访问地址：http://127.0.0.1:5173（`/api`、`/uploads`、`/images` 自动代理至 `http://127.0.0.1:8088`）
- 也可执行 `npm run build` 后直接访问 http://127.0.0.1:8088 由 FastAPI 统一托管前后端！

### 3. 一键启动脚本

```powershell
.\start_local.ps1
```

### 4. 后端冒烟与集成测试

```powershell
D:\DevTools\Anaconda3\envs\yolov11\python.exe backend\smoke_test.py
```

## 三、演示账号说明

- 首页启动支持快捷选择 5 个预设校园角色（李明轩 / 陈思琪 / 王浩然 / 林晓雯 / 管理员张老师）一键登录。
- 「其他登录方式 → 账号密码」统一演示密码为 `cqca123456`（服务端采用加盐 `scrypt` 校验 + 连续 5 次错误锁定 60 秒）。
- 进入底部 **「我的 → 数据可视化与模型评测看板」** 可查看 Recharts 实时图表、GPU/YOLO26n/OpenCLIP 运行状态及三策略评测对比。
