"""
Server-Side Authentication Service (Python FastAPI Port)
- Salted scrypt password verification for the 5 preset campus accounts (demo password: cqca123456)
- Constant-time comparison + 5 consecutive failures -> 60s lockout
- Real 6-digit email OTP lifecycle via smtplib when SMTP_USER / SMTP_PASS are configured
"""

import hashlib
import hmac
import re
import secrets
import smtplib
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List, Optional

from backend.config import SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER

SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
PASSWORD_KEY_LEN = 64
OTP_KEY_LEN = 32

MAX_CONSECUTIVE_PASSWORD_FAILURES = 5
PASSWORD_LOCKOUT_SECONDS = 60

EMAIL_CODE_TTL_SECONDS = 10 * 60
EMAIL_CODE_MAX_ATTEMPTS = 5

# Exact per-account salted scrypt hashes matching the preset demo credentials
PRESET_PASSWORD_CREDENTIALS: Dict[str, Dict[str, str]] = {
    "admin_shx614519": {
        "saltHex": "37f0fe830d2ca2da5bdd4561df764679",
        "hashHex": "cb2f1b539dd7e420303f51a285f74f893d4b3d2a539d46b97bb881db02969052fa541e51ec88a713f2da3c9fea4f9002f5d20edd85d2eed2476c494084797346",
    },
    "demo_student_li": {
        "saltHex": "e4f42f2b5c8c58e714444011c603f73e",
        "hashHex": "360d54e0e3cf18f1b857489a2bb173e190fc2fcd534b23866da9e8a6587dac9ad214a1b070ba1b3fbfab10311e63a92c1db434a7603818dc8fad500f84875a5a",
    },
    "student_chen": {
        "saltHex": "0972191c3567a68a9d73e02a565f4b5b",
        "hashHex": "8dd907a708efc3f09a4e89927a6fbafbc2ff1bd621aca3a09bdcc39670de4ebafb515e091b831f4026260def54c939b4893e106d62de9dc681b6d3397b063d9f",
    },
    "student_wang": {
        "saltHex": "de84026ed70881b658794a2cef220319",
        "hashHex": "d8bf828f85b0499d93d626dd3e3edb5715e7946322df16802cf5584d4eb1701ba8ab0ead6ff72f4cf6d26804f0f88d7d60134d0c7fb1b622666a6f8fb5ca4029",
    },
    "student_lin": {
        "saltHex": "ff1f6ccb10fd43d255c9ef7b25f469bd",
        "hashHex": "c47f91aad272142279210c6bda3610daa01bd3b864a8b962ae8d322f2f0445bf6ebc1804179eccf5f9db3cf2a01eedc51845d33c7bd27b535795e422b341c75f",
    },
}

_DUMMY_SALT = bytes.fromhex("00112233445566778899aabbccddeeff")
_password_lockouts: Dict[str, Dict[str, float]] = {}
_active_email_codes: Dict[str, Dict[str, Any]] = {}


def _normalize(raw: str) -> str:
    return (raw or "").strip().lower()


def _derive_scrypt_hex(secret: str, salt_hex: str, key_len: int) -> str:
    dk = hashlib.scrypt(
        secret.encode("utf-8"),
        salt=bytes.fromhex(salt_hex),
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=key_len,
    )
    return dk.hex()


def get_smtp_status() -> Dict[str, Any]:
    configured = bool(SMTP_USER and SMTP_PASS)
    return {
        "host": SMTP_HOST,
        "port": SMTP_PORT,
        "configured": configured,
    }


def find_user_by_identifier(users: List[Dict[str, Any]], account: str) -> Optional[Dict[str, Any]]:
    norm = _normalize(account)
    if not norm:
        return None
    for u in users:
        candidates = [
            u.get("studentId"),
            u.get("displayName"),
            u.get("email"),
            u.get("phone"),
            u.get("uid"),
        ]
        if any(_normalize(str(c)) == norm for c in candidates if c):
            return u
    return None


def find_user_by_email(users: List[Dict[str, Any]], email: str) -> Optional[Dict[str, Any]]:
    norm = _normalize(email)
    if not norm:
        return None
    for u in users:
        if _normalize(str(u.get("email") or "")) == norm:
            return u
    return None


