/**
 * Firestore Persistence Layer (All Collections, Server-Side Seed Invocation, Caching & Idempotency)
 *
 * Uses Firebase Firestore exclusively (never localStorage for application data).
 * Calls ensureAnonymousOrActiveSession() before any Firestore read/write.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  db,
  ensureAnonymousOrActiveSession,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import {
  ADMIN_WHITELIST_EMAIL,
  ALGORITHM_VERSION,
  AuditLog,
  CampusCategory,
  ClaimRecord,
  DEFAULT_MATCHING_CONFIG,
  EMBEDDING_MODEL_VERSION,
  GEMINI_MODEL,
  getDeterministicEmbeddingId,
  ImageEmbedding,
  LostFoundItem,
  MatchingWeightsConfig,
  MatchFeedback,
  MatchRecord,
  MessageRecord,
  RECOGNITION_MODEL_VERSION,
  RecognitionTask,
  resolveClaimRoleActors,
  UserProfile,
  UserReviewRecord,
  WalletTransaction,
} from '../types/models';
import {
  executeThreeWayRecallAndRerank,
  getDeterministicMatchId,
  l2Normalize,
} from './matchingEngine';

const API_BASE = typeof window === 'undefined' ? 'http://localhost:3000' : '';

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 12000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`服务请求超时（>${Math.round(timeoutMs / 1000)}秒），请点击重试`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const cleaned: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      cleaned[k] = v;
    }
  }
  return cleaned as T;
}

export async function fetchAllDataBundle(): Promise<{
  users: UserProfile[];
  items: LostFoundItem[];
  embeddings: ImageEmbedding[];
  tasks: RecognitionTask[];
  matches: MatchRecord[];
  feedbacks: MatchFeedback[];
  claims: ClaimRecord[];
  messages: MessageRecord[];
  auditLogs: AuditLog[];
}> {
  await ensureAnonymousOrActiveSession();
  try {
    const [
      usersSnap,
      itemsSnap,
      embSnap,
      tasksSnap,
      matchesSnap,
      fbSnap,
      claimsSnap,
      msgSnap,
      auditSnap,
    ] = await Promise.all([
      getDocs(collection(db, 'users')),
      getDocs(collection(db, 'items')),
      getDocs(collection(db, 'image_embeddings')),
      getDocs(collection(db, 'recognition_tasks')),
      getDocs(collection(db, 'matches')),
      getDocs(collection(db, 'match_feedback')),
      getDocs(collection(db, 'claims')),
      getDocs(collection(db, 'messages')),
      getDocs(collection(db, 'audit_logs')),
    ]);

    const users = usersSnap.docs.map((d) => d.data() as UserProfile);
    const items = itemsSnap.docs
      .map((d) => d.data() as LostFoundItem)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const embeddings = embSnap.docs.map((d) => d.data() as ImageEmbedding);
    const tasks = tasksSnap.docs
      .map((d) => d.data() as RecognitionTask)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const matches = matchesSnap.docs
      .map((d) => d.data() as MatchRecord)
      .sort((a, b) => b.totalScore - a.totalScore);
    const feedbacks = fbSnap.docs
      .map((d) => d.data() as MatchFeedback)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const claims = claimsSnap.docs
      .map((d) => d.data() as ClaimRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const messages = msgSnap.docs
      .map((d) => d.data() as MessageRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const auditLogs = auditSnap.docs
      .map((d) => d.data() as AuditLog)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { users, items, embeddings, tasks, matches, feedbacks, claims, messages, auditLogs };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'items');
  }
}

/**
 * Step 2: Calls the Node server's idempotent POST /api/seed endpoint to initialize or reset
 * the exact 12 deterministic demo items (6 lost + 6 found) and their 6 shared vectors.
 */
export async function resetToDeterministic12DemoData(
  actor?: UserProfile,
  mode: 'if_empty' | 'reset' = 'reset'
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  const resp = await fetch(`${API_BASE}/api/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, actor }),
  });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error || `Server seed failed with status ${resp.status}`);
  }
}

export async function upsertUserProfile(profile: UserProfile): Promise<void> {
  await ensureAnonymousOrActiveSession();
  const path = `users/${profile.uid}`;
  try {
    await setDoc(doc(db, 'users', profile.uid), stripUndefined(profile), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function recordAuditLog(
  actor: UserProfile,
  action: string,
  targetId: string,
  detail: string
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry: AuditLog = {
    id,
    actorUid: actor.uid,
    actorName: actor.displayName,
    actorRole: actor.role,
    action,
    targetId,
    detail: detail.slice(0, 950),
    createdAt: new Date().toISOString(),
  };
  try {
    await setDoc(doc(db, 'audit_logs', id), stripUndefined(entry));
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `audit_logs/${id}`);
  }
}

/**
 * P0-2: Lookup cached embedding strictly by (sha256, modelVersion).
 * Document ID is derived deterministically from (imageHash, modelVersion) ONLY via getDeterministicEmbeddingId,
 * and we also query by (sha256, modelVersion) so an existing document for the same pair is ALWAYS reused
 * and a duplicate document is never created.
 */
export async function getOrEncodeCachedEmbedding(params: {
  sha256: string;
  itemId: string;
  base64Image?: string;
  mimeType?: string;
  imageUrl?: string;
  title: string;
  description: string;
  categoryHint: string;
  colorHint: string;
}): Promise<{ embedding: ImageEmbedding; cacheHit: boolean }> {
  await ensureAnonymousOrActiveSession();
  const modelVersion = EMBEDDING_MODEL_VERSION;
  const embeddingId = getDeterministicEmbeddingId(params.sha256, modelVersion);
  const path = `image_embeddings/${embeddingId}`;

  try {
    // 1. Direct lookup by deterministic ID emb_${imageHash}_${modelVersion}
    const existingSnap = await getDoc(doc(db, 'image_embeddings', embeddingId));
    if (existingSnap.exists()) {
      return {
        embedding: existingSnap.data() as ImageEmbedding,
        cacheHit: true,
      };
    }

    // 2. Query by (sha256, modelVersion) pair to guarantee zero duplicate docs for the same pair
    const pairQuery = query(
      collection(db, 'image_embeddings'),
      where('sha256', '==', params.sha256),
      where('modelVersion', '==', modelVersion)
    );
    const pairSnap = await getDocs(pairQuery);
    if (!pairSnap.empty) {
      return {
        embedding: pairSnap.docs[0].data() as ImageEmbedding,
        cacheHit: true,
      };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  const resp = await fetchWithTimeout(
    `${API_BASE}/api/embeddings/encode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sha256: params.sha256,
        base64Image: params.base64Image,
        mimeType: params.mimeType,
        imageUrl: params.imageUrl,
        title: params.title,
        description: params.description,
        categoryHint: params.categoryHint,
        colorHint: params.colorHint,
      }),
    },
    12000
  );

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(
      errBody.error || `图像特征编码接口 (/api/embeddings/encode) 返回错误状态码 ${resp.status}`
    );
  }

  const data = await resp.json();
  if (!Array.isArray(data.vector) || data.vector.length === 0) {
    throw new Error('图像特征编码服务未返回有效特征数据');
  }

  const vector = l2Normalize(data.vector);
  const actualModelVersion = data.modelVersion || modelVersion;
  const finalEmbeddingId = getDeterministicEmbeddingId(params.sha256, actualModelVersion);

  const newEmbedding: ImageEmbedding = {
    id: finalEmbeddingId,
    sha256: params.sha256,
    modelVersion: actualModelVersion,
    dimension: vector.length,
    vector,
    itemId: params.itemId,
    visualSummary: (data.visualSummary || `${params.categoryHint} · ${params.colorHint}`).slice(0, 200),
    createdAt: new Date().toISOString(),
  };

  try {
    await setDoc(doc(db, 'image_embeddings', finalEmbeddingId), stripUndefined(newEmbedding));
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `image_embeddings/${finalEmbeddingId}`);
  }

  return { embedding: newEmbedding, cacheHit: false };
}

