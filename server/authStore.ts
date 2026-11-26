/**
 * Server-Side Authentication Store & Verification Service (Server-Only — Never Imported by Frontend)
 *
 * Implements:
 * 1. Real server-side password verification for the 5 preset campus accounts using per-account
 *    salted scrypt hashes (16-byte random salt + 64-byte derived key) and constant-time comparison,
 *    with a 5-consecutive-failure -> 60-second per-account lockout guard.
 * 2. Complete email verification code (OTP) lifecycle:
 *    - 6-digit cryptographically random code via crypto.randomInt
 *    - Stores ONLY salted scrypt hash server-side (10-minute expiry, max 5 attempts, 1 active code/email)
 *    - Real SMTP delivery via nodemailer configured strictly from environment Secrets:
 *      SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), SMTP_USER, SMTP_PASS
 *    - Honest unconfigured status when SMTP secrets are absent (no fake send, no bypass)
 */

import nodeCrypto from 'crypto';
import nodemailer from 'nodemailer';
import { SEED_USERS } from '../src/data/seedData.ts';
import { UserProfile } from '../src/types/models.ts';

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;
const PASSWORD_KEY_LEN = 64;
const OTP_KEY_LEN = 32;

const MAX_CONSECUTIVE_PASSWORD_FAILURES = 5;
const PASSWORD_LOCKOUT_MS = 60 * 1000;

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

export interface SaltedPasswordCredential {
  saltHex: string;
  hashHex: string;
}

/**
 * Precomputed per-account salted scrypt hashes for the 5 preset accounts.
 * Plaintext credentials never appear in source code or frontend bundles.
 */
export const PRESET_PASSWORD_CREDENTIALS: Record<string, SaltedPasswordCredential> = {
  admin_shx614519: {
    saltHex: '37f0fe830d2ca2da5bdd4561df764679',
    hashHex:
      'cb2f1b539dd7e420303f51a285f74f893d4b3d2a539d46b97bb881db02969052fa541e51ec88a713f2da3c9fea4f9002f5d20edd85d2eed2476c494084797346',
  },
  demo_student_li: {
    saltHex: 'e4f42f2b5c8c58e714444011c603f73e',
    hashHex:
      '360d54e0e3cf18f1b857489a2bb173e190fc2fcd534b23866da9e8a6587dac9ad214a1b070ba1b3fbfab10311e63a92c1db434a7603818dc8fad500f84875a5a',
  },
  student_chen: {
    saltHex: '0972191c3567a68a9d73e02a565f4b5b',
    hashHex:
      '8dd907a708efc3f09a4e89927a6fbafbc2ff1bd621aca3a09bdcc39670de4ebafb515e091b831f4026260def54c939b4893e106d62de9dc681b6d3397b063d9f',
  },
  student_wang: {
    saltHex: 'de84026ed70881b658794a2cef220319',
    hashHex:
      'd8bf828f85b0499d93d626dd3e3edb5715e7946322df16802cf5584d4eb1701ba8ab0ead6ff72f4cf6d26804f0f88d7d60134d0c7fb1b622666a6f8fb5ca4029',
  },
  student_lin: {
    saltHex: 'ff1f6ccb10fd43d255c9ef7b25f469bd',
    hashHex:
      'c47f91aad272142279210c6bda3610daa01bd3b864a8b962ae8d322f2f0445bf6ebc1804179eccf5f9db3cf2a01eedc51845d33c7bd27b535795e422b341c75f',
  },
};

const DUMMY_SALT_BUFFER = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

interface PasswordLockoutState {
  consecutiveFailures: number;
  lockedUntilMs: number;
}

export interface EmailVerificationCodeRecord {
  uid: string;
  email: string;
  codeSaltHex: string;
  codeHashHex: string;
  expiresAtMs: number;
  attemptsRemaining: number;
  createdAtMs: number;
}

const passwordLockoutByKey = new Map<string, PasswordLockoutState>();
const activeEmailCodesByEmail = new Map<string, EmailVerificationCodeRecord>();

export function normalizeIdentifier(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function findPresetUserByAccountIdentifier(accountInput: string): UserProfile | undefined {
  const normalized = normalizeIdentifier(accountInput);
  if (!normalized) return undefined;

  return SEED_USERS.find((u) => {
    const candidates = [u.studentId, u.displayName, u.email, u.phone, u.uid]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase());
    return candidates.includes(normalized);
  });
}

export function findPresetUserByEmail(emailInput: string): UserProfile | undefined {
  const normalized = normalizeIdentifier(emailInput);
  if (!normalized) return undefined;
  return SEED_USERS.find((u) => u.email.trim().toLowerCase() === normalized);
}

