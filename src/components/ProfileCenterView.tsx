/**
 * Tab 4: Personal Center & Sub-Pages (我的界面 — 闲鱼风格重构)
 *
 * Implements:
 * 1. Single-row top entry bar (我丢失的 | 我捡到的 | 历史发布 | 历史浏览) — no duplicate second row.
 * 2. Every functional entry (我丢失的, 我捡到的, 历史发布, 历史浏览, 我的钱包, 认领交接, 编辑资料) opens a dedicated sub-page
 *    with a "<" back header rather than displaying inline on the main overview.
 * 3. No edit button on the `我的` main page; profile editing is only accessible inside `个人主页` -> `编辑资料`,
 *    which opens a full-page Xianyu-style `编辑资料` screen with 昵称, 头像, 简介, 院校班级, 生日, 电话号码, 邮箱.
 * 4. Dynamic positive review rate (`好评率`) calculated in real time from the user's actual reviews.
 * 5. Strict per-user item ownership (`item.ownerUid === currentUser.uid`) across multiple real user accounts.
 */

import React, { useMemo, useState } from 'react';
import {
  Edit3,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  EyeOff,
  QrCode,
  X,
  Check,
  Send,
  MapPin,
  Upload,
  UserCheck,
  Headphones,
  Settings,
  Moon,
  Sun,
  Clock,
  Trash2,
  Bell,
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  ThumbsUp,
  Star,
  Sparkles,
  LogOut,
  BarChart3,
} from 'lucide-react';
import { signOutFirebase } from '../lib/firebase';
import {
  CAMPUS_CATEGORIES,
  CAMPUS_LOCATION_AREAS,
  CampusCategory,
  CampusLocationArea,
  ClaimRecord,
  ItemStatus,
  LostFoundItem,
  MatchRecord,
  MessageRecord,
  RecognitionTask,
  UserProfile,
  UserReviewRecord,
  WalletTransaction,
} from '../types/models';
import {
  clearUserBrowsingHistory,
  markNotificationsReadInFirestore,
  sendInSiteMessage,
  toggleUserItemListingStatus,
  updateUserItemInFirestore,
  updateUserProfileInFirestore,
  updateUserPushNotifyPreference,
} from '../services/firestoreService';
import { ResilientItemImage } from './QrCodeSvg';
import { ClaimsAndMessagesView } from './ClaimsAndMessagesView';
import { AnalyticsDashboardView } from './AnalyticsDashboardView';
import {
  cleanDisplayName,
  getCounterpartyUidForMessage,
  isStrictTwoPartyMessage,
  isUserParticipantInMessage,
  resolveConversationCounterparty,
  resolveUserProfile,
} from './PublicUserProfileModal';

interface ProfileCenterViewProps {
  currentUser: UserProfile;
  users: UserProfile[];
  onUpdateCurrentUser: (updated: UserProfile) => void;
  onOpenAuthModal: () => void;
  onLogout: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: (nextDark: boolean) => void;
  onOpenItemDetail: (item: LostFoundItem) => void;
  onOpenUserProfile: (user: UserProfile) => void;
  allItems: LostFoundItem[];
  activeItems: LostFoundItem[];
  tasks?: RecognitionTask[];
  matches: MatchRecord[];
  claims: ClaimRecord[];
  messages: MessageRecord[];
  onDataMutated: () => Promise<void>;
}

const AVATAR_PRESETS = [
  'https://api.dicebear.com/7.x/adventurer/svg?seed=CampusLi&backgroundColor=ffdfbf',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=StudentChen&backgroundColor=ffd5dc',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=StudentWang&backgroundColor=c0aede',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=StudentLin&backgroundColor=d1d4f9',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=CampusAdmin&backgroundColor=b6e3f4',
];

