/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Plus,
  Calendar,
  MapPin,
  Home,
  MessageCircle,
  User,
  ChevronDown,
  ChevronRight,
  X,
  Check,
  CheckCircle2,
  AlertCircle,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  CAMPUS_CATEGORIES,
  CAMPUS_LOCATION_AREAS,
  CampusCategory,
  CampusLocationArea,
  ClaimRecord,
  DEFAULT_MATCHING_CONFIG,
  ImageEmbedding,
  ItemStatus,
  LostFoundItem,
  MatchRecord,
  MessageRecord,
  resolveCanonicalAuthProfile,
  UserProfile,
} from './types/models';
import { SEED_USERS } from './data/seedData';
import { auth, ensureAnonymousOrActiveSession } from './lib/firebase';
import {
  createClaimRequest,
  fetchAllDataBundle,
  recordUserBrowsingHistory,
  resetToDeterministic12DemoData,
  updateUserDarkModePreference,
} from './services/firestoreService';
import { ResilientItemImage } from './components/QrCodeSvg';
import { AuthModal } from './components/AuthModal';
import { MessagesCenterView } from './components/MessagesCenterView';
import { SmartMatchWizardView } from './components/SmartMatchWizardView';
import { ProfileCenterView } from './components/ProfileCenterView';
import {
  ActiveThreadTarget,
  cleanDisplayName,
  getCounterpartyUidForMessage,
  PublicUserProfileModal,
  resolveUserProfile,
} from './components/PublicUserProfileModal';

type BottomTab = 'home' | 'messages' | 'match' | 'profile';

const TAB_ORDER: BottomTab[] = ['home', 'messages', 'match', 'profile'];

const STATUS_LABELS: Record<ItemStatus, string> = {
  open: '寻找中',
  matching: '寻找中',
  claiming: '认领中',
  handover: '待交接',
  returned: '已归还',
  delisted: '已下架',
};

export function parseFlexibleDateFilter(raw: string, bound: 'start' | 'end'): number | null {
  const trimmed = (raw || '').trim().replace(/\//g, '-');
  if (!trimmed) return null;
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnlyMatch) {
    const yyyy = dateOnlyMatch[1];
    const mm = dateOnlyMatch[2].padStart(2, '0');
    const dd = dateOnlyMatch[3].padStart(2, '0');
    const iso =
      bound === 'start' ? `${yyyy}-${mm}-${dd}T00:00:00` : `${yyyy}-${mm}-${dd}T23:59:59.999`;
    const ts = Date.parse(iso);
    return Number.isNaN(ts) ? null : ts;
  }
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(/\s+/, 'T');
  const ts = Date.parse(normalized);
  return Number.isNaN(ts) ? null : ts;
}

type FilterDropdownKey = 'sort' | 'bounty' | 'location' | 'category' | 'time' | null;

