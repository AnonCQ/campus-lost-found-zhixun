/**
 * 认领进度与交接凭证页 (Production-Grade Mobile View with Strict Role & Voucher Separation)
 *
 * - Found-post claims ('claim_found') vs. Lost-post return clues ('return_lost'):
 *   - Unified role mapping via resolveClaimRoleActors:
 *     - loserUid (失主): exclusively views the 6-digit handoverCode + QR voucher after approval.
 *     - finderUid (拾主/实物持有人) or admin (值班老师): exclusively sees the 6-digit verification input box (never sees the voucher code on their own screen).
 * - Rejected applications can be supplemented and resubmitted cleanly by the applicant.
 * - Completed handovers unlock real mutual peer reviews between loser and finder.
 */

import React, { useMemo, useState } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  KeyRound,
  QrCode,
  AlertCircle,
  Clock,
  MapPin,
  Plus,
  ChevronDown,
  RefreshCw,
  Star,
} from 'lucide-react';
import {
  ClaimRecord,
  LostFoundItem,
  MessageRecord,
  resolveClaimRoleActors,
  UserProfile,
} from '../types/models';
import {
  createClaimRequest,
  reviewClaimByAdmin,
  submitHandoverMutualReview,
  verifyHandoverCodeAndComplete,
} from '../services/firestoreService';
import { QrCodeSvg, ResilientItemImage } from './QrCodeSvg';

interface ClaimsAndMessagesViewProps {
  items: LostFoundItem[];
  claims: ClaimRecord[];
  messages: MessageRecord[];
  currentUser: UserProfile;
  initialItemId?: string | null;
  onDataMutated: () => Promise<void>;
}

type ClaimFilterTab = 'all' | 'pending_review' | 'approved_handover' | 'completed';

