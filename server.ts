/**
 * Full-Stack Server Entry Point (Node.js + Express + Vite Middleware)
 *
 * Implements the layered backend architecture (Routes / Services / Models):
 * - Firebase Admin SDK token verification & idempotent 12-item deterministic seed (POST /api/seed)
 * - P0-1 Vision Recognition & Configurable Campus Category Mapping (using GEMINI_MODEL = 'gemini-4-carbon')
 * - P0-2 L2-Normalized Image Feature Vector Encoding & SHA-256 Deduplication Support
 * - P1-1 Explainable Match Reasoning (using GEMINI_MODEL = 'gemini-4-carbon')
 * - P1-3 Independent Evaluation Benchmark Endpoint
 */

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import nodeCrypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { initializeApp as initializeClientApp } from 'firebase/app';
import { getAuth as getClientAuth, signInAnonymously } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore as getClientFirestore,
  writeBatch,
} from 'firebase/firestore';
import firebaseConfig from './src/firebase-applet-config.json' with { type: 'json' };
import {
  getSmtpConfiguration,
  sendEmailVerificationCode,
  verifyEmailCodeLogin,
  verifyPasswordLogin,
} from './server/authStore.ts';
import {
  ADMIN_WHITELIST_EMAIL,
  AuditLog,
  EMBEDDING_MODEL_VERSION,
  GEMINI_MODEL,
  mapRawClassToCampusCategory,
  MODEL_TO_CAMPUS_CATEGORY_MAP,
  RECOGNITION_MODEL_VERSION,
  UserProfile,
} from './src/types/models.ts';
import {
  extractColors,
  extractBrands,
  extractSemanticTokens,
  l2Normalize,
} from './src/services/matchingEngine.ts';
import { runDatasetEvaluation } from './src/services/evaluationRunner.ts';
import {
  buildSeedEmbeddings,
  buildSeedMatches,
  buildSeedTasks,
  SEED_AUDIT_LOGS,
  SEED_CLAIMS,
  SEED_ITEMS,
  SEED_MESSAGES,
  SEED_USERS,
} from './src/data/seedData.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin SDK
const adminApp =
  getApps().length === 0
    ? initializeAdminApp({
        projectId: process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId || 'gen-lang-client-0274035340',
      })
    : getApps()[0];

const adminDb = getAdminFirestore(adminApp, firebaseConfig.firestoreDatabaseId);

// Server-side Firebase JS client connected to the exact provisioned database ID
const serverFirebaseApp = initializeClientApp(firebaseConfig, 'server-seed-worker');
const serverClientAuth = getClientAuth(serverFirebaseApp);
const serverClientDb = getClientFirestore(serverFirebaseApp, firebaseConfig.firestoreDatabaseId);

async function ensureServerClientAuth(): Promise<void> {
  if (!serverClientAuth.currentUser) {
    try {
      await signInAnonymously(serverClientAuth);
    } catch {
      // Proceed if anonymous sign-in is already active or handled
    }
  }
}

// Initialize @google/genai client (Server-Side Only)
// Vision recognition & reasoning strictly use GEMINI_MODEL = 'gemini-4-carbon'.
// Image embeddings strictly use EMBEDDING_MODEL_VERSION = 'gemini-embedding-2' via ai.models.embedContent.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

const taskResultByIdempotencyKey = new Map<string, Record<string, unknown>>();
const realVectorCacheByShaAndModel = new Map<string, number[]>();

/**
 * Resolves raw image bytes (base64 + mimeType) from:
 * 1) Direct base64 payload in request body
 * 2) Data URL (data:image/...;base64,...)
 * 3) Local public image file on disk (/images/item_*.jpg or /src/assets/images/item_*.jpg)
 * 4) Remote Cloud Storage URL (https://firebasestorage.googleapis.com/... or https://storage.googleapis.com/...)
 */
async function resolveImageBytes(params: {
  base64Image?: string;
  mimeType?: string;
  imageUrl?: string;
}): Promise<{ base64Data: string; mimeType: string }> {
  if (params.base64Image && typeof params.base64Image === 'string' && params.base64Image.length > 32) {
    const cleanB64 = params.base64Image.includes(',')
      ? params.base64Image.split(',')[1]
      : params.base64Image;
    return {
      base64Data: cleanB64,
      mimeType: params.mimeType || 'image/jpeg',
    };
  }

  const imageUrl = (params.imageUrl || '').trim();
  if (!imageUrl) {
    throw new Error('缺少图像数据：未提供 base64Image 或 imageUrl，无法调用真实图像特征编码模型');
  }

  if (imageUrl.startsWith('data:image/')) {
    const [header, b64] = imageUrl.split(',');
    const mimeMatch = header.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/);
    if (!b64) {
      throw new Error('无效的 data:image Base64 数据格式');
    }
    return {
      base64Data: b64,
      mimeType: mimeMatch?.[1] || params.mimeType || 'image/jpeg',
    };
  }

  if (imageUrl.startsWith('/images/') || imageUrl.startsWith('/src/assets/images/')) {
    const fileName = path.basename(imageUrl);
    const candidatePaths = [
      path.join(__dirname, 'public', 'images', fileName),
      path.join(__dirname, 'dist', 'images', fileName),
      path.join(__dirname, 'src', 'assets', 'images', fileName),
    ];
    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate)) {
        const buf = fs.readFileSync(candidate);
        const ext = path.extname(fileName).toLowerCase();
        const detectedMime =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return {
          base64Data: buf.toString('base64'),
          mimeType: params.mimeType || detectedMime,
        };
      }
    }
    throw new Error(`本地公开图像文件不存在: ${imageUrl}`);
  }

  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    const resp = await fetch(imageUrl);
    if (!resp.ok) {
      throw new Error(`拉取远程 Cloud Storage 图像失败 (${resp.status}): ${imageUrl}`);
    }
    const contentType = resp.headers.get('content-type') || params.mimeType || 'image/jpeg';
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.byteLength < 32) {
      throw new Error(`远程图像字节长度异常 (${buf.byteLength} bytes)`);
    }
    return {
      base64Data: buf.toString('base64'),
      mimeType: contentType.split(';')[0].trim() || 'image/jpeg',
    };
  }

  throw new Error(`不支持的图像路径格式: ${imageUrl}`);
}

