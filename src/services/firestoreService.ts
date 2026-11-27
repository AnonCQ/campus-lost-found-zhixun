/**
 * FastAPI REST Persistence Layer (SQLite / MySQL Backend via SQLAlchemy)
 *
 * Replaces cloud Firebase Firestore SDK with clean REST API calls to the local
 * Python FastAPI backend (backend/main.py), preserving 100% of component contracts.
 */

import {
  AuditLog,
  CampusCategory,
  ClaimRecord,
  DEFAULT_MATCHING_CONFIG,
  ImageEmbedding,
  LostFoundItem,
  MatchingWeightsConfig,
  MatchFeedback,
  MatchRecord,
  MessageRecord,
  RecognitionTask,
  UserProfile,
} from '../types/models';

const API_BASE = '';

async function requestJson<T>(
  url: string,
  options?: RequestInit,
  timeoutMs = 25000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}${url}`, {
      ...options,
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: any = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { detail: text };
      }
    }
    if (!resp.ok) {
      const msg = parsed?.detail || parsed?.error || `接口请求失败 (${resp.status})`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return parsed as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`服务请求超时（>${Math.round(timeoutMs / 1000)}秒），请稍后重试`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  return requestJson('/api/bundle', { method: 'GET' });
}

export interface AnalyticsOverviewPayload {
  summary: {
    totalItems: number;
    lostCount: number;
    foundCount: number;
    returnedCount: number;
    recoveryRate: number;
    totalMatches: number;
    highScoreMatches: number;
    confirmedMatches: number;
    totalClaims: number;
    completedClaims: number;
    totalEmbeddings: number;
    totalTasks: number;
    succeededTasks: number;
    failedTasks: number;
    cacheHitRate: number;
    avgLatencyMs: number;
    avgConfidence: number;
  };
  categoryDistribution: Array<{
    category: string;
    lost: number;
    found: number;
    returned: number;
    total: number;
  }>;
  locationHotspots: Array<{
    area: string;
    lost: number;
    found: number;
    total: number;
  }>;
  statusFunnel: Array<{
    status: string;
    label: string;
    count: number;
  }>;
  dailyTrend: Array<{
    date: string;
    lost: number;
    found: number;
    returned: number;
  }>;
  aiTelemetry: {
    modelsReady: boolean;
    device: string;
    gpuName: string;
    yoloModel: string;
    yoloWeightsExists: boolean;
    yoloSha256: string;
    yoloNumClasses: number;
    clipModel: string;
    embeddingModelVersion: string;
    embeddingDimension: number;
    recognitionModelVersion: string;
    memoryCacheEntries: number;
    loadError: string | null;
  };
  evaluationSummary: Array<{
    strategyKey: string;
    strategyName: string;
    precision: number;
    recall: number;
    f1: number;
    recallAt1: number;
    recallAt3: number;
    recallAt5: number;
    avgLatencyMs: number;
  }>;
}

export async function fetchAnalyticsOverview(): Promise<AnalyticsOverviewPayload> {
  return requestJson<AnalyticsOverviewPayload>('/api/analytics/overview', { method: 'GET' });
}

export async function runBackendEvaluation(
  datasetKey: 'dataset' | 'dataset_control' | 'dataset_blind' = 'dataset',
  config?: Partial<MatchingWeightsConfig>
): Promise<any> {
  return requestJson('/api/eval/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetKey, config }),
  });
}

export async function resetToDeterministic12DemoData(
  actor?: UserProfile,
  mode: 'if_empty' | 'reset' = 'reset'
): Promise<void> {
  await requestJson('/api/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, actor }),
  }, 60000);
}

export async function upsertUserProfile(profile: UserProfile): Promise<void> {
  await requestJson(`/api/users/${encodeURIComponent(profile.uid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
}

export async function recordAuditLog(
  actor: UserProfile,
  action: string,
  targetId: string,
  detail: string
): Promise<void> {
  await requestJson('/api/audit-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, action, targetId, detail }),
  });
}

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
  const data = await requestJson<{
    embedding: ImageEmbedding;
    cacheHit: boolean;
  }>('/api/embeddings/encode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return {
    embedding: data.embedding,
    cacheHit: Boolean(data.cacheHit),
  };
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
  _currentProfile: UserProfile
): Promise<UserProfile> {
  return requestJson<UserProfile>(`/api/users/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...updates, recordAudit: true }),
  });
}

export async function recordUserBrowsingHistory(
  currentProfile: UserProfile,
  itemId: string
): Promise<UserProfile> {
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/browsing-history`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
    }
  );
}

export async function clearUserBrowsingHistory(
  currentProfile: UserProfile
): Promise<UserProfile> {
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/browsing-history`,
    { method: 'DELETE' }
  );
}

export async function markNotificationsReadInFirestore(
  currentProfile: UserProfile,
  notificationIds: string[]
): Promise<UserProfile> {
  if (!notificationIds.length) return currentProfile;
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/read-notifications`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationIds }),
    }
  );
}

