/**
 * Two-Stage Campus Login & Account Switcher UI
 *
 * Stage 1 (`quick_sheet`):
 *   - Bottom sheet popup shown on app launch or when switching accounts.
 *   - Dropdown selector containing all 5 preset campus users (李明轩, 陈思琪, 王浩然, 林晓雯, 张老师).
 *   - Clicking "本机账号一键登录" logs in immediately as the selected user.
 *   - Clicking "其他登录方式" transitions to Stage 2 (`full_screen`).
 *
 * Stage 2 (`full_screen`):
 *   - Full-screen login view with server-side verified login paths:
 *     1. 账号密码: real server-side verification (POST /api/auth/password-login), salted scrypt hash,
 *        5 consecutive failures -> 60s lockout, quick-fill chips fill ONLY account identifier (never password).
 *     2. 邮箱验证码: real 2-step OTP flow (POST /api/auth/email-code + POST /api/auth/email-login),
 *        honest unconfigured message when SMTP secrets are absent.
 *     3. 手机号 & 人脸识别: honestly labeled 暂未开通 and cannot log in.
 *     4. Google: Firebase Google popup authentication (admin / campus user).
 */

import React, { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronDown,
  X,
  Check,
  Eye,
  EyeOff,
  Smartphone,
  Mail,
  ScanFace,
  KeyRound,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  Clock,
  Lock,
} from 'lucide-react';
import {
  ADMIN_WHITELIST_EMAIL,
  resolveCanonicalAuthProfile,
  UserProfile,
} from '../types/models';
import { SEED_USERS } from '../data/seedData';
import { signInWithGooglePopup } from '../lib/firebase';
import { upsertUserProfile } from '../services/firestoreService';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile;
  users?: UserProfile[];
  onSelectUser: (user: UserProfile) => void;
}

type LoginStage = 'quick_sheet' | 'full_screen';
type FullScreenMethod = 'password' | 'phone' | 'email' | 'face';

