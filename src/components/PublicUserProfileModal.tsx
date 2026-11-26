import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Sparkles,
  Star,
  ThumbsUp,
  UserCheck,
} from 'lucide-react';
import { LostFoundItem, MessageRecord, UserProfile, UserReviewRecord } from '../types/models';
import { SEED_USERS } from '../data/seedData';
import { ResilientItemImage } from './QrCodeSvg';

const FALLBACK_AVATARS = [
  'https://api.dicebear.com/7.x/adventurer/svg?seed=CampusLi&backgroundColor=ffdfbf',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=StudentChen&backgroundColor=ffd5dc',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=StudentWang&backgroundColor=c0aede',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=StudentZhang&backgroundColor=d1d4f9',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=CampusAdmin&backgroundColor=b6e3f4',
];

export function cleanDisplayName(raw?: string): string {
  if (!raw) return '校友同学';
  const cleaned = raw.replace(/\s*\(.*?\)/g, '').trim();
  return cleaned || '校友同学';
}

export function getFallbackAvatarForUid(uid?: string): string {
  if (!uid) return FALLBACK_AVATARS[0];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_AVATARS[hash % FALLBACK_AVATARS.length];
}

/**
 * Resolves a full UserProfile by UID or fallback display name across live Firestore users + SEED_USERS.
 */
export function resolveUserProfile(
  uid: string | undefined,
  fallbackName: string | undefined,
  users: UserProfile[]
): UserProfile {
  const combinedUsers = [...users, ...SEED_USERS];

  if (uid) {
    const byUid = combinedUsers.find((u) => u.uid === uid);
    if (byUid) {
      return {
        ...byUid,
        displayName: cleanDisplayName(byUid.displayName),
        avatarUrl: byUid.avatarUrl || getFallbackAvatarForUid(byUid.uid),
      };
    }
  }

  const targetCleanName = fallbackName ? cleanDisplayName(fallbackName) : '';
  if (targetCleanName) {
    const byName = combinedUsers.find(
      (u) => cleanDisplayName(u.displayName) === targetCleanName
    );
    if (byName) {
      return {
        ...byName,
        displayName: cleanDisplayName(byName.displayName),
        avatarUrl: byName.avatarUrl || getFallbackAvatarForUid(byName.uid),
      };
    }
  }

  const resolvedUid = uid || `campus_user_${targetCleanName || 'peer'}`;
  return {
    uid: resolvedUid,
    email: '',
    displayName: targetCleanName || '校友同学',
    role: 'student',
    department: '校园实名认证同学',
    bio: '热爱校园生活，拾金不昧互助同学',
    avatarUrl: getFallbackAvatarForUid(resolvedUid),
    createdAt: '2026-11-01T08:00:00.000Z',
  };
}

export interface ActiveThreadTarget {
  viewerUid: string;
  itemId: string;
  counterpartyUid: string;
}

/**
 * Resolves the strict 2-participant UID pair [senderUid, receiverUid] for a 1-to-1 message.
 * Handles legacy owner replies where receiverUid matched senderUid by inferring the counterparty
 * from prior messages on the same item, without modifying any stored message records.
 */
export function getMessageParticipantPair(
  msg: MessageRecord,
  itemMessagesChronological: MessageRecord[],
  item?: LostFoundItem
): [string, string] | null {
  const sender = msg.senderUid?.trim();
  if (!sender || sender === 'empty') return null;

  let receiver = msg.receiverUid?.trim();
  if (!receiver || receiver === sender) {
    if (item?.ownerUid && item.ownerUid !== sender) {
      receiver = item.ownerUid;
    } else {
      for (let i = itemMessagesChronological.length - 1; i >= 0; i--) {
        const prev = itemMessagesChronological[i];
        if (prev.createdAt <= msg.createdAt && prev.senderUid && prev.senderUid !== sender) {
          receiver = prev.senderUid;
          break;
        }
      }
      if (!receiver || receiver === sender) {
        for (let i = 0; i < itemMessagesChronological.length; i++) {
          const other = itemMessagesChronological[i];
          if (other.senderUid && other.senderUid !== sender) {
            receiver = other.senderUid;
            break;
          }
        }
      }
    }
  }

  if (!receiver || receiver === sender) return null;
  return [sender, receiver];
}

/**
 * Returns true if and only if `userUid` is one of the two participants of `msg`.
 */
export function isUserParticipantInMessage(
  msg: MessageRecord,
  userUid: string,
  itemMessagesChronological: MessageRecord[],
  item?: LostFoundItem
): boolean {
  if (!userUid) return false;
  const pair = getMessageParticipantPair(msg, itemMessagesChronological, item);
  if (!pair) return false;
  return pair[0] === userUid || pair[1] === userUid;
}

