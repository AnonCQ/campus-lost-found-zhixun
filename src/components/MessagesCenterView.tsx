/**
 * Tab 2: Messages Center (消息中心 — 参考滴滴 App 消息中心 UI)
 * - Top header: "消息中心" + clear unread icon + settings icon
 * - Warm notification reminder strip ("为避免错过重要通知，请点击开启消息提醒 [去开启]")
 * - 4 Category Cards: 对话 | 匹配提醒 | 悬赏通知 | 服务提醒
 * - High-score Match System Notifications (Requirement 6):
 *   When a Lost/Found post has a high match score with an opposite post, displays a system notification
 *   in the message list and attaches the matched post card inside the notification detail view.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageCircle,
  Send,
  ChevronLeft,
  MapPin,
  Sparkles,
  CheckCircle2,
  ArrowUpRight,
  Bell,
  Wallet,
  ShieldAlert,
  Settings,
  X,
  CheckCheck,
  ThumbsUp,
  Ban,
} from 'lucide-react';
import {
  DEFAULT_MATCHING_CONFIG,
  LostFoundItem,
  MatchRecord,
  MessageRecord,
  UserProfile,
} from '../types/models';
import {
  markNotificationsReadInFirestore,
  sendInSiteMessage,
  updateMatchStatusWithFeedback,
  updateUserPushNotifyPreference,
} from '../services/firestoreService';
import { ResilientItemImage } from './QrCodeSvg';
import {
  ActiveThreadTarget,
  cleanDisplayName,
  getCounterpartyUidForMessage,
  isStrictTwoPartyMessage,
  resolveConversationCounterparty,
  resolveUserProfile,
} from './PublicUserProfileModal';

interface MessagesCenterViewProps {
  items: LostFoundItem[];
  matches: MatchRecord[];
  messages: MessageRecord[];
  users: UserProfile[];
  currentUser: UserProfile;
  onUpdateCurrentUser?: (updated: UserProfile) => void;
  selectedThread: ActiveThreadTarget | null;
  onSelectThread: (target: ActiveThreadTarget | null) => void;
  onOpenItemDetail: (item: LostFoundItem) => void;
  onOpenUserProfile: (user: UserProfile) => void;
  onDataMutated: () => Promise<void>;
}

const QUICK_REPLIES = [
  '您好，请问这件物品还在吗？特征和我的完全一致！',
  '请问今天方便在图书馆一楼服务台当面交接吗？',
  '我已提交认领信息，麻烦您查看确认一下，非常感谢！',
  '好的，我大约15分钟后到约定地点，辛苦您了！',
];

interface SystemMatchAlert {
  id: string;
  match: MatchRecord;
  myItem: LostFoundItem;
  matchedItem: LostFoundItem;
  ownerSide: 'lost' | 'found';
  createdAt: string;
}

interface ConversationThread {
  threadKey: string;
  itemId: string;
  counterpartyUid: string;
  participantUids: [string, string];
  item?: LostFoundItem;
  messages: MessageRecord[];
  lastMessage: MessageRecord;
}

export const MessagesCenterView: React.FC<MessagesCenterViewProps> = ({
  items,
  matches,
  messages,
  users,
  currentUser,
  onUpdateCurrentUser,
  selectedThread,
  onSelectThread,
  onOpenItemDetail,
  onOpenUserProfile,
  onDataMutated,
}) => {
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [activeCategory, setActiveCategory] = useState<
    'all' | 'chat' | 'match_alert' | 'bounty' | 'service'
  >('all');
  const [showNotifyBanner, setShowNotifyBanner] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(
    currentUser.pushNotifyEnabled !== false
  );
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(currentUser.readNotificationIds || [])
  );
  const [selectedMatchAlert, setSelectedMatchAlert] = useState<SystemMatchAlert | null>(null);
  const [submittingMatchFeedback, setSubmittingMatchFeedback] = useState<
    'confirm' | 'exclude' | null
  >(null);
  const [isSafetySheetOpen, setIsSafetySheetOpen] = useState(false);

  useEffect(() => {
    setReadIds(new Set(currentUser.readNotificationIds || []));
  }, [currentUser.uid, currentUser.readNotificationIds]);

  useEffect(() => {
    setNotifyEnabled(currentUser.pushNotifyEnabled !== false);
  }, [currentUser.uid, currentUser.pushNotifyEnabled]);

  const handleTogglePushNotify = async (nextVal: boolean) => {
    setNotifyEnabled(nextVal);
    try {
      const updatedUser = await updateUserPushNotifyPreference(currentUser, nextVal);
      onUpdateCurrentUser?.(updatedUser);
    } catch {
      // Ignore transient write error
    }
  };

  const handleMatchFeedbackAction = async (
    alert: SystemMatchAlert,
    action: 'confirm' | 'exclude'
  ) => {
    setSubmittingMatchFeedback(action);
    try {
      await updateMatchStatusWithFeedback(
        alert.match,
        action,
        action === 'confirm' ? '用户确认智能匹配线索高度吻合' : '用户核对后排除误报（非同一物品）',
        currentUser
      );
      await onDataMutated();
      if (action === 'exclude') {
        setSelectedMatchAlert(null);
      } else {
        setSelectedMatchAlert({
          ...alert,
          match: { ...alert.match, status: 'confirmed' },
        });
      }
    } finally {
      setSubmittingMatchFeedback(null);
    }
  };

  const persistReadNotifications = async (idsToAdd: string[]) => {
    const clean = idsToAdd.filter(Boolean);
    if (clean.length === 0) return;
    setReadIds((prev) => {
      const next = new Set(prev);
      clean.forEach((id) => next.add(id));
      return next;
    });
    const updatedUser = await markNotificationsReadInFirestore(currentUser, clean);
    onUpdateCurrentUser?.(updatedUser);
  };

  const itemById = useMemo(() => {
    const map = new Map<string, LostFoundItem>();
    for (const it of items) {
      map.set(it.id, it);
    }
    return map;
  }, [items]);

  // Build High-Score System Match Notifications (Requirement 6 + [B1] + [P0-4]: strict >= 58.0 threshold & exclude returned/delisted items)
  const systemMatchAlerts = useMemo<SystemMatchAlert[]>(() => {
    const alerts: SystemMatchAlert[] = [];
    const curEmail = currentUser.email.toLowerCase();
    for (const m of matches) {
      if (m.status === 'excluded' || m.totalScore < DEFAULT_MATCHING_CONFIG.decisionThreshold) {
        continue;
      }
      const lostItem = itemById.get(m.lostItemId);
      const foundItem = itemById.get(m.foundItemId);
      if (!lostItem || !foundItem) continue;
      if (
        lostItem.status === 'delisted' ||
        lostItem.status === 'returned' ||
        foundItem.status === 'delisted' ||
        foundItem.status === 'returned'
      ) {
        continue;
      }

      // G1: Strict ownership filter — only include match alerts where currentUser owns lostItem or foundItem
      const isLostMine =
        lostItem.ownerUid === currentUser.uid ||
        (Boolean(curEmail) && lostItem.ownerEmail?.toLowerCase() === curEmail);
      const isFoundMine =
        foundItem.ownerUid === currentUser.uid ||
        (Boolean(curEmail) && foundItem.ownerEmail?.toLowerCase() === curEmail);
      if (!isLostMine && !isFoundMine) continue;

      const ownerSide: 'lost' | 'found' = isLostMine ? 'lost' : 'found';
      const myItem = ownerSide === 'lost' ? lostItem : foundItem;
      const matchedItem = ownerSide === 'lost' ? foundItem : lostItem;

      alerts.push({
        id: `sys_match_${m.id}`,
        match: m,
        myItem,
        matchedItem,
        ownerSide,
        createdAt: m.updatedAt || m.createdAt,
      });
    }
    return alerts.sort((a, b) => b.match.totalScore - a.match.totalScore);
  }, [matches, itemById, currentUser.uid, currentUser.email]);

  // Round 13: Split current user's match alerts into 失物匹配 (currentUser owns lostItem) and 拾物匹配 (currentUser owns foundItem)
  const lostMatchAlerts = useMemo<SystemMatchAlert[]>(
    () => systemMatchAlerts.filter((a) => a.ownerSide === 'lost'),
    [systemMatchAlerts]
  );

  const foundMatchAlerts = useMemo<SystemMatchAlert[]>(
    () => systemMatchAlerts.filter((a) => a.ownerSide === 'found'),
    [systemMatchAlerts]
  );

  useEffect(() => {
    setSelectedMatchAlert(null);
    setIsSafetySheetOpen(false);
  }, [currentUser.uid]);

  // Chronologically sorted messages per itemId for deterministic 2-participant resolution
  const messagesByItemId = useMemo(() => {
    const map = new Map<string, MessageRecord[]>();
    const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const msg of sorted) {
      const list = map.get(msg.itemId);
      if (list) {
        list.push(msg);
      } else {
        map.set(msg.itemId, [msg]);
      }
    }
    return map;
  }, [messages]);

  // Group 1-to-1 conversations strictly where currentUser.uid is one of the two participants
  const threads = useMemo<ConversationThread[]>(() => {
    const grouped = new Map<string, ConversationThread>();
    const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const msg of sorted) {
      const item = itemById.get(msg.itemId);
      const itemMsgs = messagesByItemId.get(msg.itemId) || [];
      const counterpartyUid = getCounterpartyUidForMessage(
        msg,
        currentUser.uid,
        itemMsgs,
        item
      );

      // Strict participation filter: exclude any message where currentUser is NOT a participant
      if (!counterpartyUid || counterpartyUid === currentUser.uid) {
        continue;
      }

      const threadKey = `${msg.itemId}::${counterpartyUid}`;
      const existing = grouped.get(threadKey);
      if (!existing) {
        grouped.set(threadKey, {
          threadKey,
          itemId: msg.itemId,
          counterpartyUid,
          participantUids: [currentUser.uid, counterpartyUid],
          item,
          messages: [msg],
          lastMessage: msg,
        });
      } else {
        existing.messages.push(msg);
        existing.lastMessage = msg;
      }
    }

    return Array.from(grouped.values()).sort((a, b) =>
      b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt)
    );
  }, [messages, itemById, messagesByItemId, currentUser.uid]);

  // Strict participation & viewer-identity render gate for opening a 1-to-1 conversation screen
  const activeThread = useMemo<ConversationThread | null>(() => {
    if (!selectedThread) return null;

    // Gate 1: Account-switch hygiene — thread must have been opened by the currently signed-in user
    if (selectedThread.viewerUid !== currentUser.uid) return null;

    // Gate 2: Distinct valid counterparty
    const counterpartyUid = selectedThread.counterpartyUid?.trim();
    if (!counterpartyUid || counterpartyUid === currentUser.uid) return null;

    const threadKey = `${selectedThread.itemId}::${counterpartyUid}`;
    const existing = threads.find((t) => t.threadKey === threadKey);
    if (existing) {
      // Double-check participation invariant
      if (!existing.participantUids.includes(currentUser.uid)) return null;
      return existing;
    }

    // Gate 3: Initiating a brand-new 1-to-1 conversation is allowed ONLY with:
    // (a) the owner of the target post (when owner !== currentUser), or
    // (b) official campus service desk ('admin_support' with 'admin_shx614519')
    const targetItem = itemById.get(selectedThread.itemId);
    const isAuthorizedServiceChat =
      selectedThread.itemId === 'admin_support' &&
      counterpartyUid === 'admin_shx614519' &&
      currentUser.uid !== 'admin_shx614519';
    const isAuthorizedPostOwnerChat =
      Boolean(targetItem) &&
      targetItem!.ownerUid === counterpartyUid &&
      targetItem!.ownerUid !== currentUser.uid;

    if (!isAuthorizedServiceChat && !isAuthorizedPostOwnerChat) {
      return null;
    }

    const itemMsgs = messagesByItemId.get(selectedThread.itemId) || [];
    const strictPairMsgs = itemMsgs.filter((m) =>
      isStrictTwoPartyMessage(m, currentUser.uid, counterpartyUid, itemMsgs, targetItem)
    );

    const peerProfile = resolveUserProfile(
      counterpartyUid,
      targetItem?.ownerName,
      users
    );

    return {
      threadKey,
      itemId: selectedThread.itemId,
      counterpartyUid,
      participantUids: [currentUser.uid, counterpartyUid],
      item: targetItem,
      messages: strictPairMsgs,
      lastMessage:
        strictPairMsgs[strictPairMsgs.length - 1] || {
          id: 'empty',
          itemId: selectedThread.itemId,
          itemTitle: targetItem?.title || '官方服务咨询',
          senderUid: counterpartyUid,
          senderName: peerProfile.displayName,
          receiverUid: currentUser.uid,
          content: '暂无私信记录，发送第一条消息开始沟通吧',
          createdAt: targetItem?.createdAt || new Date().toISOString(),
        },
    };
  }, [selectedThread, currentUser.uid, threads, itemById, messagesByItemId, users]);

  // Scrub any stale or unauthorized selectedThread back to null so leftover UI state cannot persist
  useEffect(() => {
    if (selectedThread && !activeThread) {
      onSelectThread(null);
    }
  }, [selectedThread, activeThread, onSelectThread]);

  // Automatically mark an active open conversation as read
  useEffect(() => {
    if (activeThread && activeThread.lastMessage.id !== 'empty') {
      const key = `chat_${activeThread.threadKey}::${activeThread.lastMessage.id}`;
      if (!readIds.has(key)) {
        void persistReadNotifications([key]);
      }
    }
  }, [activeThread?.threadKey, activeThread?.lastMessage.id]);

  const unreadMatchAlertCount = useMemo(
    () => (notifyEnabled ? systemMatchAlerts.filter((a) => !readIds.has(a.id)).length : 0),
    [systemMatchAlerts, readIds, notifyEnabled]
  );

  // [P1-4] Messages sent by currentUser themselves never count as unread
  const unreadThreadCount = useMemo(
    () =>
      notifyEnabled
        ? threads.filter(
            (t) =>
              t.lastMessage.senderUid !== currentUser.uid &&
              !readIds.has(`chat_${t.threadKey}::${t.lastMessage.id}`)
          ).length
        : 0,
    [threads, readIds, currentUser.uid, notifyEnabled]
  );

  const totalUnreadCount = notifyEnabled ? unreadMatchAlertCount + unreadThreadCount : 0;

  const markAllAsRead = () => {
    const idsToMark: string[] = ['sys_service_safety'];
    systemMatchAlerts.forEach((a) => idsToMark.push(a.id));
    threads.forEach((t) => idsToMark.push(`chat_${t.threadKey}::${t.lastMessage.id}`));
    void persistReadNotifications(idsToMark);
  };

  const handleSend = async (customContent?: string) => {
    if (!activeThread || !activeThread.participantUids.includes(currentUser.uid)) return;
    const text = (customContent ?? replyText).trim();
    if (!text) return;

    setSending(true);
    try {
      const targetItem = activeThread.item;
      const receiverUid = activeThread.counterpartyUid;
      if (!receiverUid || receiverUid === currentUser.uid) return;

      const sentMsg = await sendInSiteMessage({
        itemId: activeThread.itemId,
        itemTitle:
          targetItem?.title ||
          (activeThread.itemId === 'admin_support' ? '联系失物招领服务台' : '物品沟通私信'),
        content: text,
        actor: currentUser,
        receiverUid,
      });
      void persistReadNotifications([`chat_${activeThread.threadKey}::${sentMsg.id}`]);
      if (!customContent) setReplyText('');
      await onDataMutated();
    } finally {
      setSending(false);
    }
  };

  // ==================== VIEW 1: SYSTEM MATCH NOTIFICATION DETAIL (附带高分匹配原帖) ====================
  if (selectedMatchAlert) {
    const { match, myItem, matchedItem } = selectedMatchAlert;
    return (
      <div className="flex flex-col h-full min-h-[76vh] bg-[#F5F6F8] -mx-3.5 -mt-3 pb-6">
        {/* Top Bar */}
        <div className="px-4 py-3.5 bg-white border-b border-slate-100 flex items-center justify-between sticky top-0 z-10">
          <button
            type="button"
            onClick={() => setSelectedMatchAlert(null)}
            className="min-h-[38px] px-2 rounded-xl hover:bg-slate-100 flex items-center gap-1 text-xs font-bold text-slate-800 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>返回消息中心</span>
          </button>
          <div className="text-sm font-extrabold text-slate-900">智能匹配提醒</div>
          <div className="w-16" />
        </div>

        <div className="p-4 space-y-4">
          {/* Timestamp pill */}
          <div className="text-center">
            <span className="px-3 py-1 rounded-full bg-slate-200/70 text-[11px] text-slate-500 font-mono">
              {selectedMatchAlert.createdAt.slice(5, 16).replace('T', ' ')}
            </span>
          </div>

          {/* System Notification Bubble + Attached Matched Post Card */}
          <div className="bg-white rounded-3xl p-4 shadow-xs border border-slate-200/70 space-y-3.5">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#FF6B2C] to-[#FF3D00] text-white flex items-center justify-center shrink-0 shadow-xs">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-extrabold text-slate-900">
                  系统发现高匹配度{matchedItem.type === 'found' ? '拾物帖' : '失物帖'}
                </div>
                <div className="text-[11px] text-emerald-600 font-semibold">
                  匹配得分：{match.totalScore.toFixed(0)}% · 建议尽快核对
                </div>
              </div>
            </div>

            <p className="text-xs text-slate-700 leading-relaxed bg-orange-50/60 p-3 rounded-2xl border border-orange-100">
              系统检测到有同学新发布的
              <strong>
                {matchedItem.type === 'found' ? '拾物招领' : '失物求助'}《{matchedItem.title}》
              </strong>
              与您发布的
              <strong>
                {myItem.type === 'lost' ? '失物' : '拾物'}《{myItem.title}》
              </strong>
              特征高度吻合，已为您附上该帖子：
            </p>

            {/* Attached Matched Post Card (附上该帖子) */}
            <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-50/70">
              <div className="relative">
                <ResilientItemImage
                  src={matchedItem.imageUrl}
                  alt={matchedItem.title}
                  category={matchedItem.campusCategory}
                  className="w-full h-44 object-cover"
                />
                <span
                  className={`absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[10px] font-bold text-white shadow-xs ${
                    matchedItem.type === 'lost' ? 'bg-[#FF5000]' : 'bg-[#0066CC]'
                  }`}
                >
                  {matchedItem.type === 'lost' ? '对方失物帖' : '对方拾物帖'}
                </span>
                <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-slate-900/80 text-white text-[10px] font-bold">
                  匹配度 {match.totalScore.toFixed(0)}%
                </span>
              </div>

              <div className="p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-900 line-clamp-1">
                    {matchedItem.title}
                  </h3>
                  {matchedItem.type === 'lost' && (matchedItem.rewardAmount || 0) > 0 && (
                    <span className="text-xs font-extrabold text-[#FF5000] shrink-0">
                      悬赏 ¥{matchedItem.rewardAmount}
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                  {matchedItem.description}
                </p>

                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-200/70">
                  <span className="flex items-center gap-1 truncate">
                    <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                    <span className="truncate">{matchedItem.location}</span>
                  </span>
                  <span className="font-mono shrink-0">
                    {matchedItem.eventTime.slice(5, 16).replace('T', ' ')}
                  </span>
                </div>

                {/* Action buttons on the attached post */}
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMatchAlert(null);
                      onOpenItemDetail(matchedItem);
                    }}
                    className="py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-800 border border-slate-200 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <span>查看帖子详情</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMatchAlert(null);
                      if (matchedItem.ownerUid && matchedItem.ownerUid !== currentUser.uid) {
                        onSelectThread({
                          viewerUid: currentUser.uid,
                          itemId: matchedItem.id,
                          counterpartyUid: matchedItem.ownerUid,
                        });
                      } else {
                        onSelectThread(null);
                      }
                    }}
                    className="py-2 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center justify-center gap-1 cursor-pointer shadow-2xs"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>联系发布者</span>
                  </button>
                </div>
              </div>
            </div>

            {/* [P2-1] Match Feedback Loop: Confirm Accurate Match or Exclude False Positive */}
            <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2">
              <div className="flex items-center justify-between text-[11px] text-slate-600">
                <span className="font-bold text-slate-800">智能匹配准确度反馈</span>
                {match.status === 'confirmed' && (
                  <span className="text-emerald-600 font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>已标记为吻合线索</span>
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={submittingMatchFeedback !== null || match.status === 'confirmed'}
                  onClick={() => handleMatchFeedbackAction(selectedMatchAlert, 'confirm')}
                  className="py-2 px-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-60"
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                  <span>
                    {match.status === 'confirmed'
                      ? '已确认吻合'
                      : submittingMatchFeedback === 'confirm'
                      ? '记录中...'
                      : '标记线索吻合'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={submittingMatchFeedback !== null}
                  onClick={() => handleMatchFeedbackAction(selectedMatchAlert, 'exclude')}
                  className="py-2 px-2.5 rounded-xl bg-white hover:bg-red-50 text-slate-600 hover:text-red-600 border border-slate-200 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-60"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>
                    {submittingMatchFeedback === 'exclude' ? '移除中...' : '排除误报（非同一件）'}
                  </span>
                </button>
              </div>
            </div>

            {/* Your own item reference */}
            <div className="p-2.5 rounded-xl bg-slate-100/80 flex items-center justify-between text-[11px] text-slate-600">
              <span className="truncate">关联您的帖子：《{myItem.title}》</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedMatchAlert(null);
                  onOpenItemDetail(myItem);
                }}
                className="text-[#0066CC] font-semibold shrink-0 ml-2 cursor-pointer"
              >
                查看我的帖 &gt;
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==================== VIEW 2: PRIVATE CHAT CONVERSATION ====================
  if (activeThread && activeThread.participantUids.includes(currentUser.uid)) {
    const item = activeThread.item;
    const counterparty = resolveConversationCounterparty({
      messages: activeThread.messages,
      item,
      currentUser,
      users,
      counterpartyUid: activeThread.counterpartyUid,
    });
    const counterpartyName = cleanDisplayName(counterparty.displayName);

    return (
      <div className="flex flex-col h-full min-h-[75vh] bg-white -mx-3.5 -mt-3">
        {/* Conversation Top Header: Displays Counterparty Avatar + Nickname (Click to view Public Profile) */}
        <div className="px-4 py-3 bg-white border-b border-slate-100 flex items-center justify-between gap-2 sticky top-0 z-10">
          <button
            type="button"
            onClick={() => onSelectThread(null)}
            className="min-h-[38px] px-2 rounded-xl hover:bg-slate-100 flex items-center gap-1 text-xs font-bold text-slate-700 cursor-pointer shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>返回</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenUserProfile(counterparty)}
            title={`查看 ${counterpartyName} 的个人主页`}
            className="min-w-0 flex-1 flex items-center justify-center gap-2.5 py-1 px-2 rounded-2xl hover:bg-slate-50 transition-colors cursor-pointer group"
          >
            <img
              src={counterparty.avatarUrl}
              alt={counterpartyName}
              className="w-9 h-9 rounded-full object-cover border border-slate-200 bg-amber-50 shrink-0 group-hover:ring-2 group-hover:ring-[#FF6B2C]/40 transition-all"
            />
            <div className="text-left min-w-0">
              <div className="text-sm font-bold text-slate-900 truncate group-hover:text-[#FF6B2C] transition-colors">
                {counterpartyName}
              </div>
              <div className="text-[10px] text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 shrink-0" />
                <span>校园实名认证 · 查看主页</span>
              </div>
            </div>
          </button>

          {item && (
            <button
              type="button"
              onClick={() => onOpenItemDetail(item)}
              className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200/80 text-[11px] font-semibold text-slate-700 flex items-center gap-1 cursor-pointer shrink-0"
            >
              <span>查看帖子</span>
              <ArrowUpRight className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Linked Item Banner Card */}
        {item && (
          <div
            onClick={() => onOpenItemDetail(item)}
            className="mx-3 mt-2.5 p-2.5 rounded-2xl bg-slate-50 border border-slate-200/80 flex items-center gap-3 cursor-pointer"
          >
            <ResilientItemImage
              src={item.imageUrl}
              alt={item.title}
              category={item.campusCategory}
              className="w-12 h-12 rounded-xl object-cover shrink-0 border border-slate-200"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    item.type === 'lost'
                      ? 'bg-orange-100 text-[#FF5000]'
                      : 'bg-blue-100 text-[#0066CC]'
                  }`}
                >
                  {item.type === 'lost' ? '失物' : '拾物'}
                </span>
                {item.type === 'lost' && (item.rewardAmount || 0) > 0 && (
                  <span className="text-xs font-extrabold text-[#FF5000]">
                    悬赏 ¥{item.rewardAmount}
                  </span>
                )}
              </div>
              <div className="text-xs font-semibold text-slate-900 truncate mt-0.5">
                {item.title}
              </div>
              <div className="text-[11px] text-slate-500 flex items-center gap-1 truncate">
                <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="truncate">{item.location}</span>
              </div>
            </div>
          </div>
        )}

        {/* Messages Scroll Area */}
        <div className="flex-1 p-4 space-y-3 overflow-y-auto max-h-[48vh]">
          {activeThread.messages.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <MessageCircle className="w-8 h-8 text-slate-300 mx-auto" />
              <div className="text-xs font-medium text-slate-600">暂无对话消息</div>
              <div className="text-[11px] text-slate-400">
                点击下方快捷短语或输入文字即可联系 {counterpartyName}
              </div>
            </div>
          ) : (
            activeThread.messages.map((msg) => {
              const isMe = msg.senderUid === currentUser.uid;
              const senderProfile = isMe
                ? resolveUserProfile(currentUser.uid, currentUser.displayName, users)
                : resolveUserProfile(msg.senderUid, msg.senderName, users);
              const senderDisplayName = cleanDisplayName(msg.senderName || senderProfile.displayName);

              return (
                <div
                  key={msg.id}
                  className={`flex items-start gap-2.5 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  <button
                    type="button"
                    onClick={() => onOpenUserProfile(senderProfile)}
                    title={`查看 ${senderDisplayName} 的个人主页`}
                    className="shrink-0 mt-0.5 cursor-pointer group"
                  >
                    <img
                      src={senderProfile.avatarUrl}
                      alt={senderDisplayName}
                      className="w-8 h-8 rounded-full object-cover border border-slate-200 bg-amber-50 group-hover:ring-2 group-hover:ring-[#FF6B2C]/40 transition-all"
                    />
                  </button>

                  <div className={`flex flex-col max-w-[78%] ${isMe ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-1.5 mb-1 px-1">
                      <button
                        type="button"
                        onClick={() => onOpenUserProfile(senderProfile)}
                        className="text-[11px] font-medium text-slate-600 hover:text-[#FF6B2C] cursor-pointer"
                      >
                        {senderDisplayName}
                      </button>
                      <span className="text-[10px] font-mono text-slate-400">
                        {msg.createdAt.slice(5, 16).replace('T', ' ')}
                      </span>
                    </div>
                    <div
                      className={`px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed ${
                        isMe
                          ? 'bg-[#FF6B2C] text-white rounded-br-xs shadow-xs'
                          : 'bg-slate-100 text-slate-800 rounded-bl-xs border border-slate-200/60'
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Quick Reply Chips & Input */}
        <div className="px-3 pt-2 border-t border-slate-100 bg-slate-50/60">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 no-scrollbar">
            {QUICK_REPLIES.map((qr) => (
              <button
                key={qr}
                type="button"
                disabled={sending}
                onClick={() => handleSend(qr)}
                className="px-2.5 py-1 rounded-full bg-white hover:bg-orange-50 text-[11px] text-slate-700 border border-slate-200/90 whitespace-nowrap cursor-pointer transition-colors shrink-0"
              >
                {qr.slice(0, 16)}...
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-center gap-2 pb-3 pt-1"
          >
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="发消息询问物品细节或约定交接地点..."
              className="flex-1 px-3.5 py-2.5 text-xs bg-white border border-slate-200 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
            />
            <button
              type="submit"
              disabled={sending || !replyText.trim()}
              className="min-h-[40px] px-4 rounded-2xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer transition-colors shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>发送</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ==================== VIEW 3: DIDI-STYLE MESSAGE CENTER HOME (参考上传截图) ====================
  // [M4] Strict category section isolation:
  // - 匹配提醒 ('match_alert') shows ONLY 失物匹配 / 拾物匹配
  // - 服务提醒 ('service') shows ONLY 认领安全提醒 and 失物招领服务台
  // - 对话 ('chat') / 悬赏通知 ('bounty') shows ONLY conversation rows
  // - 全部 ('all') shows all sections
  const showMatchSection =
    activeCategory === 'all' || activeCategory === 'match_alert';
  const showServiceSection =
    activeCategory === 'all' || activeCategory === 'service';
  const showChatSection =
    activeCategory === 'all' || activeCategory === 'chat' || activeCategory === 'bounty';

  const displayedThreads =
    activeCategory === 'bounty'
      ? threads.filter((t) => (t.item?.rewardAmount || 0) > 0)
      : threads;

  return (
    <div className="bg-white min-h-[82vh] -mx-3.5 -mt-3 pb-10">
      {/* 1. DiDi Style Top Title Bar: "消息中心" + Unread Count + Clear Unread & Settings Icons */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900">消息中心</h1>
          {totalUnreadCount > 0 && (
            <span
              data-testid="messages-header-unread-count"
              className="px-2 py-0.5 rounded-full bg-[#FF3B30] text-white text-xs font-bold font-mono"
            >
              {totalUnreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-slate-700">
          <button
            type="button"
            onClick={markAllAsRead}
            title="全部标为已读"
            className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center cursor-pointer transition-colors"
          >
            <CheckCheck className="w-5 h-5 stroke-[1.8]" />
          </button>
          <button
            type="button"
            onClick={() => void handleTogglePushNotify(!notifyEnabled)}
            title="消息通知设置"
            className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center cursor-pointer transition-colors"
          >
            <Settings className="w-5 h-5 stroke-[1.8]" />
          </button>
        </div>
      </div>

      {/* 2. Warm Orange Notification Permission Banner (参考截图) */}
      {showNotifyBanner && (
        <div className="px-4 py-2.5 bg-[#FFF5EE] flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#FF6B2C] truncate">
            {notifyEnabled
              ? '已开启实时消息与匹配提醒，有新线索将第一时间通知您'
              : '为避免错过重要通知，请点击开启消息提醒'}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {!notifyEnabled && (
              <button
                type="button"
                onClick={() => void handleTogglePushNotify(true)}
                className="px-2.5 py-0.5 rounded-full border border-[#FF6B2C]/70 text-[#FF6B2C] text-[11px] font-medium bg-white/80 cursor-pointer"
              >
                去开启
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowNotifyBanner(false)}
              className="text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 3. Four Category Cards in a Row (参考截图：对话 / 匹配提醒 / 悬赏通知 / 服务提醒) */}
      <div className="grid grid-cols-4 gap-2.5 px-4 py-3.5">
        <button
          type="button"
          onClick={() => setActiveCategory((c) => (c === 'chat' ? 'all' : 'chat'))}
          className={`relative rounded-2xl py-3 px-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
            activeCategory === 'chat'
              ? 'bg-blue-50 ring-1 ring-blue-300'
              : 'bg-[#F7F8FA] hover:bg-slate-100/80'
          }`}
        >
          {unreadThreadCount > 0 && (
            <span className="w-2 h-2 rounded-full bg-[#FF3B30] absolute top-1.5 right-1.5" />
          )}
          <span className="text-[13px] font-bold text-[#1677FF]">对话</span>
          <div className="w-8 h-8 rounded-full bg-[#1677FF] text-white flex items-center justify-center shadow-2xs">
            <MessageCircle className="w-4 h-4 fill-current" />
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            setActiveCategory((c) => (c === 'match_alert' ? 'all' : 'match_alert'))
          }
          className={`relative rounded-2xl py-3 px-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
            activeCategory === 'match_alert'
              ? 'bg-orange-50 ring-1 ring-orange-300'
              : 'bg-[#F7F8FA] hover:bg-slate-100/80'
          }`}
        >
          {unreadMatchAlertCount > 0 && (
            <span className="w-2 h-2 rounded-full bg-[#FF3B30] absolute top-1.5 right-1.5" />
          )}
          <span className="text-[13px] font-bold text-[#FF5A36]">匹配提醒</span>
          <div className="w-8 h-8 rounded-full bg-[#FF5A36] text-white flex items-center justify-center shadow-2xs">
            <Sparkles className="w-4 h-4 fill-current" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveCategory((c) => (c === 'bounty' ? 'all' : 'bounty'))}
          className={`relative rounded-2xl py-3 px-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
            activeCategory === 'bounty'
              ? 'bg-teal-50 ring-1 ring-teal-300'
              : 'bg-[#F7F8FA] hover:bg-slate-100/80'
          }`}
        >
          <span className="text-[13px] font-bold text-[#13A8A8]">悬赏通知</span>
          <div className="w-8 h-8 rounded-full bg-[#13A8A8] text-white flex items-center justify-center shadow-2xs">
            <Wallet className="w-4 h-4" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveCategory((c) => (c === 'service' ? 'all' : 'service'))}
          className={`relative rounded-2xl py-3 px-2 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
            activeCategory === 'service'
              ? 'bg-amber-50 ring-1 ring-amber-300'
              : 'bg-[#F7F8FA] hover:bg-slate-100/80'
          }`}
        >
          {!readIds.has('sys_service_safety') && (
            <span className="w-2 h-2 rounded-full bg-[#FF3B30] absolute top-1.5 right-1.5" />
          )}
          <span className="text-[13px] font-bold text-[#FA8C16]">服务提醒</span>
          <div className="w-8 h-8 rounded-full bg-[#FA8C16] text-white flex items-center justify-center shadow-2xs">
            <Bell className="w-4 h-4 fill-current" />
          </div>
        </button>
      </div>

      {/* 4. Unified Message List (DiDi Row Layout: Left Circular Icon + Title & Subtitle + Right Time & Red Pill) */}
      <div className="divide-y divide-slate-100 px-4">
        {/* A. High-Score System Match Notification Rows — Split into 失物匹配 & 拾物匹配 (Round 13) */}
        {showMatchSection && (
          <div className="py-2.5 space-y-3">
            {(
              [
                {
                  key: 'lost' as const,
                  title: '失物匹配',
                  badgeClass: 'bg-orange-50 text-[#FF5000] border-orange-200/80',
                  alerts: lostMatchAlerts,
                },
                {
                  key: 'found' as const,
                  title: '拾物匹配',
                  badgeClass: 'bg-blue-50 text-[#0066CC] border-blue-200/80',
                  alerts: foundMatchAlerts,
                },
              ]
            ).map((group) => (
              <div
                key={group.key}
                data-testid={`match-alert-group-${group.key}`}
                className="rounded-2xl border border-slate-100 bg-slate-50/40 px-3 py-2"
              >
                {/* Group Header + Count */}
                <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-extrabold text-slate-800">{group.title}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${group.badgeClass}`}
                    >
                      {group.alerts.length}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400">
                    {group.key === 'lost' ? '我的失物帖匹配提醒' : '我的拾物帖匹配提醒'}
                  </span>
                </div>

                {/* Group Rows or Empty State (暂无) */}
                {group.alerts.length === 0 ? (
                  <div className="py-3 text-xs text-slate-400 text-center">暂无</div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {group.alerts.map((alert) => {
                      const isRead = readIds.has(alert.id);
                      const unreadCount = isRead ? 0 : 1;
                      return (
                        <div
                          key={alert.id}
                          onClick={() => {
                            void persistReadNotifications([alert.id]);
                            setSelectedMatchAlert(alert);
                          }}
                          className="py-3 flex items-center gap-3.5 hover:bg-slate-50/80 transition-colors cursor-pointer"
                        >
                          {/* Left Circular Icon */}
                          <div className="w-12 h-12 rounded-full bg-[#F3EEFF] flex items-center justify-center shrink-0">
                            <div className="w-7 h-7 rounded-xl bg-[#722ED1] text-white flex items-center justify-center">
                              <Sparkles className="w-4 h-4" />
                            </div>
                          </div>

                          {/* Middle Title + Preview */}
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[15px] font-bold text-slate-900 truncate">
                                智能匹配提醒
                              </span>
                              <span className="text-xs text-slate-400 font-normal shrink-0">
                                {alert.createdAt.slice(11, 16) || '19:35'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[13px] text-slate-500 truncate">
                                发现与您《{alert.myItem.title}》高度匹配的帖子（
                                {alert.match.totalScore.toFixed(0)}
                                %），点击查看该帖
                              </p>
                              {unreadCount > 0 && (
                                <span className="px-1.5 min-w-[20px] h-[18px] rounded-full bg-[#FF3B30] text-white text-[11px] font-bold flex items-center justify-center shrink-0">
                                  {unreadCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* B. Safety / Verification Service Reminder Row ([M3]: opens dedicated safety reminder sheet, never systemMatchAlerts[0]) */}
        {showServiceSection && (
          <div
            data-testid="service-safety-reminder-row"
            onClick={() => {
              void persistReadNotifications(['sys_service_safety']);
              setIsSafetySheetOpen(true);
            }}
            className="py-3.5 flex items-center gap-3.5 hover:bg-slate-50/80 transition-colors cursor-pointer"
          >
            <div className="w-12 h-12 rounded-full bg-[#EBF5FF] flex items-center justify-center shrink-0">
              <div className="w-7 h-7 rounded-xl bg-[#1677FF] text-white flex items-center justify-center">
                <ShieldAlert className="w-4 h-4" />
              </div>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[15px] font-bold text-slate-900">认领安全提醒</span>
                <span className="text-xs text-slate-400">18:56</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] text-slate-500 truncate">
                  当面交接物品建议在图书馆或教学楼服务台进行，核对特征后再归还
                </p>
                {!readIds.has('sys_service_safety') && (
                  <span className="px-1.5 min-w-[20px] h-[18px] rounded-full bg-[#FF3B30] text-white text-[11px] font-bold flex items-center justify-center shrink-0">
                    1
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* C. Private Message Conversation Rows (Participant-Only, Counterparty Avatar + Nickname) */}
        {showChatSection &&
          (activeCategory === 'chat' || activeCategory === 'bounty') &&
          displayedThreads.length === 0 && (
            <div className="py-10 text-center space-y-1.5">
              <MessageCircle className="w-7 h-7 text-slate-300 mx-auto" />
              <div className="text-xs font-semibold text-slate-500">
                {activeCategory === 'bounty' ? '暂无参与的悬赏对话' : '暂无参与的私信对话'}
              </div>
              <p className="text-[11px] text-slate-400">
                在首页帖子详情点击「给发布者发私信」即可发起 1 对 1 沟通
              </p>
            </div>
          )}

        {showChatSection &&
          displayedThreads.map((thread) => {
            const item = thread.item;
            const counterparty = resolveConversationCounterparty({
              messages: thread.messages,
              item,
              currentUser,
              users,
              counterpartyUid: thread.counterpartyUid,
            });
            const counterpartyName = cleanDisplayName(counterparty.displayName);
            const threadReadKey = `chat_${thread.threadKey}::${thread.lastMessage.id}`;
            const isRead =
              thread.lastMessage.senderUid === currentUser.uid || readIds.has(threadReadKey);
            const unreadNum = notifyEnabled && !isRead ? 1 : 0;
            return (
              <div
                key={thread.threadKey}
                onClick={() => {
                  void persistReadNotifications([threadReadKey]);
                  onSelectThread({
                    viewerUid: currentUser.uid,
                    itemId: thread.itemId,
                    counterpartyUid: thread.counterpartyUid,
                  });
                }}
                className="py-3.5 flex items-center gap-3.5 hover:bg-slate-50/80 transition-colors cursor-pointer"
              >
                {/* Left Counterparty Circular Avatar (Click to view Counterparty's Public Profile) */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenUserProfile(counterparty);
                  }}
                  title={`查看 ${counterpartyName} 的个人主页`}
                  className="relative shrink-0 cursor-pointer group"
                >
                  <img
                    src={counterparty.avatarUrl}
                    alt={counterpartyName}
                    className="w-12 h-12 rounded-full object-cover border border-slate-200 bg-amber-50 group-hover:ring-2 group-hover:ring-[#FF6B2C]/40 transition-all"
                  />
                </button>

                {/* Middle Counterparty Nickname + Message Preview */}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[15px] font-bold text-slate-900 truncate">
                        {counterpartyName}
                      </span>
                      <span className="px-1.5 py-0.2 rounded border border-slate-200 text-[10px] text-slate-500 shrink-0">
                        {thread.itemId === 'admin_support'
                          ? '官方服务'
                          : item?.type === 'lost'
                          ? '失物帖'
                          : '拾物帖'}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400 shrink-0">
                      {thread.lastMessage.createdAt.slice(5, 10).replace('-', '/')}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] text-slate-500 truncate">
                      {thread.lastMessage.content}
                    </p>
                    {unreadNum > 0 && (
                      <span className="px-1.5 min-w-[20px] h-[18px] rounded-full bg-[#FF3B30] text-white text-[11px] font-bold flex items-center justify-center shrink-0">
                        {unreadNum}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      {/* Divider & Campus Service Assistant Row ([M4]: only visible under 全部 or 服务提醒) */}
      {showServiceSection && (
        <>
          <div className="px-8 py-5 flex items-center gap-3">
            <div className="h-px bg-slate-100 flex-1" />
            <span className="text-xs text-slate-400">更早的消息</span>
            <div className="h-px bg-slate-100 flex-1" />
          </div>

          <div className="px-4">
            <div
              data-testid="service-desk-assistant-row"
              onClick={() => {
                if (currentUser.uid !== 'admin_shx614519') {
                  onSelectThread({
                    viewerUid: currentUser.uid,
                    itemId: 'admin_support',
                    counterpartyUid: 'admin_shx614519',
                  });
                } else {
                  setActiveCategory('service');
                }
              }}
              className="py-2 flex items-center gap-3.5 hover:bg-slate-50 rounded-2xl transition-colors cursor-pointer"
            >
              <div className="w-12 h-12 rounded-full bg-orange-100 text-[#FF6B2C] flex items-center justify-center font-bold text-sm shrink-0">
                客服
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[15px] font-bold text-slate-900">失物招领服务台</span>
                    <span className="px-1.5 py-0.2 rounded border border-slate-200 text-[10px] text-slate-500">
                      官方
                    </span>
                  </div>
                  <span className="text-xs text-slate-400">11/01</span>
                </div>
                <p className="text-[13px] text-slate-500 truncate">
                  Hi，有任何寻找失物或归还拾物的问题都可以随时留言咨询～
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      {/* [M3] Dedicated Safety Reminder Sheet Modal */}
      {isSafetySheetOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/55 backdrop-blur-xs p-0 sm:p-4">
          <div
            data-testid="safety-reminder-sheet"
            className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-4 border border-slate-100"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-2xl bg-[#EBF5FF] text-[#1677FF] flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">认领安全提醒</h3>
                  <p className="text-[11px] text-slate-500">校园失物招领中心 · 当面交接核验守则</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsSafetySheetOpen(false)}
                className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-700 leading-relaxed">
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/70 space-y-1">
                <div className="font-bold text-slate-900">1. 选择校园公共场所当面交接</div>
                <p className="text-slate-600">
                  建议优先约在图书馆一楼服务台、第一/第二教学楼值班室或大学生活动中心 105 室进行当面交接。
                </p>
              </div>
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/70 space-y-1">
                <div className="font-bold text-slate-900">2. 核对独有特征与 6 位数字交接码</div>
                <p className="text-slate-600">
                  认领申请经审核通过后会自动生成 6 位数字交接码与专属二维码，请持有人当面核验特征无误后再输入交接码完成核销。
                </p>
              </div>
              <div className="p-3 rounded-2xl bg-orange-50/70 border border-orange-200/70 space-y-1">
                <div className="font-bold text-[#FF5000]">3. 悬赏赏金安全结算提醒</div>
                <p className="text-slate-600">
                  悬赏帖的赏金将在持有人或管理员当面核销 6 位交接码后自动转入拾获者钱包，切勿私下提前转账或泄露交接码。
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsSafetySheetOpen(false)}
              className="w-full py-2.5 rounded-2xl bg-[#1677FF] hover:bg-blue-700 text-white text-xs font-extrabold cursor-pointer transition-colors"
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