export const ClaimsAndMessagesView: React.FC<ClaimsAndMessagesViewProps> = ({
  items,
  claims,
  currentUser,
  initialItemId,
  onDataMutated,
}) => {
  const isAdmin = currentUser.role === 'admin';

  // [G5] Exclude the current user's own posts and non-claimable posts from the + 认领/归还 dropdown
  const claimableItems = useMemo(
    () =>
      items.filter(
        (it) =>
          it.ownerUid !== currentUser.uid &&
          it.status !== 'delisted' &&
          it.status !== 'returned' &&
          it.status !== 'handover'
      ),
    [items, currentUser.uid]
  );

  const [statusFilter, setStatusFilter] = useState<ClaimFilterTab>('all');
  const [showNewClaimSheet, setShowNewClaimSheet] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>(
    initialItemId && claimableItems.some((i) => i.id === initialItemId)
      ? initialItemId
      : claimableItems[0]?.id || ''
  );
  const [newClaimAnswer, setNewClaimAnswer] = useState('');
  const [submittingNewClaim, setSubmittingNewClaim] = useState(false);
  const [claimErrorMsg, setClaimErrorMsg] = useState<string | null>(null);

  // Admin review loading state
  const [reviewingClaimId, setReviewingClaimId] = useState<string | null>(null);

  // Handover verification code input per claimId
  const [handoverCodeInputs, setHandoverCodeInputs] = useState<Record<string, string>>({});
  const [handoverError, setHandoverError] = useState<Record<string, string>>({});
  const [handoverSuccess, setHandoverSuccess] = useState<Record<string, boolean>>({});
  const [verifyingClaimId, setVerifyingClaimId] = useState<string | null>(null);

  // Rejected claim resubmission state per claimId
  const [resubmitInputs, setResubmitInputs] = useState<Record<string, string>>({});
  const [resubmittingId, setResubmittingId] = useState<string | null>(null);
  const [resubmitError, setResubmitError] = useState<Record<string, string>>({});

  // Mutual review state per completed claimId
  const [reviewRatings, setReviewRatings] = useState<Record<string, '好评' | '中评' | '差评'>>({});
  const [reviewContents, setReviewContents] = useState<Record<string, string>>({});
  const [submittingReviewId, setSubmittingReviewId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<Record<string, string>>({});

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const selectedItem =
    claimableItems.find((i) => i.id === selectedItemId) || claimableItems[0];

  // Role-isolated claim list:
  // - Admin sees all claims across the campus
  // - Student sees claims where they are the claimant, loser, finder, or owner of the associated item
  const visibleClaims = useMemo(() => {
    const roleFiltered = isAdmin
      ? claims
      : claims.filter((c) => {
          const item = itemById.get(c.itemId);
          const { loserUid, finderUid } = resolveClaimRoleActors(c, item);
          return (
            c.claimantUid === currentUser.uid ||
            item?.ownerUid === currentUser.uid ||
            loserUid === currentUser.uid ||
            finderUid === currentUser.uid
          );
        });

    if (statusFilter === 'all') return roleFiltered;
    return roleFiltered.filter((c) => c.status === statusFilter);
  }, [claims, isAdmin, currentUser.uid, itemById, statusFilter]);

  const handleCreateQuickClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedItem || !newClaimAnswer.trim()) return;
    if (selectedItem.ownerUid === currentUser.uid) {
      setClaimErrorMsg('不能对本人发布的帖子提交认领或归还申请');
      return;
    }
    setClaimErrorMsg(null);
    setSubmittingNewClaim(true);
    try {
      await createClaimRequest({
        item: selectedItem,
        verificationAnswer: newClaimAnswer.trim(),
        actor: currentUser,
      });
      setNewClaimAnswer('');
      setShowNewClaimSheet(false);
      await onDataMutated();
    } catch (err) {
      setClaimErrorMsg(err instanceof Error ? err.message : '提交核验申请失败');
    } finally {
      setSubmittingNewClaim(false);
    }
  };

  const handleResubmitRejectedClaim = async (claim: ClaimRecord, item: LostFoundItem) => {
    const nextAns = (resubmitInputs[claim.id] || '').trim();
    if (!nextAns) {
      setResubmitError((prev) => ({
        ...prev,
        [claim.id]: '请补充更具体的物品独有特征后再提交',
      }));
      return;
    }
    setResubmitError((prev) => ({ ...prev, [claim.id]: '' }));
    setResubmittingId(claim.id);
    try {
      await createClaimRequest({
        item,
        matchId: claim.matchId,
        verificationAnswer: nextAns,
        actor: currentUser,
      });
      setResubmitInputs((prev) => ({ ...prev, [claim.id]: '' }));
      await onDataMutated();
    } catch (err) {
      setResubmitError((prev) => ({
        ...prev,
        [claim.id]: err instanceof Error ? err.message : '重新提交失败',
      }));
    } finally {
      setResubmittingId(null);
    }
  };

  const handleAdminDecision = async (
    claim: ClaimRecord,
    decision: 'approved_handover' | 'rejected'
  ) => {
    if (!isAdmin) return;
    setReviewingClaimId(claim.id);
    try {
      const item = itemById.get(claim.itemId);
      const defaultNote =
        decision === 'approved_handover'
          ? '特征核对一致，已为失主签发 6 位交接码与专属二维码，请双方当面核验归还。'
          : '所填特征与实物留存信息不符，请补充细节后重新提交。';
      await reviewClaimByAdmin(claim, item, decision, defaultNote, currentUser);
      await onDataMutated();
    } finally {
      setReviewingClaimId(null);
    }
  };

  const handleVerifyHandover = async (claim: ClaimRecord) => {
    const inputVal = (handoverCodeInputs[claim.id] || '').trim();
    if (!inputVal) {
      setHandoverError((prev) => ({
        ...prev,
        [claim.id]: '请输入失主出示的 6 位数字交接码',
      }));
      return;
    }
    const item = itemById.get(claim.itemId);
    const { loserUid, finderUid } = resolveClaimRoleActors(claim, item);
    const canVerify =
      isAdmin || Boolean(finderUid && currentUser.uid === finderUid && currentUser.uid !== loserUid);
    if (!canVerify) {
      setHandoverError((prev) => ({
        ...prev,
        [claim.id]: '仅实物持有人（拾主）或值班管理员可核销交接码',
      }));
      return;
    }
    setHandoverError((prev) => ({ ...prev, [claim.id]: '' }));
    setVerifyingClaimId(claim.id);
    try {
      await verifyHandoverCodeAndComplete(claim, item, inputVal, currentUser);
      setHandoverSuccess((prev) => ({ ...prev, [claim.id]: true }));
      await onDataMutated();
    } catch (err) {
      setHandoverError((prev) => ({
        ...prev,
        [claim.id]: err instanceof Error ? err.message : '交接码核验未通过',
      }));
    } finally {
      setVerifyingClaimId(null);
    }
  };

  const handleSubmitMutualReview = async (claim: ClaimRecord, item?: LostFoundItem) => {
    const rating = reviewRatings[claim.id] || '好评';
    const content = (reviewContents[claim.id] || '').trim();
    if (!content) {
      setReviewError((prev) => ({ ...prev, [claim.id]: '请填写简短的交接评价内容' }));
      return;
    }
    setReviewError((prev) => ({ ...prev, [claim.id]: '' }));
    setSubmittingReviewId(claim.id);
    try {
      await submitHandoverMutualReview({
        claim,
        item,
        rating,
        content,
        actor: currentUser,
      });
      setReviewContents((prev) => ({ ...prev, [claim.id]: '' }));
      await onDataMutated();
    } catch (err) {
      setReviewError((prev) => ({
        ...prev,
        [claim.id]: err instanceof Error ? err.message : '评价提交失败',
      }));
    } finally {
      setSubmittingReviewId(null);
    }
  };

  return (
    <div className="space-y-3.5">
      {/* Top Status Filter Bar + New Claim/Return Entry */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 border border-slate-200/75 dark:border-slate-800 shadow-2xs space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl flex-1">
            {[
              { key: 'all' as const, label: '全部' },
              { key: 'pending_review' as const, label: '待审核' },
              { key: 'approved_handover' as const, label: '待交接' },
              { key: 'completed' as const, label: '已归还' },
            ].map((tab) => {
              const active = statusFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setStatusFilter(tab.key)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-white dark:bg-slate-900 text-slate-950 dark:text-white shadow-2xs'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setShowNewClaimSheet((v) => !v)}
            className="px-3 py-2 rounded-xl bg-[#FFE14D] hover:bg-[#FFCC00] text-slate-950 text-xs font-extrabold flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>认领 / 归还</span>
          </button>
        </div>

        {/* Collapsible New Claim / Return Clue Form */}
        {showNewClaimSheet &&
          (selectedItem ? (
            <form
              onSubmit={handleCreateQuickClaim}
              className="pt-2.5 border-t border-slate-100 dark:border-slate-800 space-y-2.5"
            >
              <div>
                <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1">
                  选择他人发布的拾物帖（申请认领）或失物帖（提供归还线索）
                </label>
                <div className="relative">
                  <select
                    value={selectedItem.id}
                    onChange={(e) => {
                      setSelectedItemId(e.target.value);
                      setClaimErrorMsg(null);
                    }}
                    className="w-full appearance-none pl-3 pr-8 py-2 text-xs font-medium bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-[#FF6B2C]"
                  >
                    {claimableItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        [{it.type === 'lost' ? '失物 · 提供归还' : '拾物 · 申请认领'}] {it.title}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 text-xs text-slate-600 dark:text-slate-300">
                <span className="font-bold text-slate-800 dark:text-slate-100">核验问题：</span>
                {selectedItem.verificationQuestion || '请描述物品独有特征（如贴纸、尾号、磨损位置）'}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  required
                  value={newClaimAnswer}
                  onChange={(e) => setNewClaimAnswer(e.target.value)}
                  placeholder={
                    selectedItem.type === 'lost'
                      ? '描述您拾获实物的独有特征以发起归还...'
                      : '填写物品独有特征回答以申请认领...'
                  }
                  className="flex-1 px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-[#FF6B2C]"
                />
                <button
                  type="submit"
                  disabled={submittingNewClaim || !newClaimAnswer.trim()}
                  className="px-4 py-2 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold whitespace-nowrap cursor-pointer disabled:opacity-50"
                >
                  {submittingNewClaim
                    ? '提交中...'
                    : selectedItem.type === 'lost'
                    ? '提交归还线索'
                    : '提交认领申请'}
                </button>
              </div>
              {claimErrorMsg && (
                <div className="text-[11px] font-semibold text-red-600">{claimErrorMsg}</div>
              )}
            </form>
          ) : (
            <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-400 text-center py-3">
              当前暂无可申请认领或提供归还的他人发布物品
            </div>
          ))}
      </div>

      {/* Claim Cards List */}
      {visibleClaims.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 rounded-3xl py-14 px-4 text-center space-y-2 border border-slate-200/75 dark:border-slate-800">
          <div className="text-xs font-bold text-slate-600 dark:text-slate-300">
            暂无相关认领或归还记录
          </div>
          <p className="text-[11px] text-slate-400">
            在首页物品详情页或点击右上角「认领 / 归还」提交特征核对后，可在此查看进度与交接凭证
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleClaims.map((claim) => {
            const item = itemById.get(claim.itemId);
            const { claimType, loserUid, finderUid } = resolveClaimRoleActors(claim, item);
            const isReturnLostFlow = claimType === 'return_lost';
            const isMyClaimApplication = claim.claimantUid === currentUser.uid;
            const isLoser = Boolean(loserUid && currentUser.uid === loserUid);
            const isFinder = Boolean(
              finderUid && currentUser.uid === finderUid && currentUser.uid !== loserUid
            );
            const canVerifyHandover = isAdmin || isFinder;
            const cleanClaimantName = claim.claimantName.replace(/\s*\(.*?\)/g, '');
            const cleanPostOwnerName = (item?.ownerName || '失物招领中心').replace(
              /\s*\(.*?\)/g,
              ''
            );

            const canResubmitRejected =
              claim.status === 'rejected' &&
              isMyClaimApplication &&
              Boolean(
                item &&
                  item.status !== 'delisted' &&
                  item.status !== 'returned' &&
                  item.status !== 'handover'
              );

            const alreadyReviewedByMe = Boolean(
              claim.reviewedParticipantUids?.includes(currentUser.uid)
            );
            const canParticipateInReview =
              claim.status === 'completed' && (isLoser || isFinder);

            const statusLabel =
              claim.status === 'pending_review'
                ? '待审核'
                : claim.status === 'approved_handover'
                ? '待当面交接'
                : claim.status === 'completed'
                ? '已归还'
                : '未通过';

            const statusTone =
              claim.status === 'completed'
                ? 'text-emerald-700 dark:text-emerald-400'
                : claim.status === 'approved_handover'
                ? 'text-[#0066CC] dark:text-blue-400'
                : claim.status === 'pending_review'
                ? 'text-[#FF5000] dark:text-orange-400'
                : 'text-red-600 dark:text-red-400';

            const relationTitle = isReturnLostFlow
              ? isMyClaimApplication
                ? '我提供归还线索'
                : `归还线索提供人：${cleanClaimantName}`
              : isMyClaimApplication
              ? '我申请认领'
              : `认领申请人：${cleanClaimantName}`;

            return (
              <div
                key={claim.id}
                className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-3.5"
              >
                {/* Top Header: Role Relation + Status */}
                <div className="flex items-center justify-between text-xs pb-2.5 border-b border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300 min-w-0">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                        isReturnLostFlow
                          ? 'bg-orange-50 text-[#FF5000] dark:bg-orange-950/60 dark:text-orange-300'
                          : 'bg-blue-50 text-[#0066CC] dark:bg-blue-950/60 dark:text-blue-300'
                      }`}
                    >
                      {isReturnLostFlow ? '失物归还' : '拾物认领'}
                    </span>
                    <span className="font-bold text-slate-900 dark:text-white truncate">
                      {relationTitle}
                    </span>
                    <span className="shrink-0">·</span>
                    <span className="font-mono text-[11px] text-slate-400 shrink-0">
                      {claim.createdAt.slice(5, 16).replace('T', ' ')}
                    </span>
                  </div>
                  <span className={`font-extrabold shrink-0 ml-2 ${statusTone}`}>
                    {statusLabel}
                  </span>
                </div>

                {/* Associated Item Summary Row */}
                <div className="flex items-center gap-3">
                  {item && (
                    <ResilientItemImage
                      src={item.imageUrl}
                      alt={item.title}
                      category={item.campusCategory}
                      className="w-16 h-16 rounded-2xl object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-xs font-bold text-slate-900 dark:text-white line-clamp-1">
                      {claim.itemTitle || item?.title}
                    </div>
                    {item && (
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 truncate">
                        <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="truncate">{item.location}</span>
                      </div>
                    )}
                    <div className="text-[11px] text-slate-400">
                      {isReturnLostFlow ? '失主发布人：' : '拾物发布人：'}
                      {cleanPostOwnerName}
                    </div>
                  </div>
                </div>

                {/* Verification Q&A Card */}
                <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/75 border border-slate-200/60 dark:border-slate-700/70 text-xs space-y-1.5">
                  <div className="text-slate-500 dark:text-slate-400">
                    核验问题：
                    {claim.verificationQuestion ||
                      item?.verificationQuestion ||
                      '物品细节特征核对'}
                  </div>
                  <div className="text-slate-900 dark:text-slate-100 font-semibold">
                    核验回答：{claim.verificationAnswer}
                  </div>
                  {claim.reviewNote && (
                    <div className="text-slate-600 dark:text-slate-300 pt-1.5 border-t border-slate-200/60 dark:border-slate-700 text-[11px]">
                      审核备注：{claim.reviewNote}
                    </div>
                  )}
                </div>

                {/* 1. PENDING_REVIEW STATE: Strict Role Separation (No handoverCode leaked to anyone) */}
                {claim.status === 'pending_review' &&
                  (isAdmin ? (
                    <div className="pt-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                        管理员特征核验审批：
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={reviewingClaimId === claim.id}
                          onClick={() => handleAdminDecision(claim, 'rejected')}
                          className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-red-50 dark:bg-slate-800 text-red-600 dark:text-red-400 text-xs font-bold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>驳回</span>
                        </button>
                        <button
                          type="button"
                          disabled={reviewingClaimId === claim.id}
                          onClick={() => handleAdminDecision(claim, 'approved_handover')}
                          className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>
                            {reviewingClaimId === claim.id ? '处理中...' : '通过并签发交接码'}
                          </span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-3.5 py-2.5 rounded-2xl bg-orange-50/80 dark:bg-orange-950/40 border border-orange-200/70 dark:border-orange-900/60 flex items-center gap-2 text-xs text-[#FF5000] dark:text-orange-300 font-semibold">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>特征核验信息已提交，待管理员审核通过后为失主签发当面交接凭证</span>
                    </div>
                  ))}

                {/* 2. REJECTED STATE: Resubmission Entry for Claimant ([P1-3]) */}
                {canResubmitRejected && item && (
                  <div className="p-3 rounded-2xl bg-red-50/60 dark:bg-red-950/30 border border-red-200/70 dark:border-red-900/60 space-y-2">
                    <div className="text-xs font-bold text-red-700 dark:text-red-300 flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>补充独有特征重新提交核验</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={resubmitInputs[claim.id] ?? ''}
                        onChange={(e) =>
                          setResubmitInputs((prev) => ({
                            ...prev,
                            [claim.id]: e.target.value,
                          }))
                        }
                        placeholder="请补充更准确的贴纸、尾号、划痕等细节..."
                        className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-slate-800 dark:text-white border border-red-200 dark:border-red-800 rounded-xl focus:outline-none focus:border-[#FF6B2C]"
                      />
                      <button
                        type="button"
                        disabled={resubmittingId === claim.id}
                        onClick={() => handleResubmitRejectedClaim(claim, item)}
                        className="px-3.5 py-1.5 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        {resubmittingId === claim.id ? '提交中...' : '重新提交'}
                      </button>
                    </div>
                    {resubmitError[claim.id] && (
                      <div className="text-[11px] font-semibold text-red-600">
                        {resubmitError[claim.id]}
                      </div>
                    )}
                  </div>
                )}

                {/* 3. APPROVED_HANDOVER STATE: Strict One-Way Voucher Protocol ([P0-2]) */}
                {claim.status === 'approved_handover' && (
                  <div className="p-4 rounded-2xl bg-slate-900 text-white space-y-3.5">
                    {isLoser ? (
                      /* Loser Side ONLY: Displays the 6-digit handoverCode + QR code (no verification input) */
                      <>
                        <div className="flex items-center justify-between gap-4">
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5 text-xs text-amber-300 font-bold">
                              <QrCode className="w-4 h-4" />
                              <span>线下当面交接凭证（失主专属）</span>
                            </div>
                            <div className="text-[11px] text-slate-400">6 位交接核验码</div>
                            <div
                              data-testid={`loser-handover-code-${claim.id}`}
                              className="text-3xl font-mono font-black tracking-widest text-white tabular-nums"
                            >
                              {claim.handoverCode}
                            </div>
                            <p className="text-[11px] text-slate-400 leading-snug pt-0.5">
                              请当面查验实物无误后，向拾主或值班老师出示此交接码完成核销
                            </p>
                          </div>

                          <div className="shrink-0 flex flex-col items-center bg-white p-2 rounded-2xl">
                            <QrCodeSvg
                              payload={claim.qrPayload || claim.handoverCode}
                              size={104}
                            />
                          </div>
                        </div>

                        <div className="pt-2.5 border-t border-slate-800 flex items-center gap-2 text-xs text-amber-300/90 font-medium">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>
                            安全提示：切勿在私信中提前发送交接码；对方核销后将同步完成归还与赏金结算
                          </span>
                        </div>
                      </>
                    ) : canVerifyHandover ? (
                      /* Finder / Admin Side ONLY: Displays ONLY the 6-digit verification input box (NEVER displays handoverCode or QR) */
                      <>
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5 text-xs text-amber-300 font-bold">
                            <KeyRound className="w-4 h-4" />
                            <span>线下当面交接核销（持有人 / 管理员核验端）</span>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed">
                            请在线下当面交付实物时，请失主出示其手机上的 6 位交接核验码并输入下方完成核销：
                          </p>
                        </div>

                        <div className="pt-1 flex items-center gap-2">
                          <div className="flex-1 flex items-center gap-2 bg-slate-800 rounded-xl px-3 py-2 border border-slate-700">
                            <KeyRound className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              value={handoverCodeInputs[claim.id] ?? ''}
                              onChange={(e) =>
                                setHandoverCodeInputs((prev) => ({
                                  ...prev,
                                  [claim.id]: e.target.value.replace(/\D/g, '').slice(0, 6),
                                }))
                              }
                              placeholder="请输入失主出示的 6 位交接码"
                              className="w-full bg-transparent text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none"
                            />
                          </div>
                          <button
                            type="button"
                            disabled={verifyingClaimId === claim.id}
                            onClick={() => handleVerifyHandover(claim)}
                            className="px-4 py-2 rounded-xl bg-[#FFE14D] hover:bg-[#FFCC00] text-slate-950 text-xs font-extrabold cursor-pointer whitespace-nowrap disabled:opacity-50"
                          >
                            {verifyingClaimId === claim.id ? '核验中...' : '确认交接归还'}
                          </button>
                        </div>

                        {handoverError[claim.id] && (
                          <div className="text-xs text-red-400 flex items-center gap-1.5">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>{handoverError[claim.id]}</span>
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                )}

                {/* 4. COMPLETED STATE: Completion Banner + Real Mutual Review Entry ([P2-1]) */}
                {claim.status === 'completed' && (
                  <div className="space-y-2.5">
                    <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/80 dark:border-emerald-800/70 flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>
                        已完成线下当面交接核销，物品已确认归还失主
                        {handoverSuccess[claim.id] ? '（已同步更新关联帖与赏金账单）' : ''}
                      </span>
                    </div>

                    {canParticipateInReview && (
                      <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/75 dark:border-slate-700 space-y-2.5">
                        {alreadyReviewedByMe ? (
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            <Star className="w-3.5 h-3.5 fill-current" />
                            <span>您已完成本次交接互评，评价已计入对方个人主页信用档案</span>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                                <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400" />
                                <span>评价本次当面交接（{isLoser ? '评价拾主' : '评价失主'}）</span>
                              </span>
                              <div className="flex items-center gap-1">
                                {(['好评', '中评', '差评'] as const).map((rt) => {
                                  const currentRt = reviewRatings[claim.id] || '好评';
                                  const active = currentRt === rt;
                                  return (
                                    <button
                                      key={rt}
                                      type="button"
                                      onClick={() =>
                                        setReviewRatings((prev) => ({ ...prev, [claim.id]: rt }))
                                      }
                                      className={`px-2 py-0.5 rounded-lg text-[11px] font-bold cursor-pointer transition-colors ${
                                        active
                                          ? 'bg-[#FF6B2C] text-white'
                                          : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                                      }`}
                                    >
                                      {rt}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={reviewContents[claim.id] ?? ''}
                                onChange={(e) =>
                                  setReviewContents((prev) => ({
                                    ...prev,
                                    [claim.id]: e.target.value,
                                  }))
                                }
                                placeholder={
                                  isLoser
                                    ? '感谢热心拾获归还，写下您的感谢评价...'
                                    : '写下对失主沟通与当面交接的评价...'
                                }
                                className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-[#FF6B2C]"
                              />
                              <button
                                type="button"
                                disabled={submittingReviewId === claim.id}
                                onClick={() => handleSubmitMutualReview(claim, item)}
                                className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-[#FF6B2C] text-white text-xs font-bold shrink-0 cursor-pointer disabled:opacity-50"
                              >
                                {submittingReviewId === claim.id ? '提交中...' : '提交评价'}
                              </button>
                            </div>

                            {reviewError[claim.id] && (
                              <div className="text-[11px] font-semibold text-red-600">
                                {reviewError[claim.id]}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