export async function updateUserProfileInFirestore(
  uid: string,
  updates: {
    displayName: string;
    email: string;
    phone?: string;
    studentId?: string;
    department?: string;
    className?: string;
    bio?: string;
    birthday?: string;
    avatarUrl?: string;
  },
  currentProfile: UserProfile
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const updated: UserProfile = {
    ...currentProfile,
    uid,
    displayName: updates.displayName.trim().slice(0, 90) || currentProfile.displayName,
    email: updates.email.trim().slice(0, 240) || currentProfile.email,
    phone: updates.phone !== undefined ? updates.phone.trim().slice(0, 30) : currentProfile.phone,
    studentId:
      updates.studentId !== undefined ? updates.studentId.trim().slice(0, 60) : currentProfile.studentId,
    department:
      updates.department !== undefined ? updates.department.trim().slice(0, 120) : currentProfile.department,
    className:
      updates.className !== undefined ? updates.className.trim().slice(0, 120) : currentProfile.className,
    bio:
      updates.bio !== undefined ? updates.bio.trim().slice(0, 280) : currentProfile.bio,
    birthday:
      updates.birthday !== undefined ? updates.birthday.trim().slice(0, 30) : currentProfile.birthday,
    avatarUrl:
      updates.avatarUrl !== undefined ? updates.avatarUrl.trim().slice(0, 1000) : currentProfile.avatarUrl,
    updatedAt: now,
  };
  const path = `users/${uid}`;
  try {
    await setDoc(doc(db, 'users', uid), stripUndefined(updated), { merge: true });
    await recordAuditLog(
      updated,
      'USER_PROFILE_UPDATE',
      uid,
      `用户更新个人资料：昵称=[${updated.displayName}]，院校班级=[${updated.department || ''} ${updated.className || ''}]`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
  return updated;
}

export async function recordUserBrowsingHistory(
  currentProfile: UserProfile,
  itemId: string
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const prevIds = Array.isArray(currentProfile.browsedItemIds)
    ? currentProfile.browsedItemIds
    : [];
  const nextIds = [itemId, ...prevIds.filter((id) => id !== itemId)].slice(0, 30);
  const now = new Date().toISOString();
  const updated: UserProfile = {
    ...currentProfile,
    browsedItemIds: nextIds,
    updatedAt: now,
  };
  try {
    await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

export async function clearUserBrowsingHistory(
  currentProfile: UserProfile
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const updated: UserProfile = {
    ...currentProfile,
    browsedItemIds: [],
    updatedAt: now,
  };
  try {
    await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

export async function markNotificationsReadInFirestore(
  currentProfile: UserProfile,
  notificationIds: string[]
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const cleanIncoming = notificationIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 180);
  if (cleanIncoming.length === 0) return currentProfile;

  const prevIds = Array.isArray(currentProfile.readNotificationIds)
    ? currentProfile.readNotificationIds
    : [];
  const mergedSet = new Set<string>([...prevIds, ...cleanIncoming]);
  if (mergedSet.size === prevIds.length && cleanIncoming.every((id) => prevIds.includes(id))) {
    return currentProfile;
  }

  const nextIds = Array.from(mergedSet).slice(-180);
  const now = new Date().toISOString();
  const updated: UserProfile = {
    ...currentProfile,
    readNotificationIds: nextIds,
    updatedAt: now,
  };
  try {
    await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

export async function updateUserDarkModePreference(
  currentProfile: UserProfile,
  darkMode: boolean
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const updated: UserProfile = {
    ...currentProfile,
    darkMode,
    updatedAt: now,
  };
  try {
    await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

export async function updateUserPushNotifyPreference(
  currentProfile: UserProfile,
  pushNotifyEnabled: boolean
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const updated: UserProfile = {
    ...currentProfile,
    pushNotifyEnabled,
    updatedAt: now,
  };
  try {
    await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

function getAvailableWalletBalance(profile: UserProfile): number {
  return typeof profile.walletBalance === 'number' ? profile.walletBalance : 85;
}

export async function recordBountyWalletTransaction(
  currentProfile: UserProfile,
  txInput: {
    title: string;
    type: 'income' | 'expense';
    amount: number;
    itemId?: string;
    counterpartyName?: string;
  }
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const cleanAmount = Math.max(1, Math.round(Number(txInput.amount) || 0));
  const prevBalance = getAvailableWalletBalance(currentProfile);
  if (txInput.type === 'expense' && prevBalance < cleanAmount) {
    throw new Error(`钱包可用余额不足（当前 ¥${prevBalance}，需支付 ¥${cleanAmount}）`);
  }
  const nextBalance =
    txInput.type === 'income'
      ? prevBalance + cleanAmount
      : Math.max(0, prevBalance - cleanAmount);

  const newTx: WalletTransaction = stripUndefined({
    id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: txInput.title.trim().slice(0, 140),
    type: txInput.type,
    amount: cleanAmount,
    itemId: txInput.itemId,
    counterpartyName: (txInput.counterpartyName || '同学').slice(0, 60),
    createdAt: now,
  });

  const prevList = Array.isArray(currentProfile.walletTransactions)
    ? currentProfile.walletTransactions
    : [];
  const nextList = [newTx, ...prevList].slice(0, 40);

  const updated: UserProfile = {
    ...currentProfile,
    walletBalance: nextBalance,
    walletTransactions: nextList,
    updatedAt: now,
  };

  try {
    const existingSnap = await getDoc(doc(db, 'users', currentProfile.uid));
    if (existingSnap.exists()) {
      await updateDoc(doc(db, 'users', currentProfile.uid), {
        walletBalance: nextBalance,
        walletTransactions: nextList,
        updatedAt: now,
      });
    } else {
      await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

export async function addUserReviewInFirestore(
  currentProfile: UserProfile,
  reviewInput: {
    reviewerName: string;
    roleTag: '失主评价' | '拾主评价';
    rating?: '好评' | '中评' | '差评';
    content: string;
    itemTitle: string;
  }
): Promise<UserProfile> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const newReview: UserReviewRecord = {
    id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    reviewerName: reviewInput.reviewerName.trim().slice(0, 50) || '热心同学',
    roleTag: reviewInput.roleTag,
    rating: reviewInput.rating || '好评',
    content: reviewInput.content.trim().slice(0, 300),
    itemTitle: reviewInput.itemTitle.trim().slice(0, 120),
    createdAt: now,
  };

  const prevReviews = Array.isArray(currentProfile.reviews) ? currentProfile.reviews : [];
  const nextReviews = [newReview, ...prevReviews].slice(0, 40);

  const updated: UserProfile = {
    ...currentProfile,
    reviews: nextReviews,
    updatedAt: now,
  };

  try {
    await setDoc(doc(db, 'users', currentProfile.uid), stripUndefined(updated), { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${currentProfile.uid}`);
  }
  return updated;
}

export async function updateUserItemInFirestore(
  item: LostFoundItem,
  updates: {
    title: string;
    description: string;
    campusCategory: CampusCategory;
    color?: string;
    brand?: string;
    locationArea: string;
    locationDetail?: string;
    rewardAmount?: number;
    conditionText?: string;
    verificationQuestion?: string;
  },
  actor: UserProfile
): Promise<LostFoundItem> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const cleanArea = (updates.locationArea || '').trim().slice(0, 60);
  const cleanDetail = (updates.locationDetail || '').trim().slice(0, 140);
  const composedLocation = cleanArea
    ? cleanDetail
      ? `${cleanArea} · ${cleanDetail}`
      : cleanArea
    : item.location;

  const finalReward =
    item.type === 'lost' && typeof updates.rewardAmount === 'number'
      ? Math.max(0, Math.min(9999, Math.round(updates.rewardAmount)))
      : item.rewardAmount;

  if (item.type === 'lost' && typeof finalReward === 'number' && finalReward > 0) {
    const actorSnap = await getDoc(doc(db, 'users', actor.uid)).catch(() => null);
    const liveActor = actorSnap?.exists() ? (actorSnap.data() as UserProfile) : actor;
    const availableBalance = getAvailableWalletBalance(liveActor);
    const maxAllowed = Math.max(availableBalance, item.rewardAmount || 0);
    if (finalReward > maxAllowed) {
      throw new Error(
        `悬赏金额（¥${finalReward}）超出当前钱包可用余额（¥${availableBalance}），请调低悬赏金额后再保存`
      );
    }
  }

  const updatedItem: LostFoundItem = {
    ...item,
    title: updates.title.trim().slice(0, 190) || item.title,
    description: updates.description.trim().slice(0, 1900) || item.description,
    campusCategory: updates.campusCategory || item.campusCategory,
    color: updates.color !== undefined ? updates.color.trim().slice(0, 60) : item.color,
    brand: updates.brand !== undefined ? updates.brand.trim().slice(0, 100) : item.brand,
    rewardAmount: finalReward,
    locationArea: cleanArea || item.locationArea,
    locationDetail: cleanDetail,
    location: composedLocation.slice(0, 190),
    conditionText:
      updates.conditionText !== undefined ? updates.conditionText.trim().slice(0, 120) : item.conditionText,
    verificationQuestion:
      updates.verificationQuestion !== undefined
        ? updates.verificationQuestion.trim().slice(0, 280)
        : item.verificationQuestion,
    updatedAt: now,
  };

  try {
    await setDoc(doc(db, 'items', item.id), stripUndefined(updatedItem));
    if (updatedItem.status !== 'delisted' && updatedItem.status !== 'returned') {
      const bundle = await fetchAllDataBundle();
      const mergedItems = [
        updatedItem,
        ...bundle.items.filter(
          (i) => i.id !== updatedItem.id && i.status !== 'delisted' && i.status !== 'returned'
        ),
      ];
      await runAndPersistMatchesForItem(
        updatedItem,
        mergedItems,
        bundle.embeddings,
        bundle.matches
      );
    }
    await recordAuditLog(
      actor,
      'ITEM_EDIT',
      item.id,
      `用户 [${actor.displayName}] 编辑帖子 [${updatedItem.title}]，地点=[${updatedItem.location}]，悬赏=[¥${updatedItem.rewardAmount || 0}]`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
  }
  return updatedItem;
}

export async function toggleUserItemListingStatus(
  item: LostFoundItem,
  nextStatus: 'delisted' | 'open',
  actor: UserProfile,
  existingMatches: MatchRecord[] = []
): Promise<LostFoundItem> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const updatedItem: LostFoundItem = {
    ...item,
    status: nextStatus,
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'items', item.id), stripUndefined(updatedItem));
    if (nextStatus === 'delisted') {
      const matchesToRemove = existingMatches.filter(
        (m) => m.lostItemId === item.id || m.foundItemId === item.id
      );
      for (const m of matchesToRemove) {
        batch.delete(doc(db, 'matches', m.id));
      }
    }
    await batch.commit();

    // [G1] When an item transitions delisted -> open, recompute and re-persist its >= 58.0 matches
    if (nextStatus === 'open') {
      const bundle = await fetchAllDataBundle();
      const mergedItems = [
        updatedItem,
        ...bundle.items.filter(
          (i) => i.id !== updatedItem.id && i.status !== 'delisted' && i.status !== 'returned'
        ),
      ];
      await runAndPersistMatchesForItem(
        updatedItem,
        mergedItems,
        bundle.embeddings,
        bundle.matches
      );
    }

    await recordAuditLog(
      actor,
      nextStatus === 'delisted' ? 'ITEM_USER_DELIST' : 'ITEM_USER_RELIST',
      item.id,
      `用户 [${actor.displayName}] 将帖子 [${item.title}] 状态变更为 ${nextStatus === 'delisted' ? '已下架 (delisted)' : '重新上架 (open)'}`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
  }
  return updatedItem;
}

/**
 * Creates a new Lost/Found item, creates its RecognitionTask (pending -> running -> succeeded/failed),
 * encodes or reuses its SHA-256 embedding, and triggers 3-way recall matching.
 */
export async function publishItemWithRecognitionWorkflow(params: {
  draftItemId?: string;
  userManuallySelectedCategory?: boolean;
  type: 'lost' | 'found';
  title: string;
  description: string;
  campusCategory: CampusCategory;
  color: string;
  quantity: number;
  brand: string;
  rewardAmount?: number;
  locationArea?: string;
  locationDetail?: string;
  location: string;
  eventTime: string;
  conditionText: string;
  verificationQuestion?: string;
  verificationAnswerHint?: string;
  imageUrl?: string;
  storagePath?: string;
  imageSha256?: string;
  base64Image?: string;
  mimeType?: string;
  actor: UserProfile;
  onTaskStatusChange?: (status: RecognitionTask['status'], task: RecognitionTask) => void;
}): Promise<{ item: LostFoundItem; task: RecognitionTask; cacheHit: boolean }> {
  await ensureAnonymousOrActiveSession();
  const plannedReward =
    params.type === 'lost' && typeof params.rewardAmount === 'number'
      ? Math.max(0, Math.min(9999, Math.round(params.rewardAmount)))
      : 0;
  if (params.type === 'lost' && plannedReward > 0) {
    const actorSnap = await getDoc(doc(db, 'users', params.actor.uid)).catch(() => null);
    const liveActor = actorSnap?.exists() ? (actorSnap.data() as UserProfile) : params.actor;
    const availableBalance = getAvailableWalletBalance(liveActor);
    if (plannedReward > availableBalance) {
      throw new Error(
        `悬赏金额（¥${plannedReward}）超出当前钱包可用余额（¥${availableBalance}），请调低悬赏金额后再发布`
      );
    }
  }

  const now = new Date().toISOString();
  const cleanTitle = params.title.trim().slice(0, 190);
  let itemId =
    params.draftItemId && /^[a-zA-Z0-9_-]+$/.test(params.draftItemId)
      ? params.draftItemId
      : `item_${params.type}_${Date.now()}`;

  // Check-before-create guard: prevent duplicate items if a stalled publish already created the doc
  try {
    const directSnap = await getDoc(doc(db, 'items', itemId));
    if (directSnap.exists()) {
      const existingData = directSnap.data() as LostFoundItem;
      if (existingData.recognitionStatus === 'succeeded' || existingData.status === 'matching') {
        const existingTaskSnap = existingData.recognitionTaskId
          ? await getDoc(doc(db, 'recognition_tasks', existingData.recognitionTaskId))
          : null;
        return {
          item: existingData,
          task: (existingTaskSnap?.data() as RecognitionTask) || {
            id: existingData.recognitionTaskId || `task_${itemId}`,
            itemId,
            idempotencyKey: `idem_${itemId}`,
            status: 'succeeded',
            retryCount: 0,
            modelVersion: RECOGNITION_MODEL_VERSION,
            createdAt: existingData.createdAt,
          },
          cacheHit: true,
        };
      }
    } else {
      // Also check if the same user already created a non-delisted item with the exact same title & type in the last 5 minutes
      const ownerQuery = query(
        collection(db, 'items'),
        where('ownerUid', '==', params.actor.uid)
      );
      const ownerSnap = await getDocs(ownerQuery);
      const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
      const recentDup = ownerSnap.docs
        .map((d) => d.data() as LostFoundItem)
        .find(
          (it) =>
            !it.isSeededDemo &&
            it.status !== 'delisted' &&
            it.type === params.type &&
            it.title.trim() === cleanTitle &&
            new Date(it.createdAt).getTime() >= fiveMinsAgo
        );
      if (recentDup) {
        if (recentDup.recognitionStatus === 'succeeded' || recentDup.status === 'matching') {
          const existingTaskSnap = recentDup.recognitionTaskId
            ? await getDoc(doc(db, 'recognition_tasks', recentDup.recognitionTaskId))
            : null;
          return {
            item: recentDup,
            task: (existingTaskSnap?.data() as RecognitionTask) || {
              id: recentDup.recognitionTaskId || `task_${recentDup.id}`,
              itemId: recentDup.id,
              idempotencyKey: `idem_${recentDup.id}`,
              status: 'succeeded',
              retryCount: 0,
              modelVersion: RECOGNITION_MODEL_VERSION,
              createdAt: recentDup.createdAt,
            },
            cacheHit: true,
          };
        }
        // Reuse the existing stalled item's ID so retry updates in place rather than duplicating
        itemId = recentDup.id;
      }
    }
  } catch {
    // Proceed with itemId if lookup fails
  }

  const taskId = `task_${itemId}`;
  const sha = params.imageSha256 || `sha256_text_${itemId}`;
  const idempotencyKey = `idem_${itemId}_${sha.slice(0, 24)}`;

  const initialTask: RecognitionTask = {
    id: taskId,
    itemId,
    itemTitle: cleanTitle.slice(0, 180),
    idempotencyKey,
    status: 'pending',
    retryCount: 0,
    maxRetries: 3,
    modelVersion: RECOGNITION_MODEL_VERSION,
    createdAt: now,
    updatedAt: now,
  };

  const cleanArea = (params.locationArea || '').trim().slice(0, 60);
  const cleanDetail = (params.locationDetail || '').trim().slice(0, 140);
  const composedLocation = cleanArea
    ? cleanDetail
      ? `${cleanArea} · ${cleanDetail}`
      : cleanArea
    : params.location.slice(0, 190);

  const initialItem: LostFoundItem = {
    id: itemId,
    type: params.type,
    title: cleanTitle,
    description: params.description.slice(0, 1900),
    campusCategory: params.campusCategory,
    color: params.color || '未知',
    quantity: params.quantity || 1,
    brand: params.brand || '',
    rewardAmount:
      params.type === 'lost' && typeof params.rewardAmount === 'number'
        ? Math.max(0, Math.min(9999, Math.round(params.rewardAmount)))
        : 0,
    locationArea: cleanArea || undefined,
    locationDetail: cleanDetail || undefined,
    location: composedLocation.slice(0, 190),
    eventTime: params.eventTime,
    conditionText: params.conditionText || '正常',
    keywords: [],
    imageUrl: params.imageUrl || '',
    storagePath: params.storagePath || '',
    imageSha256: sha,
    recognitionTaskId: taskId,
    recognitionStatus: 'pending',
    modelVersion: RECOGNITION_MODEL_VERSION,
    status: 'open',
    ownerUid: params.actor.uid,
    ownerName: params.actor.displayName,
    ownerEmail: params.actor.email,
    verificationQuestion: params.verificationQuestion?.slice(0, 280),
    verificationAnswerHint: params.verificationAnswerHint?.slice(0, 280),
    isSeededDemo: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await setDoc(doc(db, 'recognition_tasks', taskId), stripUndefined(initialTask));
    await setDoc(doc(db, 'items', itemId), stripUndefined(initialItem));
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `items/${itemId}`);
  }
  params.onTaskStatusChange?.('pending', initialTask);

  const runningTask: RecognitionTask = {
    ...initialTask,
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  try {
    await setDoc(doc(db, 'recognition_tasks', taskId), stripUndefined(runningTask));
    await updateDoc(doc(db, 'items', itemId), {
      recognitionStatus: 'running',
      updatedAt: runningTask.updatedAt,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `recognition_tasks/${taskId}`);
  }
  params.onTaskStatusChange?.('running', runningTask);

  const tStart = performance.now();
  try {
    const hasImageInput = Boolean(params.base64Image || params.imageUrl);
    const [recogSettled, embSettled] = await Promise.allSettled([
      fetchWithTimeout(
        `${API_BASE}/api/tasks/recognize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            itemId,
            idempotencyKey,
            base64Image: params.base64Image,
            mimeType: params.mimeType,
            imageUrl: params.imageUrl,
            title: params.title,
            description: params.description,
            userCategoryHint: params.campusCategory,
          }),
        },
        12000
      ),
      hasImageInput
        ? getOrEncodeCachedEmbedding({
            sha256: sha,
            itemId,
            base64Image: params.base64Image,
            mimeType: params.mimeType,
            imageUrl: params.imageUrl,
            title: params.title,
            description: params.description,
            categoryHint: params.campusCategory,
            colorHint: params.color,
          })
        : Promise.resolve(null),
    ]);

    if (recogSettled.status === 'rejected') {
      throw recogSettled.reason;
    }
    const recogResp = recogSettled.value;
    if (!recogResp.ok) {
      const errBody = await recogResp.json().catch(() => ({}));
      throw new Error(errBody.error || `识别服务返回状态码 ${recogResp.status}`);
    }

    const recogData = await recogResp.json();
    const latencyMs = Math.round(recogData.latencyMs || performance.now() - tStart);
    const mappedCat: CampusCategory =
      recogData.mappedCampusCategory || params.campusCategory || 'unknown';

    // M1: Automatically apply recognised campusCategory unless the user explicitly overrode the category manually
    const finalCampusCategory: CampusCategory =
      !params.userManuallySelectedCategory && mappedCat && mappedCat !== 'unknown'
        ? mappedCat
        : params.campusCategory !== 'unknown'
        ? params.campusCategory
        : mappedCat !== 'unknown'
        ? mappedCat
        : '数码电子';

    const embResult = embSettled.status === 'fulfilled' ? embSettled.value : null;
    const embErrorMsg =
      embSettled.status === 'rejected'
        ? embSettled.reason instanceof Error
          ? embSettled.reason.message
          : String(embSettled.reason)
        : undefined;

    const succeededTask: RecognitionTask = {
      ...runningTask,
      status: embErrorMsg ? 'failed' : 'succeeded',
      modelVersion: recogData.modelVersion || RECOGNITION_MODEL_VERSION,
      recognitionSource: recogData.recognitionSource || 'model',
      isFallback: Boolean(recogData.isFallback),
      fallbackReason: recogData.fallbackReason
        ? String(recogData.fallbackReason).slice(0, 480)
        : undefined,
      errorMessage: embErrorMsg
        ? String(embErrorMsg).slice(0, 480)
        : recogData.fallbackReason
        ? String(recogData.fallbackReason).slice(0, 480)
        : undefined,
      rawModelClass: recogData.rawModelClass || 'unknown',
      mappedCampusCategory: mappedCat,
      confidence: typeof recogData.confidence === 'number' ? recogData.confidence : 0,
      bbox:
        Array.isArray(recogData.bbox) && recogData.bbox.length === 4
          ? (recogData.bbox.slice(0, 4) as [number, number, number, number])
          : [0, 0, 0, 0],
      extractedColor: recogData.color || params.color || '未知',
      extractedBrand: recogData.brand || params.brand || '',
      extractedKeywords: Array.isArray(recogData.keywords) ? recogData.keywords.slice(0, 12) : [],
      latencyMs,
      cacheHit: Boolean(embResult?.cacheHit),
      embeddingId: embResult?.embedding?.id,
      updatedAt: new Date().toISOString(),
    };

    const updatedItem: LostFoundItem = {
      ...initialItem,
      campusCategory: finalCampusCategory,
      rawModelClass: succeededTask.rawModelClass,
      color: params.color && params.color !== '未知' ? params.color : succeededTask.extractedColor || '未知',
      brand: params.brand || succeededTask.extractedBrand || '',
      keywords: succeededTask.extractedKeywords,
      embeddingId: embResult?.embedding?.id,
      recognitionStatus: 'succeeded',
      modelVersion: succeededTask.modelVersion,
      recognitionSource: succeededTask.recognitionSource,
      isFallback: succeededTask.isFallback,
      fallbackReason: succeededTask.fallbackReason,
      confidence: succeededTask.confidence,
      bbox: succeededTask.bbox,
      latencyMs,
      status: 'matching',
      updatedAt: succeededTask.updatedAt,
    };

    await setDoc(doc(db, 'recognition_tasks', taskId), stripUndefined(succeededTask));
    await setDoc(doc(db, 'items', itemId), stripUndefined(updatedItem));
    params.onTaskStatusChange?.(succeededTask.status, succeededTask);

    await recordAuditLog(
      params.actor,
      'ITEM_PUBLISH_AND_RECOGNIZE',
      itemId,
      `发布${params.type === 'lost' ? '失物' : '拾物'} [${updatedItem.title}]，识别来源=[${succeededTask.isFallback ? 'Fallback降级' : `${GEMINI_MODEL}模型`}]，原始类 [${succeededTask.rawModelClass}] -> 校园类 [${updatedItem.campusCategory}]，置信度=${((succeededTask.confidence || 0) * 100).toFixed(1)}%，特征缓存命中=${Boolean(embResult?.cacheHit)}`
    );

    return { item: updatedItem, task: succeededTask, cacheHit: Boolean(embResult?.cacheHit) };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedTask: RecognitionTask = {
      ...runningTask,
      status: 'failed',
      errorMessage: errMsg.slice(0, 450),
      latencyMs: Math.round(performance.now() - tStart),
      updatedAt: new Date().toISOString(),
    };
    try {
      await setDoc(doc(db, 'recognition_tasks', taskId), stripUndefined(failedTask));
      await updateDoc(doc(db, 'items', itemId), {
        recognitionStatus: 'failed',
        updatedAt: failedTask.updatedAt,
      });
    } catch (fsErr) {
      handleFirestoreError(fsErr, OperationType.UPDATE, `recognition_tasks/${taskId}`);
    }
    params.onTaskStatusChange?.('failed', failedTask);
    throw new Error(`发布处理异常：${errMsg}`);
  }
}

export async function retryRecognitionTask(
  task: RecognitionTask,
  item: LostFoundItem,
  actor: UserProfile
): Promise<RecognitionTask> {
  await ensureAnonymousOrActiveSession();
  const nextRetry = (task.retryCount || 0) + 1;
  const runningTask: RecognitionTask = {
    ...task,
    status: 'running',
    retryCount: nextRetry,
    errorMessage: '',
    updatedAt: new Date().toISOString(),
  };
  try {
    await setDoc(doc(db, 'recognition_tasks', task.id), stripUndefined(runningTask));
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `recognition_tasks/${task.id}`);
  }

  const t0 = performance.now();
  try {
    const [resp, embResult] = await Promise.all([
      fetch(`${API_BASE}/api/tasks/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          itemId: item.id,
          idempotencyKey: `${task.idempotencyKey}_retry_${nextRetry}`,
          imageUrl: item.imageUrl,
          title: item.title,
          description: item.description,
          userCategoryHint: item.campusCategory,
        }),
      }),
      item.imageUrl || item.imageSha256
        ? getOrEncodeCachedEmbedding({
            sha256: item.imageSha256 || `sha256_item_${item.id}`,
            itemId: item.id,
            imageUrl: item.imageUrl,
            title: item.title,
            description: item.description,
            categoryHint: item.campusCategory,
            colorHint: item.color || '',
          })
        : Promise.resolve(null),
    ]);

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || `识别服务返回状态码 ${resp.status}`);
    }

    const data = await resp.json();
    const succeeded: RecognitionTask = {
      ...runningTask,
      status: 'succeeded',
      modelVersion: data.modelVersion || RECOGNITION_MODEL_VERSION,
      recognitionSource: data.recognitionSource || 'model',
      isFallback: Boolean(data.isFallback),
      fallbackReason: data.fallbackReason ? String(data.fallbackReason).slice(0, 480) : undefined,
      errorMessage: data.fallbackReason ? String(data.fallbackReason).slice(0, 480) : undefined,
      rawModelClass: data.rawModelClass || item.rawModelClass || 'unknown',
      mappedCampusCategory: data.mappedCampusCategory || item.campusCategory,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      bbox:
        Array.isArray(data.bbox) && data.bbox.length === 4
          ? (data.bbox.slice(0, 4) as [number, number, number, number])
          : [0, 0, 0, 0],
      cacheHit: embResult ? embResult.cacheHit : task.cacheHit,
      embeddingId: embResult ? embResult.embedding.id : item.embeddingId,
      latencyMs: Math.round(data.latencyMs || performance.now() - t0),
      updatedAt: new Date().toISOString(),
    };

    await setDoc(doc(db, 'recognition_tasks', task.id), stripUndefined(succeeded));
    await setDoc(
      doc(db, 'items', item.id),
      stripUndefined({
        ...item,
        rawModelClass: succeeded.rawModelClass,
        campusCategory: succeeded.mappedCampusCategory || item.campusCategory,
        embeddingId: succeeded.embeddingId || item.embeddingId,
        recognitionStatus: 'succeeded',
        modelVersion: succeeded.modelVersion,
        recognitionSource: succeeded.recognitionSource,
        isFallback: succeeded.isFallback,
        fallbackReason: succeeded.fallbackReason,
        confidence: succeeded.confidence,
        bbox: succeeded.bbox,
        latencyMs: succeeded.latencyMs,
        updatedAt: succeeded.updatedAt,
      })
    );
    await recordAuditLog(
      actor,
      'TASK_MANUAL_RETRY',
      task.id,
      `管理员手动重试识别任务 [${task.id}] (第 ${nextRetry} 次重试) 成功，耗时 ${succeeded.latencyMs}ms。`
    );
    return succeeded;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failedTask: RecognitionTask = {
      ...runningTask,
      status: 'failed',
      errorMessage: errMsg.slice(0, 450),
      latencyMs: Math.round(performance.now() - t0),
      updatedAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'recognition_tasks', task.id), stripUndefined(failedTask));
    await updateDoc(doc(db, 'items', item.id), {
      recognitionStatus: 'failed',
      updatedAt: failedTask.updatedAt,
    });
    return failedTask;
  }
}

export async function runAndPersistMatchesForItem(
  targetItem: LostFoundItem,
  allItems: LostFoundItem[],
  allEmbeddings: ImageEmbedding[],
  existingMatches: MatchRecord[],
  config: MatchingWeightsConfig = DEFAULT_MATCHING_CONFIG
): Promise<{
  updatedMatches: MatchRecord[];
  recallStats: {
    category_family: number;
    text_keyword: number;
    image_vector: number;
    union_deduped: number;
    scannedEmbeddingCount: number;
  };
}> {
  await ensureAnonymousOrActiveSession();
  if (targetItem.status === 'delisted' || targetItem.status === 'returned') {
    return {
      updatedMatches: [],
      recallStats: {
        category_family: 0,
        text_keyword: 0,
        image_vector: 0,
        union_deduped: 0,
        scannedEmbeddingCount: 0,
      },
    };
  }
  const oppositeItems = allItems.filter(
    (it) =>
      it.type !== targetItem.type &&
      it.status !== 'delisted' &&
      it.status !== 'returned'
  );
  const embByItemId = new Map<string, ImageEmbedding>();
  const embById = new Map<string, ImageEmbedding>(allEmbeddings.map((e) => [e.id, e]));

  for (const it of allItems) {
    if (it.embeddingId && embById.has(it.embeddingId)) {
      embByItemId.set(it.id, embById.get(it.embeddingId)!);
    }
  }

  const recallResult = executeThreeWayRecallAndRerank(
    targetItem,
    oppositeItems,
    embByItemId,
    config,
    'three_way_rerank'
  );

  const existingById = new Map(existingMatches.map((m) => [m.id, m]));
  const now = new Date().toISOString();
  const persisted: MatchRecord[] = [];
  const persistedIds = new Set<string>();
  const minThreshold = config.decisionThreshold; // 58.0

  // [B1] Persist ONLY pairs with totalScore >= 58.0 (decisionThreshold), and purge any sub-threshold or stale match docs for targetItem
  const qualifiedMatches = recallResult.matches.filter((ev) => ev.totalScore >= minThreshold);

  try {
    const batch = writeBatch(db);
    for (const ev of qualifiedMatches) {
      const matchId = getDeterministicMatchId(ev.lostItemId, ev.foundItemId);
      const prev = existingById.get(matchId);
      const preservedStatus = prev ? prev.status : 'candidate';
      const createdAt = prev ? prev.createdAt : now;

      const record: MatchRecord = {
        id: matchId,
        lostItemId: ev.lostItemId,
        foundItemId: ev.foundItemId,
        totalScore: ev.totalScore,
        ruleScore7D: ev.ruleScore7D,
        imageSimilarity: ev.imageSimilarity,
        conflictPenalty: ev.conflictPenalty,
        dimensionScores: ev.dimensionScores,
        recallSources: ev.recallSources,
        conflictReasons: ev.conflictReasons,
        explanationSummary: ev.explanationSummary,
        algorithmVersion: ALGORITHM_VERSION,
        status: preservedStatus,
        createdAt,
        updatedAt: now,
      };
      batch.set(doc(db, 'matches', matchId), stripUndefined(record));
      persisted.push(record);
      persistedIds.add(matchId);
    }

    for (const oldMatch of existingMatches) {
      const involvesTarget =
        oldMatch.lostItemId === targetItem.id || oldMatch.foundItemId === targetItem.id;
      if (involvesTarget && (!persistedIds.has(oldMatch.id) || oldMatch.totalScore < minThreshold)) {
        batch.delete(doc(db, 'matches', oldMatch.id));
      }
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'matches');
  }

  return {
    updatedMatches: persisted,
    recallStats: {
      ...recallResult.recallChannelCounts,
      scannedEmbeddingCount: recallResult.scannedEmbeddingCount,
    },
  };
}

export async function updateMatchStatusWithFeedback(
  match: MatchRecord,
  action: 'confirm' | 'exclude' | 'restore',
  reason: string,
  actor: UserProfile
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  const newStatus: MatchRecord['status'] =
    action === 'confirm' ? 'confirmed' : action === 'exclude' ? 'excluded' : 'candidate';
  const now = new Date().toISOString();
  const feedbackId = `fb_${match.id}_${Date.now()}`;

  const updatedMatch: MatchRecord = {
    ...match,
    status: newStatus,
    updatedAt: now,
  };
  const feedback: MatchFeedback = {
    id: feedbackId,
    matchId: match.id,
    itemId: match.lostItemId,
    userUid: actor.uid,
    userName: actor.displayName,
    action,
    reason: reason.slice(0, 400),
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'matches', match.id), stripUndefined(updatedMatch));
    await setDoc(doc(db, 'match_feedback', feedbackId), stripUndefined(feedback));
    await recordAuditLog(
      actor,
      `MATCH_${action.toUpperCase()}`,
      match.id,
      `用户对匹配记录 [${match.id}] 执行 ${action} 操作，当前状态=${newStatus}。`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `matches/${match.id}`);
  }
}

export async function manualCorrectItemCategory(
  item: LostFoundItem,
  newCategory: CampusCategory,
  actor: UserProfile
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const updated: LostFoundItem = {
    ...item,
    campusCategory: newCategory,
    manualCategoryOverride: newCategory,
    updatedAt: now,
  };
  const feedbackId = `fb_cat_${item.id}_${Date.now()}`;
  const feedback: MatchFeedback = {
    id: feedbackId,
    matchId: `item_override_${item.id}`,
    itemId: item.id,
    userUid: actor.uid,
    userName: actor.displayName,
    action: 'correct_category',
    correctedCategory: newCategory,
    reason: `人工将物品类别从 [${item.campusCategory}] 修正为 [${newCategory}]`,
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'items', item.id), stripUndefined(updated));
    await setDoc(doc(db, 'match_feedback', feedbackId), stripUndefined(feedback));
    await recordAuditLog(
      actor,
      'CATEGORY_MANUAL_OVERRIDE',
      item.id,
      `人工纠错物品 [${item.title}] 类别：${item.campusCategory} -> ${newCategory}`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
  }
}

/**
 * Admin-only action (restricted to shx614519@gmail.com):
 * Sets item status to 'delisted', removes its candidate match records so it never appears
 * as a match candidate or counts toward active items, and records an ITEM_DELIST audit log entry
 * containing item id, actor, and timestamp.
 */
export async function delistItemByAdmin(
  item: LostFoundItem,
  adminActor: UserProfile,
  existingMatches: MatchRecord[] = []
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  const isWhitelistedAdmin =
    adminActor.role === 'admin' &&
    adminActor.email.toLowerCase() === ADMIN_WHITELIST_EMAIL.toLowerCase();
  if (!isWhitelistedAdmin) {
    throw new Error(`权限不足：仅管理员白名单账号 (${ADMIN_WHITELIST_EMAIL}) 可执行物品下架操作`);
  }

  const now = new Date().toISOString();
  const updatedItem: LostFoundItem = {
    ...item,
    status: 'delisted',
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'items', item.id), stripUndefined(updatedItem));

    // Remove any match candidates involving this delisted item
    const matchesToRemove = existingMatches.filter(
      (m) => m.lostItemId === item.id || m.foundItemId === item.id
    );
    for (const m of matchesToRemove) {
      batch.delete(doc(db, 'matches', m.id));
    }
    await batch.commit();

    await recordAuditLog(
      adminActor,
      'ITEM_DELIST',
      item.id,
      `管理员 [${adminActor.email}] 于 ${now} 下架物品 [ID=${item.id}，标题=${item.title}]，状态已设为 delisted 并移出大厅检索与匹配候选池。`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
  }
}

export async function createClaimRequest(params: {
  item: LostFoundItem;
  matchId?: string;
  verificationAnswer: string;
  actor: UserProfile;
}): Promise<ClaimRecord> {
  await ensureAnonymousOrActiveSession();
  // [G5] Forbid claiming one's own post or claiming non-claimable items
  if (params.item.ownerUid === params.actor.uid) {
    throw new Error('不能对本人发布的帖子提交认领或归还申请');
  }
  if (
    params.item.status === 'delisted' ||
    params.item.status === 'returned' ||
    params.item.status === 'handover'
  ) {
    throw new Error('该物品当前状态不支持发起新的核验申请');
  }

  const cleanAnswer = params.verificationAnswer.trim().slice(0, 480);
  if (!cleanAnswer) {
    throw new Error('请填写物品细节特征回答');
  }

  const now = new Date().toISOString();
  const claimId = `claim_${params.item.id}_${params.actor.uid}`;

  // [P1-3] Prevent overwriting an already pending/approved/completed claim; allow resubmission ONLY when status === 'rejected'
  let existingClaim: ClaimRecord | null = null;
  try {
    const existingSnap = await getDoc(doc(db, 'claims', claimId));
    if (existingSnap.exists()) {
      existingClaim = existingSnap.data() as ClaimRecord;
      if (existingClaim.status === 'pending_review' || existingClaim.status === 'approved_handover') {
        throw new Error('您已提交过该物品的核验申请，请在「我的 → 认领进度与交接码」查看审核与交接进度');
      }
      if (existingClaim.status === 'completed') {
        throw new Error('该物品已完成当面交接归还，无需重复提交');
      }
    }
  } catch (err) {
    if (err instanceof Error && (err.message.includes('已提交过') || err.message.includes('已完成当面交接'))) {
      throw err;
    }
  }

  // [P0-1] Distinguish Found-post claim ('claim_found') vs Lost-post return clue ('return_lost')
  const claimType = params.item.type === 'lost' ? 'return_lost' : 'claim_found';
  const loserUid = claimType === 'return_lost' ? params.item.ownerUid : params.actor.uid;
  const finderUid = claimType === 'claim_found' ? params.item.ownerUid : params.actor.uid;

  const codeNum = Math.floor(100000 + Math.random() * 900000);
  const handoverCode = String(codeNum);
  const qrPayload = handoverCode;

  const claim: ClaimRecord = {
    id: claimId,
    itemId: params.item.id,
    itemTitle: params.item.title,
    matchId: params.matchId || existingClaim?.matchId,
    claimType,
    loserUid,
    finderUid,
    claimantUid: params.actor.uid,
    claimantName: params.actor.displayName,
    claimantEmail: params.actor.email,
    verificationQuestion:
      params.item.verificationQuestion || '请描述物品独有特征（如贴纸、尾号、磨损位置）：',
    verificationAnswer: cleanAnswer,
    status: 'pending_review',
    handoverCode,
    qrPayload,
    createdAt: existingClaim ? existingClaim.createdAt : now,
    updatedAt: now,
  };

  try {
    await setDoc(doc(db, 'claims', claimId), stripUndefined(claim));
    await updateDoc(doc(db, 'items', params.item.id), {
      status: 'claiming',
      updatedAt: now,
    });
    await recordAuditLog(
      params.actor,
      existingClaim ? 'CLAIM_RESUBMIT' : 'CLAIM_SUBMIT',
      claimId,
      `${existingClaim ? '补充特征重新提交' : '提交'}${claimType === 'return_lost' ? '失物归还线索' : '拾物认领申请'} [${params.item.title}]，等待管理员初审。`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `claims/${claimId}`);
  }
  return claim;
}

export async function reviewClaimByAdmin(
  claim: ClaimRecord,
  item: LostFoundItem | undefined,
  decision: 'approved_handover' | 'rejected',
  reviewNote: string,
  adminActor: UserProfile
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  if (adminActor.role !== 'admin') {
    throw new Error('权限不足：仅失物招领中心管理员可执行认领审核操作');
  }
  const now = new Date().toISOString();
  const cleanReviewer = adminActor.displayName.replace(/\s*\(.*?\)/g, '');
  const { claimType, loserUid, finderUid } = resolveClaimRoleActors(claim, item);

  const updatedClaim: ClaimRecord = {
    ...claim,
    claimType,
    loserUid,
    finderUid,
    status: decision,
    reviewedBy: cleanReviewer,
    reviewNote: reviewNote.slice(0, 300),
    updatedAt: now,
  };

  try {
    // Inspect all claims on the same item to maintain multi-applicant state consistency ([P1-3])
    const itemClaimsSnap = await getDocs(
      query(collection(db, 'claims'), where('itemId', '==', claim.itemId))
    );
    const otherClaims = itemClaimsSnap.docs
      .map((d) => d.data() as ClaimRecord)
      .filter((c) => c.id !== claim.id);

    const batch = writeBatch(db);
    batch.set(doc(db, 'claims', claim.id), stripUndefined(updatedClaim));

    if (decision === 'approved_handover') {
      // Auto-reject any competing pending_review applications once a candidate enters face-to-face handover
      for (const oc of otherClaims) {
        if (oc.status === 'pending_review') {
          batch.set(
            doc(db, 'claims', oc.id),
            stripUndefined({
              ...oc,
              status: 'rejected',
              reviewedBy: cleanReviewer,
              reviewNote: '该物品已有其他申请人通过特征初审进入当面交接环节。',
              updatedAt: now,
            })
          );
        }
      }
      if (item) {
        batch.update(doc(db, 'items', item.id), {
          status: 'handover',
          updatedAt: now,
        });
      }
    } else if (item) {
      const hasApprovedOther = otherClaims.some((c) => c.status === 'approved_handover');
      const hasPendingOther = otherClaims.some((c) => c.status === 'pending_review');
      const nextItemStatus = hasApprovedOther
        ? 'handover'
        : hasPendingOther
        ? 'claiming'
        : 'matching';
      batch.update(doc(db, 'items', item.id), {
        status: nextItemStatus,
        updatedAt: now,
      });
    }

    await batch.commit();
    await recordAuditLog(
      adminActor,
      decision === 'approved_handover' ? 'CLAIM_APPROVE' : 'CLAIM_REJECT',
      claim.id,
      `管理员审核${claimType === 'return_lost' ? '归还线索单' : '认领单'} [${claim.id}] 结果：${decision === 'approved_handover' ? '审核通过进入当面交接' : '驳回'}。备注：${reviewNote}`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `claims/${claim.id}`);
  }
}

export async function verifyHandoverCodeAndComplete(
  claim: ClaimRecord,
  item: LostFoundItem | undefined,
  inputCode: string,
  actor: UserProfile
): Promise<void> {
  await ensureAnonymousOrActiveSession();
  if (claim.status === 'completed') {
    throw new Error('该交接单已完成核销，无需重复操作');
  }

  let targetItem = item;
  if (!targetItem) {
    const itemSnap = await getDoc(doc(db, 'items', claim.itemId));
    if (itemSnap.exists()) {
      targetItem = itemSnap.data() as LostFoundItem;
    }
  }

  const { claimType, loserUid, finderUid } = resolveClaimRoleActors(claim, targetItem);
  const isAdmin = actor.role === 'admin';
  // [P0-1] & [P0-2] Only the physical holder (finderUid, never loserUid) or a campus admin can verify the 6-digit code
  const canVerify =
    isAdmin || Boolean(finderUid && actor.uid === finderUid && actor.uid !== loserUid);
  if (!canVerify) {
    throw new Error('权限不足：仅实物持有人（拾主）或值班管理员可输入交接码完成核销');
  }
  if (inputCode.trim() !== claim.handoverCode.trim()) {
    throw new Error('输入的 6 位交接核验码不正确，请与失主当面核对后重试');
  }

  const now = new Date().toISOString();

  try {
    // 1. Discover paired opposite item & active matches ([P0-3] & [P0-4])
    let pairedOppositeItem: LostFoundItem | null = null;
    let winningMatch: MatchRecord | null = null;
    const relatedMatchesMap = new Map<string, MatchRecord>();

    if (targetItem) {
      const primaryMatchField = targetItem.type === 'found' ? 'foundItemId' : 'lostItemId';
      const primaryMatchSnap = await getDocs(
        query(collection(db, 'matches'), where(primaryMatchField, '==', targetItem.id))
      );
      for (const d of primaryMatchSnap.docs) {
        const m = d.data() as MatchRecord;
        relatedMatchesMap.set(m.id, m);
      }
      if (claim.matchId && !relatedMatchesMap.has(claim.matchId)) {
        const explicitSnap = await getDoc(doc(db, 'matches', claim.matchId));
        if (explicitSnap.exists()) {
          const em = explicitSnap.data() as MatchRecord;
          relatedMatchesMap.set(em.id, em);
        }
      }

      const validMatches = Array.from(relatedMatchesMap.values())
        .filter(
          (m) =>
            m.status !== 'excluded' &&
            m.totalScore >= DEFAULT_MATCHING_CONFIG.decisionThreshold
        )
        .sort((a, b) => b.totalScore - a.totalScore);

      const expectedOppositeOwnerUid = targetItem.type === 'found' ? loserUid : finderUid;
      for (const candMatch of validMatches) {
        const oppId =
          targetItem.type === 'found' ? candMatch.lostItemId : candMatch.foundItemId;
        const oppSnap = await getDoc(doc(db, 'items', oppId));
        if (!oppSnap.exists()) continue;
        const oppData = oppSnap.data() as LostFoundItem;
        if (oppData.ownerUid === expectedOppositeOwnerUid) {
          pairedOppositeItem = oppData;
          winningMatch = candMatch;
          if (candMatch.id === claim.matchId) break;
          break;
        }
      }

      if (pairedOppositeItem) {
        const secondaryMatchField =
          pairedOppositeItem.type === 'found' ? 'foundItemId' : 'lostItemId';
        const secondarySnap = await getDocs(
          query(
            collection(db, 'matches'),
            where(secondaryMatchField, '==', pairedOppositeItem.id)
          )
        );
        for (const d of secondarySnap.docs) {
          const m = d.data() as MatchRecord;
          relatedMatchesMap.set(m.id, m);
        }
      }
    }

    // 2. [P0-3] Closed-Loop Dual-Sided Bounty Settlement (deduct loserUid expense + credit finderUid income)
    const lostItemForBounty =
      targetItem?.type === 'lost' ? targetItem : pairedOppositeItem;
    const realRewardAmount = lostItemForBounty
      ? Math.max(0, Math.round(Number(lostItemForBounty.rewardAmount) || 0))
      : 0;

    if (
      !claim.bountySettled &&
      realRewardAmount > 0 &&
      loserUid &&
      finderUid &&
      loserUid !== finderUid
    ) {
      const [loserSnap, finderSnap] = await Promise.all([
        getDoc(doc(db, 'users', loserUid)),
        getDoc(doc(db, 'users', finderUid)),
      ]);
      const loserProfile: UserProfile | null = loserSnap.exists()
        ? (loserSnap.data() as UserProfile)
        : actor.uid === loserUid
        ? actor
        : null;
      const finderProfile: UserProfile | null = finderSnap.exists()
        ? (finderSnap.data() as UserProfile)
        : actor.uid === finderUid
        ? actor
        : null;

      if (!loserProfile) {
        throw new Error('未找到失主账户资料，无法完成悬赏金扣款核销');
      }
      const loserAvailable = getAvailableWalletBalance(loserProfile);
      if (loserAvailable < realRewardAmount) {
        throw new Error(
          `失主钱包当前可用余额（¥${loserAvailable}）不足以支付悬赏金（¥${realRewardAmount}），请失主核实余额后再核销`
        );
      }

      const loserCleanName = loserProfile.displayName.replace(/\s*\(.*?\)/g, '') || '失主同学';
      const finderCleanName =
        finderProfile?.displayName.replace(/\s*\(.*?\)/g, '') || '拾主同学';

      await recordBountyWalletTransaction(loserProfile, {
        title: `归还核销《${lostItemForBounty!.title}》支付悬赏赏金`,
        type: 'expense',
        amount: realRewardAmount,
        itemId: lostItemForBounty!.id,
        counterpartyName: finderCleanName,
      });

      if (finderProfile) {
        await recordBountyWalletTransaction(finderProfile, {
          title: `完成《${(targetItem || lostItemForBounty)!.title}》当面归还领取悬赏赏金`,
          type: 'income',
          amount: realRewardAmount,
          itemId: (targetItem || lostItemForBounty)!.id,
          counterpartyName: loserCleanName,
        });
      }
    }

    // 3. Atomic batch update for completed claim, returned item(s), match status cleanup, and competing claims
    const batch = writeBatch(db);
    const updatedClaim: ClaimRecord = {
      ...claim,
      claimType,
      loserUid,
      finderUid,
      status: 'completed',
      bountySettled: true,
      updatedAt: now,
    };
    batch.set(doc(db, 'claims', claim.id), stripUndefined(updatedClaim));

    if (targetItem) {
      batch.update(doc(db, 'items', targetItem.id), {
        status: 'returned',
        updatedAt: now,
      });
    }
    if (
      pairedOppositeItem &&
      pairedOppositeItem.id !== targetItem?.id &&
      pairedOppositeItem.status !== 'delisted' &&
      pairedOppositeItem.status !== 'returned'
    ) {
      batch.update(doc(db, 'items', pairedOppositeItem.id), {
        status: 'returned',
        updatedAt: now,
      });
    }

    // Confirm the winning match and remove stale candidate match alerts for returned items
    for (const m of relatedMatchesMap.values()) {
      if (winningMatch && m.id === winningMatch.id) {
        batch.set(
          doc(db, 'matches', m.id),
          stripUndefined({
            ...m,
            status: 'confirmed',
            updatedAt: now,
          })
        );
      } else if (m.status === 'candidate') {
        batch.delete(doc(db, 'matches', m.id));
      }
    }

    // Auto-close any competing active claims on targetItem or pairedOppositeItem
    const affectedItemIds = Array.from(
      new Set([claim.itemId, pairedOppositeItem?.id].filter(Boolean) as string[])
    );
    for (const affId of affectedItemIds) {
      const claimSnap = await getDocs(
        query(collection(db, 'claims'), where('itemId', '==', affId))
      );
      for (const cd of claimSnap.docs) {
        const cData = cd.data() as ClaimRecord;
        if (
          cData.id !== claim.id &&
          (cData.status === 'pending_review' || cData.status === 'approved_handover')
        ) {
          batch.set(
            doc(db, 'claims', cData.id),
            stripUndefined({
              ...cData,
              status: 'rejected',
              reviewedBy: '系统管理员',
              reviewNote: '该物品已完成当面核验归还，其余申请自动关闭。',
              updatedAt: now,
            })
          );
        }
      }
    }

    await batch.commit();

    await recordAuditLog(
      actor,
      'HANDOVER_COMPLETE',
      claim.id,
      `凭 6 位交接码完成物品 [${claim.itemTitle || claim.itemId}] 当面归还核销${pairedOppositeItem ? `，同步完结关联配对帖 [${pairedOppositeItem.title}]` : ''}${realRewardAmount > 0 ? `，悬赏金 ¥${realRewardAmount} 已双边闭环结算` : ''}。`
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('余额')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `claims/${claim.id}`);
  }
}

export async function submitHandoverMutualReview(params: {
  claim: ClaimRecord;
  item?: LostFoundItem;
  rating: '好评' | '中评' | '差评';
  content: string;
  actor: UserProfile;
}): Promise<void> {
  await ensureAnonymousOrActiveSession();
  if (params.claim.status !== 'completed') {
    throw new Error('仅已完成当面交接归还的记录可提交互评');
  }
  const { loserUid, finderUid } = resolveClaimRoleActors(params.claim, params.item);
  const isLoser = Boolean(loserUid && params.actor.uid === loserUid);
  const isFinder = Boolean(finderUid && params.actor.uid === finderUid);
  if (!isLoser && !isFinder) {
    throw new Error('仅本次交接的失主或拾主双方可进行互评');
  }
  const targetUid = isLoser ? finderUid : loserUid;
  if (!targetUid || targetUid === params.actor.uid) {
    throw new Error('未找到有效的互评对象');
  }
  const alreadyReviewed = Array.isArray(params.claim.reviewedParticipantUids)
    ? params.claim.reviewedParticipantUids
    : [];
  if (alreadyReviewed.includes(params.actor.uid)) {
    throw new Error('您已完成本次交接的评价，请勿重复提交');
  }

  const cleanContent = params.content.trim().slice(0, 300);
  if (!cleanContent) {
    throw new Error('请填写评价内容');
  }

  const now = new Date().toISOString();
  const targetSnap = await getDoc(doc(db, 'users', targetUid));
  if (!targetSnap.exists()) {
    throw new Error('未找到对方账户资料');
  }
  const targetProfile = targetSnap.data() as UserProfile;
  const newReview: UserReviewRecord = {
    id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    reviewerName: params.actor.displayName.replace(/\s*\(.*?\)/g, '').slice(0, 50) || '热心同学',
    roleTag: isLoser ? '失主评价' : '拾主评价',
    rating: params.rating,
    content: cleanContent,
    itemTitle: (params.claim.itemTitle || params.item?.title || '校园失物招领物品').slice(0, 120),
    createdAt: now,
  };
  const prevReviews = Array.isArray(targetProfile.reviews) ? targetProfile.reviews : [];
  const nextReviews = [newReview, ...prevReviews].slice(0, 40);
  const nextReviewedUids = Array.from(new Set([...alreadyReviewed, params.actor.uid])).slice(0, 5);

  try {
    await updateDoc(doc(db, 'users', targetUid), {
      reviews: nextReviews,
      updatedAt: now,
    });
    await updateDoc(doc(db, 'claims', params.claim.id), {
      reviewedParticipantUids: nextReviewedUids,
      updatedAt: now,
    });
    await recordAuditLog(
      params.actor,
      'HANDOVER_MUTUAL_REVIEW',
      params.claim.id,
      `交接互评：${params.actor.displayName} 对 [${targetProfile.displayName}] 提交 ${params.rating}（${newReview.roleTag}）`
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `claims/${params.claim.id}`);
  }
}

export async function sendInSiteMessage(params: {
  itemId: string;
  itemTitle?: string;
  content: string;
  actor: UserProfile;
  receiverUid?: string;
}): Promise<MessageRecord> {
  await ensureAnonymousOrActiveSession();
  const now = new Date().toISOString();
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const cleanSenderName = params.actor.displayName.replace(/\s*\(.*?\)/g, '');
  const msg: MessageRecord = {
    id: msgId,
    itemId: params.itemId,
    itemTitle: params.itemTitle?.slice(0, 150),
    senderUid: params.actor.uid,
    senderName: cleanSenderName,
    senderRole: params.actor.role,
    receiverUid: params.receiverUid || 'admin_shx614519',
    content: params.content.trim().slice(0, 950),
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'messages', msgId), stripUndefined(msg));
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `messages/${msgId}`);
  }
  return msg;
}