/**
 * Returns the counterparty UID (the participant !== userUid) if `userUid` is a participant of `msg`, else null.
 */
export function getCounterpartyUidForMessage(
  msg: MessageRecord,
  userUid: string,
  itemMessagesChronological: MessageRecord[],
  item?: LostFoundItem
): string | null {
  if (!userUid) return null;
  const pair = getMessageParticipantPair(msg, itemMessagesChronological, item);
  if (!pair) return null;
  if (pair[0] === userUid) return pair[1];
  if (pair[1] === userUid) return pair[0];
  return null;
}

/**
 * Returns true if and only if the two participants of `msg` are strictly {uidA, uidB} with uidA !== uidB.
 */
export function isStrictTwoPartyMessage(
  msg: MessageRecord,
  uidA: string,
  uidB: string,
  itemMessagesChronological: MessageRecord[],
  item?: LostFoundItem
): boolean {
  if (!uidA || !uidB || uidA === uidB) return false;
  const pair = getMessageParticipantPair(msg, itemMessagesChronological, item);
  if (!pair) return false;
  return (
    (pair[0] === uidA && pair[1] === uidB) ||
    (pair[0] === uidB && pair[1] === uidA)
  );
}

/**
 * Viewer-relative counterparty resolver for any 1-to-1 conversation.
 * Always resolves the participant who is NOT the currently signed-in user (`uid !== currentUser.uid`).
 */
export function resolveConversationCounterparty(params: {
  messages: MessageRecord[];
  item?: LostFoundItem;
  currentUser: UserProfile;
  users: UserProfile[];
  counterpartyUid?: string;
}): UserProfile {
  const { messages, item, currentUser, users, counterpartyUid } = params;
  const myUid = currentUser.uid;
  const myCleanName = cleanDisplayName(currentUser.displayName);

  // 0. If explicit counterpartyUid is known (and distinct from currentUser), resolve it directly
  if (counterpartyUid && counterpartyUid !== myUid) {
    const msgFromPeer = [...messages]
      .reverse()
      .find((m) => m.senderUid === counterpartyUid && m.id !== 'empty');
    const fallbackPeerName =
      msgFromPeer?.senderName ||
      (item && item.ownerUid === counterpartyUid ? item.ownerName : undefined);
    return resolveUserProfile(counterpartyUid, fallbackPeerName, users);
  }

  // 1. Check message senders who are not currentUser (from newest to oldest)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.senderUid && msg.senderUid !== myUid && msg.senderUid !== 'empty') {
      return resolveUserProfile(msg.senderUid, msg.senderName, users);
    }
  }

  // 2. Check message receivers who are not currentUser (when currentUser sent all messages so far)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.receiverUid && msg.receiverUid !== myUid) {
      return resolveUserProfile(msg.receiverUid, undefined, users);
    }
  }

  // 3. Check message senderName if different from currentUser's name
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const senderClean = cleanDisplayName(msg.senderName);
    if (senderClean && senderClean !== myCleanName && msg.id !== 'empty') {
      return resolveUserProfile(msg.senderUid, msg.senderName, users);
    }
  }

  // 4. Check the related item's owner if not currentUser
  if (item && item.ownerUid !== myUid) {
    return resolveUserProfile(item.ownerUid, item.ownerName, users);
  }

  return resolveUserProfile(undefined, '校友同学', users);
}

interface PublicUserProfileModalProps {
  user: UserProfile | null;
  currentUser: UserProfile;
  allItems: LostFoundItem[];
  onClose: () => void;
  onOpenItemDetail: (item: LostFoundItem) => void;
}

