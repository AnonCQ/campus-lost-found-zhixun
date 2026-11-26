/**
 * Core Domain Models, Constants, and Configurable Category Mapping
 *
 * CRITICAL MODEL RULE:
 * Every Gemini vision recognition and reasoning call uses GEMINI_MODEL = 'gemini-4-carbon'.
 * Image feature embeddings use the real multimodal embedding model EMBEDDING_MODEL_VERSION = 'gemini-embedding-2'
 * via ai.models.embedContent (3072D L2-normalized vectors from raw image bytes).
 */

export const GEMINI_MODEL = 'gemini-4-carbon' as const;
export const EMBEDDING_MODEL_VERSION = 'gemini-embedding-2' as const;
export const RECOGNITION_MODEL_VERSION = 'gemini-4-carbon-vision-v1' as const;
export const ALGORITHM_VERSION = 'v2.4-hybrid-3way' as const;
export const ADMIN_WHITELIST_EMAIL = 'shx614519@gmail.com' as const;
export const MAX_VECTOR_CANDIDATES = 100 as const;
export const DEFAULT_TOP_K = 5 as const;

export type CampusCategory =
  | '数码电子'
  | '证件卡类'
  | '水杯雨伞'
  | '箱包服饰'
  | '图书文具'
  | '钥匙配饰'
  | '运动生活'
  | 'unknown';

export const CAMPUS_CATEGORIES: { value: CampusCategory; label: string; description: string }[] = [
  { value: '数码电子', label: '数码电子', description: '笔记本电脑、手机、无线耳机、平板、充电宝、U盘' },
  { value: '证件卡类', label: '证件卡类', description: '校园一卡通、学生证、身份证、银行借记卡' },
  { value: '水杯雨伞', label: '水杯雨伞', description: '保温杯、运动水壶、折叠晴雨伞、长柄伞' },
  { value: '箱包服饰', label: '箱包服饰', description: '双肩书包、帆布托特包、钱包、卡包、外套围巾' },
  { value: '图书文具', label: '图书文具', description: '教材课本、纸质笔记本、笔袋、钢笔、计算器' },
  { value: '钥匙配饰', label: '钥匙配饰', description: '宿舍钥匙串、门禁卡扣、眼镜、手表、饰品挂件' },
  { value: '运动生活', label: '运动生活', description: '篮球、羽毛球拍、运动护具、饭盒、校园生活用品' },
  { value: 'unknown', label: '待人工确认 (unknown)', description: '模型置信度不足或不在标准映射表内，需人工纠错' },
];

/**
 * P0-1(4): Configurable "Model Class -> Campus Category" Mapping Table.
 * Note: Production architecture runs Ultralytics YOLO26n official weights (yolo26n.pt)
 * using actual model.names & results.boxes. This web environment substitutes
 * Gemini Vision (gemini-4-carbon) with the exact same configurable mapping contract.
 * Unrecognized classes or low confidence (< 0.45) map to 'unknown' for manual correction.
 */