def verify_password_login(
    users: List[Dict[str, Any]],
    account: str,
    password: str,
) -> Dict[str, Any]:
    now = time.time()
    trimmed_acc = (account or "").strip()
    raw_pwd = password if isinstance(password, str) else ""

    if not trimmed_acc:
        return {"ok": False, "status": 400, "code": "EMPTY_ACCOUNT", "error": "请输入学工号、姓名或校园邮箱"}
    if not raw_pwd.strip():
        return {"ok": False, "status": 400, "code": "EMPTY_PASSWORD", "error": "请输入登录密码"}

    matched_user = find_user_by_identifier(users, trimmed_acc)
    lock_key = matched_user["uid"] if matched_user else f"unknown:{_normalize(trimmed_acc)}"

    lock_state = _password_lockouts.get(lock_key)
    if lock_state and lock_state.get("locked_until", 0) > now:
        rem = max(1, int(lock_state["locked_until"] - now + 0.999))
        return {
            "ok": False,
            "status": 429,
            "code": "ACCOUNT_LOCKED",
            "lockedSecondsRemaining": rem,
            "error": f"该账号连续输错密码次数过多，请 {rem} 秒后再试",
        }
    if lock_state and 0 < lock_state.get("locked_until", 0) <= now:
        _password_lockouts.pop(lock_key, None)

    cred = PRESET_PASSWORD_CREDENTIALS.get(matched_user["uid"]) if matched_user else None
    pwd_ok = False
    if cred:
        derived = _derive_scrypt_hex(raw_pwd, cred["saltHex"], PASSWORD_KEY_LEN)
        pwd_ok = hmac.compare_digest(bytes.fromhex(derived), bytes.fromhex(cred["hashHex"]))
    else:
        hashlib.scrypt(
            raw_pwd.encode("utf-8"),
            salt=_DUMMY_SALT,
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=PASSWORD_KEY_LEN,
        )

    if not matched_user or not pwd_ok:
        prev = int(_password_lockouts.get(lock_key, {}).get("failures", 0))
        nxt = prev + 1
        if nxt >= MAX_CONSECUTIVE_PASSWORD_FAILURES:
            _password_lockouts[lock_key] = {
                "failures": nxt,
                "locked_until": now + PASSWORD_LOCKOUT_SECONDS,
            }
            return {
                "ok": False,
                "status": 429,
                "code": "ACCOUNT_LOCKED",
                "lockedSecondsRemaining": PASSWORD_LOCKOUT_SECONDS,
                "error": "连续输错密码 5 次，该账号已锁定 60 秒，请稍后再试",
            }
        _password_lockouts[lock_key] = {"failures": nxt, "locked_until": 0}
        return {
            "ok": False,
            "status": 401,
            "code": "INVALID_CREDENTIALS",
            "failuresRemaining": MAX_CONSECUTIVE_PASSWORD_FAILURES - nxt,
            "error": "账号或密码不正确",
        }

    _password_lockouts.pop(lock_key, None)
    return {"ok": True, "status": 200, "user": matched_user}