const STATUS_BADGE_MAP: Record<ItemStatus, { label: string; cls: string }> = {
  open: {
    label: '寻找中',
    cls: 'bg-blue-50 text-[#0066CC] border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800',
  },
  matching: {
    label: '匹配中',
    cls: 'bg-orange-50 text-[#FF5000] border-orange-200 dark:bg-orange-950/60 dark:text-orange-300 dark:border-orange-800',
  },
  claiming: {
    label: '认领中',
    cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
  },
  handover: {
    label: '待交接',
    cls: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800',
  },
  returned: {
    label: '已归还',
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
  },
  delisted: {
    label: '已下架',
    cls: 'bg-slate-100 text-slate-500 border-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  },
};

const DEFAULT_WALLET_TRANSACTIONS: WalletTransaction[] = [
  {
    id: 'tx_default_1',
    title: '拾获归还《银色 14寸 MacBook Pro》领取赏金',
    type: 'income',
    amount: 50,
    itemId: 'demo_lost_01',
    counterpartyName: '陈思琪',
    createdAt: '2026-11-08T19:30:00.000Z',
  },
  {
    id: 'tx_default_2',
    title: '拾获归还《米白色帆布手提袋》领取赏金',
    type: 'income',
    amount: 15,
    itemId: 'demo_lost_05',
    counterpartyName: '林晓雯',
    createdAt: '2026-11-07T20:15:00.000Z',
  },
  {
    id: 'tx_default_3',
    title: '发布寻物《蓝色挂绳校园一卡通》支付悬赏金',
    type: 'expense',
    amount: 10,
    itemId: 'demo_lost_03',
    counterpartyName: '悬赏支付',
    createdAt: '2026-11-06T14:10:00.000Z',
  },
  {
    id: 'tx_default_4',
    title: '拾获归还《白色 AirPods Pro 耳机》领取赏金',
    type: 'income',
    amount: 30,
    itemId: 'demo_lost_02',
    counterpartyName: '王浩然',
    createdAt: '2026-11-05T11:40:00.000Z',
  },
];

const DEFAULT_USER_REVIEWS: UserReviewRecord[] = [
  {
    id: 'rev_default_1',
    reviewerName: '陈思琪',
    roleTag: '失主评价',
    rating: '好评',
    content: '同学人超级好！在图书馆捡到我的电脑后第一时间发帖联系，当面交接非常顺利，感谢！',
    itemTitle: '银色 14寸 MacBook Pro 笔记本电脑',
    createdAt: '2026-11-08T19:35:00.000Z',
  },
  {
    id: 'rev_default_2',
    reviewerName: '林晓雯',
    roleTag: '失主评价',
    rating: '好评',
    content: '帆布袋里的微积分课本和笔记都在，帮了大忙，拾金不昧好同学！',
    itemTitle: '米白色帆布手提袋',
    createdAt: '2026-11-07T20:20:00.000Z',
  },
  {
    id: 'rev_default_3',
    reviewerName: '王浩然',
    roleTag: '拾主评价',
    rating: '好评',
    content: '失主沟通很有礼貌，核对特征后很快就来操场完成了当面认领，赏金也即时到账。',
    itemTitle: '蓝色挂绳校园一卡通',
    createdAt: '2026-11-06T17:05:00.000Z',
  },
];

type SubPageKey =
  | 'main'
  | 'user_homepage'
  | 'edit_profile'
  | 'my_lost'
  | 'my_found'
  | 'history'
  | 'browsing_history'
  | 'wallet'
  | 'claims'
  | 'analytics';

type EditFieldKey =
  | 'nickname'
  | 'avatar'
  | 'bio'
  | 'college_class'
  | 'birthday'
  | 'phone'
  | 'email'
  | null;

export const ProfileCenterView: React.FC<ProfileCenterViewProps> = ({
  currentUser,
  users,
  onUpdateCurrentUser,
  onLogout,
  isDarkMode,
  onToggleDarkMode,
  onOpenItemDetail,
  onOpenUserProfile,
  allItems,
  activeItems,
  tasks = [],
  matches,
  claims,
  messages,
  onDataMutated,
}) => {
  const [subPage, setSubPage] = useState<SubPageKey>('main');
  const [homepageTab, setHomepageTab] = useState<'found' | 'lost' | 'reviews'>('found');
  const [walletFilter, setWalletFilter] = useState<'all' | 'income' | 'expense'>('all');

  // 1. Full-page Edit Profile (`subPage === 'edit_profile'`) state
  const [activeEditField, setActiveEditField] = useState<EditFieldKey>(null);
  const [editName, setEditName] = useState(currentUser.displayName);
  const [editEmail, setEditEmail] = useState(currentUser.email);
  const [editPhone, setEditPhone] = useState(currentUser.phone || '13910230982');
  const [editDepartment, setEditDepartment] = useState(
    currentUser.department || '计算机科学与技术学院'
  );
  const [editClassName, setEditClassName] = useState(
    currentUser.className || '计科2301班'
  );
  const [editBio, setEditBio] = useState(
    currentUser.bio || '热爱校园生活，拾金不昧互助同学'
  );
  const [editBirthday, setEditBirthday] = useState(
    currentUser.birthday || '2005-01-20'
  );
  const [editAvatarUrl, setEditAvatarUrl] = useState(
    currentUser.avatarUrl || AVATAR_PRESETS[0]
  );
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSavedToast, setProfileSavedToast] = useState<string | null>(null);

  // 2. Contact Admin Modal state
  const [isContactAdminOpen, setIsContactAdminOpen] = useState(false);
  const [adminMsgInput, setAdminMsgInput] = useState('');
  const [sendingAdminMsg, setSendingAdminMsg] = useState(false);
  const [adminMsgSentToast, setAdminMsgSentToast] = useState(false);

  // 3. Settings Modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const pushNotifyEnabled = currentUser.pushNotifyEnabled !== false;
  const [clearingHistory, setClearingHistory] = useState(false);

  // 4. Item Edit Modal state
  const [editingItem, setEditingItem] = useState<LostFoundItem | null>(null);
  const [itemTitle, setItemTitle] = useState('');
  const [itemDesc, setItemDesc] = useState('');
  const [itemCategory, setItemCategory] = useState<CampusCategory>('数码电子');
  const [itemColor, setItemColor] = useState('');
  const [itemBrand, setItemBrand] = useState('');
  const [itemArea, setItemArea] = useState<CampusLocationArea>('图书馆');
  const [itemDetail, setItemDetail] = useState('');
  const [itemReward, setItemReward] = useState<number>(0);
  const [itemVerifQuestion, setItemVerifQuestion] = useState('');
  const [itemEditError, setItemEditError] = useState<string | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [togglingItemId, setTogglingItemId] = useState<string | null>(null);

  // 5. Item Messages Drawer state
  const [messageDrawerItem, setMessageDrawerItem] = useState<LostFoundItem | null>(null);
  const [drawerCounterpartyUid, setDrawerCounterpartyUid] = useState<string | null>(null);
  const [drawerReplyText, setDrawerReplyText] = useState('');
  const [sendingDrawerReply, setSendingDrawerReply] = useState(false);

  const openEditProfilePage = () => {
    setEditName(currentUser.displayName.replace(/\s*\(.*?\)/g, ''));
    setEditEmail(currentUser.email);
    setEditPhone(
      currentUser.phone || (currentUser.role === 'admin' ? '13800138000' : '13910230982')
    );
    setEditDepartment(currentUser.department || '计算机科学与技术学院');
    setEditClassName(currentUser.className || '计科2301班');
    setEditBio(currentUser.bio || '热爱校园生活，拾金不昧互助同学');
    setEditBirthday(currentUser.birthday || '2005-01-20');
    setEditAvatarUrl(
      currentUser.avatarUrl ||
        (currentUser.role === 'admin' ? AVATAR_PRESETS[4] : AVATAR_PRESETS[0])
    );
    setActiveEditField(null);
    setSubPage('edit_profile');
  };

  const handleAvatarFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setEditAvatarUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfileField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || !editEmail.trim()) return;
    setSavingProfile(true);
    try {
      const updated = await updateUserProfileInFirestore(
        currentUser.uid,
        {
          displayName: editName.trim(),
          email: editEmail.trim(),
          phone: editPhone.trim(),
          department: editDepartment.trim(),
          className: editClassName.trim(),
          bio: editBio.trim(),
          birthday: editBirthday.trim(),
          avatarUrl: editAvatarUrl.trim(),
        },
        currentUser
      );
      onUpdateCurrentUser(updated);
      await onDataMutated();
      setActiveEditField(null);
      setProfileSavedToast('个人资料已保存更新');
      window.setTimeout(() => setProfileSavedToast(null), 2200);
    } finally {
      setSavingProfile(false);
    }
  };

  const {
    myLostItems,
    myFoundItems,
    myHistoryItems,
    browsedItems,
    walletBalance,
    walletTransactions,
    totalIncome,
    totalExpense,
    userReviews,
    positiveRate,
    creditTierLabel,
  } = useMemo(() => {
    // Strictly filter items owned by currentUser.uid so each user account has its own distinct items
    const owned = allItems.filter((i) => i.ownerUid === currentUser.uid);
    const lost = owned.filter((i) => i.type === 'lost' && i.status !== 'delisted');
    const found = owned.filter((i) => i.type === 'found' && i.status !== 'delisted');

    // [G2] Fall back to demo IDs ONLY when browsedItemIds is undefined (never after 清空 sets []), and exclude delisted items
    const activeItemById = new Map(
      activeItems.filter((i) => i.status !== 'delisted').map((i) => [i.id, i])
    );
    const rawBrowsedIds =
      currentUser.browsedItemIds !== undefined
        ? currentUser.browsedItemIds
        : ['demo_found_01', 'demo_found_02', 'demo_lost_03', 'demo_found_04'];
    const browsed = rawBrowsedIds
      .map((id) => activeItemById.get(id))
      .filter((it): it is LostFoundItem => Boolean(it));

    const txs =
      Array.isArray(currentUser.walletTransactions) && currentUser.walletTransactions.length > 0
        ? currentUser.walletTransactions
        : DEFAULT_WALLET_TRANSACTIONS;

    const incomeSum = txs
      .filter((t) => t.type === 'income')
      .reduce((acc, t) => acc + t.amount, 0);
    const expenseSum = txs
      .filter((t) => t.type === 'expense')
      .reduce((acc, t) => acc + t.amount, 0);
    const balance =
      typeof currentUser.walletBalance === 'number'
        ? currentUser.walletBalance
        : Math.max(0, incomeSum - expenseSum);

    const revs =
      Array.isArray(currentUser.reviews) && currentUser.reviews.length > 0
        ? currentUser.reviews
        : DEFAULT_USER_REVIEWS;

    // Dynamically calculate real positive review rate (好评率)
    const positiveCount = revs.filter((r) => r.rating === '好评').length;
    const computedRate =
      revs.length > 0 ? Math.round((positiveCount / revs.length) * 100) : 100;
    const tierLabel =
      computedRate >= 95 ? '极好' : computedRate >= 80 ? '优秀' : '良好';

    return {
      myLostItems: lost,
      myFoundItems: found,
      myHistoryItems: owned,
      browsedItems: browsed,
      walletBalance: balance,
      walletTransactions: txs,
      totalIncome: incomeSum,
      totalExpense: expenseSum,
      userReviews: revs,
      positiveRate: computedRate,
      creditTierLabel: tierLabel,
    };
  }, [
    allItems,
    activeItems,
    currentUser.uid,
    currentUser.browsedItemIds,
    currentUser.walletBalance,
    currentUser.walletTransactions,
    currentUser.reviews,
  ]);

  const filteredWalletTransactions = useMemo(() => {
    if (walletFilter === 'all') return walletTransactions;
    return walletTransactions.filter((t) => t.type === walletFilter);
  }, [walletTransactions, walletFilter]);

  const itemMap = useMemo(() => new Map(allItems.map((i) => [i.id, i])), [allItems]);

  const messagesByItemId = useMemo(() => {
    const map = new Map<string, MessageRecord[]>();
    const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const m of sorted) {
      const list = map.get(m.itemId);
      if (list) {
        list.push(m);
      } else {
        map.set(m.itemId, [m]);
      }
    }
    return map;
  }, [messages]);

  // Strict participation filter: only count & expose messages where currentUser is a participant
  const messageCountByItem = useMemo(() => {
    const map = new Map<string, MessageRecord[]>();
    const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const m of sorted) {
      const item = itemMap.get(m.itemId);
      const itemMsgs = messagesByItemId.get(m.itemId) || [];
      if (!isUserParticipantInMessage(m, currentUser.uid, itemMsgs, item)) {
        continue;
      }
      const list = map.get(m.itemId) || [];
      list.push(m);
      map.set(m.itemId, list);
    }
    return map;
  }, [messages, itemMap, messagesByItemId, currentUser.uid]);

  const adminMessages = useMemo(() => {
    const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return sorted.filter((m) => {
      const item = itemMap.get(m.itemId);
      const itemMsgs = messagesByItemId.get(m.itemId) || [];
      if (!isUserParticipantInMessage(m, currentUser.uid, itemMsgs, item)) {
        return false;
      }
      return m.itemId === 'admin_support' || m.content.startsWith('【联系管理员】');
    });
  }, [messages, itemMap, messagesByItemId, currentUser.uid]);

  const handleSendAdminMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminMsgInput.trim()) return;
    setSendingAdminMsg(true);
    try {
      const adminSupportChrono = messagesByItemId.get('admin_support') || [];
      const lastPeerMsg = [...adminMessages]
        .reverse()
        .find((m) => m.senderUid && m.senderUid !== currentUser.uid);
      const receiverUid =
        currentUser.uid === 'admin_shx614519'
          ? lastPeerMsg?.senderUid ||
            getCounterpartyUidForMessage(
              adminMessages[adminMessages.length - 1],
              currentUser.uid,
              adminSupportChrono
            ) ||
            'demo_student_li'
          : 'admin_shx614519';

      const sentMsg = await sendInSiteMessage({
        itemId: 'admin_support',
        itemTitle: '联系管理员咨询',
        content: `【联系管理员】${adminMsgInput.trim()}`,
        actor: currentUser,
        receiverUid,
      });
      const readKey = `chat_admin_support::${receiverUid}::${sentMsg.id}`;
      const updatedUser = await markNotificationsReadInFirestore(currentUser, [readKey]);
      onUpdateCurrentUser(updatedUser);
      setAdminMsgInput('');
      setAdminMsgSentToast(true);
      window.setTimeout(() => setAdminMsgSentToast(false), 2500);
      await onDataMutated();
    } finally {
      setSendingAdminMsg(false);
    }
  };

  const handleClearBrowsingHistory = async () => {
    setClearingHistory(true);
    try {
      const updated = await clearUserBrowsingHistory(currentUser);
      onUpdateCurrentUser(updated);
      await onDataMutated();
    } finally {
      setClearingHistory(false);
    }
  };

  const openEditItemModal = (item: LostFoundItem) => {
    if (item.ownerUid !== currentUser.uid) return;
    setEditingItem(item);
    setItemEditError(null);
    setItemTitle(item.title);
    setItemDesc(item.description);
    setItemCategory(item.campusCategory);
    setItemColor(item.color || '');
    setItemBrand(item.brand || '');
    const parsedArea = (item.locationArea ||
      item.location.split('·')[0].trim()) as CampusLocationArea;
    setItemArea(CAMPUS_LOCATION_AREAS.includes(parsedArea) ? parsedArea : '图书馆');
    setItemDetail(
      item.locationDetail !== undefined
        ? item.locationDetail
        : item.location.includes('·')
        ? item.location.split('·').slice(1).join('·').trim()
        : ''
    );
    setItemReward(item.rewardAmount || 0);
    setItemVerifQuestion(item.verificationQuestion || '');
  };

  const handleSaveItemEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem || editingItem.ownerUid !== currentUser.uid || !itemTitle.trim() || !itemDesc.trim()) return;
    if (editingItem.type === 'lost') {
      const maxAllowedReward = Math.max(walletBalance, editingItem.rewardAmount || 0);
      if (itemReward > maxAllowedReward) {
        setItemEditError(
          `悬赏金额（¥${itemReward}）超出当前钱包可用余额（¥${walletBalance}），请调低悬赏金额后再保存`
        );
        return;
      }
    }
    setItemEditError(null);
    setSavingItem(true);
    try {
      await updateUserItemInFirestore(
        editingItem,
        {
          title: itemTitle.trim(),
          description: itemDesc.trim(),
          campusCategory: itemCategory,
          color: itemColor.trim(),
          brand: itemBrand.trim(),
          locationArea: itemArea,
          locationDetail: itemDetail.trim(),
          rewardAmount: editingItem.type === 'lost' ? itemReward : 0,
          verificationQuestion: itemVerifQuestion.trim(),
        },
        currentUser
      );
      await onDataMutated();
      setEditingItem(null);
    } catch (err) {
      setItemEditError(err instanceof Error ? err.message : '保存修改失败，请重试');
    } finally {
      setSavingItem(false);
    }
  };

  const handleToggleDelist = async (item: LostFoundItem) => {
    if (item.ownerUid !== currentUser.uid) return;
    const nextStatus = item.status === 'delisted' ? 'open' : 'delisted';
    setTogglingItemId(item.id);
    try {
      await toggleUserItemListingStatus(item, nextStatus, currentUser, matches);
      await onDataMutated();
    } finally {
      setTogglingItemId(null);
    }
  };

  const handleSendDrawerReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageDrawerItem || !drawerReplyText.trim()) return;
    setSendingDrawerReply(true);
    try {
      const allChronoMsgs = messagesByItemId.get(messageDrawerItem.id) || [];
      const myItemMsgs = messageCountByItem.get(messageDrawerItem.id) || [];

      let targetReceiverUid: string | null = null;
      if (messageDrawerItem.ownerUid !== currentUser.uid) {
        targetReceiverUid = messageDrawerItem.ownerUid;
      } else {
        if (drawerCounterpartyUid && drawerCounterpartyUid !== currentUser.uid) {
          targetReceiverUid = drawerCounterpartyUid;
        } else {
          for (let i = myItemMsgs.length - 1; i >= 0; i--) {
            const peer = getCounterpartyUidForMessage(
              myItemMsgs[i],
              currentUser.uid,
              allChronoMsgs,
              messageDrawerItem
            );
            if (peer && peer !== currentUser.uid) {
              targetReceiverUid = peer;
              break;
            }
          }
        }
      }

      if (!targetReceiverUid || targetReceiverUid === currentUser.uid) {
        return;
      }

      const sentMsg = await sendInSiteMessage({
        itemId: messageDrawerItem.id,
        itemTitle: messageDrawerItem.title,
        content: drawerReplyText.trim(),
        actor: currentUser,
        receiverUid: targetReceiverUid,
      });
      const readKey = `chat_${messageDrawerItem.id}::${targetReceiverUid}::${sentMsg.id}`;
      const updatedUser = await markNotificationsReadInFirestore(currentUser, [readKey]);
      onUpdateCurrentUser(updatedUser);
      setDrawerReplyText('');
      await onDataMutated();
    } finally {
      setSendingDrawerReply(false);
    }
  };

  const avatarSrc =
    currentUser.avatarUrl ||
    (currentUser.role === 'admin' ? AVATAR_PRESETS[4] : AVATAR_PRESETS[0]);

  const cleanNickname = currentUser.displayName.replace(/\s*\(.*?\)/g, '');

  // Shared modals across main and sub-pages
  const renderSharedModals = () => (
    <>
      {/* MODAL 2: CONTACT ADMIN */}
      {isContactAdminOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/55 backdrop-blur-xs p-0 sm:p-4">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-4 border border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-orange-100 dark:bg-orange-950/70 text-[#FF5000] flex items-center justify-center">
                  <Headphones className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">
                    联系校园管理员
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    失物招领事务咨询、纠纷协调与急件处理
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsContactAdminOpen(false)}
                className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/70 dark:border-slate-700 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">值班部门：</span>
                <span className="font-bold text-slate-900 dark:text-white">
                  校团委学生事务与失物招领中心
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">办公地点：</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  大学生活动中心一楼 105 室
                </span>
              </div>
            </div>

            <div className="space-y-2 max-h-44 overflow-y-auto">
              <div className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                在线留言记录 ({adminMessages.length})
              </div>
              {adminMessages.slice(-4).map((m) => (
                <div
                  key={m.id}
                  className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 text-xs space-y-0.5"
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span className="font-bold text-slate-700 dark:text-slate-200">
                      {m.senderName.replace(/\s*\(.*?\)/g, '')}
                    </span>
                    <span className="font-mono">{m.createdAt.slice(5, 16).replace('T', ' ')}</span>
                  </div>
                  <p className="text-slate-700 dark:text-slate-300">{m.content}</p>
                </div>
              ))}
            </div>

            <form onSubmit={handleSendAdminMessage} className="space-y-2.5 pt-1">
              <textarea
                rows={2}
                value={adminMsgInput}
                onChange={(e) => setAdminMsgInput(e.target.value)}
                placeholder="向管理员描述您遇到的问题或需要协助的物品信息..."
                className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
              />
              {adminMsgSentToast && (
                <div className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>已发送给管理员，可在「消息中心」查看回复</span>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsContactAdminOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  关闭
                </button>
                <button
                  type="submit"
                  disabled={sendingAdminMsg || !adminMsgInput.trim()}
                  className="px-5 py-2 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{sendingAdminMsg ? '发送中...' : '发送给管理员'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: SETTINGS SHEET (No edit profile button here — editing is exclusively inside Personal Homepage) */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/55 backdrop-blur-xs p-0 sm:p-4">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-4 border border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-slate-900 dark:text-white" />
                <h3 className="text-base font-bold text-slate-900 dark:text-white">设置</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5">
              {/* Dark Mode Toggle */}
              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-slate-200/80 dark:bg-slate-700 text-slate-900 dark:text-amber-300 flex items-center justify-center">
                    {isDarkMode ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      黑夜模式
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {isDarkMode ? '当前已开启深色夜间护眼主题' : '切换为深色背景，夜间浏览更舒适'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={isDarkMode}
                  onClick={() => onToggleDarkMode(!isDarkMode)}
                  className={`w-12 h-7 rounded-full p-1 transition-colors cursor-pointer flex items-center ${
                    isDarkMode ? 'bg-[#FF6B2C] justify-end' : 'bg-slate-300 justify-start'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-xs transition-transform" />
                </button>
              </div>

              {/* Push Notification Toggle */}
              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-slate-200/80 dark:bg-slate-700 text-slate-800 dark:text-slate-200 flex items-center justify-center">
                    <Bell className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      匹配与私信通知
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      发现高度相似物品时在消息页提醒
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={pushNotifyEnabled}
                  onClick={() => {
                    const nextVal = !pushNotifyEnabled;
                    onUpdateCurrentUser({ ...currentUser, pushNotifyEnabled: nextVal });
                    updateUserPushNotifyPreference(currentUser, nextVal)
                      .then((updated) => onUpdateCurrentUser(updated))
                      .catch(() => {});
                  }}
                  className={`w-12 h-7 rounded-full p-1 transition-colors cursor-pointer flex items-center ${
                    pushNotifyEnabled ? 'bg-[#FF6B2C] justify-end' : 'bg-slate-300 justify-start'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-xs transition-transform" />
                </button>
              </div>

              {/* Log Out (退出登录) */}
              <button
                type="button"
                onClick={() => {
                  setIsSettingsOpen(false);
                  setMessageDrawerItem(null);
                  setDrawerCounterpartyUid(null);
                  signOutFirebase().catch(() => {});
                  onLogout();
                }}
                className="w-full p-3.5 rounded-2xl bg-red-50/80 dark:bg-red-950/40 hover:bg-red-100/80 dark:hover:bg-red-950/60 border border-red-200/70 dark:border-red-900/60 flex items-center justify-between cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-red-100 dark:bg-red-900/60 text-red-600 dark:text-red-300 flex items-center justify-center">
                    <LogOut className="w-4 h-4" />
                  </div>
                  <div className="text-left">
                    <div className="text-xs font-bold text-red-600 dark:text-red-300">
                      退出登录
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      当前账号：{cleanNickname} · 点击退出并返回登录界面
                    </div>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-red-400" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: EDIT PUBLISHED ITEM */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-3xl shadow-2xl p-5 space-y-4 my-8 border border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  编辑发布内容
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  修改物品名称、地点、悬赏金额与描述
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveItemEdit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  物品名称 *
                </label>
                <input
                  type="text"
                  required
                  value={itemTitle}
                  onChange={(e) => setItemTitle(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-[#FF6B2C]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    大体位置 *
                  </label>
                  <select
                    value={itemArea}
                    onChange={(e) => setItemArea(e.target.value as CampusLocationArea)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    {CAMPUS_LOCATION_AREAS.map((area) => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    详细位置
                  </label>
                  <input
                    type="text"
                    value={itemDetail}
                    onChange={(e) => setItemDetail(e.target.value)}
                    placeholder="楼层/教室/宿舍楼号"
                    className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    分类
                  </label>
                  <select
                    value={itemCategory}
                    onChange={(e) => setItemCategory(e.target.value as CampusCategory)}
                    className="w-full px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    {CAMPUS_CATEGORIES.filter((c) => c.value !== 'unknown').map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    颜色
                  </label>
                  <input
                    type="text"
                    value={itemColor}
                    onChange={(e) => setItemColor(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    品牌
                  </label>
                  <input
                    type="text"
                    value={itemBrand}
                    onChange={(e) => setItemBrand(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
              </div>

              {editingItem.type === 'lost' && (
                <div className="p-3 rounded-2xl bg-orange-50/80 dark:bg-orange-950/40 border border-orange-200/80 dark:border-orange-800 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-orange-950 dark:text-orange-200">
                      悬赏金额 (元) · 可用余额 ¥{walletBalance}：
                    </span>
                    <div className="flex items-center gap-1.5">
                      {[0, 10, 20, 50].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => {
                            setItemReward(v);
                            setItemEditError(null);
                          }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer ${
                            itemReward === v
                              ? 'bg-[#FF5000] text-white'
                              : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-orange-200 dark:border-orange-800'
                          }`}
                        >
                          {v === 0 ? '无' : `¥${v}`}
                        </button>
                      ))}
                      <input
                        type="number"
                        min={0}
                        max={9999}
                        value={itemReward}
                        onChange={(e) => {
                          setItemReward(Math.max(0, Math.min(9999, Number(e.target.value) || 0)));
                          setItemEditError(null);
                        }}
                        className="w-16 px-2 py-1 text-xs font-mono bg-white dark:bg-slate-800 dark:text-white border border-orange-200 dark:border-orange-800 rounded-lg"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  特征描述 *
                </label>
                <textarea
                  rows={3}
                  required
                  value={itemDesc}
                  onChange={(e) => setItemDesc(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {editingItem.type === 'lost' ? '归还核验问题（选填）' : '认领核验问题（选填）'}
                </label>
                <input
                  type="text"
                  value={itemVerifQuestion}
                  onChange={(e) => setItemVerifQuestion(e.target.value)}
                  placeholder="选填，如：请说出物品贴纸图案或证件尾号"
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              {itemEditError && (
                <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs font-semibold text-red-600 dark:text-red-300">
                  {itemEditError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingItem}
                  className="px-5 py-2 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {savingItem ? '保存中...' : '保存修改'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 5: VIEW MESSAGES ON THIS ITEM (Participant-Only & 2-Party Isolated) */}
      {messageDrawerItem && (() => {
        const allChronoMsgs = messagesByItemId.get(messageDrawerItem.id) || [];
        const myParticipatedMsgs = messageCountByItem.get(messageDrawerItem.id) || [];
        const isMyOwnPost = messageDrawerItem.ownerUid === currentUser.uid;

        // Build distinct 2-party counterparty threads involving currentUser on this item
        const groupedByPeer = new Map<
          string,
          { peerUid: string; profile: UserProfile; messages: MessageRecord[]; lastAt: string }
        >();
        for (const m of myParticipatedMsgs) {
          const peerUid = getCounterpartyUidForMessage(
            m,
            currentUser.uid,
            allChronoMsgs,
            messageDrawerItem
          );
          if (!peerUid || peerUid === currentUser.uid) continue;
          const existing = groupedByPeer.get(peerUid);
          if (!existing) {
            const profile = resolveConversationCounterparty({
              messages: [m],
              item: messageDrawerItem,
              currentUser,
              users,
              counterpartyUid: peerUid,
            });
            groupedByPeer.set(peerUid, {
              peerUid,
              profile,
              messages: [m],
              lastAt: m.createdAt,
            });
          } else {
            existing.messages.push(m);
            existing.lastAt = m.createdAt;
          }
        }
        const counterpartyGroups = Array.from(groupedByPeer.values()).sort((a, b) =>
          b.lastAt.localeCompare(a.lastAt)
        );

        let activePeerProfile: UserProfile | null = null;
        let drawerMsgs: MessageRecord[] = [];

        if (!isMyOwnPost) {
          // Viewing someone else's post (e.g. from Browsing History -> 联系发布者):
          // Counterparty is strictly the post owner, and messages are strictly {currentUser, ownerUid}
          const ownerUid = messageDrawerItem.ownerUid;
          drawerMsgs = myParticipatedMsgs.filter((m) =>
            isStrictTwoPartyMessage(
              m,
              currentUser.uid,
              ownerUid,
              allChronoMsgs,
              messageDrawerItem
            )
          );
          activePeerProfile = resolveConversationCounterparty({
            messages: drawerMsgs,
            item: messageDrawerItem,
            currentUser,
            users,
            counterpartyUid: ownerUid,
          });
        } else if (counterpartyGroups.length > 0) {
          // Viewing own post's 收到的消息 when at least 1 student has messaged currentUser
          const selectedGroup =
            counterpartyGroups.find((g) => g.peerUid === drawerCounterpartyUid) ||
            counterpartyGroups[0];
          activePeerProfile = selectedGroup.profile;
          drawerMsgs = selectedGroup.messages;
        }

        const counterpartyName = activePeerProfile
          ? cleanDisplayName(activePeerProfile.displayName)
          : '';

        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/55 backdrop-blur-xs p-0 sm:p-4">
            <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-3.5 max-h-[85vh] flex flex-col border border-slate-100 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
                {activePeerProfile ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMessageDrawerItem(null);
                      setDrawerCounterpartyUid(null);
                      onOpenUserProfile(activePeerProfile!);
                    }}
                    title={`查看 ${counterpartyName} 的个人主页`}
                    className="min-w-0 flex items-center gap-2.5 text-left cursor-pointer group"
                  >
                    <img
                      src={activePeerProfile.avatarUrl}
                      alt={counterpartyName}
                      className="w-10 h-10 rounded-full object-cover border border-slate-200 dark:border-slate-700 bg-amber-50 shrink-0 group-hover:ring-2 group-hover:ring-[#FF6B2C]/40 transition-all"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900 dark:text-white truncate group-hover:text-[#FF6B2C] transition-colors">
                        {counterpartyName}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        关联帖子：《{messageDrawerItem.title}》 · 点击查看TA主页
                      </p>
                    </div>
                  </button>
                ) : (
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                      收到的消息
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      关联帖子：《{messageDrawerItem.title}》
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMessageDrawerItem(null);
                    setDrawerCounterpartyUid(null);
                  }}
                  className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Counterparty thread selector pills if multiple peers messaged own post */}
              {isMyOwnPost && counterpartyGroups.length > 1 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                  {counterpartyGroups.map((grp) => {
                    const isSelected = activePeerProfile?.uid === grp.peerUid;
                    const grpName = cleanDisplayName(grp.profile.displayName);
                    return (
                      <button
                        key={grp.peerUid}
                        type="button"
                        onClick={() => setDrawerCounterpartyUid(grp.peerUid)}
                        className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[#FF6B2C] text-white'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <img
                          src={grp.profile.avatarUrl}
                          alt={grpName}
                          className="w-4 h-4 rounded-full object-cover bg-amber-50"
                        />
                        <span>{grpName}</span>
                        <span className="text-[10px] opacity-85">({grp.messages.length})</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex-1 overflow-y-auto space-y-2.5 py-2 min-h-[200px]">
                {drawerMsgs.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-400">
                    {isMyOwnPost
                      ? '暂时还没有同学就该帖子发送消息'
                      : `暂无与 ${counterpartyName} 的私信记录，发送消息开始沟通吧`}
                  </div>
                ) : (
                  drawerMsgs.map((m) => {
                    const isMe = m.senderUid === currentUser.uid;
                    const senderProfile = isMe
                      ? resolveUserProfile(currentUser.uid, currentUser.displayName, users)
                      : resolveUserProfile(m.senderUid, m.senderName, users);
                    const senderDisplayName = cleanDisplayName(
                      m.senderName || senderProfile.displayName
                    );
                    return (
                      <div
                        key={m.id}
                        className={`p-3 rounded-2xl text-xs space-y-1.5 ${
                          isMe
                            ? 'bg-orange-50 dark:bg-orange-950/60 border border-orange-200/80 dark:border-orange-800 ml-6'
                            : 'bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700 mr-6'
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                          <button
                            type="button"
                            onClick={() => {
                              setMessageDrawerItem(null);
                              setDrawerCounterpartyUid(null);
                              onOpenUserProfile(senderProfile);
                            }}
                            className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200 hover:text-[#FF6B2C] cursor-pointer"
                          >
                            <img
                              src={senderProfile.avatarUrl}
                              alt={senderDisplayName}
                              className="w-5 h-5 rounded-full object-cover border border-slate-200 bg-amber-50 shrink-0"
                            />
                            <span>{senderDisplayName}</span>
                          </button>
                          <span className="font-mono">
                            {m.createdAt.slice(5, 16).replace('T', ' ')}
                          </span>
                        </div>
                        <p className="text-slate-800 dark:text-slate-200 leading-relaxed">
                          {m.content}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>

              {activePeerProfile ? (
                <form
                  onSubmit={handleSendDrawerReply}
                  className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={drawerReplyText}
                    onChange={(e) => setDrawerReplyText(e.target.value)}
                    placeholder={`回复 ${counterpartyName}...`}
                    className="flex-1 px-3.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                  />
                  <button
                    type="submit"
                    disabled={sendingDrawerReply || !drawerReplyText.trim()}
                    className="px-4 py-2 rounded-2xl bg-[#FF6B2C] text-white text-xs font-bold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>发送</span>
                  </button>
                </form>
              ) : (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-center text-[11px] text-slate-400">
                  当有同学就该帖子发来私信时，您可在此查看并直接回复
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );

  // ============================================================================
  // SUB-PAGE 0: 完整「编辑资料」页面 (Requirement 1 — 参考图 1 完整列表页，仅从个人主页进入)
  // 保留字段：昵称、头像、简介、院校班级、生日、电话号码、邮箱
  // ============================================================================
  if (subPage === 'edit_profile') {
    const collegeClassText = `${editDepartment} · ${editClassName}`;
    return (
      <div className="space-y-4 pb-10 pt-1">
        {/* Top Navigation Bar matching Reference Image 1 */}
        <div className="flex items-center justify-between px-1 py-2">
          <button
            type="button"
            onClick={() => setSubPage('user_homepage')}
            className="w-9 h-9 rounded-full hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center text-slate-900 dark:text-white cursor-pointer"
            aria-label="返回个人主页"
          >
            <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
          </button>
          <h2 className="text-[17px] font-bold text-slate-950 dark:text-white tracking-tight">
            编辑资料
          </h2>
          <div className="w-9" />
        </div>

        {profileSavedToast && (
          <div className="mx-1 px-3.5 py-2.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/70 border border-emerald-200 dark:border-emerald-800 text-xs font-bold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
            <Check className="w-4 h-4 shrink-0" />
            <span>{profileSavedToast}</span>
          </div>
        )}

        {/* Rounded White Card with 7 Clean Rows matching Reference Image 1 */}
        <div className="bg-white dark:bg-slate-900 rounded-[26px] shadow-2xs border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800/80 overflow-hidden">
          {/* Row 1: 昵称 */}
          <button
            type="button"
            onClick={() => setActiveEditField('nickname')}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <span className="text-[15px] font-bold text-slate-900 dark:text-white">昵称</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[14px] text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
                {editName}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>

          {/* Row 2: 头像 */}
          <button
            type="button"
            onClick={() => setActiveEditField('avatar')}
            className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <span className="text-[15px] font-bold text-slate-900 dark:text-white">头像</span>
            <div className="flex items-center gap-2">
              <img
                src={editAvatarUrl}
                alt="当前头像"
                className="w-12 h-12 rounded-full object-cover border border-slate-200 dark:border-slate-700 bg-amber-50"
              />
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>

          {/* Row 3: 简介 */}
          <button
            type="button"
            onClick={() => setActiveEditField('bio')}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <span className="text-[15px] font-bold text-slate-900 dark:text-white shrink-0">
              简介
            </span>
            <div className="flex items-center gap-1.5 min-w-0 ml-4">
              <span className="text-[14px] text-slate-500 dark:text-slate-400 truncate max-w-[210px]">
                {editBio || '介绍一下自己吧'}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>

          {/* Row 4: 院校班级 */}
          <button
            type="button"
            onClick={() => setActiveEditField('college_class')}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-baseline gap-2.5 shrink-0">
              <span className="text-[15px] font-bold text-slate-900 dark:text-white">
                院校班级
              </span>
              <span className="text-xs text-slate-400">发现校友</span>
            </div>
            <div className="flex items-center gap-1.5 min-w-0 ml-3">
              <span className="text-[14px] text-[#4A6FA5] dark:text-blue-400 font-medium truncate max-w-[180px]">
                {collegeClassText}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>

          {/* Row 5: 生日 */}
          <button
            type="button"
            onClick={() => setActiveEditField('birthday')}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-baseline gap-2.5 shrink-0">
              <span className="text-[15px] font-bold text-slate-900 dark:text-white">生日</span>
              <span className="text-xs text-slate-400">生日当天送你生日祝福</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] text-slate-500 dark:text-slate-400 font-mono">
                {editBirthday}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>

          {/* Row 6: 电话号码 */}
          <button
            type="button"
            onClick={() => setActiveEditField('phone')}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-baseline gap-2.5 shrink-0">
              <span className="text-[15px] font-bold text-slate-900 dark:text-white">
                电话号码
              </span>
              <span className="text-xs text-slate-400">仅自己可见</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] text-slate-500 dark:text-slate-400 font-mono">
                {editPhone}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>

          {/* Row 7: 邮箱 */}
          <button
            type="button"
            onClick={() => setActiveEditField('email')}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-baseline gap-2.5 shrink-0">
              <span className="text-[15px] font-bold text-slate-900 dark:text-white">邮箱</span>
              <span className="text-xs text-slate-400">仅自己可见</span>
            </div>
            <div className="flex items-center gap-1.5 min-w-0 ml-3">
              <span className="text-[14px] text-slate-500 dark:text-slate-400 truncate max-w-[190px]">
                {editEmail}
              </span>
              <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
            </div>
          </button>
        </div>

        {/* Bottom Sheet Editor when a row is tapped */}
        {activeEditField && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/55 backdrop-blur-xs p-0 sm:p-4">
            <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-4 border border-slate-100 dark:border-slate-800">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  {activeEditField === 'nickname' && '修改昵称'}
                  {activeEditField === 'avatar' && '更换头像'}
                  {activeEditField === 'bio' && '修改个人简介'}
                  {activeEditField === 'college_class' && '修改院校与班级'}
                  {activeEditField === 'birthday' && '设置生日'}
                  {activeEditField === 'phone' && '修改电话号码'}
                  {activeEditField === 'email' && '修改电子邮箱'}
                </h3>
                <button
                  type="button"
                  onClick={() => setActiveEditField(null)}
                  className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveProfileField} className="space-y-4">
                {activeEditField === 'nickname' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      昵称
                    </label>
                    <input
                      type="text"
                      required
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                    />
                  </div>
                )}

                {activeEditField === 'avatar' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3.5">
                      <img
                        src={editAvatarUrl}
                        alt="头像预览"
                        className="w-16 h-16 rounded-full object-cover border-2 border-[#FF6B2C] bg-amber-50 shrink-0"
                      />
                      <label className="px-3.5 py-2 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5 cursor-pointer">
                        <Upload className="w-4 h-4" />
                        <span>从相册上传新头像</span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          onChange={handleAvatarFileUpload}
                          className="hidden"
                        />
                      </label>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-500 mb-2">
                        或选择推荐校园头像：
                      </div>
                      <div className="flex items-center gap-2.5">
                        {AVATAR_PRESETS.map((presetUrl, i) => (
                          <button
                            key={presetUrl}
                            type="button"
                            onClick={() => setEditAvatarUrl(presetUrl)}
                            className={`w-11 h-11 rounded-full overflow-hidden border-2 cursor-pointer transition-transform ${
                              editAvatarUrl === presetUrl
                                ? 'border-[#FF6B2C] scale-105'
                                : 'border-slate-200 opacity-75'
                            }`}
                          >
                            <img src={presetUrl} alt={`头像${i + 1}`} className="w-full h-full" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {activeEditField === 'bio' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      个人简介
                    </label>
                    <textarea
                      rows={3}
                      value={editBio}
                      onChange={(e) => setEditBio(e.target.value)}
                      placeholder="写一句简单的自我介绍..."
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                    />
                  </div>
                )}

                {activeEditField === 'college_class' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                        所属学院
                      </label>
                      <input
                        type="text"
                        value={editDepartment}
                        onChange={(e) => setEditDepartment(e.target.value)}
                        placeholder="例如：计算机科学与技术学院"
                        className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                        专业班级
                      </label>
                      <input
                        type="text"
                        value={editClassName}
                        onChange={(e) => setEditClassName(e.target.value)}
                        placeholder="例如：计科2301班"
                        className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                      />
                    </div>
                  </div>
                )}

                {activeEditField === 'birthday' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      出生日期
                    </label>
                    <input
                      type="date"
                      value={editBirthday}
                      onChange={(e) => setEditBirthday(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm font-mono bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                    />
                  </div>
                )}

                {activeEditField === 'phone' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      手机号码（仅自己可见，不会在个人主页公开）
                    </label>
                    <input
                      type="tel"
                      required
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm font-mono bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                    />
                  </div>
                )}

                {activeEditField === 'email' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      电子邮箱（仅自己可见，不会在个人主页公开）
                    </label>
                    <input
                      type="email"
                      required
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:border-[#FF6B2C]"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveEditField(null)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="px-5 py-2 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>{savingProfile ? '保存中...' : '保存'}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ============================================================================
  // SUB-PAGE 1: 个人主页界面 (点击头像或昵称后跳转，右上角点「编辑资料」进入完整编辑页)
  // ============================================================================
  if (subPage === 'user_homepage') {
    const gridItems = homepageTab === 'found' ? myFoundItems : myLostItems;
    return (
      <div className="space-y-0 pb-10 -mx-3.5 -mt-3">
        {/* Warm Orange-Amber Top Cover Header */}
        <div className="bg-gradient-to-br from-[#CA6E1E] via-[#B45B12] to-[#8C4308] text-white px-4 pt-4 pb-9 relative overflow-hidden">
          <div className="absolute -right-6 -top-6 w-40 h-40 rounded-full bg-amber-300/15 blur-2xl pointer-events-none" />

          {/* Top Bar: < Back on Left | 编辑资料 on Right (Only place where 编辑资料 can be opened) */}
          <div className="flex items-center justify-between mb-4">
            <button
              type="button"
              onClick={() => setSubPage('main')}
              className="w-9 h-9 rounded-full bg-black/20 hover:bg-black/30 flex items-center justify-center text-white cursor-pointer transition-colors"
              aria-label="返回我的页面"
            >
              <ChevronLeft className="w-5 h-5 stroke-[2.5]" />
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openEditProfilePage}
                className="px-3.5 py-1.5 rounded-full bg-black/25 hover:bg-black/35 backdrop-blur-xs text-xs font-bold text-white cursor-pointer transition-colors"
              >
                编辑资料
              </button>
            </div>
          </div>

          {/* Avatar + Nickname + Stats Row */}
          <div className="flex items-center gap-3.5">
            <img
              src={avatarSrc}
              alt={cleanNickname}
              className="w-[74px] h-[74px] rounded-full object-cover border-2 border-white/85 bg-amber-100 shadow-md shrink-0"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <h1 className="text-[22px] font-black text-white tracking-tight truncate">
                {cleanNickname}
              </h1>
              <div className="text-xs text-white/90 flex items-center gap-2.5 font-medium">
                <span>
                  <strong className="font-mono font-black">{myFoundItems.length}</strong> 次拾物助人
                </span>
                <span>·</span>
                <span>
                  <strong className="font-mono font-black">{userReviews.length}</strong> 条评价
                </span>
                <span>·</span>
                <span className="text-white/80">刚刚来过</span>
              </div>
              {currentUser.bio && (
                <p className="text-[11px] text-white/85 truncate pt-0.5">{currentUser.bio}</p>
              )}
            </div>
          </div>

          {/* Non-Sensitive Campus Tags Row (NO phone or email shown) */}
          <div className="flex flex-wrap items-center gap-1.5 mt-3.5">
            <span className="px-2.5 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              {currentUser.department || '计算机科学与技术学院'}
              {currentUser.className ? ` · ${currentUser.className}` : ''}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              实名认证同学
            </span>
            <span className="px-2.5 py-1 rounded-full bg-black/20 text-[11px] font-semibold text-white/95">
              校园热心互助
            </span>
          </div>

          {/* Reputation / Credit Banner Bar with REAL Dynamic Positive Rate (Requirement 3) */}
          <div
            onClick={() => setHomepageTab('reviews')}
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

        {/* Lower Rounded White Sheet: 捡到的物品 | 在找的物品 | 评价 */}
        <div className="bg-white dark:bg-slate-900 rounded-t-[28px] -mt-4 px-4 pt-4 pb-8 min-h-[520px] space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2.5">
            <div className="flex items-center gap-6">
              {[
                { key: 'found' as const, label: '捡到的物品', count: myFoundItems.length },
                { key: 'lost' as const, label: '在找的物品', count: myLostItems.length },
                { key: 'reviews' as const, label: '评价', count: userReviews.length },
              ].map((t) => {
                const active = homepageTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setHomepageTab(t.key)}
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

          {/* Tab Content */}
          {homepageTab === 'reviews' ? (
            <div className="space-y-3">
              {/* Real-time Positive Rate Summary Strip */}
              <div className="p-3 rounded-2xl bg-amber-50/70 dark:bg-slate-800 border border-amber-200/60 dark:border-slate-700 flex items-center justify-between text-xs">
                <span className="text-slate-700 dark:text-slate-200 font-semibold">
                  共收到 <strong>{userReviews.length}</strong> 条真实互助评价
                </span>
                <span className="font-extrabold text-[#FF5000] font-mono">
                  真实好评率 {positiveRate}%
                </span>
              </div>

              {userReviews.map((rev) => (
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
                    <span className="font-mono shrink-0">
                      {rev.createdAt.slice(0, 10)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : gridItems.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <div className="text-sm font-bold text-slate-400">这里空空如也~</div>
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

        {renderSharedModals()}
      </div>
    );
  }

  // ============================================================================
  // SUB-PAGE 2: 我的钱包独立页面 (领取的赏金进入钱包，显示余额和出入账记录)
  // ============================================================================
  if (subPage === 'wallet') {
    return (
      <div className="space-y-3.5 pb-8">
        {/* Sub-page Top Bar */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl px-3.5 py-3 flex items-center justify-between border border-slate-200/70 dark:border-slate-800 shadow-2xs">
          <button
            type="button"
            onClick={() => setSubPage('main')}
            className="flex items-center gap-1 text-xs font-bold text-slate-800 dark:text-slate-100 hover:text-[#FF6B2C] cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
            <span>返回我的</span>
          </button>
          <h2 className="text-sm font-black text-slate-950 dark:text-white">我的钱包</h2>
          <div className="w-12" />
        </div>

        {/* Balance Hero Card */}
        <div className="bg-gradient-to-br from-[#FF6B2C] via-[#FF5000] to-[#E04300] text-white rounded-3xl p-5 shadow-md space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="text-xs text-white/85 font-medium flex items-center gap-1.5">
                <Wallet className="w-4 h-4" />
                <span>钱包可用余额 (元)</span>
              </div>
              <div className="text-3xl font-black font-mono tracking-tight">
                ¥{walletBalance.toFixed(2)}
              </div>
            </div>

            <div className="px-3 py-1.5 rounded-2xl bg-white/15 backdrop-blur-xs text-white text-[11px] font-bold">
              悬赏由当面核销自动结算
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/20 text-xs">
            <div>
              <div className="text-white/75 text-[11px]">累计领取赏金入账</div>
              <div className="text-base font-extrabold font-mono mt-0.5">
                +¥{totalIncome.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-white/75 text-[11px]">累计支付悬赏支出</div>
              <div className="text-base font-extrabold font-mono mt-0.5">
                -¥{totalExpense.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        {/* Income / Expense Records List */}
        <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-200/70 dark:border-slate-800 shadow-2xs space-y-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-950 dark:text-white">出入账记录</h3>
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
              {[
                { key: 'all' as const, label: '全部' },
                { key: 'income' as const, label: '赏金入账' },
                { key: 'expense' as const, label: '悬赏支出' },
              ].map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setWalletFilter(f.key)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition-colors ${
                    walletFilter === f.key
                      ? 'bg-white dark:bg-slate-900 text-slate-950 dark:text-white shadow-2xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {filteredWalletTransactions.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">暂无对应出入账记录</div>
            ) : (
              filteredWalletTransactions.map((tx) => {
                const isIncome = tx.type === 'income';
                return (
                  <div
                    key={tx.id}
                    className="py-3 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 ${
                          isIncome
                            ? 'bg-orange-50 dark:bg-orange-950/60 text-[#FF5000]'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {isIncome ? (
                          <ArrowDownLeft className="w-4 h-4" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {tx.title}
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                          <span>{tx.counterpartyName || '校园互助'}</span>
                          <span>·</span>
                          <span className="font-mono">
                            {tx.createdAt.slice(0, 16).replace('T', ' ')}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div
                      className={`text-sm font-black font-mono shrink-0 ${
                        isIncome
                          ? 'text-[#FF5000]'
                          : 'text-slate-800 dark:text-slate-200'
                      }`}
                    >
                      {isIncome ? `+¥${tx.amount.toFixed(2)}` : `-¥${tx.amount.toFixed(2)}`}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {renderSharedModals()}
      </div>
    );
  }

  // ============================================================================
  // SUB-PAGE 3: 认领进度与交接码独立页面
  // ============================================================================
  if (subPage === 'claims') {
    return (
      <div className="space-y-3.5 pb-8">
        <div className="bg-white dark:bg-slate-900 rounded-2xl px-3.5 py-3 flex items-center justify-between border border-slate-200/70 dark:border-slate-800 shadow-2xs">
          <button
            type="button"
            onClick={() => setSubPage('main')}
            className="flex items-center gap-1 text-xs font-bold text-slate-800 dark:text-slate-100 hover:text-[#FF6B2C] cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
            <span>返回我的</span>
          </button>
          <h2 className="text-sm font-black text-slate-950 dark:text-white">
            认领进度与交接码
          </h2>
          <div className="w-12" />
        </div>

        <ClaimsAndMessagesView
          items={activeItems}
          claims={claims}
          messages={messages}
          currentUser={currentUser}
          initialItemId={activeItems[0]?.id || null}
          onDataMutated={onDataMutated}
        />

        {renderSharedModals()}
      </div>
    );
  }

  // ============================================================================
  // SUB-PAGE 3B: 数据可视化与模型评测看板 (Recharts + FastAPI + YOLO26n/OpenCLIP)
  // ============================================================================
  if (subPage === 'analytics') {
    return (
      <div className="space-y-3.5 pb-8">
        <div className="bg-white dark:bg-slate-900 rounded-2xl px-3.5 py-3 flex items-center justify-between border border-slate-200/70 dark:border-slate-800 shadow-2xs">
          <button
            type="button"
            onClick={() => setSubPage('main')}
            className="flex items-center gap-1 text-xs font-bold text-slate-800 dark:text-slate-100 hover:text-[#FF6B2C] cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
            <span>返回我的</span>
          </button>
          <h2 className="text-sm font-black text-slate-950 dark:text-white">
            数据可视化与模型评测看板
          </h2>
          <div className="w-12" />
        </div>

        <AnalyticsDashboardView
          currentUser={currentUser}
          items={allItems}
          tasks={tasks}
          onDataMutated={onDataMutated}
        />

        {renderSharedModals()}
      </div>
    );
  }

  // ============================================================================
  // SUB-PAGES 4..7: 我丢失的 | 我捡到的 | 历史发布 | 历史浏览 (独立二级页面)
  // ============================================================================
  if (
    subPage === 'my_lost' ||
    subPage === 'my_found' ||
    subPage === 'history' ||
    subPage === 'browsing_history'
  ) {
    const pageTitle =
      subPage === 'my_lost'
        ? '我丢失的'
        : subPage === 'my_found'
        ? '我捡到的'
        : subPage === 'history'
        ? '历史发布'
        : '历史浏览';

    const listItems =
      subPage === 'my_lost'
        ? myLostItems
        : subPage === 'my_found'
        ? myFoundItems
        : subPage === 'history'
        ? myHistoryItems
        : browsedItems;

    return (
      <div className="space-y-3.5 pb-8">
        {/* Sticky Sub-Page Header */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl px-3.5 py-3 flex items-center justify-between border border-slate-200/70 dark:border-slate-800 shadow-2xs">
          <button
            type="button"
            onClick={() => setSubPage('main')}
            className="flex items-center gap-1 text-xs font-bold text-slate-800 dark:text-slate-100 hover:text-[#FF6B2C] cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
            <span>返回我的</span>
          </button>

          <h2 className="text-sm font-black text-slate-950 dark:text-white">
            {pageTitle} ({listItems.length})
          </h2>

          {subPage === 'browsing_history' && browsedItems.length > 0 ? (
            <button
              type="button"
              disabled={clearingHistory}
              onClick={handleClearBrowsingHistory}
              className="text-xs font-semibold text-red-500 flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>清空</span>
            </button>
          ) : (
            <div className="w-12" />
          )}
        </div>

        {/* Dedicated Page Item List */}
        <div className="space-y-2.5">
          {listItems.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 rounded-3xl py-14 px-4 text-center space-y-2 border border-slate-200/70 dark:border-slate-800">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                暂无{pageTitle}记录
              </div>
              <div className="text-[11px] text-slate-400">
                {subPage === 'browsing_history'
                  ? '在首页点击任意失物或拾物帖子即可自动记录浏览足迹'
                  : '可点击底部中间的「+」按钮发布失物或拾物信息'}
              </div>
            </div>
          ) : (
            listItems.map((item) => {
              const itemMessages = messageCountByItem.get(item.id) || [];
              const badge = STATUS_BADGE_MAP[item.status] || STATUS_BADGE_MAP.open;
              return (
                <div
                  key={`${subPage}_${item.id}`}
                  className={`p-3.5 rounded-3xl border transition-all space-y-3 ${
                    item.status === 'delisted'
                      ? 'bg-slate-50/70 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800 opacity-75'
                      : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800 shadow-2xs'
                  }`}
                >
                  <div
                    onClick={() => onOpenItemDetail(item)}
                    className="flex items-start gap-3 cursor-pointer"
                  >
                    <ResilientItemImage
                      src={item.imageUrl}
                      alt={item.title}
                      category={item.campusCategory}
                      className="w-18 h-18 rounded-2xl object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              item.type === 'lost'
                                ? 'bg-orange-100 text-[#FF5000] dark:bg-orange-950/80 dark:text-orange-300'
                                : 'bg-blue-100 text-[#0066CC] dark:bg-blue-950/80 dark:text-blue-300'
                            }`}
                          >
                            {item.type === 'lost' ? '失物' : '拾物'}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                        </div>

                        {item.type === 'lost' && (item.rewardAmount || 0) > 0 && (
                          <span className="text-xs font-extrabold text-[#FF5000]">
                            悬赏 ¥{item.rewardAmount}
                          </span>
                        )}
                      </div>

                      <h3 className="text-xs font-bold text-slate-900 dark:text-white line-clamp-1">
                        {item.title}
                      </h3>

                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 truncate">
                        <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="truncate">{item.location}</span>
                        <span>·</span>
                        <span className="font-mono">
                          {item.eventTime.slice(5, 16).replace('T', ' ')}
                        </span>
                      </div>
                    </div>
                  </div>

                  {subPage === 'browsing_history' ? (
                    <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>浏览足迹</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setDrawerCounterpartyUid(null);
                            setDrawerReplyText('');
                            setMessageDrawerItem(item);
                          }}
                          className="px-3 py-1.5 rounded-xl bg-orange-50 dark:bg-orange-950/60 text-[#FF5000] dark:text-orange-300 text-xs font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                          <span>
                            {item.ownerUid === currentUser.uid
                              ? `收到的消息 (${itemMessages.length})`
                              : '联系发布者'}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenItemDetail(item)}
                          className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs font-semibold cursor-pointer"
                        >
                          查看详情
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDrawerCounterpartyUid(null);
                          setDrawerReplyText('');
                          setMessageDrawerItem(item);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-orange-50 dark:bg-orange-950/60 hover:bg-orange-100/80 text-[#FF5000] dark:text-orange-300 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        <MessageCircle className="w-3.5 h-3.5" />
                        <span>收到的消息 ({itemMessages.length})</span>
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEditItemModal(item)}
                          className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                          <span>编辑</span>
                        </button>

                        <button
                          type="button"
                          disabled={togglingItemId === item.id}
                          onClick={() => handleToggleDelist(item)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50 ${
                            item.status === 'delisted'
                              ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200'
                              : 'bg-red-50 hover:bg-red-100 text-red-600 border border-red-200/80'
                          }`}
                        >
                          <EyeOff className="w-3.5 h-3.5" />
                          <span>
                            {togglingItemId === item.id
                              ? '处理中...'
                              : item.status === 'delisted'
                              ? '重新上架'
                              : '下架'}
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {renderSharedModals()}
      </div>
    );
  }

  // ============================================================================
  // MAIN OVERVIEW PAGE (`subPage === 'main'`)
  // ============================================================================
  return (
    <div className="space-y-3.5 pb-8 pt-1">
      {/* 1. XIANYU-STYLE TOP PROFILE HEADER (Click Avatar or Nickname > to enter Personal Homepage) */}
      <div className="px-1.5 pt-2 pb-1 flex items-center justify-between gap-2">
        <div
          onClick={() => setSubPage('user_homepage')}
          className="flex items-center gap-3.5 cursor-pointer group min-w-0 flex-1"
        >
          <div className="relative w-[68px] h-[68px] rounded-full overflow-hidden border border-slate-200/80 dark:border-slate-700 shadow-xs shrink-0 bg-amber-100">
            <img
              src={avatarSrc}
              alt={cleanNickname}
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-0 inset-x-0 bg-[#FFE14D]/95 py-0.5 text-[9px] font-bold text-slate-900 text-center tracking-tight">
              个人主页
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-0.5">
              <h1 className="text-[21px] font-black text-slate-950 dark:text-white tracking-tight truncate group-hover:text-[#FF6B2C] transition-colors">
                {cleanNickname}
              </h1>
              <ChevronRight className="w-5 h-5 text-slate-900 dark:text-slate-200 stroke-[2.6] shrink-0 group-hover:translate-x-0.5 transition-transform" />
            </div>

            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-200/75 dark:bg-slate-800 text-[11px] font-bold text-slate-800 dark:text-slate-200 max-w-full truncate">
              <span className="truncate">
                {currentUser.department || '计算机科学与技术学院'} · 好评 {positiveRate}%
              </span>
            </div>
          </div>
        </div>

        {/* Right: 联系管理员 & 设置 (无切换账号入口) */}
        <div className="flex items-center gap-3.5 shrink-0 pr-1">
          <button
            type="button"
            onClick={() => setIsContactAdminOpen(true)}
            className="flex flex-col items-center gap-1 text-slate-900 dark:text-slate-100 hover:text-[#FF6B2C] transition-colors cursor-pointer"
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center">
              <Headphones className="w-6 h-6 stroke-[2]" />
            </div>
            <span className="text-[11px] font-medium whitespace-nowrap">联系管理员</span>
          </button>

          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="flex flex-col items-center gap-1 text-slate-900 dark:text-slate-100 hover:text-[#FF6B2C] transition-colors cursor-pointer"
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center">
              <Settings className="w-6 h-6 stroke-[2]" />
            </div>
            <span className="text-[11px] font-medium whitespace-nowrap">设置</span>
          </button>
        </div>
      </div>

      {/* 2. SINGLE-ROW FUNCTIONAL BAR CARD (移除编辑按钮，仅点击进入个人主页后可编辑) */}
      <div className="bg-white dark:bg-slate-900 rounded-[24px] shadow-2xs border border-slate-100 dark:border-slate-800 overflow-hidden">
        {/* Top Banner Strip (No edit button here per Requirement 1) */}
        <div
          onClick={() => setSubPage('user_homepage')}
          className="relative px-4 py-3.5 bg-gradient-to-r from-[#FFF5F2] via-[#FFF9F5] to-[#FDF2F8] dark:from-slate-800/90 dark:via-slate-800 dark:to-slate-800/80 flex items-center justify-between cursor-pointer overflow-hidden"
        >
          <div className="space-y-1 z-10">
            <div className="flex items-center gap-1.5">
              <span className="text-[16px] font-black italic tracking-tight text-slate-900 dark:text-white">
                我的个人主页
              </span>
              <span className="text-[11px] font-extrabold text-[#FF5000] bg-orange-100/90 dark:bg-orange-950/70 px-1.5 py-0.5 rounded-md not-italic">
                好评率 {positiveRate}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600 dark:text-slate-300 font-medium">
                查看捡到的物品、在找的物品、互助评价与编辑资料
              </span>
            </div>
          </div>

          <span className="px-3 py-1 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-bold shrink-0">
            去主页 &gt;
          </span>
        </div>

        {/* Single 4-Column Functional Entry Row (Clicking opens dedicated sub-page) */}
        <div className="grid grid-cols-4 py-4 px-2 text-center bg-white dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setSubPage('my_lost')}
            className="flex flex-col items-center gap-1.5 py-1 cursor-pointer group"
          >
            <span className="text-[21px] font-black font-mono leading-none text-slate-950 dark:text-white group-hover:text-[#FF5000] transition-colors">
              {myLostItems.length}
            </span>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 group-hover:text-[#FF5000]">
              我丢失的
            </span>
          </button>

          <button
            type="button"
            onClick={() => setSubPage('my_found')}
            className="flex flex-col items-center gap-1.5 py-1 cursor-pointer group"
          >
            <span className="text-[21px] font-black font-mono leading-none text-slate-950 dark:text-white group-hover:text-[#FF5000] transition-colors">
              {myFoundItems.length}
            </span>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 group-hover:text-[#FF5000]">
              我捡到的
            </span>
          </button>

          <button
            type="button"
            onClick={() => setSubPage('history')}
            className="flex flex-col items-center gap-1.5 py-1 cursor-pointer group"
          >
            <span className="text-[21px] font-black font-mono leading-none text-slate-950 dark:text-white group-hover:text-[#FF5000] transition-colors">
              {myHistoryItems.length}
            </span>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 group-hover:text-[#FF5000]">
              历史发布
            </span>
          </button>

          <button
            type="button"
            onClick={() => setSubPage('browsing_history')}
            className="flex flex-col items-center gap-1.5 py-1 cursor-pointer group"
          >
            <span className="text-[21px] font-black font-mono leading-none text-slate-950 dark:text-white group-hover:text-[#FF5000] transition-colors">
              {browsedItems.length}
            </span>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 group-hover:text-[#FF5000]">
              历史浏览
            </span>
          </button>
        </div>
      </div>

      {/* 3. MY WALLET CARD (我的钱包：领取的赏金进入钱包，显示余额和出入账记录) */}
      <div
        onClick={() => setSubPage('wallet')}
        className="bg-white dark:bg-slate-900 rounded-[24px] p-4 shadow-2xs border border-slate-100 dark:border-slate-800 space-y-3 cursor-pointer hover:border-orange-200 transition-all"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-orange-50 dark:bg-orange-950/60 text-[#FF5000] flex items-center justify-center shrink-0">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-black text-slate-950 dark:text-white">我的钱包</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                领取的悬赏赏金自动入账 · 查看余额与出入账明细
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 text-right">
            <div>
              <div className="text-base font-black font-mono text-[#FF5000]">
                ¥{walletBalance.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-400">可用余额</div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </div>
        </div>

        {/* Latest 2 Wallet Records Preview */}
        <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
          <span>
            累计赏金入账 <strong className="font-mono text-[#FF5000]">+¥{totalIncome.toFixed(2)}</strong>
          </span>
          <span>
            悬赏支出 <strong className="font-mono text-slate-800 dark:text-slate-200">-¥{totalExpense.toFixed(2)}</strong>
          </span>
          <span className="text-[#FF6B2C] font-bold">账单明细 &gt;</span>
        </div>
      </div>

      {/* 4. HANDOVER VERIFICATION & CLAIMS CARD (点击进入独立认领交接页) */}
      <div className="bg-white dark:bg-slate-900 rounded-[24px] p-4 shadow-2xs border border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setSubPage('claims')}
          className="w-full flex items-center justify-between gap-3 cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-[#0066CC] dark:text-blue-400 flex items-center justify-center shrink-0">
              <QrCode className="w-5 h-5" />
            </div>
            <div className="text-left">
              <div className="text-sm font-black text-slate-950 dark:text-white">
                认领进度与交接码
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {currentUser.role === 'admin'
                  ? '审核认领申请与管理线下当面交接凭证'
                  : '查看认领进度与出示线下当面交接凭证'}
              </div>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* 5. DATA VISUALIZATION & AI MODEL EVALUATION DASHBOARD CARD */}
      <div className="bg-white dark:bg-slate-900 rounded-[24px] p-4 shadow-2xs border border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setSubPage('analytics')}
          className="w-full flex items-center justify-between gap-3 cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div className="text-left">
              <div className="text-sm font-black text-slate-950 dark:text-white">
                数据可视化与模型评测看板
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                YOLO26n + OpenCLIP 运行监测 · 校园分类/热力图表 · 三策略评测对比
              </div>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {renderSharedModals()}
    </div>
  );
};