export const PublicUserProfileModal: React.FC<PublicUserProfileModalProps> = ({
  user,
  currentUser,
  allItems,
  onClose,
  onOpenItemDetail,
}) => {
  const [activeTab, setActiveTab] = useState<'found' | 'lost' | 'reviews'>('found');

  const userItemsAndStats = useMemo(() => {
    if (!user) {
      return {
        foundItems: [] as LostFoundItem[],
        lostItems: [] as LostFoundItem[],
        reviews: [] as UserReviewRecord[],
        positiveRate: 100,
        creditTierLabel: '极好',
      };
    }

    const cleanTargetName = cleanDisplayName(user.displayName);
    const owned = allItems.filter(
      (i) =>
        i.status !== 'delisted' &&
        (i.ownerUid === user.uid || cleanDisplayName(i.ownerName) === cleanTargetName)
    );
    const foundItems = owned.filter((i) => i.type === 'found');
    const lostItems = owned.filter((i) => i.type === 'lost');

    const reviews: UserReviewRecord[] =
      Array.isArray(user.reviews) && user.reviews.length > 0 ? user.reviews : [];

    const positiveCount = reviews.filter((r) => r.rating === '好评').length;
    const positiveRate =
      reviews.length > 0 ? Math.round((positiveCount / reviews.length) * 100) : 100;
    const creditTierLabel =
      positiveRate >= 95 ? '极好' : positiveRate >= 80 ? '优秀' : '良好';

    return {
      foundItems,
      lostItems,
      reviews,
      positiveRate,
      creditTierLabel,
    };
  }, [user, allItems]);

  // Default to the tab that has published items so the viewer immediately sees the user's posts
  useEffect(() => {
    if (!user) return;
    if (userItemsAndStats.foundItems.length > 0) {
      setActiveTab('found');
    } else if (userItemsAndStats.lostItems.length > 0) {
      setActiveTab('lost');
    } else {
      setActiveTab('found');
    }
  }, [user, userItemsAndStats.foundItems.length, userItemsAndStats.lostItems.length]);

  if (!user) return null;

  const isMe = user.uid === currentUser.uid;
  const nickname = cleanDisplayName(user.displayName);
  const avatarSrc = user.avatarUrl || getFallbackAvatarForUid(user.uid);
  const { foundItems, lostItems, reviews, positiveRate, creditTierLabel } = userItemsAndStats;
  const gridItems = activeTab === 'found' ? foundItems : lostItems;

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-xs flex justify-center overflow-y-auto">
      <div className="w-full max-w-[460px] min-h-screen bg-[#F5F6F8] dark:bg-slate-950 shadow-2xl flex flex-col">
        {/* Warm Orange-Amber Top Cover Header */}
        <div className="bg-gradient-to-br from-[#CA6E1E] via-[#B45B12] to-[#8C4308] text-white px-4 pt-4 pb-9 relative overflow-hidden shrink-0">
          <div className="absolute -right-6 -top-6 w-40 h-40 rounded-full bg-amber-300/15 blur-2xl pointer-events-none" />

          {/* Top Bar: < Back on Left | Read-only badge for other users (Never allow editing other users' profiles) */}
          <div className="flex items-center justify-between mb-4">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-full bg-black/25 hover:bg-black/35 flex items-center gap-1 text-xs font-bold text-white cursor-pointer transition-colors"
              aria-label="返回"
            >
              <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
              <span>返回</span>
            </button>

            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              <UserCheck className="w-3.5 h-3.5 text-amber-300" />
              <span>{isMe ? '我的个人主页' : 'TA的个人主页'}</span>
            </div>
          </div>

          {/* Avatar + Nickname + Stats Row */}
          <div className="flex items-center gap-3.5">
            <img
              src={avatarSrc}
              alt={nickname}
              className="w-[74px] h-[74px] rounded-full object-cover border-2 border-white/85 bg-amber-100 shadow-md shrink-0"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <h1 className="text-[22px] font-black text-white tracking-tight truncate">
                  {nickname}
                </h1>
                {user.role === 'admin' && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-300 text-slate-950 text-[10px] font-extrabold shrink-0">
                    官方老师
                  </span>
                )}
              </div>
              <div className="text-xs text-white/90 flex items-center gap-2.5 font-medium">
                <span>
                  <strong className="font-mono font-black">{foundItems.length}</strong> 次拾物助人
                </span>
                <span>·</span>
                <span>
                  <strong className="font-mono font-black">{lostItems.length}</strong> 次寻物求助
                </span>
                <span>·</span>
                <span>
                  <strong className="font-mono font-black">{reviews.length}</strong> 条评价
                </span>
              </div>
              {user.bio && (
                <p className="text-[11px] text-white/85 line-clamp-2 pt-0.5">{user.bio}</p>
              )}
            </div>
          </div>

          {/* Non-Sensitive Campus Tags Row */}
          <div className="flex flex-wrap items-center gap-1.5 mt-3.5">
            <span className="px-2.5 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              {user.department || '计算机科学与技术学院'}
              {user.className ? ` · ${user.className}` : ''}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              校园实名认证
            </span>
            <span className="px-2.5 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              校园热心互助
            </span>
          </div>

          {/* Reputation / Credit Banner Bar */}
          <div
            onClick={() => setActiveTab('reviews')}
            className="mt-4 px-3.5 py-2.5 rounded-2xl bg-black/20 backdrop-blur-xs flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
              <span className="flex items-center gap-1 font-bold text-white whitespace-nowrap">
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                <span>失主信用 · 极好</span>
              </span>
              <span className="text-white/30">|</span>
              <span className="flex items-center gap-1 font-bold text-white whitespace-nowrap">
                <ThumbsUp className="w-3.5 h-3.5 text-amber-300" />
                <span>
                  拾主信用 · {creditTierLabel} · 好评 {positiveRate}%
                </span>
              </span>
            </div>
            <ChevronRight className="w-4 h-4 text-white/70 shrink-0" />
          </div>
        </div>

        {/* Lower Rounded White Sheet: 捡到的物品 | 在找的物品 | 评价 (Strictly Read-Only for other users' posts) */}
        <div className="bg-white dark:bg-slate-900 rounded-t-[28px] -mt-4 px-4 pt-4 pb-12 flex-1 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2.5">
            <div className="flex items-center gap-6">
              {[
                { key: 'found' as const, label: '捡到的物品', count: foundItems.length },
                { key: 'lost' as const, label: '在找的物品', count: lostItems.length },
                { key: 'reviews' as const, label: '评价', count: reviews.length },
              ].map((t) => {
                const active = activeTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setActiveTab(t.key)}
                    className={`relative pb-1.5 text-[15px] flex items-baseline gap-1 cursor-pointer transition-all ${
                      active
                        ? 'font-black text-slate-950 dark:text-white'
                        : 'font-medium text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    <span>{t.label}</span>
                    <span className="text-xs font-mono">{t.count}</span>
                    {active && (
                      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-1 rounded-full bg-[#FFCC00]" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {activeTab === 'reviews' ? (
            <div className="space-y-3">
              <div className="p-3 rounded-2xl bg-amber-50/70 dark:bg-slate-800 border border-amber-200/60 dark:border-slate-700 flex items-center justify-between text-xs">
                <span className="text-slate-700 dark:text-slate-200 font-semibold">
                  共收到 <strong>{reviews.length}</strong> 条真实互助评价
                </span>
                <span className="font-extrabold text-[#FF5000] font-mono">
                  真实好评率 {positiveRate}%
                </span>
              </div>

              {reviews.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">暂无互助评价记录</div>
              ) : (
                reviews.map((rev) => (
                  <div
                    key={rev.id}
                    className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-100 dark:border-slate-800 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-orange-100 dark:bg-orange-950 text-[#FF5000] font-bold text-xs flex items-center justify-center">
                          {rev.reviewerName.slice(0, 1)}
                        </div>
                        <span className="text-xs font-bold text-slate-900 dark:text-white">
                          {rev.reviewerName}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-amber-100/80 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 text-[10px] font-bold">
                          {rev.roleTag}
                        </span>
                      </div>
                      <span
                        className={`text-[11px] font-bold flex items-center gap-0.5 ${
                          rev.rating === '好评'
                            ? 'text-[#FF5000]'
                            : rev.rating === '中评'
                            ? 'text-amber-600'
                            : 'text-slate-500'
                        }`}
                      >
                        <Star className="w-3.5 h-3.5 fill-current" />
                        <span>{rev.rating}</span>
                      </span>
                    </div>

                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                      {rev.content}
                    </p>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-200/50 dark:border-slate-700/50">
                      <span className="truncate">关联物品：{rev.itemTitle}</span>
                      <span className="font-mono shrink-0">{rev.createdAt.slice(0, 10)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : gridItems.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <div className="text-sm font-bold text-slate-400">暂无相关发布记录</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {gridItems.map((item) => (
                <div
                  key={item.id}
                  onClick={() => onOpenItemDetail(item)}
                  className="bg-slate-50/80 dark:bg-slate-800/80 rounded-2xl overflow-hidden border border-slate-200/70 dark:border-slate-700 flex flex-col justify-between cursor-pointer hover:border-orange-300 transition-all"
                >
                  <div>
                    <div className="relative">
                      <ResilientItemImage
                        src={item.imageUrl}
                        alt={item.title}
                        category={item.campusCategory}
                        className="w-full h-36 object-cover"
                      />
                      <span
                        className={`absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-bold text-white ${
                          item.type === 'lost' ? 'bg-[#FF5000]' : 'bg-[#0066CC]'
                        }`}
                      >
                        {item.type === 'lost' ? '在找' : '拾获'}
                      </span>
                    </div>
                    <div className="p-2.5 space-y-1">
                      <h3 className="text-xs font-bold text-slate-900 dark:text-white line-clamp-2 leading-snug">
                        {item.title}
                      </h3>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 truncate">
                        <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="truncate">{item.location}</span>
                      </div>
                    </div>
                  </div>

                  {/* Read-only footer: no edit or delist buttons */}
                  <div className="px-2.5 py-2 border-t border-slate-200/60 dark:border-slate-700 flex items-center justify-between text-[11px]">
                    {item.type === 'lost' && (item.rewardAmount || 0) > 0 ? (
                      <span className="font-extrabold text-[#FF5000] font-mono">
                        悬赏 ¥{item.rewardAmount}
                      </span>
                    ) : (
                      <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                        {item.type === 'found' ? '拾物招领' : '寻物启事'}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-400 font-mono">
                      {item.eventTime.slice(5, 10)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