def send_email_verification_code(users: List[Dict[str, Any]], email_input: str) -> Dict[str, Any]:
    norm_email = _normalize(email_input)
    if not norm_email or not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", norm_email):
        return {"ok": False, "status": 400, "code": "INVALID_EMAIL", "error": "请输入有效的校园邮箱地址"}

    matched_user = find_user_by_email(users, norm_email)
    if not matched_user:
        return {"ok": False, "status": 404, "code": "EMAIL_NOT_BOUND", "error": "该邮箱未绑定账号"}

    smtp = get_smtp_status()
    if not smtp["configured"]:
        return {
            "ok": False,
            "status": 422,
            "code": "SMTP_NOT_CONFIGURED",
            "error": "邮箱验证码暂未开通（邮件服务未配置）",
        }

    code = str(secrets.randbelow(900000) + 100000)
    salt_hex = secrets.token_hex(16)
    hash_hex = _derive_scrypt_hex(code, salt_hex, OTP_KEY_LEN)
    now = time.time()
    _active_email_codes[norm_email] = {
        "uid": matched_user["uid"],
        "email": norm_email,
        "codeSaltHex": salt_hex,
        "codeHashHex": hash_hex,
        "expiresAt": now + EMAIL_CODE_TTL_SECONDS,
        "attemptsRemaining": EMAIL_CODE_MAX_ATTEMPTS,
    }

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "【智寻校园】登录邮箱验证码"
        msg["From"] = f"智寻校园 <{SMTP_USER}>"
        msg["To"] = matched_user["email"]
        body = (
            f"您好，{matched_user['displayName']}：\n\n"
            f"您正在使用邮箱验证码登录「智寻校园」，本次验证码为：{code}\n"
            f"验证码 10 分钟内有效，最多可验证 5 次。"
        )
        msg.attach(MIMEText(body, "plain", "utf-8"))
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(SMTP_USER, [matched_user["email"]], msg.as_string())
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(SMTP_USER, [matched_user["email"]], msg.as_string())

        return {
            "ok": True,
            "status": 200,
            "message": "验证码已发送至绑定邮箱，10 分钟内有效",
            "expiresInSeconds": EMAIL_CODE_TTL_SECONDS,
        }
    except Exception as exc:
        _active_email_codes.pop(norm_email, None)
        print(f"[Auth SMTP Error] {exc}")
        return {
            "ok": False,
            "status": 502,
            "code": "SMTP_SEND_FAILED",
            "error": "邮件发送失败，请稍后重试或联系管理员检查 SMTP 配置",
        }


def verify_email_code_login(
    users: List[Dict[str, Any]], email_input: str, code_input: str
) -> Dict[str, Any]:
    norm_email = _normalize(email_input)
    trimmed_code = (code_input or "").strip()
    if not norm_email or not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", norm_email):
        return {"ok": False, "status": 400, "code": "INVALID_EMAIL", "error": "请输入有效的校园邮箱地址"}
    matched_user = find_user_by_email(users, norm_email)
    if not matched_user:
        return {"ok": False, "status": 404, "code": "EMAIL_NOT_BOUND", "error": "该邮箱未绑定账号"}
    if not re.fullmatch(r"\d{6}", trimmed_code):
        return {"ok": False, "status": 400, "code": "INVALID_CODE_FORMAT", "error": "请输入 6 位数字验证码"}

    rec = _active_email_codes.get(norm_email)
    if not rec:
        return {"ok": False, "status": 400, "code": "CODE_NOT_FOUND", "error": "验证码不存在或已失效，请先获取验证码"}
    if time.time() > rec["expiresAt"]:
        _active_email_codes.pop(norm_email, None)
        return {"ok": False, "status": 400, "code": "CODE_EXPIRED", "error": "验证码已过期，请重新获取"}
    if rec["attemptsRemaining"] <= 0:
        _active_email_codes.pop(norm_email, None)
        return {
            "ok": False,
            "status": 429,
            "code": "ATTEMPTS_EXHAUSTED",
            "attemptsRemaining": 0,
            "error": "验证码错误次数已达上限，请重新获取",
        }

    derived = _derive_scrypt_hex(trimmed_code, rec["codeSaltHex"], OTP_KEY_LEN)
    if not hmac.compare_digest(bytes.fromhex(derived), bytes.fromhex(rec["codeHashHex"])):
        rec["attemptsRemaining"] -= 1
        if rec["attemptsRemaining"] <= 0:
            _active_email_codes.pop(norm_email, None)
            return {
                "ok": False,
                "status": 429,
                "code": "ATTEMPTS_EXHAUSTED",
                "attemptsRemaining": 0,
                "error": "验证码错误次数已达上限，请重新获取",
            }
        return {
            "ok": False,
            "status": 401,
            "code": "INVALID_CODE",
            "attemptsRemaining": rec["attemptsRemaining"],
            "error": f"验证码不正确，还可尝试 {rec['attemptsRemaining']} 次",
        }

    _active_email_codes.pop(norm_email, None)
    return {"ok": True, "status": 200, "user": matched_user}