export const MODEL_TO_CAMPUS_CATEGORY_MAP: Record<string, CampusCategory> = {
  // 数码电子
  laptop: '数码电子',
  notebook_computer: '数码电子',
  macbook: '数码电子',
  'cell phone': '数码电子',
  smartphone: '数码电子',
  mobile_phone: '数码电子',
  iphone: '数码电子',
  earbuds: '数码电子',
  airpods: '数码电子',
  headphones: '数码电子',
  earphones: '数码电子',
  tablet: '数码电子',
  ipad: '数码电子',
  power_bank: '数码电子',
  charger: '数码电子',
  usb_drive: '数码电子',
  mouse: '数码电子',
  keyboard: '数码电子',
  笔记本电脑: '数码电子',
  手机: '数码电子',
  耳机: '数码电子',
  平板电脑: '数码电子',
  充电宝: '数码电子',

  // 证件卡类
  campus_card: '证件卡类',
  student_id: '证件卡类',
  id_card: '证件卡类',
  bank_card: '证件卡类',
  debit_card: '证件卡类',
  credit_card: '证件卡类',
  smart_card: '证件卡类',
  badge: '证件卡类',
  校园卡: '证件卡类',
  银行卡: '证件卡类',
  借记卡: '证件卡类',
  身份证: '证件卡类',
  学生证: '证件卡类',

  // 水杯雨伞
  bottle: '水杯雨伞',
  water_bottle: '水杯雨伞',
  thermos: '水杯雨伞',
  tumbler: '水杯雨伞',
  cup: '水杯雨伞',
  mug: '水杯雨伞',
  umbrella: '水杯雨伞',
  水杯: '水杯雨伞',
  保温杯: '水杯雨伞',
  雨伞: '水杯雨伞',

  // 箱包服饰
  backpack: '箱包服饰',
  handbag: '箱包服饰',
  tote_bag: '箱包服饰',
  canvas_bag: '箱包服饰',
  suitcase: '箱包服饰',
  wallet: '箱包服饰',
  purse: '箱包服饰',
  jacket: '箱包服饰',
  hat: '箱包服饰',
  书包: '箱包服饰',
  双肩包: '箱包服饰',
  帆布包: '箱包服饰',
  钱包: '箱包服饰',
  服饰: '箱包服饰',

  // 图书文具
  book: '图书文具',
  textbook: '图书文具',
  paper_notebook: '图书文具',
  pencil_case: '图书文具',
  pen: '图书文具',
  calculator: '图书文具',
  笔记本: '图书文具',
  书籍: '图书文具',
  教材: '图书文具',
  文具盒: '图书文具',
  笔袋: '图书文具',

  // 钥匙配饰
  keys: '钥匙配饰',
  keychain: '钥匙配饰',
  key_ring: '钥匙配饰',
  access_fob: '钥匙配饰',
  glasses: '钥匙配饰',
  eyeglasses: '钥匙配饰',
  sunglasses: '钥匙配饰',
  watch: '钥匙配饰',
  wristwatch: '钥匙配饰',
  钥匙: '钥匙配饰',
  钥匙串: '钥匙配饰',
  眼镜: '钥匙配饰',
  手表: '钥匙配饰',

  // 运动生活
  sports_ball: '运动生活',
  basketball: '运动生活',
  tennis_racket: '运动生活',
  badminton_racket: '运动生活',
  篮球: '运动生活',
  球拍: '运动生活',
};

export function mapRawClassToCampusCategory(
  rawClass: string | undefined | null,
  confidence = 1.0,
  minConfidenceThreshold = 0.45
): CampusCategory {
  if (!rawClass || confidence < minConfidenceThreshold) {
    return 'unknown';
  }
  const normalized = rawClass.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const direct = MODEL_TO_CAMPUS_CATEGORY_MAP[normalized] || MODEL_TO_CAMPUS_CATEGORY_MAP[rawClass.trim().toLowerCase()];
  if (direct) return direct;

  for (const [key, cat] of Object.entries(MODEL_TO_CAMPUS_CATEGORY_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return cat;
    }
  }
  return 'unknown';
}

export const BOUNTY_PRESET_AMOUNTS = [0, 10, 20, 50] as const;

export interface WalletTransaction {
  id: string;
  title: string;
  type: 'income' | 'expense';
  amount: number;
  itemId?: string;
  counterpartyName?: string;
  createdAt: string;
}