export async function updateUserDarkModePreference(
  currentProfile: UserProfile,
  darkMode: boolean
): Promise<UserProfile> {
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/preferences`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ darkMode }),
    }
  );
}

export async function updateUserPushNotifyPreference(
  currentProfile: UserProfile,
  pushNotifyEnabled: boolean
): Promise<UserProfile> {
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/preferences`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushNotifyEnabled }),
    }
  );
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
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/wallet/transactions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(txInput),
    }
  );
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
  return requestJson<UserProfile>(
    `/api/users/${encodeURIComponent(currentProfile.uid)}/reviews`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewInput),
    }
  );
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
  return requestJson<LostFoundItem>(`/api/items/${encodeURIComponent(item.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates, actor }),
  });
}

export async function toggleUserItemListingStatus(
  item: LostFoundItem,
  nextStatus: 'delisted' | 'open',
  actor: UserProfile,
  _existingMatches: MatchRecord[] = []
): Promise<LostFoundItem> {
  return requestJson<LostFoundItem>(`/api/items/${encodeURIComponent(item.id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nextStatus, actor }),
  });
}

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
  const { onTaskStatusChange, ...payload } = params;
  const res = await requestJson<{
    item: LostFoundItem;
    task: RecognitionTask;
    cacheHit: boolean;
  }>(
    '/api/items/publish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    30000
  );
  if (res.task) {
    onTaskStatusChange?.(res.task.status, res.task);
  }
  return res;
}

export async function retryRecognitionTask(
  task: RecognitionTask,
  _item: LostFoundItem,
  actor: UserProfile
): Promise<RecognitionTask> {
  return requestJson<RecognitionTask>(`/api/tasks/${encodeURIComponent(task.id)}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor }),
  });
}

export async function runAndPersistMatchesForItem(
  targetItem: LostFoundItem,
  _allItems: LostFoundItem[],
  _allEmbeddings: ImageEmbedding[],
  _existingMatches: MatchRecord[],
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
  return requestJson(`/api/items/${encodeURIComponent(targetItem.id)}/rematch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
}

export async function updateMatchStatusWithFeedback(
  match: MatchRecord,
  action: 'confirm' | 'exclude' | 'restore',
  reason: string,
  actor: UserProfile
): Promise<void> {
  await requestJson(`/api/matches/${encodeURIComponent(match.id)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, reason, actor }),
  });
}

export async function manualCorrectItemCategory(
  item: LostFoundItem,
  newCategory: CampusCategory,
  actor: UserProfile
): Promise<void> {
  await requestJson(`/api/items/${encodeURIComponent(item.id)}/correct-category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newCategory, actor }),
  });
}

export async function delistItemByAdmin(
  item: LostFoundItem,
  adminActor: UserProfile,
  _existingMatches: MatchRecord[] = []
): Promise<void> {
  await requestJson(`/api/items/${encodeURIComponent(item.id)}/delist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: adminActor }),
  });
}

export async function createClaimRequest(params: {
  item: LostFoundItem;
  matchId?: string;
  verificationAnswer: string;
  actor: UserProfile;
}): Promise<ClaimRecord> {
  return requestJson<ClaimRecord>('/api/claims', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemId: params.item.id,
      matchId: params.matchId,
      verificationAnswer: params.verificationAnswer,
      actor: params.actor,
    }),
  });
}

export async function reviewClaimByAdmin(
  claim: ClaimRecord,
  _item: LostFoundItem | undefined,
  decision: 'approved_handover' | 'rejected',
  reviewNote: string,
  adminActor: UserProfile
): Promise<void> {
  await requestJson(`/api/claims/${encodeURIComponent(claim.id)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, reviewNote, actor: adminActor }),
  });
}

export async function verifyHandoverCodeAndComplete(
  claim: ClaimRecord,
  _item: LostFoundItem | undefined,
  inputCode: string,
  actor: UserProfile
): Promise<void> {
  await requestJson(`/api/claims/${encodeURIComponent(claim.id)}/verify-handover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputCode, actor }),
  });
}

export async function submitHandoverMutualReview(params: {
  claim: ClaimRecord;
  item?: LostFoundItem;
  rating: '好评' | '中评' | '差评';
  content: string;
  actor: UserProfile;
}): Promise<void> {
  await requestJson(`/api/claims/${encodeURIComponent(params.claim.id)}/mutual-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rating: params.rating,
      content: params.content,
      actor: params.actor,
    }),
  });
}

export async function sendInSiteMessage(params: {
  itemId: string;
  itemTitle?: string;
  content: string;
  actor: UserProfile;
  receiverUid?: string;
}): Promise<MessageRecord> {
  return requestJson<MessageRecord>('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}