function maskPhoneNumber(phone?: string): string {
  const raw = (phone || '13910230982').trim();
  if (raw.length === 11) {
    return `${raw.slice(0, 3)}****${raw.slice(7)}`;
  }
  return raw;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  users,
  onSelectUser,
}) => {
  const [stage, setStage] = useState<LoginStage>('quick_sheet');
  const [method, setMethod] = useState<FullScreenMethod>('password');

  // Selected user in Stage 1 dropdown (and synced to Stage 2 quick-fill identifier only)
  const [selectedUid, setSelectedUid] = useState<string>(
    currentUser?.uid || SEED_USERS[1].uid
  );
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);

  // Terms agreement checkbox
  const [agreedTerms, setAgreedTerms] = useState<boolean>(true);
  const [termsHint, setTermsHint] = useState<boolean>(false);

  // Stage 2 (Full-Screen) form fields — password is NEVER prefilled
  const [accountInput, setAccountInput] = useState<string>(
    currentUser?.studentId || SEED_USERS[1].studentId || '2023010982'
  );
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [submittingPassword, setSubmittingPassword] = useState<boolean>(false);

  // Email OTP state
  const [emailInput, setEmailInput] = useState<string>(
    currentUser?.email || SEED_USERS[1].email || 'limingxuan@campus.edu.cn'
  );
  const [emailCodeInput, setEmailCodeInput] = useState<string>('');
  const [sendingEmailCode, setSendingEmailCode] = useState<boolean>(false);
  const [verifyingEmailLogin, setVerifyingEmailLogin] = useState<boolean>(false);
  const [emailResendSeconds, setEmailResendSeconds] = useState<number>(0);
  const [emailSuccessNotice, setEmailSuccessNotice] = useState<string | null>(null);
  const [emailSmtpConfigured, setEmailSmtpConfigured] = useState<boolean | null>(null);

  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showProblemTip, setShowProblemTip] = useState(false);

  // Order preset users so the 4 students come first, followed by the teacher/admin account
  const liveUsersByUid = new Map<string, UserProfile>((users || []).map((u) => [u.uid, u]));
  const presetUsers = SEED_USERS.map((seedU) => {
    const liveU = liveUsersByUid.get(seedU.uid);
    return liveU ? { ...seedU, ...liveU } : seedU;
  });
  const orderedUsers = [
    ...presetUsers.filter((u) => u.role === 'student'),
    ...presetUsers.filter((u) => u.role === 'admin'),
  ];

  const selectedSeedUser =
    orderedUsers.find((u) => u.uid === selectedUid) || orderedUsers[0];

  useEffect(() => {
    if (isOpen) {
      setStage('quick_sheet');
      setIsUserDropdownOpen(false);
      setPasswordInput('');
      setEmailCodeInput('');
      setAuthError(null);
      setEmailSuccessNotice(null);
      setShowProblemTip(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (emailResendSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setEmailResendSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [emailResendSeconds]);

  // Check whether SMTP mail delivery is configured when entering the email OTP form
  useEffect(() => {
    if (!isOpen || stage !== 'full_screen' || method !== 'email') return;
    let cancelled = false;
    fetch('/api/auth/email-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.configured === 'boolean') {
          setEmailSmtpConfigured(data.configured);
        }
      })
      .catch(() => {
        // Leave null if unreachable; tapping 获取验证码 still checks server directly
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, stage, method]);

  // Quick-fill ONLY fills the account identifier / email — NEVER fills password
  const syncIdentifierWithUser = (u: UserProfile) => {
    setSelectedUid(u.uid);
    setAccountInput(u.studentId || u.displayName);
    setEmailInput(u.email);
    setEmailCodeInput('');
    setAuthError(null);
    setEmailSuccessNotice(null);
  };

  if (!isOpen) return null;

  const completeLoginWithProfile = async (
    targetUser: UserProfile,
    shouldPersistNewProfile = false
  ) => {
    setAuthError(null);
    const liveMerged = liveUsersByUid.get(targetUser.uid);
    const nextProfile: UserProfile = {
      ...(liveMerged || {}),
      ...targetUser,
      isDemoRole: targetUser.isDemoRole !== undefined ? targetUser.isDemoRole : true,
    };
    if (shouldPersistNewProfile) {
      try {
        await upsertUserProfile(nextProfile);
      } catch {
        // Ignore transient error during account switch
      }
    }
    setPasswordInput('');
    setEmailCodeInput('');
    onSelectUser(nextProfile);
    onClose();
  };

  const handleQuickOneClickLogin = async () => {
    if (!agreedTerms) {
      setTermsHint(true);
      setAgreedTerms(true);
      window.setTimeout(() => setTermsHint(false), 1800);
    }
    await completeLoginWithProfile(selectedSeedUser, false);
  };

  const handleRequestEmailCode = async () => {
    setAuthError(null);
    setEmailSuccessNotice(null);
    const trimmedEmail = emailInput.trim();
    if (!trimmedEmail) {
      setAuthError('请输入校园邮箱地址');
      return;
    }

    setSendingEmailCode(true);
    try {
      const resp = await fetch('/api/auth/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.code === 'SMTP_NOT_CONFIGURED' || resp.status === 503) {
        setEmailSmtpConfigured(false);
        setAuthError(data.error || '邮箱验证码暂未开通（邮件服务未配置）');
        return;
      }
      if (!resp.ok || !data.ok) {
        setAuthError(data.error || '获取验证码失败，请稍后重试');
        return;
      }
      setEmailSmtpConfigured(true);
      setEmailSuccessNotice(data.message || '验证码已发送至绑定邮箱，10 分钟内有效');
      setEmailResendSeconds(60);
    } catch {
      setAuthError('网络请求异常，无法连接认证服务，请稍后重试');
    } finally {
      setSendingEmailCode(false);
    }
  };

  const handleFullScreenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (method === 'phone' || method === 'face') {
      setAuthError('该登录方式暂未开通，请使用账号密码、邮箱验证码或返回一键登录');
      return;
    }

    if (!agreedTerms) {
      setTermsHint(true);
      return;
    }

    if (method === 'password') {
      const trimmedAccount = accountInput.trim();
      if (!trimmedAccount) {
        setAuthError('请输入学工号、姓名或校园邮箱');
        return;
      }
      if (!passwordInput.trim()) {
        setAuthError('请输入登录密码');
        return;
      }

      setSubmittingPassword(true);
      try {
        const resp = await fetch('/api/auth/password-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: trimmedAccount,
            password: passwordInput,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok || !data.user) {
          setAuthError(data.error || '账号或密码不正确');
          return;
        }
        await completeLoginWithProfile(data.user as UserProfile, false);
      } catch {
        setAuthError('网络请求异常，请稍后重试');
      } finally {
        setSubmittingPassword(false);
      }
      return;
    }

    if (method === 'email') {
      const trimmedEmail = emailInput.trim();
      const trimmedCode = emailCodeInput.trim();
      if (!trimmedEmail) {
        setAuthError('请输入校园邮箱地址');
        return;
      }
      if (!/^\d{6}$/.test(trimmedCode)) {
        setAuthError('请输入 6 位数字验证码');
        return;
      }

      setVerifyingEmailLogin(true);
      try {
        const resp = await fetch('/api/auth/email-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            code: trimmedCode,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok || !data.user) {
          setAuthError(data.error || '验证码校验失败，请重试');
          return;
        }
        await completeLoginWithProfile(data.user as UserProfile, false);
      } catch {
        setAuthError('网络请求异常，请稍后重试');
      } finally {
        setVerifyingEmailLogin(false);
      }
    }
  };

  const handleGoogleLogin = async () => {
    setLoadingGoogle(true);
    setAuthError(null);
    try {
      const cred = await signInWithGooglePopup();
      const fbUser = cred.user;
      const profile = resolveCanonicalAuthProfile(fbUser, users || [], SEED_USERS);
      if (!liveUsersByUid.has(profile.uid)) {
        await upsertUserProfile(profile);
      }
      onSelectUser(profile);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthError(
        msg.includes('popup-closed-by-user')
          ? '已取消 Google 登录窗口，您可直接使用上方校园账号登录。'
          : `Google 登录提示：${msg}`
      );
    } finally {
      setLoadingGoogle(false);
    }
  };

  // ============================================================================
  // STAGE 1: 底部快捷一键登录弹窗（保持不变）
  // ============================================================================
  if (stage === 'quick_sheet') {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/55 backdrop-blur-[2px] p-0 sm:p-4">
        <div className="w-full sm:max-w-[430px] bg-white dark:bg-slate-900 rounded-t-[32px] sm:rounded-[32px] shadow-2xl overflow-hidden border border-slate-100 dark:border-slate-800 animate-in fade-in slide-in-from-bottom-4 duration-200">
          {/* Warm Soft-Peach Header Banner with Illustration & Top-Right Close Button */}
          <div className="relative bg-gradient-to-b from-[#FFF1E6] via-[#FFF8F3] to-white dark:from-slate-800 dark:via-slate-900 dark:to-slate-900 pt-7 pb-4 px-6 overflow-hidden">
            {/* Close X Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭登录弹窗"
              className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-black/5 cursor-pointer z-20"
            >
              <X className="w-5 h-5 stroke-[2.2]" />
            </button>

            <div className="flex items-center justify-between gap-2">
              {/* Left 2-Line Bold Title */}
              <div className="space-y-1 z-10">
                <h2 className="text-[30px] leading-[1.18] font-black text-[#22252A] dark:text-white tracking-tight">
                  让寻物
                  <br />
                  更安心
                </h2>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 pt-1">
                  校园实名互助 · 拾物快速归还
                </p>
              </div>

              {/* Right Flat Illustration */}
              <svg
                viewBox="0 0 200 135"
                className="w-44 h-28 shrink-0 -mr-2 select-none pointer-events-none"
                aria-hidden="true"
              >
                <circle cx="125" cy="68" r="52" fill="#FFE4D1" opacity="0.55" />
                <rect x="136" y="76" width="38" height="28" rx="4" fill="#D5D9E0" transform="rotate(-12 136 76)" />
                <path d="M122 54 C136 54 148 66 150 112 L106 112 C108 68 114 54 122 54 Z" fill="#FFFFFF" />
                <circle cx="124" cy="34" r="12" fill="#FDE2D2" />
                <path d="M113 28 C115 19 131 19 136 27 L141 29 L112 30 Z" fill="#FF6B2C" />
                <path d="M64 78 L46 66" stroke="#FDE2D2" strokeWidth="7" strokeLinecap="round" />
                <rect x="40" y="57" width="8" height="14" rx="2" fill="#1E293B" transform="rotate(-25 40 57)" />
                <path d="M78 58 C92 58 100 72 104 118 L62 118 C64 76 68 58 78 58 Z" fill="#FFFFFF" />
                <path d="M66 102 L102 102 L106 132 L62 132 Z" fill="#1E293B" />
                <path d="M78 60 C72 75 72 95 76 112" stroke="#FF6B2C" strokeWidth="4.5" fill="none" />
                <path d="M76 84 L112 78 L118 122 L70 122 Z" fill="#FF6B2C" />
                <circle cx="80" cy="39" r="11.5" fill="#FDE2D2" />
                <path d="M69 36 C70 26 86 26 90 35 C86 39 76 38 69 36 Z" fill="#1E293B" />
                <circle cx="84" cy="42" r="2.2" fill="none" stroke="#F59E0B" strokeWidth="1.3" />
              </svg>
            </div>
          </div>

          {/* Body Content */}
          <div className="px-6 pb-7 pt-2 space-y-4">
            {/* User Dropdown Box */}
            <div className="space-y-1.5 relative">
              <button
                type="button"
                onClick={() => setIsUserDropdownOpen((v) => !v)}
                className="w-full px-4 py-3.5 rounded-2xl bg-[#F7F8FA] dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 hover:border-slate-300 flex items-center justify-between transition-all cursor-pointer"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <img
                    src={selectedSeedUser.avatarUrl}
                    alt={selectedSeedUser.displayName}
                    className="w-9 h-9 rounded-full object-cover border border-slate-200 bg-amber-50 shrink-0"
                  />
                  <div className="text-left min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[18px] font-black font-mono text-slate-950 dark:text-white tracking-tight">
                        {maskPhoneNumber(selectedSeedUser.phone)}
                      </span>
                      <span className="text-xs font-extrabold text-slate-900 dark:text-white">
                        {selectedSeedUser.displayName}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {selectedSeedUser.department} · {selectedSeedUser.className || '教职工'}（学工号{' '}
                      {selectedSeedUser.studentId}）
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 text-xs font-bold text-slate-500 shrink-0 ml-2">
                  <span>切换用户</span>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${
                      isUserDropdownOpen ? 'rotate-180 text-[#FF6B2C]' : ''
                    }`}
                  />
                </div>
              </button>

              {/* Expandable User Dropdown List with all 5 preset users */}
              {isUserDropdownOpen && (
                <div className="absolute left-0 right-0 top-[72px] z-30 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 p-2 space-y-1 max-h-60 overflow-y-auto">
                  {orderedUsers.map((u) => {
                    const isSelected = u.uid === selectedSeedUser.uid;
                    return (
                      <button
                        key={u.uid}
                        type="button"
                        onClick={() => {
                          syncIdentifierWithUser(u);
                          setIsUserDropdownOpen(false);
                        }}
                        className={`w-full px-3 py-2.5 rounded-xl flex items-center justify-between gap-2.5 text-left transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-amber-50 dark:bg-slate-700/80 text-slate-950 dark:text-white'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-700/40 text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <img
                            src={u.avatarUrl}
                            alt={u.displayName}
                            className="w-8 h-8 rounded-full object-cover border border-slate-200 bg-amber-50 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-black text-slate-900 dark:text-white">
                                {u.displayName}
                              </span>
                              <span className="text-xs font-mono font-bold text-slate-600 dark:text-slate-300">
                                {maskPhoneNumber(u.phone)}
                              </span>
                              {u.role === 'admin' && (
                                <span className="px-1.5 py-0.2 rounded bg-blue-50 text-[#0066CC] text-[10px] font-bold">
                                  管理员
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {u.department} · {u.className || '失物招领中心'}
                            </div>
                          </div>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-[#FF6B2C] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}

              <p className="text-[11px] text-slate-400 pl-1">
                认证服务由校园统一身份认证中心提供（点击上方账号卡片可切换登录账号）
              </p>
            </div>

            {/* Agreement Checkbox Row */}
            <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={agreedTerms}
                onChange={(e) => {
                  setAgreedTerms(e.target.checked);
                  if (e.target.checked) setTermsHint(false);
                }}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#0B2149] focus:ring-0 cursor-pointer"
              />
              <span className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                阅读并同意
                <span className="text-[#FF6B2C]">
                  服务协议及基本功能个人信息处理规则、《校园统一认证服务条款》、个人信息共享说明
                </span>
              </span>
            </label>

            {/* Primary Deep-Navy Button */}
            <button
              type="button"
              onClick={handleQuickOneClickLogin}
              className="w-full py-3.5 rounded-2xl bg-[#0B2149] hover:bg-[#081836] active:scale-[0.99] text-white text-[15px] font-bold tracking-wide shadow-sm transition-all cursor-pointer"
            >
              本机账号一键登录（{selectedSeedUser.displayName}）
            </button>

            {/* Bottom Links Row: 其他登录方式 | 登录遇到问题 */}
            <div className="flex items-center justify-between pt-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              <button
                type="button"
                onClick={() => {
                  setStage('full_screen');
                  setMethod('password');
                  setPasswordInput('');
                  setAuthError(null);
                  setEmailSuccessNotice(null);
                }}
                className="hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                其他登录方式
              </button>

              <button
                type="button"
                onClick={() => setShowProblemTip((v) => !v)}
                className="hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                登录遇到问题
              </button>
            </div>

            {showProblemTip && (
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800 text-[11px] text-slate-600 dark:text-slate-300 border border-slate-200/70 dark:border-slate-700">
                您可直接下拉选择任意校园账号点击「本机账号一键登录」，或点击「其他登录方式」通过账号密码、邮箱验证码或 Google 管理员认证登录。如忘记密码请联系失物招领服务中心。
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // STAGE 2: 全屏「其他登录方式」界面（服务端真实校验 + 未开通诚实提示）
  // ============================================================================
  const isUnopenedMethod = method === 'phone' || method === 'face';
  const isSubmitting = submittingPassword || verifyingEmailLogin;

  const isFormFilled =
    method === 'password'
      ? Boolean(accountInput.trim() && passwordInput.trim())
      : method === 'email'
      ? Boolean(emailInput.trim() && /^\d{6}$/.test(emailCodeInput.trim()))
      : false;

  const canSubmitFullScreen = !isUnopenedMethod && agreedTerms && isFormFilled && !isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#E8ECF2] dark:bg-slate-950 sm:py-4 overflow-y-auto">
      <div className="w-full sm:max-w-[450px] min-h-screen sm:min-h-[860px] bg-white dark:bg-slate-900 sm:rounded-[38px] sm:shadow-[0_24px_70px_rgba(15,23,42,0.18)] sm:border-[6px] sm:border-slate-900/90 flex flex-col justify-between relative overflow-hidden">
        {/* Top Warm Soft-Peach Ambient Glow */}
        <div className="relative pt-4 pb-6 px-6 bg-gradient-to-b from-[#FFF3EA] via-[#FFF9F5] to-white dark:from-slate-800 dark:via-slate-900 dark:to-slate-900 overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute -top-10 -right-10 w-52 h-52 rounded-full bg-[#FFE4D0]/65 blur-xl pointer-events-none"
          />
          <div
            aria-hidden="true"
            className="absolute top-6 right-16 w-28 h-28 rounded-full bg-[#FFEAD9]/70 blur-lg pointer-events-none"
          />

          {/* Top Navigation Row */}
          <div className="relative z-10 flex items-center justify-between h-10 mb-6">
            <button
              type="button"
              onClick={() => {
                setStage('quick_sheet');
                setAuthError(null);
                setEmailSuccessNotice(null);
              }}
              aria-label="返回快捷登录"
              className="w-9 h-9 -ml-2 rounded-full flex items-center justify-center text-slate-900 dark:text-white hover:bg-black/5 cursor-pointer"
            >
              <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 cursor-pointer"
            >
              关闭
            </button>
          </div>

          {/* Greeting Headline & Subtitle */}
          <div className="relative z-10 space-y-1.5 pt-2">
            <h1 className="text-[28px] font-extrabold text-slate-950 dark:text-white tracking-tight">
              嗨，欢迎回来
            </h1>
            <p className="text-[13px] text-slate-500 dark:text-slate-400">
              {method === 'password'
                ? '请输入校园账号与登录密码完成身份核验'
                : method === 'email'
                ? '使用绑定校园邮箱接收 6 位一次性验证码登录'
                : '请选择已开通的校园统一身份认证方式'}
            </p>
          </div>
        </div>

        {/* Main Form Sheet Card */}
        <div className="flex-1 bg-white dark:bg-slate-900 rounded-t-[32px] -mt-3 px-6 pt-6 pb-6 flex flex-col justify-between z-10">
          <form onSubmit={handleFullScreenSubmit} className="space-y-4">
            {/* Quick-Fill Preset Account Bar (fills ONLY identifier/email — never password) */}
            {!isUnopenedMethod && (
              <div className="flex items-center justify-between gap-1.5 overflow-x-auto no-scrollbar pb-1">
                <span className="text-[11px] font-semibold text-slate-400 shrink-0">
                  快捷填入账号：
                </span>
                {orderedUsers.map((u) => {
                  const active = u.uid === selectedUid;
                  return (
                    <button
                      key={u.uid}
                      type="button"
                      onClick={() => syncIdentifierWithUser(u)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-bold shrink-0 transition-colors cursor-pointer ${
                        active
                          ? 'bg-[#FFE14D] text-slate-950'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                      }`}
                    >
                      {u.displayName}
                    </button>
                  );
                })}
              </div>
            )}

            {/* MODE 1: 账号密码形式 (Real server-side verification) */}
            {method === 'password' && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-[0_4px_24px_rgba(15,23,42,0.06)] border border-slate-100 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700 overflow-hidden">
                <div className="px-4 py-3.5 flex items-center gap-3">
                  <span className="text-[15px] font-medium text-slate-700 dark:text-slate-200 w-14 shrink-0 border-r border-slate-200 dark:border-slate-700 pr-2">
                    账号
                  </span>
                  <input
                    type="text"
                    value={accountInput}
                    onChange={(e) => {
                      setAccountInput(e.target.value);
                      if (authError) setAuthError(null);
                    }}
                    placeholder="请输入学工号、姓名或邮箱"
                    autoComplete="username"
                    className="flex-1 text-[15px] text-slate-900 dark:text-white placeholder:text-slate-300 bg-transparent focus:outline-none"
                  />
                  {accountInput && (
                    <button
                      type="button"
                      onClick={() => setAccountInput('')}
                      aria-label="清空账号"
                      className="text-slate-300 hover:text-slate-500 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="px-4 py-3.5 flex items-center gap-3">
                  <span className="text-[15px] font-medium text-slate-700 dark:text-slate-200 w-14 shrink-0 border-r border-slate-200 dark:border-slate-700 pr-2">
                    密码
                  </span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value);
                      if (authError) setAuthError(null);
                    }}
                    placeholder="请输入登录密码"
                    autoComplete="current-password"
                    className="flex-1 text-[15px] text-slate-900 dark:text-white placeholder:text-slate-300 bg-transparent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    className="text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            {/* MODE 2: 邮箱验证码登录 (Real 2-step OTP flow) */}
            {method === 'email' && (
              <div className="space-y-3">
                {emailSmtpConfigured === false && (
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
                    <span>邮箱验证码暂未开通（邮件服务未配置）</span>
                  </div>
                )}
                <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-[0_4px_24px_rgba(15,23,42,0.06)] border border-slate-100 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700 overflow-hidden">
                  <div className="px-4 py-3.5 flex items-center gap-3">
                    <span className="text-[15px] font-medium text-slate-700 dark:text-slate-200 w-14 shrink-0 border-r border-slate-200 dark:border-slate-700 pr-2">
                      邮箱
                    </span>
                    <input
                      type="email"
                      value={emailInput}
                      onChange={(e) => {
                        setEmailInput(e.target.value);
                        if (authError) setAuthError(null);
                        if (emailSuccessNotice) setEmailSuccessNotice(null);
                      }}
                      placeholder="请输入绑定的校园邮箱"
                      autoComplete="email"
                      className="flex-1 text-[15px] text-slate-900 dark:text-white placeholder:text-slate-300 bg-transparent focus:outline-none min-w-0"
                    />
                    {emailInput && (
                      <button
                        type="button"
                        onClick={() => setEmailInput('')}
                        aria-label="清空邮箱"
                        className="text-slate-300 hover:text-slate-500 cursor-pointer shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="px-4 py-3.5 flex items-center gap-2.5">
                    <span className="text-[15px] font-medium text-slate-700 dark:text-slate-200 w-14 shrink-0 border-r border-slate-200 dark:border-slate-700 pr-2">
                      验证码
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={emailCodeInput}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                        setEmailCodeInput(digits);
                        if (authError) setAuthError(null);
                      }}
                      placeholder="请输入 6 位验证码"
                      autoComplete="one-time-code"
                      className="flex-1 text-[15px] font-mono tracking-widest text-slate-900 dark:text-white placeholder:text-slate-300 placeholder:tracking-normal placeholder:font-sans bg-transparent focus:outline-none min-w-0"
                    />
                    <button
                      type="button"
                      disabled={sendingEmailCode || emailResendSeconds > 0}
                      onClick={handleRequestEmailCode}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold shrink-0 transition-colors cursor-pointer bg-[#FFF3EA] text-[#FF6B2C] hover:bg-[#FFE4D1] disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed dark:bg-slate-700 dark:text-amber-300"
                    >
                      {sendingEmailCode
                        ? '发送中...'
                        : emailResendSeconds > 0
                        ? `${emailResendSeconds}s 后重发`
                        : '获取验证码'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* MODE 3: 手机号登录 — 暂未开通 */}
            {method === 'phone' && (
              <div className="bg-slate-50 dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700 p-5 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-500 dark:text-slate-300 mx-auto flex items-center justify-center">
                  <Smartphone className="w-7 h-7" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-sm font-bold text-slate-900 dark:text-white">
                      手机号验证码登录
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-bold">
                      暂未开通
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    校园短信验证码通道暂未开通，当前不可通过手机号验证登录。请改用「账号密码」、「邮箱验证码」或返回「本机账号一键登录」。
                  </p>
                </div>
              </div>
            )}

            {/* MODE 4: 人脸识别认证 — 暂未开通 */}
            {method === 'face' && (
              <div className="bg-slate-50 dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700 p-5 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-500 dark:text-slate-300 mx-auto flex items-center justify-center">
                  <ScanFace className="w-7 h-7" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-sm font-bold text-slate-900 dark:text-white">
                      校园实名人脸识别
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-bold">
                      暂未开通
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    人脸活体核验服务暂未开通，当前不可通过刷脸登录。请改用「账号密码」、「邮箱验证码」或返回「本机账号一键登录」。
                  </p>
                </div>
              </div>
            )}

            {/* Terms Agreement Checkbox Row */}
            {!isUnopenedMethod && (
              <label className="flex items-center gap-2 cursor-pointer select-none pt-1">
                <input
                  type="checkbox"
                  checked={agreedTerms}
                  onChange={(e) => {
                    setAgreedTerms(e.target.checked);
                    if (e.target.checked) setTermsHint(false);
                  }}
                  className="w-4 h-4 rounded border-slate-300 text-[#FF6B2C] focus:ring-0 cursor-pointer"
                />
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  阅读并同意
                  <span className="text-[#FF6B2C]">服务协议及基本功能个人信息处理规则</span>
                </span>
              </label>
            )}

            {termsHint && (
              <div className="text-xs text-[#FF5000] font-semibold">
                请先勾选同意服务协议及个人信息处理规则
              </div>
            )}

            {emailSuccessNotice && method === 'email' && (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                <span>{emailSuccessNotice}</span>
              </div>
            )}

            {authError && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                <span>{authError}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isUnopenedMethod || isSubmitting}
              className={`w-full py-3.5 rounded-xl text-[16px] font-bold transition-all flex items-center justify-center gap-2 ${
                isUnopenedMethod
                  ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                  : canSubmitFullScreen
                  ? 'bg-[#0B2149] hover:bg-[#081836] text-white shadow-sm cursor-pointer'
                  : 'bg-[#CCCCCC] dark:bg-slate-700 text-white cursor-pointer'
              }`}
            >
              {isUnopenedMethod ? (
                <>
                  <Lock className="w-4 h-4" />
                  <span>暂未开通</span>
                </>
              ) : isSubmitting ? (
                <>
                  <Clock className="w-4 h-4 animate-spin" />
                  <span>正在验证...</span>
                </>
              ) : (
                <span>登录</span>
              )}
            </button>

            <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
              <button
                type="button"
                onClick={() => {
                  setStage('quick_sheet');
                  setAuthError(null);
                  setEmailSuccessNotice(null);
                }}
                className="hover:text-slate-800 dark:hover:text-white cursor-pointer"
              >
                返回下拉选人一键登录
              </button>
              <button
                type="button"
                onClick={() => setShowProblemTip((v) => !v)}
                className="hover:text-slate-800 dark:hover:text-white cursor-pointer"
              >
                登录遇到问题
              </button>
            </div>

            {showProblemTip && (
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800 text-[11px] text-slate-600 dark:text-slate-300 border border-slate-200/70 dark:border-slate-700">
                账号密码与邮箱验证码均由服务端实时核验；如需快速体验各角色，请点击「返回下拉选人一键登录」；管理员亦可直接使用下方 Google 账号登录。
              </div>
            )}
          </form>

          {/* Bottom Circular Icons Row: 其它登录方式 */}
          <div className="pt-8 pb-2 space-y-4">
            <div className="text-center text-[11px] text-slate-400">其他登录方式</div>
            <div className="flex items-start justify-around px-1">
              {/* 1. 账号密码 */}
              <button
                type="button"
                onClick={() => {
                  setMethod('password');
                  setAuthError(null);
                  setEmailSuccessNotice(null);
                }}
                title="账号密码登录"
                className="flex flex-col items-center gap-1.5 cursor-pointer group"
              >
                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center text-white transition-transform group-hover:scale-105 ${
                    method === 'password'
                      ? 'bg-[#1677FF] ring-2 ring-offset-2 ring-[#1677FF]'
                      : 'bg-[#1677FF]/90'
                  }`}
                >
                  <KeyRound className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">
                  账号密码
                </span>
              </button>

              {/* 2. 邮箱验证码 */}
              <button
                type="button"
                onClick={() => {
                  setMethod('email');
                  setAuthError(null);
                  setEmailSuccessNotice(null);
                }}
                title="邮箱验证码登录"
                className="flex flex-col items-center gap-1.5 cursor-pointer group"
              >
                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center text-white transition-transform group-hover:scale-105 ${
                    method === 'email'
                      ? 'bg-[#22C55E] ring-2 ring-offset-2 ring-[#22C55E]'
                      : 'bg-[#22C55E]/90'
                  }`}
                >
                  <Mail className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">
                  邮箱验证
                </span>
              </button>

              {/* 3. 手机号（暂未开通） */}
              <button
                type="button"
                onClick={() => {
                  setMethod('phone');
                  setAuthError(null);
                  setEmailSuccessNotice(null);
                }}
                title="手机号登录（暂未开通）"
                className="flex flex-col items-center gap-1 cursor-pointer group"
              >
                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center text-white transition-transform group-hover:scale-105 ${
                    method === 'phone'
                      ? 'bg-slate-400 ring-2 ring-offset-2 ring-slate-400'
                      : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <Smartphone className="w-5 h-5" />
                </div>
                <span className="text-[10px] text-slate-400">手机号</span>
                <span className="text-[9px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded leading-none">
                  暂未开通
                </span>
              </button>

              {/* 4. 人脸识别（暂未开通） */}
              <button
                type="button"
                onClick={() => {
                  setMethod('face');
                  setAuthError(null);
                  setEmailSuccessNotice(null);
                }}
                title="人脸识别登录（暂未开通）"
                className="flex flex-col items-center gap-1 cursor-pointer group"
              >
                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center text-white transition-transform group-hover:scale-105 ${
                    method === 'face'
                      ? 'bg-slate-400 ring-2 ring-offset-2 ring-slate-400'
                      : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <ScanFace className="w-5 h-5" />
                </div>
                <span className="text-[10px] text-slate-400">人脸识别</span>
                <span className="text-[9px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded leading-none">
                  暂未开通
                </span>
              </button>

              {/* 5. Google / 管理员认证 */}
              <button
                type="button"
                disabled={loadingGoogle}
                onClick={handleGoogleLogin}
                title="Google 账号认证（管理员）"
                className="flex flex-col items-center gap-1.5 cursor-pointer group disabled:opacity-50"
              >
                <div className="w-11 h-11 rounded-full bg-slate-950 dark:bg-slate-700 flex items-center justify-center text-white transition-transform group-hover:scale-105">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">
                  Google
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