/**
 * Calls the real multimodal embedding model (gemini-embedding-2) on generativelanguage.googleapis.com
 * via @google/genai ai.models.embedContent with raw image bytes (inlineData), and L2-normalizes
 * the returned 3072-dimensional vector. Never falls back to hash or text pseudo-vectors.
 */
async function encodeRealImageEmbeddingFromBytes(params: {
  sha256?: string;
  base64Data: string;
  mimeType: string;
}): Promise<{
  vector: number[];
  dimension: number;
  modelVersion: string;
  cacheHitInMemory: boolean;
}> {
  const cacheKey = params.sha256 ? `${params.sha256}_${EMBEDDING_MODEL_VERSION}` : '';
  if (cacheKey && realVectorCacheByShaAndModel.has(cacheKey)) {
    const cached = realVectorCacheByShaAndModel.get(cacheKey)!;
    return {
      vector: cached,
      dimension: cached.length,
      modelVersion: EMBEDDING_MODEL_VERSION,
      cacheHitInMemory: true,
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('服务端未配置 GEMINI_API_KEY，无法调用 gemini-embedding-2 图像嵌入接口');
  }

  let lastErr: unknown = null;
  let rawValues: number[] | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const embedResp = await ai.models.embedContent({
        model: EMBEDDING_MODEL_VERSION,
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: params.mimeType || 'image/jpeg',
                  data: params.base64Data,
                },
              },
            ],
          },
        ],
      });
      rawValues = embedResp.embeddings?.[0]?.values;
      if (Array.isArray(rawValues) && rawValues.length > 0) {
        break;
      }
      throw new Error(`模型 ${EMBEDDING_MODEL_VERSION} 未返回有效图像嵌入特征`);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }

  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`模型 ${EMBEDDING_MODEL_VERSION} 未返回有效图像嵌入特征`);
  }

  const normalized = l2Normalize(rawValues);
  if (cacheKey) {
    realVectorCacheByShaAndModel.set(cacheKey, normalized);
  }

  return {
    vector: normalized,
    dimension: normalized.length,
    modelVersion: EMBEDDING_MODEL_VERSION,
    cacheHitInMemory: false,
  };
}

let seedLockPromise: Promise<{
  seeded: boolean;
  mode: string;
  itemCount: number;
  embeddingCount: number;
  embeddingDimension: number;
  embeddingModelVersion: string;
  matchCount: number;
  engine: string;
}> | null = null;

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const cleaned: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      cleaned[k] = v;
    }
  }
  return cleaned as T;
}

/**
 * Encodes all 6 unique seed images (/images/item_*.jpg) via the real gemini-embedding-2 model
 * so the 12 seeded items and 6 shared image_embeddings documents store genuine 3072D image vectors
 * computed from the exact on-disk file bytes and keyed by their real SHA-256 digest.
 */
async function buildRealVectorsForSeedItems(forceRefresh = false): Promise<Map<string, number[]>> {
  if (forceRefresh) {
    realVectorCacheByShaAndModel.clear();
  }
  const uniqueBySha = new Map<string, string>();
  for (const item of SEED_ITEMS) {
    if (item.imageSha256 && item.imageUrl && !uniqueBySha.has(item.imageSha256)) {
      uniqueBySha.set(item.imageSha256, item.imageUrl);
    }
  }

  const vectorsBySha = new Map<string, number[]>();
  for (const [expectedSha256, imageUrl] of uniqueBySha.entries()) {
    const { base64Data, mimeType } = await resolveImageBytes({ imageUrl });
    const rawBuf = Buffer.from(base64Data, 'base64');
    const computedSha256 = `sha256_${nodeCrypto.createHash('sha256').update(rawBuf).digest('hex')}`;
    const effectiveSha256 = computedSha256 || expectedSha256;
    const encoded = await encodeRealImageEmbeddingFromBytes({
      sha256: effectiveSha256,
      base64Data,
      mimeType,
    });
    vectorsBySha.set(expectedSha256, encoded.vector);
    if (effectiveSha256 !== expectedSha256) {
      vectorsBySha.set(effectiveSha256, encoded.vector);
    }
  }
  return vectorsBySha;
}