function timingSafeHexEqual(hexA: string, hexB: string): boolean {
  const bufA = Buffer.from(hexA, 'hex');
  const bufB = Buffer.from(hexB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return nodeCrypto.timingSafeEqual(bufA, bufB);
}

function deriveScryptHex(secret: string, saltHex: string, keyLen: number): string {
  const saltBuf = Buffer.from(saltHex, 'hex');
  return nodeCrypto.scryptSync(secret, saltBuf, keyLen, SCRYPT_OPTIONS).toString('hex');
}

export type PasswordLoginResult =
  | { ok: true; status: 200; user: UserProfile }
  | {
      ok: false;
      status: 400 | 401 | 429;
      code: 'EMPTY_ACCOUNT' | 'EMPTY_PASSWORD' | 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED';
      error: string;
      lockedSecondsRemaining?: number;
      failuresRemaining?: number;
    };

/**
 * Verifies account + password against the server-side salted scrypt credential store.
 * Enforces 5 consecutive failures -> 60-second per-account lockout.
 */
export function verifyPasswordLogin(
  accountInput: string,
  passwordInput: string,
  nowMs: number = Date.now()
): PasswordLoginResult {
  const trimmedAccount = String(accountInput || '').trim();
  const rawPassword = typeof passwordInput === 'string' ? passwordInput : '';

  if (!trimmedAccount) {
    return {
      ok: false,
      status: 400,
      code: 'EMPTY_ACCOUNT',
      error: '请输入学工号、姓名或校园邮箱',
    };
  }

  if (!rawPassword.trim()) {
    return {
      ok: false,
      status: 400,
      code: 'EMPTY_PASSWORD',
      error: '请输入登录密码',
    };
  }

  const matchedUser = findPresetUserByAccountIdentifier(trimmedAccount);
  const lockoutKey = matchedUser
    ? matchedUser.uid
    : `unknown:${normalizeIdentifier(trimmedAccount)}`;

  const existingLock = passwordLockoutByKey.get(lockoutKey);
  if (existingLock && existingLock.lockedUntilMs > nowMs) {
    const remainingSec = Math.max(1, Math.ceil((existingLock.lockedUntilMs - nowMs) / 1000));
    return {
      ok: false,
      status: 429,
      code: 'ACCOUNT_LOCKED',
      lockedSecondsRemaining: remainingSec,
      error: `该账号连续输错密码次数过多，请 ${remainingSec} 秒后再试`,
    };
  }

  // Reset expired lockout window before checking credentials
  if (existingLock && existingLock.lockedUntilMs > 0 && existingLock.lockedUntilMs <= nowMs) {
    passwordLockoutByKey.delete(lockoutKey);
  }

  const cred = matchedUser ? PRESET_PASSWORD_CREDENTIALS[matchedUser.uid] : undefined;
  let passwordMatched = false;

  if (cred) {
    const derivedHex = deriveScryptHex(rawPassword, cred.saltHex, PASSWORD_KEY_LEN);
    passwordMatched = timingSafeHexEqual(derivedHex, cred.hashHex);
  } else {
    // Constant-work dummy scrypt to minimize timing differences for nonexistent accounts
    nodeCrypto.scryptSync(rawPassword, DUMMY_SALT_BUFFER, PASSWORD_KEY_LEN, SCRYPT_OPTIONS);
    passwordMatched = false;
  }

  if (!matchedUser || !passwordMatched) {
    const prevFailures = passwordLockoutByKey.get(lockoutKey)?.consecutiveFailures || 0;
    const nextFailures = prevFailures + 1;
    if (nextFailures >= MAX_CONSECUTIVE_PASSWORD_FAILURES) {
      passwordLockoutByKey.set(lockoutKey, {
        consecutiveFailures: nextFailures,
        lockedUntilMs: nowMs + PASSWORD_LOCKOUT_MS,
      });
      return {
        ok: false,
        status: 429,
        code: 'ACCOUNT_LOCKED',
        lockedSecondsRemaining: Math.ceil(PASSWORD_LOCKOUT_MS / 1000),
        error: '连续输错密码 5 次，该账号已锁定 60 秒，请稍后再试',
      };
    }

    passwordLockoutByKey.set(lockoutKey, {
      consecutiveFailures: nextFailures,
      lockedUntilMs: 0,
    });
    return {
      ok: false,
      status: 401,
      code: 'INVALID_CREDENTIALS',
      failuresRemaining: MAX_CONSECUTIVE_PASSWORD_FAILURES - nextFailures,
      error: '账号或密码不正确',
    };
  }

  passwordLockoutByKey.delete(lockoutKey);
  return {
    ok: true,
    status: 200,
    user: matchedUser,
  };
}

export function getSmtpConfiguration(): {
  host: string;
  port: number;
  user: string;
  pass: string;
  configured: boolean;
} {
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim() || 'smtp.gmail.com';
  const parsedPort = Number(process.env.SMTP_PORT || 465);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 465;
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  return {
    host,
    port,
    user,
    pass,
    configured: Boolean(user && pass),
  };
}

/**
 * Generates a 6-digit OTP and stores ONLY its salted scrypt hash server-side.
 * Overwrites any previous active code for the same email.
 */
export function issueEmailVerificationCodeRecord(
  user: UserProfile,
  nowMs: number = Date.now()
): { code: string; record: EmailVerificationCodeRecord } {
  const normalizedEmail = normalizeIdentifier(user.email);
  const code = String(nodeCrypto.randomInt(100000, 1000000));
  const codeSaltHex = nodeCrypto.randomBytes(16).toString('hex');
  const codeHashHex = deriveScryptHex(code, codeSaltHex, OTP_KEY_LEN);

  const record: EmailVerificationCodeRecord = {
    uid: user.uid,
    email: normalizedEmail,
    codeSaltHex,
    codeHashHex,
    expiresAtMs: nowMs + EMAIL_CODE_TTL_MS,
    attemptsRemaining: EMAIL_CODE_MAX_ATTEMPTS,
    createdAtMs: nowMs,
  };

  // One active code per email: overwriting immediately invalidates any prior code
  activeEmailCodesByEmail.set(normalizedEmail, record);
  return { code, record };
}

export function getActiveEmailCodeRecord(
  emailInput: string
): EmailVerificationCodeRecord | undefined {
  return activeEmailCodesByEmail.get(normalizeIdentifier(emailInput));
}

export function clearActiveEmailCodeRecord(emailInput: string): void {
  activeEmailCodesByEmail.delete(normalizeIdentifier(emailInput));
}

export type SendEmailCodeResult =
  | {
      ok: true;
      status: 200;
      message: string;
      expiresInSeconds: number;
    }
  | {
      ok: false;
      status: 400 | 404 | 422 | 502;
      code: 'INVALID_EMAIL' | 'EMAIL_NOT_BOUND' | 'SMTP_NOT_CONFIGURED' | 'SMTP_SEND_FAILED';
      error: string;
    };

/**
 * Full real email verification code request handler:
 * 1. Validates email format and binding to one of the 5 preset accounts
 * 2. Checks SMTP secrets (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS); if missing, returns honest unconfigured error (HTTP 422 so reverse proxies preserve the JSON body)
 * 3. Generates 6-digit OTP, stores ONLY its salted hash server-side (10 min TTL, max 5 attempts, invalidates prior code)
 * 4. Sends the code via nodemailer SMTP transport
 */
export async function sendEmailVerificationCode(
  emailInput: string
): Promise<SendEmailCodeResult> {
  const normalizedEmail = normalizeIdentifier(emailInput);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_EMAIL',
      error: '请输入有效的校园邮箱地址',
    };
  }

  const matchedUser = findPresetUserByEmail(normalizedEmail);
  if (!matchedUser) {
    return {
      ok: false,
      status: 404,
      code: 'EMAIL_NOT_BOUND',
      error: '该邮箱未绑定账号',
    };
  }

  const smtp = getSmtpConfiguration();
  if (!smtp.configured) {
    return {
      ok: false,
      status: 422,
      code: 'SMTP_NOT_CONFIGURED',
      error: '邮箱验证码暂未开通（邮件服务未配置）',
    };
  }

  const { code } = issueEmailVerificationCodeRecord(matchedUser);

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
    });

    await transporter.sendMail({
      from: `"智寻校园" <${smtp.user}>`,
      to: matchedUser.email,
      subject: '【智寻校园】登录邮箱验证码',
      text: `您好，${matchedUser.displayName}：\n\n您正在使用邮箱验证码登录「智寻校园」，本次验证码为：${code}\n\n验证码 10 分钟内有效，最多可验证 5 次，请勿向他人泄露。如非本人操作请忽略此邮件。`,
      html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
        <h2 style="margin: 0 0 12px; color: #0B2149;">智寻校园 · 登录验证码</h2>
        <p style="color: #475569; font-size: 14px;">您好，<strong>${matchedUser.displayName}</strong>：</p>
        <p style="color: #475569; font-size: 14px;">您正在通过邮箱验证码登录校园失物招领平台，本次验证码为：</p>
        <div style="margin: 20px 0; padding: 14px 20px; background: #FFF8F3; border: 1px solid #FED7AA; border-radius: 12px; font-size: 28px; font-weight: 800; letter-spacing: 6px; text-align: center; color: #0B2149;">${code}</div>
        <p style="color: #64748b; font-size: 12px;">该验证码 <strong>10 分钟</strong> 内有效，最多允许核验 <strong>5 次</strong>，重新获取将使旧验证码立即失效。</p>
      </div>`,
    });

    return {
      ok: true,
      status: 200,
      message: '验证码已发送至绑定邮箱，10 分钟内有效',
      expiresInSeconds: Math.floor(EMAIL_CODE_TTL_MS / 1000),
    };
  } catch (err) {
    // Do not retain an undelivered code record
    activeEmailCodesByEmail.delete(normalizedEmail);
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[Auth SMTP Error] Failed to deliver verification code:', errMsg);
    return {
      ok: false,
      status: 502,
      code: 'SMTP_SEND_FAILED',
      error: '邮件发送失败，请稍后重试或联系管理员检查 SMTP 配置',
    };
  }
}

export type VerifyEmailCodeResult =
  | { ok: true; status: 200; user: UserProfile }
  | {
      ok: false;
      status: 400 | 401 | 404 | 429;
      code:
        | 'INVALID_EMAIL'
        | 'EMAIL_NOT_BOUND'
        | 'INVALID_CODE_FORMAT'
        | 'CODE_NOT_FOUND'
        | 'CODE_EXPIRED'
        | 'ATTEMPTS_EXHAUSTED'
        | 'INVALID_CODE';
      error: string;
      attemptsRemaining?: number;
    };

/**
 * Verifies an email + 6-digit code against the server-side hashed OTP record.
 * Enforces 10-minute expiration, max 5 attempts, decrement on mismatch, and single-use deletion on success.
 */
export function verifyEmailCodeLogin(
  emailInput: string,
  codeInput: string,
  nowMs: number = Date.now()
): VerifyEmailCodeResult {
  const normalizedEmail = normalizeIdentifier(emailInput);
  const trimmedCode = String(codeInput || '').trim();

  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_EMAIL',
      error: '请输入有效的校园邮箱地址',
    };
  }

  const matchedUser = findPresetUserByEmail(normalizedEmail);
  if (!matchedUser) {
    return {
      ok: false,
      status: 404,
      code: 'EMAIL_NOT_BOUND',
      error: '该邮箱未绑定账号',
    };
  }

  if (!/^\d{6}$/.test(trimmedCode)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CODE_FORMAT',
      error: '请输入 6 位数字验证码',
    };
  }

  const record = activeEmailCodesByEmail.get(normalizedEmail);
  if (!record) {
    return {
      ok: false,
      status: 400,
      code: 'CODE_NOT_FOUND',
      error: '验证码不存在或已失效，请先获取验证码',
    };
  }

  if (nowMs > record.expiresAtMs) {
    activeEmailCodesByEmail.delete(normalizedEmail);
    return {
      ok: false,
      status: 400,
      code: 'CODE_EXPIRED',
      error: '验证码已过期，请重新获取',
    };
  }

  if (record.attemptsRemaining <= 0) {
    activeEmailCodesByEmail.delete(normalizedEmail);
    return {
      ok: false,
      status: 429,
      code: 'ATTEMPTS_EXHAUSTED',
      attemptsRemaining: 0,
      error: '验证码错误次数已达上限，请重新获取',
    };
  }

  const derivedHex = deriveScryptHex(trimmedCode, record.codeSaltHex, OTP_KEY_LEN);
  const matched = timingSafeHexEqual(derivedHex, record.codeHashHex);

  if (!matched) {
    record.attemptsRemaining -= 1;
    if (record.attemptsRemaining <= 0) {
      activeEmailCodesByEmail.delete(normalizedEmail);
      return {
        ok: false,
        status: 429,
        code: 'ATTEMPTS_EXHAUSTED',
        attemptsRemaining: 0,
        error: '验证码错误次数已达上限，请重新获取',
      };
    }
    return {
      ok: false,
      status: 401,
      code: 'INVALID_CODE',
      attemptsRemaining: record.attemptsRemaining,
      error: `验证码不正确，还可尝试 ${record.attemptsRemaining} 次`,
    };
  }

  // Single-use: immediately consume and delete active OTP record
  activeEmailCodesByEmail.delete(normalizedEmail);
  return {
    ok: true,
    status: 200,
    user: matchedUser,
  };
}