export default function App() {
  const [activeTab, setActiveTab] = useState<BottomTab>('home');
  const [previousTab, setPreviousTab] = useState<BottomTab>('home');
  const [isPillMoving, setIsPillMoving] = useState(false);
  const [isDraggingPill, setIsDraggingPill] = useState(false);
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const navDockRef = useRef<HTMLElement | null>(null);
  const dragStartXRef = useRef<number | null>(null);
  const moveTimerRef = useRef<number | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);

  const [currentUser, setCurrentUser] = useState<UserProfile>({
    ...SEED_USERS[1],
    isDemoRole: true,
  });

  // Firestore state
  const [users, setUsers] = useState<UserProfile[]>(SEED_USERS);
  const usersRef = useRef<UserProfile[]>(SEED_USERS);
  useEffect(() => {
    usersRef.current = users;
  }, [users]);
  const [items, setItems] = useState<LostFoundItem[]>([]);
  const [embeddings, setEmbeddings] = useState<ImageEmbedding[]>([]);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loadingData, setLoadingData] = useState<boolean>(true);

  // Modals & Cross-Tab Routing State (Show quick-login sheet first on app launch)
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(true);
  const [selectedThread, setSelectedThread] = useState<ActiveThreadTarget | null>(null);
  const [viewingUserProfile, setViewingUserProfile] = useState<UserProfile | null>(null);

  // Item Detail Drawer on Home Feed
  const [detailItem, setDetailItem] = useState<LostFoundItem | null>(null);
  const [claimAnswerInput, setClaimAnswerInput] = useState('');
  const [submittingClaim, setSubmittingClaim] = useState(false);
  const [claimSuccessMsg, setClaimSuccessMsg] = useState<string | null>(null);
  const [claimErrorMsg, setClaimErrorMsg] = useState<string | null>(null);

  // Home Top Navigation (失物 | 拾物 | 全部) & Aligned 5-Dropdown Filter State
  const [homeChannel, setHomeChannel] = useState<'lost' | 'found' | 'all'>('lost');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeDropdown, setActiveDropdown] = useState<FilterDropdownKey>(null);
  const [sortBy, setSortBy] = useState<'latest' | 'bounty' | 'match'>('latest');
  const [onlyBounty, setOnlyBounty] = useState<boolean>(false);
  const [minBountyAmount, setMinBountyAmount] = useState<number>(0);
  const [locationFilter, setLocationFilter] = useState<'all' | CampusLocationArea | string>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | CampusCategory>('all');
  const [timePreset, setTimePreset] = useState<'all' | '24h' | '3d' | 'custom'>('all');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');

  // Sync dark mode class to <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  const triggerPillLensMotion = useCallback((durationMs = 480) => {
    setIsPillMoving(true);
    if (moveTimerRef.current) {
      window.clearTimeout(moveTimerRef.current);
    }
    moveTimerRef.current = window.setTimeout(() => {
      setIsPillMoving(false);
    }, durationMs);
  }, []);

  // Trigger liquid glass morphing animation on tab switch
  const handleSelectTab = useCallback(
    (nextTab: BottomTab) => {
      if (nextTab !== activeTab) {
        setPreviousTab(activeTab);
        setActiveTab(nextTab);
      }
      triggerPillLensMotion(480);
    },
    [activeTab, triggerPillLensMotion]
  );

  const computeProgressFromClientX = useCallback((clientX: number): number => {
    const navEl = navDockRef.current;
    if (!navEl) return 0;
    const rect = navEl.getBoundingClientRect();
    const innerWidth = Math.max(1, rect.width - 6);
    const slotWidth = innerWidth / 4;
    const relX = clientX - (rect.left + 3) - slotWidth / 2;
    const rawProgress = relX / slotWidth;
    return Math.max(0, Math.min(3, rawProgress));
  }, []);

  const handleDockPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    dragStartXRef.current = e.clientX;
  };

  const handleDockPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (dragStartXRef.current === null) return;
    const deltaX = Math.abs(e.clientX - dragStartXRef.current);
    if (deltaX > 6 || isDraggingPill) {
      if (!isDraggingPill) {
        setIsDraggingPill(true);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore if pointer capture is unsupported
        }
      }
      setDragProgress(computeProgressFromClientX(e.clientX));
    }
  };

  const handleDockPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (dragStartXRef.current === null) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    if (isDraggingPill && dragProgress !== null) {
      const snappedIdx = Math.max(0, Math.min(3, Math.round(dragProgress)));
      const targetTab = TAB_ORDER[snappedIdx];
      setIsDraggingPill(false);
      setDragProgress(null);
      handleSelectTab(targetTab);
    }
    dragStartXRef.current = null;
  };

  // Open item detail and record browsing history in Firestore
  const handleOpenItemDetail = useCallback(
    (item: LostFoundItem) => {
      setDetailItem(item);
      setClaimSuccessMsg(null);
      setClaimErrorMsg(null);
      setCurrentUser((prev) => {
        const prevIds = Array.isArray(prev.browsedItemIds)
          ? prev.browsedItemIds
          : ['demo_found_01', 'demo_found_02', 'demo_lost_03', 'demo_found_04'];
        const nextIds = [item.id, ...prevIds.filter((id) => id !== item.id)].slice(0, 30);
        const optimistic = { ...prev, browsedItemIds: nextIds };
        recordUserBrowsingHistory(optimistic, item.id).catch(() => {});
        return optimistic;
      });
    },
    []
  );

  const handleToggleDarkMode = useCallback((nextDark: boolean) => {
    setIsDarkMode(nextDark);
    setCurrentUser((prev) => {
      const updated = { ...prev, darkMode: nextDark };
      updateUserDarkModePreference(updated, nextDark).catch(() => {});
      return updated;
    });
  }, []);

  const handleSwitchUser = useCallback((nextUser: UserProfile) => {
    setSelectedThread(null);
    setDetailItem(null);
    setViewingUserProfile(null);
    setClaimSuccessMsg(null);
    setClaimErrorMsg(null);
    setClaimAnswerInput('');
    setCurrentUser(nextUser);
  }, []);

  const handleLogout = useCallback(() => {
    setSelectedThread(null);
    setDetailItem(null);
    setViewingUserProfile(null);
    setClaimSuccessMsg(null);
    setClaimErrorMsg(null);
    setClaimAnswerInput('');
    setIsAuthModalOpen(true);
  }, []);

  // Account-switch hygiene: immediately clear any open thread or drawer belonging to a previous user
  useEffect(() => {
    setSelectedThread((prev) =>
      prev && prev.viewerUid !== currentUser.uid ? null : prev
    );
    setDetailItem(null);
    setViewingUserProfile(null);
  }, [currentUser.uid]);

  useEffect(() => {
    ensureAnonymousOrActiveSession().catch(() => {});
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser && !fbUser.isAnonymous && fbUser.email) {
        setSelectedThread(null);
        setDetailItem(null);
        setViewingUserProfile(null);
        setCurrentUser(resolveCanonicalAuthProfile(fbUser, usersRef.current, SEED_USERS));
      }
    });
    return () => unsub();
  }, []);

  const loadDataFromFirestore = useCallback(async (allowAutoSeed = false) => {
    setLoadingData(true);
    try {
      await ensureAnonymousOrActiveSession();
      let bundle = await fetchAllDataBundle();
      const hasMultiAnglePhotos = bundle.items.some(
        (i) => i.id === 'demo_found_01' && i.imageUrl?.includes('found_angle_')
      );
      const hasRound12ScenePhotos =
        bundle.items.some(
          (i) => i.id === 'demo_lost_04' && i.imageUrl === '/images/tumbler-lost.jpg'
        ) &&
        bundle.items.some((i) => i.id === 'demo_lost_07') &&
        bundle.items.some((i) => i.id === 'demo_found_08');
      const hasPlainWhiteAirpods = bundle.items.some(
        (i) => i.id === 'demo_lost_02' && !i.title.includes('星星') && !i.title.includes('黄')
      );
      const hasCleanQrPayloads =
        bundle.claims.length > 0 &&
        bundle.claims.every((c) => !c.qrPayload || /^\d{6}$/.test(c.qrPayload));
      if (
        allowAutoSeed &&
        (bundle.items.length === 0 ||
          !hasMultiAnglePhotos ||
          !hasRound12ScenePhotos ||
          !hasPlainWhiteAirpods ||
          !hasCleanQrPayloads ||
          bundle.users.length < 5)
      ) {
        await resetToDeterministic12DemoData(
          SEED_USERS[0],
          bundle.items.length === 0 ? 'if_empty' : 'reset'
        );
        bundle = await fetchAllDataBundle();
      }
      if (bundle.users.length > 0) {
        setUsers(bundle.users);
      }
      setItems(bundle.items);
      setEmbeddings(bundle.embeddings);
      setMatches(bundle.matches);
      setClaims(bundle.claims);
      setMessages(bundle.messages);

      setCurrentUser((prev) => {
        const matchedProfile = bundle.users.find((u) => u.uid === prev.uid);
        if (matchedProfile) {
          if (typeof matchedProfile.darkMode === 'boolean') {
            setIsDarkMode(matchedProfile.darkMode);
          }
          return { ...prev, ...matchedProfile };
        }
        return prev;
      });
    } catch (err) {
      console.error('Failed to load Firestore bundle:', err);
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    loadDataFromFirestore(true);
  }, [loadDataFromFirestore]);

  const activeItems = useMemo(
    () => items.filter((item) => item.status !== 'delisted'),
    [items]
  );

  const activeMatches = useMemo(
    () => {
      const activeIdSet = new Set(activeItems.map((i) => i.id));
      return matches.filter(
        (m) => activeIdSet.has(m.lostItemId) && activeIdSet.has(m.foundItemId)
      );
    },
    [matches, activeItems]
  );

  const bestMatchByItemId = useMemo(() => {
    const map = new Map<string, MatchRecord>();
    for (const m of activeMatches) {
      if (m.status === 'excluded') continue;
      const prevLost = map.get(m.lostItemId);
      if (!prevLost || m.totalScore > prevLost.totalScore) {
        map.set(m.lostItemId, m);
      }
      const prevFound = map.get(m.foundItemId);
      if (!prevFound || m.totalScore > prevFound.totalScore) {
        map.set(m.foundItemId, m);
      }
    }
    return map;
  }, [activeMatches]);

  // [B1], [G3], [P0-4], [P1-1] & [P1-4] Per-user unread count for bottom-nav 消息 badge:
  // Counts ONLY the current user's own unread active match alerts (>= 58.0, non-returned) plus their own incoming unread conversations.
  const { myUnreadMessageCenterCount, messagesByItemId } = useMemo(() => {
    const byItem = new Map<string, MessageRecord[]>();
    const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const m of sorted) {
      const list = byItem.get(m.itemId);
      if (list) {
        list.push(m);
      } else {
        byItem.set(m.itemId, [m]);
      }
    }

    if (currentUser.pushNotifyEnabled === false) {
      return {
        myUnreadMessageCenterCount: 0,
        messagesByItemId: byItem,
      };
    }

    const readSet = new Set(currentUser.readNotificationIds || []);
    const activeItemMap = new Map(activeItems.map((i) => [i.id, i]));
    const allItemMap = new Map(items.map((i) => [i.id, i]));
    const curEmail = currentUser.email.toLowerCase();

    // 1. Current user's unread >= 58.0 match alerts (excluding returned items)
    let unreadMatchAlerts = 0;
    for (const m of activeMatches) {
      if (m.status === 'excluded' || m.totalScore < DEFAULT_MATCHING_CONFIG.decisionThreshold) {
        continue;
      }
      const lostItem = activeItemMap.get(m.lostItemId);
      const foundItem = activeItemMap.get(m.foundItemId);
      if (!lostItem || !foundItem) continue;
      if (lostItem.status === 'returned' || foundItem.status === 'returned') continue;
      const isLostMine =
        lostItem.ownerUid === currentUser.uid ||
        (Boolean(curEmail) && lostItem.ownerEmail?.toLowerCase() === curEmail);
      const isFoundMine =
        foundItem.ownerUid === currentUser.uid ||
        (Boolean(curEmail) && foundItem.ownerEmail?.toLowerCase() === curEmail);
      if (!isLostMine && !isFoundMine) continue;
      if (!readSet.has(`sys_match_${m.id}`)) {
        unreadMatchAlerts += 1;
      }
    }

    // 2. Current user's unread participant conversation threads (self-sent messages never count as unread)
    const latestMsgByThread = new Map<string, MessageRecord>();
    for (const m of sorted) {
      const item = allItemMap.get(m.itemId);
      const itemMsgs = byItem.get(m.itemId) || [];
      const counterpartyUid = getCounterpartyUidForMessage(
        m,
        currentUser.uid,
        itemMsgs,
        item
      );
      if (!counterpartyUid || counterpartyUid === currentUser.uid) continue;
      const threadKey = `${m.itemId}::${counterpartyUid}`;
      latestMsgByThread.set(threadKey, m);
    }

    let unreadThreads = 0;
    for (const [threadKey, lastMsg] of latestMsgByThread.entries()) {
      if (
        lastMsg.senderUid !== currentUser.uid &&
        !readSet.has(`chat_${threadKey}::${lastMsg.id}`)
      ) {
        unreadThreads += 1;
      }
    }

    return {
      myUnreadMessageCenterCount: unreadMatchAlerts + unreadThreads,
      messagesByItemId: byItem,
    };
  }, [
    activeMatches,
    activeItems,
    items,
    messages,
    currentUser.uid,
    currentUser.email,
    currentUser.readNotificationIds,
    currentUser.pushNotifyEnabled,
  ]);

  // Zero-flash synchronous guard: never pass a selectedThread opened by a previous user
  const effectiveSelectedThread =
    selectedThread &&
    selectedThread.viewerUid === currentUser.uid &&
    selectedThread.counterpartyUid !== currentUser.uid
      ? selectedThread
      : null;

  const filteredHomeItems = useMemo(() => {
    const nowTs = Date.now();
    const list = activeItems.filter((item) => {
      // [P0-4] Hide completed/returned posts by default on the Home feed (still accessible in Personal Center)
      if (item.status === 'returned') return false;
      if (homeChannel !== 'all' && item.type !== homeChannel) return false;
      if (onlyBounty && (item.rewardAmount || 0) <= 0) return false;
      if (minBountyAmount > 0 && (item.rewardAmount || 0) < minBountyAmount) return false;
      if (categoryFilter !== 'all' && item.campusCategory !== categoryFilter) return false;
      if (locationFilter && locationFilter !== 'all') {
        const itemArea = (item.locationArea || item.location.split('·')[0]).trim();
        if (
          itemArea !== locationFilter &&
          !item.location.toLowerCase().includes(locationFilter.trim().toLowerCase())
        ) {
          return false;
        }
      }

      // [P1-2] Compare 24h / 3d relative to real current time rather than a hardcoded 2026-11-08 timestamp
      if (timePreset === '24h') {
        const tItem = Date.parse(item.eventTime);
        if (!Number.isNaN(tItem) && Math.abs(nowTs - tItem) > 24 * 3600 * 1000) return false;
      } else if (timePreset === '3d') {
        const tItem = Date.parse(item.eventTime);
        if (!Number.isNaN(tItem) && Math.abs(nowTs - tItem) > 72 * 3600 * 1000) return false;
      }

      if (timeStart.trim()) {
        const tItem = Date.parse(item.eventTime);
        const tMin = parseFlexibleDateFilter(timeStart, 'start');
        if (!Number.isNaN(tItem) && tMin !== null && tItem < tMin) return false;
      }
      if (timeEnd.trim()) {
        const tItem = Date.parse(item.eventTime);
        const tMax = parseFlexibleDateFilter(timeEnd, 'end');
        if (!Number.isNaN(tItem) && tMax !== null && tItem > tMax) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const hay = `${item.title} ${item.description} ${item.campusCategory} ${item.location} ${item.locationArea || ''} ${item.locationDetail || ''} ${item.color || ''} ${item.brand || ''} ${(item.keywords || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return list.sort((a, b) => {
      if (sortBy === 'bounty') {
        return (b.rewardAmount || 0) - (a.rewardAmount || 0);
      }
      if (sortBy === 'match') {
        const scoreA = bestMatchByItemId.get(a.id)?.totalScore || 0;
        const scoreB = bestMatchByItemId.get(b.id)?.totalScore || 0;
        return scoreB - scoreA;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [
    activeItems,
    homeChannel,
    onlyBounty,
    minBountyAmount,
    categoryFilter,
    locationFilter,
    timePreset,
    timeStart,
    timeEnd,
    searchQuery,
    sortBy,
    bestMatchByItemId,
  ]);

  const handleQuickClaimSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailItem || !claimAnswerInput.trim()) return;
    if (detailItem.ownerUid === currentUser.uid) return;
    setSubmittingClaim(true);
    setClaimSuccessMsg(null);
    setClaimErrorMsg(null);
    try {
      const topMatch = bestMatchByItemId.get(detailItem.id);
      await createClaimRequest({
        item: detailItem,
        matchId: topMatch?.id,
        verificationAnswer: claimAnswerInput.trim(),
        actor: currentUser,
      });
      setClaimAnswerInput('');
      // [P0-2] Never leak the 6-digit handoverCode before admin review approval
      setClaimSuccessMsg(
        detailItem.type === 'lost'
          ? '归还线索已提交！待管理员初审通过后，可在「我的 → 认领进度与交接码」完成当面核验归还。'
          : '认领核验已提交！待管理员审核通过后，可在「我的 → 认领进度与交接码」查看专属交接凭证。'
      );
      await loadDataFromFirestore(false);
    } catch (err) {
      setClaimErrorMsg(err instanceof Error ? err.message : '提交核验申请失败，请稍后重试');
    } finally {
      setSubmittingClaim(false);
    }
  };

  const activeTabIndex = Math.max(0, TAB_ORDER.indexOf(activeTab));
  const visualPillProgress = dragProgress !== null ? dragProgress : activeTabIndex;
  const isLensActive = isDraggingPill || isPillMoving;

  return (
    <div className="min-h-screen bg-[#E8ECF2] dark:bg-slate-950 text-[#111827] dark:text-slate-100 flex flex-col items-center justify-start sm:py-4 transition-colors">
      {/* Hidden SVG Filters for Open-Source Liquid Glass & Convex Lens Refraction Effect */}
      <svg className="hidden" aria-hidden="true">
        <defs>
          <filter id="liquid-refraction-filter" x="-25%" y="-25%" width="150%" height="150%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.012 0.035"
              numOctaves="2"
              seed="7"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="9"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
          <filter id="liquid-lens-distortion" x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence
              type="turbulence"
              baseFrequency="0.014 0.042"
              numOctaves="1"
              seed="3"
              result="wave"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="wave"
              scale="7"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      {/* Mobile App Container Shell */}
      <div className="w-full sm:max-w-[450px] min-h-screen sm:min-h-[860px] bg-[#F5F6F8] dark:bg-slate-950 sm:rounded-[38px] sm:shadow-[0_24px_70px_rgba(15,23,42,0.18)] sm:border-[6px] sm:border-slate-900/90 flex flex-col relative overflow-hidden transition-colors">
        {/* Clean Top Navigation Header (Aligned to Top-Left) */}
        {activeTab === 'home' && (
          <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-100 dark:border-slate-800 px-4 pt-3 pb-2 flex items-center justify-start transition-colors">
            <div className="flex items-baseline gap-6">
              {[
                { key: 'lost', label: '失物' },
                { key: 'found', label: '拾物' },
                { key: 'all', label: '全部' },
              ].map((ch) => {
                const active = homeChannel === ch.key;
                return (
                  <button
                    key={ch.key}
                    type="button"
                    onClick={() => setHomeChannel(ch.key as any)}
                    className={`relative pb-1.5 transition-all cursor-pointer ${
                      active
                        ? 'text-[20px] font-black text-slate-950 dark:text-white tracking-tight'
                        : 'text-[16px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    <span>{ch.label}</span>
                    {active && (
                      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-[3.5px] rounded-full bg-[#FFE14D]" />
                    )}
                  </button>
                );
              })}
            </div>
          </header>
        )}

        {/* Scrollable Main Content Area (with bottom padding for fixed liquid-glass dock) */}
        <main className="flex-1 px-3.5 pt-3 pb-28 overflow-y-auto">
          {loadingData ? (
            <div className="grid grid-cols-2 gap-3 pt-2">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="bg-white dark:bg-slate-900 rounded-2xl h-64 animate-pulse p-3 flex flex-col justify-between border border-slate-200/60 dark:border-slate-800"
                >
                  <div className="w-full h-36 bg-slate-200/70 dark:bg-slate-800 rounded-xl" />
                  <div className="space-y-2">
                    <div className="w-3/4 h-3.5 bg-slate-200 dark:bg-slate-800 rounded" />
                    <div className="w-1/2 h-3 bg-slate-200/70 dark:bg-slate-800 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : activeTab === 'home' ? (
            <div className="space-y-3">
              {/* Search Bar + Aligned 5-Dropdown Filter Row (Reference Image 2 UI) */}
              <div className="bg-white dark:bg-slate-900 rounded-3xl px-3.5 pt-3 pb-2.5 shadow-2xs border border-slate-200/70 dark:border-slate-800 space-y-2">
                {/* Capsule Search Input */}
                <div className="relative flex items-center h-10 rounded-full border-[1.8px] border-slate-900 dark:border-slate-600 bg-white dark:bg-slate-900 pl-3.5 pr-1">
                  <Search className="w-4 h-4 text-slate-500 shrink-0 mr-2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      homeChannel === 'lost'
                        ? '搜索丢失物品名称、地点、特征...'
                        : homeChannel === 'found'
                        ? '搜索拾获物品名称、地点、特征...'
                        : '搜索物品名称、地点、特征...'
                    }
                    className="flex-1 text-xs bg-transparent dark:text-white focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer mr-1"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveDropdown(null)}
                    className="h-7 px-3.5 rounded-full bg-slate-900 dark:bg-[#FF6B2C] text-white text-xs font-bold flex items-center justify-center shrink-0 cursor-pointer"
                  >
                    搜索
                  </button>
                </div>

                {/* Aligned 5-Column Dropdown Filter Bar (Matching Reference Image 2: 综合 ⌄ | 悬赏 ⌄ | 区域 ⌄ | 分类 ⌄ | 时间 ⌄) */}
                <div className="grid grid-cols-5 items-center pt-0.5">
                  {/* 1. 综合 (Sort Dropdown) */}
                  <button
                    type="button"
                    onClick={() =>
                      setActiveDropdown((prev) => (prev === 'sort' ? null : 'sort'))
                    }
                    className={`h-8 px-1 flex items-center justify-center gap-0.5 text-[13px] transition-colors cursor-pointer ${
                      sortBy !== 'latest' || activeDropdown === 'sort'
                        ? 'font-black text-slate-950 dark:text-white'
                        : 'font-semibold text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate">
                      {sortBy === 'latest'
                        ? '综合'
                        : sortBy === 'bounty'
                        ? '赏金'
                        : '匹配'}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                        activeDropdown === 'sort' ? 'rotate-180 text-[#FF5000]' : 'text-slate-500'
                      }`}
                    />
                  </button>

                  {/* 2. 悬赏 (Bounty Dropdown) */}
                  <button
                    type="button"
                    onClick={() =>
                      setActiveDropdown((prev) => (prev === 'bounty' ? null : 'bounty'))
                    }
                    className={`h-8 px-1 flex items-center justify-center gap-0.5 text-[13px] transition-colors cursor-pointer ${
                      onlyBounty || minBountyAmount > 0 || activeDropdown === 'bounty'
                        ? 'font-black text-[#FF5000]'
                        : 'font-semibold text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate">
                      {minBountyAmount > 0
                        ? `¥${minBountyAmount}+`
                        : onlyBounty
                        ? '有悬赏'
                        : '悬赏'}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                        activeDropdown === 'bounty'
                          ? 'rotate-180 text-[#FF5000]'
                          : onlyBounty || minBountyAmount > 0
                          ? 'text-[#FF5000]'
                          : 'text-slate-500'
                      }`}
                    />
                  </button>

                  {/* 3. 区域 (Location Dropdown) */}
                  <button
                    type="button"
                    onClick={() =>
                      setActiveDropdown((prev) => (prev === 'location' ? null : 'location'))
                    }
                    className={`h-8 px-1 flex items-center justify-center gap-0.5 text-[13px] transition-colors cursor-pointer ${
                      locationFilter !== 'all' || activeDropdown === 'location'
                        ? 'font-black text-[#FF5000]'
                        : 'font-semibold text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate">
                      {locationFilter === 'all' ? '区域' : locationFilter}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                        activeDropdown === 'location'
                          ? 'rotate-180 text-[#FF5000]'
                          : locationFilter !== 'all'
                          ? 'text-[#FF5000]'
                          : 'text-slate-500'
                      }`}
                    />
                  </button>

                  {/* 4. 分类 (Category Dropdown) */}
                  <button
                    type="button"
                    onClick={() =>
                      setActiveDropdown((prev) => (prev === 'category' ? null : 'category'))
                    }
                    className={`h-8 px-1 flex items-center justify-center gap-0.5 text-[13px] transition-colors cursor-pointer ${
                      categoryFilter !== 'all' || activeDropdown === 'category'
                        ? 'font-black text-[#FF5000]'
                        : 'font-semibold text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate">
                      {categoryFilter === 'all' ? '分类' : categoryFilter}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                        activeDropdown === 'category'
                          ? 'rotate-180 text-[#FF5000]'
                          : categoryFilter !== 'all'
                          ? 'text-[#FF5000]'
                          : 'text-slate-500'
                      }`}
                    />
                  </button>

                  {/* 5. 时间 (Time Filter Dropdown) */}
                  <button
                    type="button"
                    onClick={() =>
                      setActiveDropdown((prev) => (prev === 'time' ? null : 'time'))
                    }
                    className={`h-8 px-1 flex items-center justify-center gap-0.5 text-[13px] transition-colors cursor-pointer ${
                      timePreset !== 'all' || timeStart || timeEnd || activeDropdown === 'time'
                        ? 'font-black text-[#FF5000]'
                        : 'font-semibold text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate">
                      {timePreset === '24h'
                        ? '24h内'
                        : timePreset === '3d'
                        ? '近3天'
                        : timePreset === 'custom'
                        ? '日期'
                        : '筛选'}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                        activeDropdown === 'time'
                          ? 'rotate-180 text-[#FF5000]'
                          : timePreset !== 'all' || timeStart || timeEnd
                          ? 'text-[#FF5000]'
                          : 'text-slate-500'
                      }`}
                    />
                  </button>
                </div>

                {/* Unified Dropdown Panel Beneath Filter Bar */}
                {activeDropdown === 'sort' && (
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
                    {[
                      { key: 'latest', label: '综合排序（最新发布优先）' },
                      { key: 'bounty', label: '悬赏金额从高到低' },
                      { key: 'match', label: '智能匹配度从高到低' },
                    ].map((opt) => {
                      const selected = sortBy === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => {
                            setSortBy(opt.key as any);
                            setActiveDropdown(null);
                          }}
                          className={`w-full px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer ${
                            selected
                              ? 'bg-orange-50 dark:bg-orange-950/60 text-[#FF5000] font-bold'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          <span>{opt.label}</span>
                          {selected && <Check className="w-3.5 h-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {activeDropdown === 'bounty' && (
                  <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {[
                        { label: '全部帖子', only: false, min: 0 },
                        { label: '仅看有悬赏', only: true, min: 0 },
                        { label: '¥10 及以上', only: true, min: 10 },
                        { label: '¥20 及以上', only: true, min: 20 },
                        { label: '¥50 及以上', only: true, min: 50 },
                      ].map((preset) => {
                        const active =
                          onlyBounty === preset.only && minBountyAmount === preset.min;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() => {
                              setOnlyBounty(preset.only);
                              setMinBountyAmount(preset.min);
                              setActiveDropdown(null);
                            }}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                              active
                                ? 'bg-[#FF5000] text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {activeDropdown === 'location' && (
                  <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setLocationFilter('all');
                        setActiveDropdown(null);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                        locationFilter === 'all'
                          ? 'bg-[#FF5000] text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      全部区域
                    </button>
                    {CAMPUS_LOCATION_AREAS.map((area) => (
                      <button
                        key={area}
                        type="button"
                        onClick={() => {
                          setLocationFilter(area);
                          setActiveDropdown(null);
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                          locationFilter === area
                            ? 'bg-[#FF5000] text-white'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {area}
                      </button>
                    ))}
                  </div>
                )}

                {activeDropdown === 'category' && (
                  <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setCategoryFilter('all');
                        setActiveDropdown(null);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                        categoryFilter === 'all'
                          ? 'bg-[#FF5000] text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      全部分类
                    </button>
                    {CAMPUS_CATEGORIES.filter((c) => c.value !== 'unknown').map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => {
                          setCategoryFilter(c.value);
                          setActiveDropdown(null);
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                          categoryFilter === c.value
                            ? 'bg-[#FF5000] text-white'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}

                {activeDropdown === 'time' && (
                  <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-semibold text-slate-500 mr-1">时间：</span>
                      {[
                        { key: 'all', label: '全部时间' },
                        { key: '24h', label: '24小时内' },
                        { key: '3d', label: '近3天' },
                        { key: 'custom', label: '指定日期' },
                      ].map((tp) => (
                        <button
                          key={tp.key}
                          type="button"
                          onClick={() => setTimePreset(tp.key as any)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                            timePreset === tp.key
                              ? 'bg-[#FF5000] text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {tp.label}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">开始日期</label>
                        <div className="relative">
                          <Calendar className="w-3 h-3 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={timeStart}
                            onChange={(e) => {
                              setTimeStart(e.target.value);
                              setTimePreset('custom');
                            }}
                            placeholder="2026-11-07"
                            className="w-full pl-7 pr-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">结束日期</label>
                        <input
                          type="text"
                          value={timeEnd}
                          onChange={(e) => {
                            setTimeEnd(e.target.value);
                            setTimePreset('custom');
                          }}
                          placeholder="2026-11-08"
                          className="w-full px-2.5 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setSortBy('latest');
                          setOnlyBounty(false);
                          setMinBountyAmount(0);
                          setLocationFilter('all');
                          setCategoryFilter('all');
                          setTimePreset('all');
                          setTimeStart('');
                          setTimeEnd('');
                          setActiveDropdown(null);
                        }}
                        className="text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer"
                      >
                        重置全部筛选
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveDropdown(null)}
                        className="px-3.5 py-1 rounded-xl bg-[#FF6B2C] text-white text-xs font-bold cursor-pointer"
                      >
                        确定
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 2-Column Waterfall/Grid Post Cards */}
              {filteredHomeItems.length === 0 ? (
                <div className="bg-white dark:bg-slate-900 rounded-3xl p-10 text-center space-y-3 border border-slate-200/70 dark:border-slate-800">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    没有找到符合条件的帖子
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setHomeChannel('all');
                      setSearchQuery('');
                      setOnlyBounty(false);
                      setMinBountyAmount(0);
                      setLocationFilter('all');
                      setCategoryFilter('all');
                      setTimePreset('all');
                      setTimeStart('');
                      setTimeEnd('');
                      setActiveDropdown(null);
                    }}
                    className="px-4 py-2 rounded-full bg-[#FF6B2C] text-white text-xs font-bold cursor-pointer"
                  >
                    查看全部帖子
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  {filteredHomeItems.map((item) => {
                    const hasBounty = item.type === 'lost' && (item.rewardAmount || 0) > 0;
                    return (
                      <article
                        key={item.id}
                        onClick={() => handleOpenItemDetail(item)}
                        className="bg-white dark:bg-slate-900 rounded-2xl overflow-hidden shadow-2xs border border-slate-200/75 dark:border-slate-800 hover:border-orange-300 transition-all flex flex-col justify-between cursor-pointer active:scale-[0.99]"
                      >
                        <div>
                          <div className="relative">
                            <ResilientItemImage
                              src={item.imageUrl}
                              alt={item.title}
                              category={item.campusCategory}
                              className="w-full h-38 object-cover"
                            />
                            <span
                              className={`absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-bold text-white shadow-2xs ${
                                item.type === 'lost' ? 'bg-[#FF5000]' : 'bg-[#0066CC]'
                              }`}
                            >
                              {item.type === 'lost' ? '失物' : '拾物'}
                            </span>
                          </div>

                          <div className="p-2.5 space-y-1.5">
                            <h3 className="text-xs font-bold text-slate-900 dark:text-white line-clamp-2 leading-snug">
                              {item.title}
                            </h3>

                            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 truncate">
                              <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                              <span className="truncate">{item.location}</span>
                            </div>

                            <div className="pt-0.5 flex items-baseline justify-between">
                              {hasBounty ? (
                                <div className="text-[#FF5000] font-extrabold flex items-baseline gap-0.5">
                                  <span className="text-[10px] font-bold bg-orange-100 dark:bg-orange-950/80 px-1 py-0.2 rounded mr-0.5">
                                    悬赏
                                  </span>
                                  <span className="text-xs">¥</span>
                                  <span className="text-base font-mono leading-none">
                                    {item.rewardAmount}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                                  {item.type === 'found' ? '拾物招领' : '寻物启事'}
                                </span>
                              )}

                              <span className="text-[10px] text-slate-400">
                                {STATUS_LABELS[item.status]}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="px-2.5 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                          <span className="truncate font-medium text-slate-700 dark:text-slate-300">
                            {(item.ownerName || '同学').replace(/\s*\(.*?\)/g, '')}
                          </span>
                          <span className="font-mono">
                            {item.eventTime.slice(5, 16).replace('T', ' ')}
                          </span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          ) : activeTab === 'messages' ? (
            <MessagesCenterView
              key={currentUser.uid}
              items={activeItems}
              matches={activeMatches}
              messages={messages}
              users={users}
              currentUser={currentUser}
              onUpdateCurrentUser={setCurrentUser}
              selectedThread={effectiveSelectedThread}
              onSelectThread={setSelectedThread}
              onOpenItemDetail={handleOpenItemDetail}
              onOpenUserProfile={setViewingUserProfile}
              onDataMutated={() => loadDataFromFirestore(false)}
            />
          ) : activeTab === 'match' ? (
            <SmartMatchWizardView
              items={activeItems}
              embeddings={embeddings}
              matches={activeMatches}
              currentUser={currentUser}
              onDataMutated={() => loadDataFromFirestore(false)}
              onOpenChatForItem={(itemId) => {
                const target = items.find((i) => i.id === itemId);
                if (target && target.ownerUid && target.ownerUid !== currentUser.uid) {
                  setSelectedThread({
                    viewerUid: currentUser.uid,
                    itemId: target.id,
                    counterpartyUid: target.ownerUid,
                  });
                } else {
                  setSelectedThread(null);
                }
                handleSelectTab('messages');
              }}
              onOpenItemDetail={handleOpenItemDetail}
              onPublishedNewItem={(newItem) => {
                setHomeChannel(newItem.type);
                handleSelectTab('home');
              }}
              onClosePublishTab={() =>
                handleSelectTab(previousTab === 'match' ? 'home' : previousTab)
              }
            />
          ) : (
            <ProfileCenterView
              key={currentUser.uid}
              currentUser={currentUser}
              users={users}
              onUpdateCurrentUser={setCurrentUser}
              onOpenAuthModal={() => setIsAuthModalOpen(true)}
              onLogout={handleLogout}
              isDarkMode={isDarkMode}
              onToggleDarkMode={handleToggleDarkMode}
              onOpenItemDetail={handleOpenItemDetail}
              onOpenUserProfile={setViewingUserProfile}
              allItems={items}
              activeItems={activeItems}
              matches={activeMatches}
              claims={claims}
              messages={messages}
              onDataMutated={() => loadDataFromFirestore(false)}
            />
          )}
        </main>

        {/* ==================== FIXED WHITE LIQUID-GLASS BOTTOM NAVIGATION BAR ==================== */}
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-26px)] max-w-[424px] pointer-events-auto select-none overflow-visible">
          <nav
            ref={navDockRef}
            aria-label="底部主导航"
            onPointerDown={handleDockPointerDown}
            onPointerMove={handleDockPointerMove}
            onPointerUp={handleDockPointerUp}
            onPointerCancel={handleDockPointerUp}
            className="didi-liquid-dock relative p-[3px] h-[64px] rounded-full grid grid-cols-4 items-center overflow-visible touch-none"
          >
            {/* 1. Base Navigation Items (Visible outside the glass lens) */}
            {/* Tab 1: 首页 */}
            <button
              type="button"
              onClick={() => {
                if (!isDraggingPill) handleSelectTab('home');
              }}
              className="relative z-10 h-[58px] min-h-[58px] rounded-full flex flex-col items-center justify-center transition-colors cursor-pointer"
            >
              <Home
                className={`w-[22px] h-[22px] transition-all duration-200 ${
                  activeTab === 'home' && !isLensActive
                    ? 'text-slate-950 fill-[#FFF3B0] stroke-[2.5] scale-105'
                    : 'text-slate-600 stroke-[2]'
                }`}
              />
              <span
                className={`text-[11px] mt-0.5 tracking-tight transition-colors duration-200 ${
                  activeTab === 'home' && !isLensActive
                    ? 'font-black text-slate-950'
                    : 'font-semibold text-slate-600'
                }`}
              >
                首页
              </span>
            </button>

            {/* Tab 2: 消息 */}
            <button
              type="button"
              onClick={() => {
                if (!isDraggingPill) handleSelectTab('messages');
              }}
              className="relative z-10 h-[58px] min-h-[58px] rounded-full flex flex-col items-center justify-center transition-colors cursor-pointer"
            >
              <div className="relative">
                <MessageCircle
                  className={`w-[22px] h-[22px] transition-all duration-200 ${
                    activeTab === 'messages' && !isLensActive
                      ? 'text-slate-950 fill-[#FFF3B0] stroke-[2.5] scale-105'
                      : 'text-slate-600 stroke-[2]'
                  }`}
                />
                {myUnreadMessageCenterCount > 0 && (
                  <span
                    data-testid="bottom-nav-messages-badge"
                    className="absolute -top-1 -right-2 w-2 h-2 rounded-full bg-[#FF3B30] ring-2 ring-white"
                  />
                )}
              </div>
              <span
                className={`text-[11px] mt-0.5 tracking-tight transition-colors duration-200 ${
                  activeTab === 'messages' && !isLensActive
                    ? 'font-black text-slate-950'
                    : 'font-semibold text-slate-600'
                }`}
              >
                消息
              </span>
            </button>

            {/* Tab 3: "+" 发布 (Soft Pale Yellow Plus Button) */}
            <button
              type="button"
              onClick={() => {
                if (!isDraggingPill) handleSelectTab('match');
              }}
              aria-label="发布或匹配物品"
              className="relative z-10 h-[58px] min-h-[58px] rounded-full flex flex-col items-center justify-center transition-transform active:scale-95 cursor-pointer"
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center shadow-sm transition-all duration-200 ${
                  activeTab === 'match' && !isLensActive
                    ? 'bg-slate-950 text-[#FFF3B0] scale-105'
                    : 'bg-[#FFF3B0] text-slate-950 border border-amber-200/80'
                }`}
              >
                <Plus className="w-5 h-5 stroke-[2.8]" />
              </div>
              <span
                className={`text-[10px] mt-0.5 tracking-tight transition-colors duration-200 ${
                  activeTab === 'match' && !isLensActive
                    ? 'font-black text-slate-950'
                    : 'font-semibold text-slate-600'
                }`}
              >
                发布
              </span>
            </button>

            {/* Tab 4: 我的 */}
            <button
              type="button"
              onClick={() => {
                if (!isDraggingPill) handleSelectTab('profile');
              }}
              className="relative z-10 h-[58px] min-h-[58px] rounded-full flex flex-col items-center justify-center transition-colors cursor-pointer"
            >
              <User
                className={`w-[22px] h-[22px] transition-all duration-200 ${
                  activeTab === 'profile' && !isLensActive
                    ? 'text-slate-950 fill-[#FFF3B0] stroke-[2.5] scale-105'
                    : 'text-slate-600 stroke-[2]'
                }`}
              />
              <span
                className={`text-[11px] mt-0.5 tracking-tight transition-colors duration-200 ${
                  activeTab === 'profile' && !isLensActive
                    ? 'font-black text-slate-950'
                    : 'font-semibold text-slate-600'
                }`}
              >
                我的
              </span>
            </button>

            {/* 2. Sliding Liquid-Glass Pill & Through-the-Glass Convex Lens Distortion Layer */}
            {/* Resting state fills the slot snugly (3px inset); Dragging state expands larger than the entire nav bar (scale 1.18 x 1.32) */}
            <div
              aria-hidden="true"
              style={{
                width: 'calc((100% - 6px) / 4)',
                transform: `translateX(${visualPillProgress * 100}%) scale(${
                  isLensActive ? '1.18, 1.32' : '1.01, 1.0'
                })`,
              }}
              className={`liquid-glass-pill absolute top-[3px] bottom-[3px] left-[3px] rounded-full pointer-events-none overflow-hidden ${
                isLensActive ? 'z-30 liquid-glass-pill-moving' : 'z-0'
              } ${isDraggingPill ? 'liquid-glass-pill-dragging' : ''}`}
            >
              {/* Synchronized Clipped Magnification & Refraction Layer (Visible when clicking/dragging the glass slider) */}
              {isLensActive && (
                <div
                  style={{
                    width: '400%',
                    transform: `translateX(${-visualPillProgress * 25}%)`,
                    filter: 'url(#liquid-lens-distortion)',
                  }}
                  className="h-full grid grid-cols-4 items-center bg-white/60 backdrop-blur-md"
                >
                  {/* Magnified & Refracted Tab 1: 首页 */}
                  <div className="flex flex-col items-center justify-center scale-[1.32] origin-center">
                    <Home className="w-[22px] h-[22px] text-slate-950 fill-[#FFF3B0] stroke-[2.5]" />
                    <span className="text-[11px] mt-0.5 font-black text-slate-950 tracking-tight">
                      首页
                    </span>
                  </div>

                  {/* Magnified & Refracted Tab 2: 消息 */}
                  <div className="flex flex-col items-center justify-center scale-[1.32] origin-center">
                    <MessageCircle className="w-[22px] h-[22px] text-slate-950 fill-[#FFF3B0] stroke-[2.5]" />
                    <span className="text-[11px] mt-0.5 font-black text-slate-950 tracking-tight">
                      消息
                    </span>
                  </div>

                  {/* Magnified & Refracted Tab 3: 发布 */}
                  <div className="flex flex-col items-center justify-center scale-[1.26] origin-center">
                    <div className="w-8 h-8 rounded-full bg-[#FFF3B0] text-slate-950 flex items-center justify-center shadow-sm border border-white">
                      <Plus className="w-5 h-5 stroke-[2.8]" />
                    </div>
                    <span className="text-[10px] mt-0.5 font-black text-slate-950 tracking-tight">
                      发布
                    </span>
                  </div>

                  {/* Magnified & Refracted Tab 4: 我的 */}
                  <div className="flex flex-col items-center justify-center scale-[1.32] origin-center">
                    <User className="w-[22px] h-[22px] text-slate-950 fill-[#FFF3B0] stroke-[2.5]" />
                    <span className="text-[11px] mt-0.5 font-black text-slate-950 tracking-tight">
                      我的
                    </span>
                  </div>
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* ==================== ITEM DETAIL BOTTOM SHEET ==================== */}
        {detailItem && (() => {
          const posterProfile = resolveUserProfile(
            detailItem.ownerUid,
            detailItem.ownerName,
            users
          );
          const posterName = cleanDisplayName(detailItem.ownerName || posterProfile.displayName);

          return (
            <div className="fixed inset-0 z-[70] bg-slate-900/55 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
              <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[88vh] flex flex-col border border-slate-100 dark:border-slate-800">
                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded-md text-xs font-bold text-white ${
                        detailItem.type === 'lost' ? 'bg-[#FF5000]' : 'bg-[#0066CC]'
                      }`}
                    >
                      {detailItem.type === 'lost' ? '失物求助' : '拾物招领'}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {detailItem.campusCategory} · {STATUS_LABELS[detailItem.status]}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetailItem(null)}
                    className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
                  {/* Clickable Poster Profile Card (Tap Avatar or Nickname to open Poster's Public Profile) */}
                  <button
                    type="button"
                    onClick={() => {
                      setDetailItem(null);
                      setViewingUserProfile(posterProfile);
                    }}
                    title={`查看 ${posterName} 的个人主页`}
                    className="w-full p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 hover:bg-orange-50/60 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-700 flex items-center justify-between gap-3 transition-colors cursor-pointer group text-left"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={posterProfile.avatarUrl}
                        alt={posterName}
                        className="w-10 h-10 rounded-full object-cover border border-slate-200 dark:border-slate-600 bg-amber-50 shrink-0 group-hover:ring-2 group-hover:ring-[#FF6B2C]/40 transition-all"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-extrabold text-slate-900 dark:text-white truncate group-hover:text-[#FF6B2C] transition-colors">
                            {posterName}
                          </span>
                          <span className="px-1.5 py-0.2 rounded bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold shrink-0">
                            实名认证
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                          {posterProfile.department || '校园实名认证同学'}
                          {posterProfile.className ? ` · ${posterProfile.className}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 text-[11px] font-bold text-[#FF6B2C] shrink-0">
                      <span>个人主页</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </button>

                  <ResilientItemImage
                    src={detailItem.imageUrl}
                    alt={detailItem.title}
                    category={detailItem.campusCategory}
                    className="w-full h-52 rounded-2xl object-cover border border-slate-200 dark:border-slate-700"
                  />

                  <div className="space-y-1">
                    {detailItem.type === 'lost' && (detailItem.rewardAmount || 0) > 0 && (
                      <div className="inline-flex items-baseline gap-1 px-2.5 py-1 rounded-xl bg-orange-50 dark:bg-orange-950/60 text-[#FF5000] font-extrabold">
                        <span className="text-xs">悬赏</span>
                        <span className="text-lg font-mono">¥{detailItem.rewardAmount}</span>
                      </div>
                    )}
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      {detailItem.title}
                    </h2>
                  </div>

                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {detailItem.description}
                  </p>

                  <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">地点：</span>
                      <span className="font-bold text-slate-900 dark:text-white">
                        {detailItem.location}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">
                        {detailItem.type === 'lost' ? '丢失时间：' : '拾获时间：'}
                      </span>
                      <span className="font-mono text-slate-800 dark:text-slate-200">
                        {detailItem.eventTime.replace('T', ' ')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">发布人：</span>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailItem(null);
                          setViewingUserProfile(posterProfile);
                        }}
                        className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200 hover:text-[#FF6B2C] cursor-pointer"
                      >
                        <img
                          src={posterProfile.avatarUrl}
                          alt={posterName}
                          className="w-4 h-4 rounded-full object-cover border border-slate-200 bg-amber-50"
                        />
                        <span>{posterName}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                      </button>
                    </div>
                  </div>

                  {/* [G5] Claim Verification Form: hidden when viewing own post or when post is already in handover/returned/delisted */}
                  {detailItem.ownerUid === currentUser.uid ? (
                    <div
                      data-testid="detail-own-post-notice"
                      className="p-3 rounded-2xl bg-slate-100/80 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2"
                    >
                      <ShieldCheck className="w-4 h-4 text-slate-500 shrink-0" />
                      <span>这是您本人发布的帖子，可在「我的」页面编辑内容或查看收到的认领与私信。</span>
                    </div>
                  ) : detailItem.status === 'handover' ||
                    detailItem.status === 'returned' ||
                    detailItem.status === 'delisted' ? (
                    <div
                      data-testid="detail-non-claimable-notice"
                      className="p-3 rounded-2xl bg-slate-100/80 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2"
                    >
                      <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>
                        该物品当前处于「{STATUS_LABELS[detailItem.status]}」状态，暂不接受新的认领申请。
                      </span>
                    </div>
                  ) : (
                    <form
                      onSubmit={handleQuickClaimSubmit}
                      className="p-3.5 rounded-2xl bg-blue-50/60 dark:bg-blue-950/40 border border-blue-200/80 dark:border-blue-800 space-y-2"
                    >
                      <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-[#0066CC]" />
                        <span>
                          {detailItem.type === 'found' ? '申请认领该物品' : '提供线索 / 归还该失物'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-300">
                        核对问题：{detailItem.verificationQuestion || '请描述物品独有特征：'}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={claimAnswerInput}
                          onChange={(e) => {
                            setClaimAnswerInput(e.target.value);
                            if (claimErrorMsg) setClaimErrorMsg(null);
                          }}
                          placeholder={
                            detailItem.type === 'found'
                              ? '填写物品特征提交认领审核...'
                              : '填写拾获实物特征提供归还线索...'
                          }
                          className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl"
                        />
                        <button
                          type="submit"
                          disabled={submittingClaim || !claimAnswerInput.trim()}
                          className="px-3 py-1.5 rounded-xl bg-[#0066CC] text-white text-xs font-bold cursor-pointer disabled:opacity-50 shrink-0"
                        >
                          {submittingClaim ? '提交中...' : '提交'}
                        </button>
                      </div>
                      {claimSuccessMsg && (
                        <div className="text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold flex items-center gap-1 pt-1">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          <span>{claimSuccessMsg}</span>
                        </div>
                      )}
                      {claimErrorMsg && (
                        <div className="text-[11px] text-red-600 dark:text-red-400 font-semibold flex items-center gap-1 pt-1">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>{claimErrorMsg}</span>
                        </div>
                      )}
                    </form>
                  )}
                </div>

                {/* Sticky Bottom Action Bar */}
                <div className="p-3.5 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      const targetItem = detailItem;
                      setDetailItem(null);
                      setViewingUserProfile(null);
                      if (targetItem.ownerUid && targetItem.ownerUid !== currentUser.uid) {
                        setSelectedThread({
                          viewerUid: currentUser.uid,
                          itemId: targetItem.id,
                          counterpartyUid: targetItem.ownerUid,
                        });
                      } else {
                        // Own post: if exactly one counterparty has messaged currentUser on this post, open that thread; otherwise open filtered messages list
                        const itemMsgs = messagesByItemId.get(targetItem.id) || [];
                        const peerUids = new Set<string>();
                        for (const m of itemMsgs) {
                          const peer = getCounterpartyUidForMessage(
                            m,
                            currentUser.uid,
                            itemMsgs,
                            targetItem
                          );
                          if (peer && peer !== currentUser.uid) {
                            peerUids.add(peer);
                          }
                        }
                        if (peerUids.size === 1) {
                          const solePeerUid = Array.from(peerUids)[0];
                          setSelectedThread({
                            viewerUid: currentUser.uid,
                            itemId: targetItem.id,
                            counterpartyUid: solePeerUid,
                          });
                        } else {
                          setSelectedThread(null);
                        }
                      }
                      handleSelectTab('messages');
                    }}
                    className="w-full py-2.5 rounded-2xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>
                      {detailItem.ownerUid === currentUser.uid ? '查看该帖消息' : '给发布者发私信'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Public User Profile Modal (Read-only for other users' posts) */}
      <PublicUserProfileModal
        user={viewingUserProfile}
        currentUser={currentUser}
        allItems={items}
        onClose={() => setViewingUserProfile(null)}
        onOpenItemDetail={handleOpenItemDetail}
      />

      {/* Account Switcher Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        currentUser={currentUser}
        users={users}
        onSelectUser={handleSwitchUser}
      />
    </div>
  );
}