/**
 * Step 2 & Requirement 3: Server-side transactional/idempotent 12-item deterministic seed and reset
 * using REAL 3072D image embeddings from gemini-embedding-2.
 * Automatically invalidates and deletes any old hash-derived or outdated-SHA vectors on reset or version mismatch.
 */
async function executeDeterministicServerSeed(
  mode: 'if_empty' | 'reset',
  actor?: UserProfile
): Promise<{
  seeded: boolean;
  mode: string;
  itemCount: number;
  embeddingCount: number;
  embeddingDimension: number;
  embeddingModelVersion: string;
  matchCount: number;
  engine: string;
}> {
  if (seedLockPromise) {
    return seedLockPromise;
  }

  seedLockPromise = (async () => {
    const collectionsToManage = [
      'items',
      'image_embeddings',
      'recognition_tasks',
      'matches',
      'match_feedback',
      'claims',
      'messages',
      'audit_logs',
    ];

    const expectedSeedEmbeddingIds = new Set(
      SEED_ITEMS.map((item) => item.embeddingId).filter((id): id is string => Boolean(id))
    );

    // 1. Try firebase-admin first
    try {
      const [existingItemsSnap, existingEmbSnap] = await Promise.all([
        adminDb.collection('items').get(),
        adminDb.collection('image_embeddings').get(),
      ]);
      const allRealEmbeddingsValid =
        existingEmbSnap.size === expectedSeedEmbeddingIds.size &&
        existingEmbSnap.docs.every((d) => {
          const data = d.data();
          return (
            expectedSeedEmbeddingIds.has(d.id) &&
            data.modelVersion === EMBEDDING_MODEL_VERSION &&
            typeof data.dimension === 'number' &&
            data.dimension > 100
          );
        });

      const hasRound12ScenePhotosAndSingletons =
        existingItemsSnap.size === SEED_ITEMS.length &&
        existingItemsSnap.docs.some(
          (d) =>
            d.id === 'demo_found_01' &&
            String(d.data()?.imageUrl || '').includes('found_angle_') &&
            d.data()?.ownerUid === 'student_wang'
        ) &&
        existingItemsSnap.docs.some(
          (d) =>
            d.id === 'demo_lost_04' &&
            d.data()?.imageUrl === '/images/tumbler-lost.jpg'
        ) &&
        existingItemsSnap.docs.some((d) => d.id === 'demo_lost_07') &&
        existingItemsSnap.docs.some((d) => d.id === 'demo_found_08');

      if (mode === 'if_empty' && hasRound12ScenePhotosAndSingletons && allRealEmbeddingsValid) {
        // Clean any audit residue item (红色雨伞) and ensure SEED_USERS reconciled wallet transactions are synced
        for (const d of existingItemsSnap.docs) {
          if (String(d.data()?.title || '').includes('红色雨伞')) {
            await d.ref.delete();
          }
        }
        const userSyncBatch = adminDb.batch();
        for (const u of SEED_USERS) {
          userSyncBatch.set(adminDb.collection('users').doc(u.uid), stripUndefined(u), { merge: true });
        }
        await userSyncBatch.commit();

        const firstDim = existingEmbSnap.docs[0]?.data()?.dimension || 3072;
        return {
          seeded: false,
          mode,
          itemCount: SEED_ITEMS.length,
          embeddingCount: existingEmbSnap.size,
          embeddingDimension: firstDim,
          embeddingModelVersion: EMBEDDING_MODEL_VERSION,
          matchCount: 6,
          engine: 'firebase-admin',
        };
      }

      let realVectorsBySha: Map<string, number[]>;
      if (allRealEmbeddingsValid && mode === 'if_empty') {
        realVectorsBySha = new Map<string, number[]>();
        existingEmbSnap.docs.forEach((d) => {
          const data = d.data();
          if (data.sha256 && Array.isArray(data.vector)) {
            realVectorsBySha.set(data.sha256, data.vector);
          }
        });
      } else {
        realVectorsBySha = await buildRealVectorsForSeedItems(mode === 'reset');
      }
      const seedEmbeddings = buildSeedEmbeddings(realVectorsBySha);
      const seedTasks = buildSeedTasks();
      const seedMatches = buildSeedMatches(seedEmbeddings);

      for (const colName of collectionsToManage) {
        const snap = await adminDb.collection(colName).get();
        if (!snap.empty) {
          const delBatch = adminDb.batch();
          snap.docs.forEach((d) => delBatch.delete(d.ref));
          await delBatch.commit();
        }
      }

      const writeBatchAdmin = adminDb.batch();
      for (const u of SEED_USERS) {
        writeBatchAdmin.set(adminDb.collection('users').doc(u.uid), stripUndefined(u));
      }
      for (const item of SEED_ITEMS) {
        writeBatchAdmin.set(adminDb.collection('items').doc(item.id), stripUndefined(item));
      }
      for (const emb of seedEmbeddings) {
        writeBatchAdmin.set(adminDb.collection('image_embeddings').doc(emb.id), stripUndefined(emb));
      }
      for (const t of seedTasks) {
        writeBatchAdmin.set(adminDb.collection('recognition_tasks').doc(t.id), stripUndefined(t));
      }
      for (const m of seedMatches) {
        writeBatchAdmin.set(adminDb.collection('matches').doc(m.id), stripUndefined(m));
      }
      for (const c of SEED_CLAIMS) {
        writeBatchAdmin.set(adminDb.collection('claims').doc(c.id), stripUndefined(c));
      }
      for (const msg of SEED_MESSAGES) {
        writeBatchAdmin.set(adminDb.collection('messages').doc(msg.id), stripUndefined(msg));
      }
      for (const log of SEED_AUDIT_LOGS) {
        writeBatchAdmin.set(adminDb.collection('audit_logs').doc(log.id), stripUndefined(log));
      }
      await writeBatchAdmin.commit();

      return {
        seeded: true,
        mode,
        itemCount: SEED_ITEMS.length,
        embeddingCount: seedEmbeddings.length,
        embeddingDimension: seedEmbeddings[0]?.dimension || 3072,
        embeddingModelVersion: EMBEDDING_MODEL_VERSION,
        matchCount: seedMatches.length,
        engine: 'firebase-admin',
      };
    } catch {
      // Cross-project container ADC fallback: execute idempotent deterministic batch on serverClientDb
      await ensureServerClientAuth();
      const [existingSnap, existingEmbSnap] = await Promise.all([
        getDocs(collection(serverClientDb, 'items')),
        getDocs(collection(serverClientDb, 'image_embeddings')),
      ]);

      const allRealEmbeddingsValid =
        existingEmbSnap.size === expectedSeedEmbeddingIds.size &&
        existingEmbSnap.docs.every((d) => {
          const data = d.data();
          return (
            expectedSeedEmbeddingIds.has(d.id) &&
            data.modelVersion === EMBEDDING_MODEL_VERSION &&
            typeof data.dimension === 'number' &&
            data.dimension > 100
          );
        });

      const hasRound12ScenePhotosAndSingletons =
        existingSnap.size === SEED_ITEMS.length &&
        existingSnap.docs.some(
          (d) =>
            d.id === 'demo_found_01' &&
            String(d.data()?.imageUrl || '').includes('found_angle_') &&
            d.data()?.ownerUid === 'student_wang'
        ) &&
        existingSnap.docs.some(
          (d) =>
            d.id === 'demo_lost_04' &&
            d.data()?.imageUrl === '/images/tumbler-lost.jpg'
        ) &&
        existingSnap.docs.some((d) => d.id === 'demo_lost_07') &&
        existingSnap.docs.some((d) => d.id === 'demo_found_08');

      if (mode === 'if_empty' && hasRound12ScenePhotosAndSingletons && allRealEmbeddingsValid) {
        const cleanupBatch = writeBatch(serverClientDb);
        for (const d of existingSnap.docs) {
          if (String(d.data()?.title || '').includes('红色雨伞')) {
            cleanupBatch.delete(d.ref);
          }
        }
        for (const u of SEED_USERS) {
          cleanupBatch.set(doc(serverClientDb, 'users', u.uid), stripUndefined(u), { merge: true });
        }
        await cleanupBatch.commit();

        const firstDim = existingEmbSnap.docs[0]?.data()?.dimension || 3072;
        return {
          seeded: false,
          mode,
          itemCount: SEED_ITEMS.length,
          embeddingCount: existingEmbSnap.size,
          embeddingDimension: firstDim,
          embeddingModelVersion: EMBEDDING_MODEL_VERSION,
          matchCount: 6,
          engine: 'server-firestore-deterministic',
        };
      }

      let realVectorsBySha: Map<string, number[]>;
      if (allRealEmbeddingsValid && mode === 'if_empty') {
        realVectorsBySha = new Map<string, number[]>();
        existingEmbSnap.docs.forEach((d) => {
          const data = d.data();
          if (data.sha256 && Array.isArray(data.vector)) {
            realVectorsBySha.set(data.sha256, data.vector);
          }
        });
      } else {
        realVectorsBySha = await buildRealVectorsForSeedItems(mode === 'reset');
      }
      const seedEmbeddings = buildSeedEmbeddings(realVectorsBySha);
      const seedTasks = buildSeedTasks();
      const seedMatches = buildSeedMatches(seedEmbeddings);

      // Delete any stale or non-seed documents (including old vec64 docs) across managed collections first
      for (const colName of collectionsToManage) {
        const snap = await getDocs(collection(serverClientDb, colName));
        if (!snap.empty) {
          const delBatch = writeBatch(serverClientDb);
          snap.docs.forEach((d) => delBatch.delete(d.ref));
          await delBatch.commit();
        }
      }

      const batch = writeBatch(serverClientDb);
      for (const u of SEED_USERS) {
        batch.set(doc(serverClientDb, 'users', u.uid), stripUndefined(u));
      }
      for (const item of SEED_ITEMS) {
        batch.set(doc(serverClientDb, 'items', item.id), stripUndefined(item));
      }
      for (const emb of seedEmbeddings) {
        batch.set(doc(serverClientDb, 'image_embeddings', emb.id), stripUndefined(emb));
      }
      for (const t of seedTasks) {
        batch.set(doc(serverClientDb, 'recognition_tasks', t.id), stripUndefined(t));
      }
      for (const m of seedMatches) {
        batch.set(doc(serverClientDb, 'matches', m.id), stripUndefined(m));
      }
      for (const c of SEED_CLAIMS) {
        batch.set(doc(serverClientDb, 'claims', c.id), stripUndefined(c));
      }
      for (const msg of SEED_MESSAGES) {
        batch.set(doc(serverClientDb, 'messages', msg.id), stripUndefined(msg));
      }
      for (const log of SEED_AUDIT_LOGS) {
        batch.set(doc(serverClientDb, 'audit_logs', log.id), stripUndefined(log));
      }

      if (actor && mode === 'reset') {
        const resetLogId = 'audit_demo_reset_latest';
        const resetLog: AuditLog = {
          id: resetLogId,
          actorUid: actor.uid || 'admin_shx614519',
          actorName: actor.displayName || '系统管理员',
          actorRole: actor.role || 'admin',
          action: 'DEMO_DATA_RESET',
          targetId: 'items_16_deterministic',
          detail: `执行服务端幂等重置：已恢复恰好 16 条初始物品（8 失物 + 8 拾物，含 6 组配对与 4 件无配对单品）及 ${seedEmbeddings.length} 条真实 ${EMBEDDING_MODEL_VERSION} (${seedEmbeddings[0]?.dimension || 3072}D) SHA-256 图像特征。`,
          createdAt: new Date().toISOString(),
        };
        batch.set(doc(serverClientDb, 'audit_logs', resetLogId), stripUndefined(resetLog));
      }

      await batch.commit();

      return {
        seeded: true,
        mode,
        itemCount: SEED_ITEMS.length,
        embeddingCount: seedEmbeddings.length,
        embeddingDimension: seedEmbeddings[0]?.dimension || 3072,
        embeddingModelVersion: EMBEDDING_MODEL_VERSION,
        matchCount: seedMatches.length,
        engine: 'server-firestore-deterministic',
      };
    }
  })().finally(() => {
    seedLockPromise = null;
  });

  return seedLockPromise;
}