export interface UserReviewRecord {
  id: string;
  reviewerName: string;
  roleTag: '失主评价' | '拾主评价';
  rating: '好评' | '中评' | '差评';
  content: string;
  itemTitle: string;
  createdAt: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: 'admin' | 'student';
  phone?: string;
  studentId?: string;
  department?: string;
  className?: string;
  bio?: string;
  birthday?: string;
  avatarUrl?: string;
  browsedItemIds?: string[];
  readNotificationIds?: string[];
  darkMode?: boolean;
  pushNotifyEnabled?: boolean;
  walletBalance?: number;
  walletTransactions?: WalletTransaction[];
  reviews?: UserReviewRecord[];
  isDemoRole?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export type ItemStatus = 'open' | 'matching' | 'claiming' | 'handover' | 'returned' | 'delisted';
export type RecognitionTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * P0-2 Deterministic Embedding Document ID:
 * Derived strictly from (imageHash, modelVersion) ONLY — no image-slug/name component —
 * so seed and publish flows always converge on the exact same document.
 */
export function getDeterministicEmbeddingId(
  imageHash: string,
  modelVersion: string = EMBEDDING_MODEL_VERSION
): string {
  const cleanHash = imageHash.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanVersion = modelVersion.trim().replace(/[^a-zA-Z0-9_.-]/g, '');
  return `emb_${cleanHash}_${cleanVersion}`;
}

export type CampusLocationArea =
  | '1号教学楼'
  | '2号教学楼'
  | '3号教学楼'
  | '宿舍楼'
  | '图书馆'
  | '食堂'
  | '操场'
  | '体育馆'
  | '实验楼'
  | '校门口'
  | '其他';

export const CAMPUS_LOCATION_AREAS: CampusLocationArea[] = [
  '1号教学楼',
  '2号教学楼',
  '3号教学楼',
  '宿舍楼',
  '图书馆',
  '食堂',
  '操场',
  '体育馆',
  '实验楼',
  '校门口',
  '其他',
];

/**
 * Composes display location string "大体位置 · 详细位置" (omitting separator and detail when detail is empty).
 */
export function composeCampusLocation(area: string, detail?: string): string {
  const cleanArea = (area || '').trim();
  const cleanDetail = (detail || '').trim();
  if (!cleanArea) return cleanDetail;
  return cleanDetail ? `${cleanArea} · ${cleanDetail}` : cleanArea;
}

export interface LostFoundItem {
  id: string;
  type: 'lost' | 'found';
  title: string;
  description: string;
  campusCategory: CampusCategory;
  rawModelClass?: string;
  manualCategoryOverride?: CampusCategory;
  color?: string;
  quantity?: number;
  brand?: string;
  rewardAmount?: number;
  locationArea?: CampusLocationArea | string;
  locationDetail?: string;
  location: string;
  eventTime: string;
  conditionText?: string;
  keywords?: string[];
  imageUrl?: string;
  storagePath?: string;
  imageSha256?: string;
  embeddingId?: string;
  recognitionTaskId?: string;
  recognitionStatus?: RecognitionTaskStatus;
  confidence?: number;
  bbox?: [number, number, number, number];
  latencyMs?: number;
  modelVersion?: string;
  recognitionSource?: 'model' | 'fallback' | 'seed_demo';
  isFallback?: boolean;
  fallbackReason?: string;
  status: ItemStatus;
  ownerUid: string;
  ownerName?: string;
  ownerEmail?: string;
  verificationQuestion?: string;
  verificationAnswerHint?: string;
  isSeededDemo?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface ImageEmbedding {
  id: string;
  sha256: string;
  modelVersion: string;
  dimension: number;
  vector: number[];
  itemId?: string;
  visualSummary?: string;
  createdAt: string;
}

export interface RecognitionTask {
  id: string;
  itemId: string;
  itemTitle?: string;
  idempotencyKey: string;
  status: RecognitionTaskStatus;
  retryCount: number;
  maxRetries?: number;
  modelVersion: string;
  rawModelClass?: string;
  mappedCampusCategory?: CampusCategory;
  confidence?: number;
  bbox?: [number, number, number, number];
  extractedColor?: string;
  extractedBrand?: string;
  extractedKeywords?: string[];
  latencyMs?: number;
  cacheHit?: boolean;
  embeddingId?: string;
  recognitionSource?: 'model' | 'fallback' | 'seed_demo';
  isFallback?: boolean;
  fallbackReason?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SevenDimensionScores {
  category: number;
  color: number;
  quantity: number;
  location: number;
  condition: number;
  keywords: number;
  time: number;
}

export type RecallSource = 'category_family' | 'text_keyword' | 'image_vector';

export interface MatchRecord {
  id: string; // Deterministic: match_${lostItemId}_${foundItemId}
  lostItemId: string;
  foundItemId: string;
  totalScore: number;
  ruleScore7D: number;
  imageSimilarity: number;
  conflictPenalty?: number;
  dimensionScores?: SevenDimensionScores;
  recallSources?: RecallSource[];
  conflictReasons?: string[];
  explanationSummary?: string;
  algorithmVersion: string;
  status: 'candidate' | 'confirmed' | 'excluded';
  createdAt: string;
  updatedAt?: string;
}

export interface MatchFeedback {
  id: string;
  matchId: string;
  itemId?: string;
  userUid: string;
  userName?: string;
  action: 'confirm' | 'exclude' | 'restore' | 'correct_category';
  reason?: string;
  correctedCategory?: CampusCategory;
  createdAt: string;
}

export type ClaimActionType = 'claim_found' | 'return_lost';

export interface ClaimRecord {
  id: string;
  itemId: string;
  itemTitle?: string;
  matchId?: string;
  claimType?: ClaimActionType;
  loserUid?: string;
  finderUid?: string;
  claimantUid: string;
  claimantName: string;
  claimantEmail?: string;
  verificationQuestion?: string;
  verificationAnswer: string;
  status: 'pending_review' | 'approved_handover' | 'rejected' | 'completed';
  handoverCode: string; // 6-digit numeric verification code
  qrPayload?: string;
  reviewedBy?: string;
  reviewNote?: string;
  bountySettled?: boolean;
  reviewedParticipantUids?: string[];
  createdAt: string;
  updatedAt?: string;
}

/**
 * Resolves the unified loser (voucher holder) and finder (physical holder / verifier)
 * across both Found-post claims ('claim_found') and Lost-post return clues ('return_lost').
 */
export function resolveClaimRoleActors(
  claim: Pick<ClaimRecord, 'claimType' | 'loserUid' | 'finderUid' | 'claimantUid'>,
  item?: Pick<LostFoundItem, 'type' | 'ownerUid'>
): {
  claimType: ClaimActionType;
  loserUid: string;
  finderUid: string;
} {
  const claimType: ClaimActionType =
    claim.claimType || (item?.type === 'lost' ? 'return_lost' : 'claim_found');
  const loserUid =
    claim.loserUid ||
    (claimType === 'return_lost' ? item?.ownerUid || '' : claim.claimantUid);
  const finderUid =
    claim.finderUid ||
    (claimType === 'claim_found' ? item?.ownerUid || '' : claim.claimantUid);
  return { claimType, loserUid, finderUid };
}

/**
 * Maps an authenticated Firebase user (e.g., Google popup login for shx614519@gmail.com)
 * back to an existing canonical campus account by email so admin_shx614519 (张老师)
 * never splits into a second duplicate UID with empty messages/posts/wallet.
 */
export function resolveCanonicalAuthProfile(
  fbUser: { uid: string; email?: string | null; displayName?: string | null; photoURL?: string | null },
  existingUsers: UserProfile[],
  seedUsers: UserProfile[]
): UserProfile {
  const normEmail = (fbUser.email || '').trim().toLowerCase();
  const isAdmin = normEmail === ADMIN_WHITELIST_EMAIL.toLowerCase();

  if (normEmail) {
    const seedMatch = seedUsers.find((u) => u.email.trim().toLowerCase() === normEmail);
    const liveByCanonicalUid = seedMatch
      ? existingUsers.find((u) => u.uid === seedMatch.uid)
      : undefined;
    const liveByEmail = existingUsers.find((u) => u.email.trim().toLowerCase() === normEmail);
    const baseCanonical = liveByCanonicalUid || seedMatch || liveByEmail;

    if (baseCanonical) {
      return {
        ...(seedMatch || {}),
        ...baseCanonical,
        uid: seedMatch ? seedMatch.uid : baseCanonical.uid,
        email: baseCanonical.email || fbUser.email || 'user@campus.edu.cn',
        displayName: baseCanonical.displayName || fbUser.displayName || (isAdmin ? '张老师' : '同学'),
        role: isAdmin ? 'admin' : baseCanonical.role,
        avatarUrl: baseCanonical.avatarUrl || fbUser.photoURL || undefined,
        isDemoRole: false,
      };
    }
  }

  return {
    uid: fbUser.uid,
    email: fbUser.email || 'user@campus.edu.cn',
    displayName: fbUser.displayName || (isAdmin ? '张老师' : '校园认证用户'),
    role: isAdmin ? 'admin' : 'student',
    department: isAdmin ? '校团委失物招领中心' : '计算机科学与技术学院',
    className: isAdmin ? '行政楼105室服务台' : '计科2301班',
    avatarUrl: fbUser.photoURL || undefined,
    isDemoRole: false,
    createdAt: new Date().toISOString(),
  };
}

export interface MessageRecord {
  id: string;
  itemId: string;
  itemTitle?: string;
  senderUid: string;
  senderName: string;
  senderRole?: 'admin' | 'student';
  receiverUid?: string;
  content: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actorUid: string;
  actorName?: string;
  actorRole?: 'admin' | 'student';
  action: string;
  targetId: string;
  detail: string;
  createdAt: string;
}

export interface MatchingWeightsConfig {
  weights7D: {
    category: number;
    color: number;
    quantity: number;
    location: number;
    condition: number;
    keywords: number;
    time: number;
  };
  ruleWeightAlpha: number; // e.g., 0.68 for 7D rule, 0.32 for image similarity
  decisionThreshold: number; // e.g., 58.0
  topK: number;
}

export const DEFAULT_MATCHING_CONFIG: MatchingWeightsConfig = {
  weights7D: {
    category: 0.22,
    color: 0.14,
    quantity: 0.06,
    location: 0.16,
    condition: 0.08,
    keywords: 0.19,
    time: 0.15,
  },
  ruleWeightAlpha: 0.68,
  decisionThreshold: 58.0,
  topK: 5,
};