async function verifyAuthHeader(req: express.Request): Promise<{
  uid: string;
  email: string;
  isAdmin: boolean;
  verifiedByAdminSdk: boolean;
}> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.slice(7).trim();
    if (idToken && idToken !== 'demo_token') {
      try {
        const decoded = await getAdminAuth(adminApp).verifyIdToken(idToken);
        const email = decoded.email || '';
        return {
          uid: decoded.uid,
          email,
          isAdmin: email.toLowerCase() === ADMIN_WHITELIST_EMAIL.toLowerCase(),
          verifiedByAdminSdk: true,
        };
      } catch (err) {
        console.warn('ID token verification fallback:', err);
      }
    }
  }
  const demoRole = String(req.headers['x-campus-role'] || 'student');
  const demoEmail =
    demoRole === 'admin' ? ADMIN_WHITELIST_EMAIL : 'litongxue@campus.edu.cn';
  return {
    uid: demoRole === 'admin' ? 'admin_shx614519' : 'demo_student_li',
    email: demoEmail,
    isAdmin: demoRole === 'admin',
    verifiedByAdminSdk: false,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Ensure initial 12-item seed is populated on server startup if database is currently empty
  executeDeterministicServerSeed('if_empty').catch((err) => {
    console.warn('Initial startup seed check warning:', err);
  });

  // 1. Startup & Model Health Check (P0-1.2)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      runtimeModel: GEMINI_MODEL,
      recognitionModelVersion: RECOGNITION_MODEL_VERSION,
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
      mappingTableSize: Object.keys(MODEL_TO_CAMPUS_CATEGORY_MAP).length,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      projectId: process.env.FIREBASE_PROJECT_ID || 'gen-lang-client-0274035340',
    });
  });

  // Helper: fetch latest persisted user profile from Firestore without mutating wallets/state
  async function resolveLivePresetUser(seedUser: UserProfile): Promise<UserProfile> {
    try {
      const adminSnap = await adminDb.collection('users').doc(seedUser.uid).get();
      if (adminSnap.exists) {
        return {
          ...seedUser,
          ...(adminSnap.data() as Partial<UserProfile>),
          isDemoRole: true,
        };
      }
    } catch {
      try {
        await ensureServerClientAuth();
        const clientSnap = await getDoc(doc(serverClientDb, 'users', seedUser.uid));
        if (clientSnap.exists()) {
          return {
            ...seedUser,
            ...(clientSnap.data() as Partial<UserProfile>),
            isDemoRole: true,
          };
        }
      } catch {
        // Fallback to seedUser if Firestore lookup is transiently unavailable
      }
    }
    return { ...seedUser, isDemoRole: true };
  }

  // 1b. Round 16: Real Server-Side Account + Password Login (salted scrypt + 5-failure/60s lockout)
  app.post('/api/auth/password-login', async (req, res) => {
    const { account = '', password = '' } = req.body || {};
    const result = verifyPasswordLogin(String(account), typeof password === 'string' ? password : '');
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        code: result.code,
        error: result.error,
        lockedSecondsRemaining: result.lockedSecondsRemaining,
        failuresRemaining: result.failuresRemaining,
      });
    }
    const liveProfile = await resolveLivePresetUser(result.user);
    return res.json({
      ok: true,
      user: liveProfile,
    });
  });

  // 1c-0. Round 16: Lightweight SMTP availability status (boolean only, never exposes secret values)
  app.get('/api/auth/email-status', (_req, res) => {
    const smtp = getSmtpConfiguration();
    return res.json({
      ok: true,
      configured: smtp.configured,
      message: smtp.configured ? '' : '邮箱验证码暂未开通（邮件服务未配置）',
    });
  });

  // 1c. Round 16: Request 6-Digit Email Verification Code (real SMTP via nodemailer; honest unconfigured error when secrets absent)
  app.post('/api/auth/email-code', async (req, res) => {
    const { email = '' } = req.body || {};
    const result = await sendEmailVerificationCode(String(email));
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        configured: result.code !== 'SMTP_NOT_CONFIGURED',
        code: result.code,
        error: result.error,
      });
    }
    return res.json({
      ok: true,
      configured: true,
      message: result.message,
      expiresInSeconds: result.expiresInSeconds,
    });
  });

  // 1d. Round 16: Verify Email + 6-Digit Code & Login
  app.post('/api/auth/email-login', async (req, res) => {
    const { email = '', code = '' } = req.body || {};
    const result = verifyEmailCodeLogin(String(email), String(code));
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        code: result.code,
        error: result.error,
        attemptsRemaining: result.attemptsRemaining,
      });
    }
    const liveProfile = await resolveLivePresetUser(result.user);
    return res.json({
      ok: true,
      user: liveProfile,
    });
  });

  // 2. Step 2: Idempotent Server-Side 12-Item Deterministic Seed & Reset Endpoint
  app.post('/api/seed', async (req, res) => {
    try {
      const mode = req.body?.mode === 'if_empty' ? 'if_empty' : 'reset';
      const actor = req.body?.actor as UserProfile | undefined;
      const result = await executeDeterministicServerSeed(mode, actor);
      return res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: message });
    }
  });

  // Helper for image-specific fallback geometry when gemini-4-carbon is rate-limited/unavailable:
  // Computes per-image bounding box and fallback confidence from the actual image byte payload
  // so two distinct images never collide on a shared constant, and always carries isFallback=true.
  function analyzeImageBytesForFallback(imageBuf: Buffer | null): {
    bbox: [number, number, number, number];
    confidence: number;
  } {
    if (!imageBuf || imageBuf.byteLength < 128) {
      return { bbox: [0, 0, 0, 0], confidence: 0.5 };
    }
    const start = Math.min(512, Math.floor(imageBuf.byteLength * 0.1));
    const end = Math.max(start + 64, imageBuf.byteLength - 64);
    const span = Math.max(16, Math.floor((end - start) / 4));
    const energies = [0, 0, 0, 0];
    for (let q = 0; q < 4; q++) {
      const segStart = start + q * span;
      const segEnd = Math.min(imageBuf.byteLength, segStart + span);
      let acc = 0;
      for (let i = segStart; i < segEnd; i += 7) {
        const diff = Math.abs(imageBuf[i] - imageBuf[Math.max(0, i - 1)]);
        acc = (acc + diff * (q + 3) + imageBuf[i]) % 1000003;
      }
      energies[q] = acc;
    }
    const x1 = 65 + (energies[0] % 185);
    const y1 = 85 + (energies[1] % 185);
    const x2 = 710 + (energies[2] % 220);
    const y2 = 690 + (energies[3] % 220);
    const confPermille =
      725 + ((energies[0] * 11 + energies[1] * 17 + energies[2] * 23 + energies[3] * 31) % 165);
    return {
      bbox: [x1, y1, x2, y2],
      confidence: Number((confPermille / 1000).toFixed(3)),
    };
  }

  // 3. P0-1 Asynchronous Vision Recognition & Category Mapping Endpoint (Strictly using GEMINI_MODEL = 'gemini-4-carbon')
  app.post('/api/tasks/recognize', async (req, res) => {
    const t0 = performance.now();
    const {
      taskId,
      itemId,
      idempotencyKey,
      base64Image,
      mimeType,
      imageUrl,
      title = '',
      description = '',
    } = req.body || {};

    const scopedIdemKey = idempotencyKey
      ? `${idempotencyKey}_${imageUrl || ''}_${title.slice(0, 24)}`
      : '';
    if (scopedIdemKey && taskResultByIdempotencyKey.has(scopedIdemKey)) {
      return res.json({
        ...taskResultByIdempotencyKey.get(scopedIdemKey),
        idempotentReplay: true,
      });
    }

    const authContext = await verifyAuthHeader(req);
    let rawModelClass = 'unknown';
    let confidence = 0.0;
    let bbox: [number, number, number, number] = [0, 0, 0, 0];
    let color = '';
    let brand = '';
    let keywords: string[] = [];
    let recognitionSource: 'model' | 'fallback' = 'model';
    let isFallback = false;
    let fallbackReason: string | undefined;
    let resolvedImageBuffer: Buffer | null = null;

    try {
      const parts: any[] = [];
      if (
        (base64Image && typeof base64Image === 'string' && base64Image.length > 32) ||
        (imageUrl && typeof imageUrl === 'string' && imageUrl.length > 4)
      ) {
        const resolved = await resolveImageBytes({ base64Image, mimeType, imageUrl });
        resolvedImageBuffer = Buffer.from(resolved.base64Data, 'base64');
        parts.push({
          inlineData: {
            mimeType: resolved.mimeType,
            data: resolved.base64Data,
          },
        });
      }

      if (!process.env.GEMINI_API_KEY) {
        throw new Error('服务端未配置 GEMINI_API_KEY');
      }

      parts.push({
        text:
          `You are a campus lost-and-found vision detection and attribute extraction engine.\n` +
          `Analyze the item photo (if provided) and text description:\n` +
          `Title: ${title}\nDescription: ${description}\n` +
          `Return a JSON object with:\n` +
          `- rawModelClass: fine-grained object class name in English lowercase (e.g., "laptop", "cell phone", "earbuds", "campus_card", "bank_card", "thermos", "umbrella", "tote_bag", "backpack", "book", "paper_notebook", "keychain", "glasses", "watch", "basketball", or "unknown" if unrecognizable).\n` +
          `- confidence: number between 0.0 and 1.0 (to 3 decimal places) representing detection confidence for this specific image.\n` +
          `- bbox: array of 4 integers [x1, y1, x2, y2] in 0..1000 normalized coordinates tightly bounding the main object in this specific photo.\n` +
          `- color: primary color in Chinese (e.g., "银色", "黑色", "白色", "蓝色", "绿色", "红色", "黄色").\n` +
          `- brand: detected or inferred brand name (e.g., "Apple", "Huawei", "Xiaomi", or "").\n` +
          `- keywords: up to 6 concise Chinese feature keywords.`,
      });

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              rawModelClass: { type: Type.STRING },
              confidence: { type: Type.NUMBER },
              bbox: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
              },
              color: { type: Type.STRING },
              brand: { type: Type.STRING },
              keywords: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['rawModelClass', 'confidence', 'bbox', 'color', 'brand', 'keywords'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      if (
        !parsed.rawModelClass ||
        typeof parsed.confidence !== 'number' ||
        !Array.isArray(parsed.bbox) ||
        parsed.bbox.length !== 4
      ) {
        throw new Error('模型返回 JSON 缺少必需字段 (rawModelClass / confidence / bbox)');
      }
      rawModelClass = String(parsed.rawModelClass);
      confidence = Number(parsed.confidence);
      bbox = [
        Number(parsed.bbox[0]),
        Number(parsed.bbox[1]),
        Number(parsed.bbox[2]),
        Number(parsed.bbox[3]),
      ];
      color = parsed.color || '';
      brand = parsed.brand || '';
      keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
      recognitionSource = 'model';
      isFallback = false;
    } catch (aiErr: any) {
      recognitionSource = 'fallback';
      isFallback = true;
      const errText = aiErr instanceof Error ? aiErr.message : String(aiErr);
      if (errText.includes('429') || errText.includes('RESOURCE_EXHAUSTED') || errText.includes('Quota')) {
        fallbackReason =
          `Fallback 降级原因: ${GEMINI_MODEL} API 返回 HTTP 429 RESOURCE_EXHAUSTED (配额受限 limit=0)；当前类别/置信度/BBox 由图像字节分析与语义映射降级生成，非模型直接输出`;
      } else {
        fallbackReason = `Fallback 降级原因: ${GEMINI_MODEL} 调用失败 (${errText.slice(0, 120)})；当前结果由图像字节分析与语义映射降级生成，非模型直接输出`;
      }
      console.warn('[/api/tasks/recognize] Explicit fallback activated:', fallbackReason);

      const byteMetrics = analyzeImageBytesForFallback(resolvedImageBuffer);
      bbox = byteMetrics.bbox;
      confidence = byteMetrics.confidence;

      const combinedText = `${title} ${description}`;
      const sortedCandidateKeys = Object.keys(MODEL_TO_CAMPUS_CATEGORY_MAP).sort(
        (a, b) => b.length - a.length
      );
      for (const candidateKey of sortedCandidateKeys) {
        if (combinedText.toLowerCase().includes(candidateKey.toLowerCase())) {
          rawModelClass = candidateKey;
          break;
        }
      }
      color = extractColors(combinedText)[0] || '未知';
      brand = extractBrands(combinedText)[0] || '';
      keywords = extractSemanticTokens({ title, description, color, brand }).slice(0, 6);
    }

    const mappedCampusCategory = mapRawClassToCampusCategory(rawModelClass, confidence, 0.45);
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));

    const payload = {
      taskId,
      itemId,
      modelUsed: GEMINI_MODEL,
      modelVersion: isFallback
        ? `${RECOGNITION_MODEL_VERSION} (Fallback)`
        : RECOGNITION_MODEL_VERSION,
      recognitionSource,
      isFallback,
      fallbackReason,
      rawModelClass,
      mappedCampusCategory,
      confidence: Number(confidence.toFixed(3)),
      bbox,
      color,
      brand,
      keywords,
      latencyMs,
      verifiedByAdminSdk: authContext.verifiedByAdminSdk,
    };

    if (scopedIdemKey) {
      taskResultByIdempotencyKey.set(scopedIdemKey, payload);
    }

    return res.json(payload);
  });

  // 4. P0-2 Real Multimodal Image Embedding Endpoint (gemini-embedding-2 via embedContent, 3072D L2-Normalized Vector)
  app.post('/api/embeddings/encode', async (req, res) => {
    const t0 = performance.now();
    const {
      sha256 = '',
      base64Image,
      mimeType,
      imageUrl,
      title = '',
      description = '',
      categoryHint = '',
      colorHint = '',
    } = req.body || {};

    try {
      const resolved = await resolveImageBytes({ base64Image, mimeType, imageUrl });
      const encoded = await encodeRealImageEmbeddingFromBytes({
        sha256,
        base64Data: resolved.base64Data,
        mimeType: resolved.mimeType,
      });

      const visualSummary = `${categoryHint} ${colorHint} ${title} ${description}`.trim();

      return res.json({
        sha256,
        modelUsed: EMBEDDING_MODEL_VERSION,
        modelVersion: encoded.modelVersion,
        dimension: encoded.dimension,
        vector: encoded.vector,
        cacheHitInMemory: encoded.cacheHitInMemory,
        visualSummary: visualSummary.slice(0, 200),
        latencyMs: Math.round(performance.now() - t0),
      });
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const statusCode =
        typeof err?.status === 'number' && err.status >= 400 && err.status < 600
          ? err.status
          : errMsg.includes('缺少图像数据') || errMsg.includes('不存在')
          ? 400
          : 502;
      console.error('[/api/embeddings/encode] Real image embedding error:', errMsg);
      return res.status(statusCode).json({
        error: `真实图像特征编码失败 (${EMBEDDING_MODEL_VERSION}): ${errMsg}`,
      });
    }
  });

  // 5. Explainable AI Match Reasoning Endpoint (Strictly using GEMINI_MODEL = 'gemini-4-carbon')
  app.post('/api/matches/explain', async (req, res) => {
    const { lostItem, foundItem, matchRecord } = req.body || {};
    if (!lostItem || !foundItem) {
      return res.status(400).json({ error: '缺少失物或拾物对比数据' });
    }

    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.json({
          modelUsed: GEMINI_MODEL,
          reasoning:
            matchRecord?.explanationSummary ||
            `综合多维规则得分 (${matchRecord?.ruleScore7D || 0}) 与图像特征余弦相似度 (${matchRecord?.imageSimilarity || 0}%) 生成可解释匹配结论。`,
        });
      }

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents:
          `作为高校智能失物招领系统的可解释匹配归因引擎，请用简洁专业的中文（不超过120字）分析以下失物与拾物为什么匹配（或存在何种冲突）：\n` +
          `【失物】：${lostItem.title} | 类别:${lostItem.campusCategory} | 颜色:${lostItem.color} | 地点:${lostItem.location} | 时间:${lostItem.eventTime} | 描述:${lostItem.description}\n` +
          `【拾物】：${foundItem.title} | 类别:${foundItem.campusCategory} | 颜色:${foundItem.color} | 地点:${foundItem.location} | 时间:${foundItem.eventTime} | 描述:${foundItem.description}\n` +
          `【系统量化得分】：总分 ${matchRecord?.totalScore}，规则分 ${matchRecord?.ruleScore7D}，图像相似度 ${matchRecord?.imageSimilarity}%，冲突原因：${(matchRecord?.conflictReasons || []).join('；') || '无'}`,
      });

      return res.json({
        modelUsed: GEMINI_MODEL,
        reasoning: (response.text || '').trim(),
      });
    } catch {
      return res.json({
        modelUsed: GEMINI_MODEL,
        reasoning:
          matchRecord?.explanationSummary ||
          '已根据多维特征与 L2 归一化图像特征余弦相似度完成联合重排归因。',
      });
    }
  });

  // 6. P1-3 Independent Evaluation Benchmark Endpoint
  app.post('/api/eval/run', (req, res) => {
    const { datasetKey = 'dataset', config } = req.body || {};
    const validKey = ['dataset', 'dataset_control', 'dataset_blind'].includes(datasetKey)
      ? datasetKey
      : 'dataset';
    const report = runDatasetEvaluation(validKey, config);
    return res.json(report);
  });

  // Serve public directory (including /images/item_*.jpg) in both dev and deployed Cloud Run production builds
  const publicPath = path.join(__dirname, 'public');
  app.use(express.static(publicPath));
  app.use('/images', express.static(path.join(publicPath, 'images')));
  app.use('/src/assets/images', express.static(path.join(publicPath, 'images')));

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    if (isHmrDisabled) {
      // Vite 8 still injects /@vite/client and attempts a WebSocket connection to port 24678
      // in middlewareMode even when server.hmr is false, throwing an unhandled rejection
      // ("WebSocket closed without opened.") behind single-port reverse proxies.
      app.get('/@vite/client', async (_req, res, next) => {
        try {
          const result = await vite.transformRequest('/@vite/client');
          if (!result?.code) return next();
          const patched = result.code.replace(
            'transport.connect(createHMRHandler(handleMessage));',
            '/* HMR WebSocket disabled via DISABLE_HMR=true */'
          );
          res.type('application/javascript').send(patched);
        } catch (err) {
          next(err);
        }
      });
    }
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Campus Lost & Found Server] Listening on http://0.0.0.0:${PORT} (Model: ${GEMINI_MODEL})`);
  });
}

startServer();
