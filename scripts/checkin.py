#!/usr/bin/env python3
"""有道 LobsterAI 每日签到（+100 积分/号/天）。

账号来源（按优先级）：
  1. 环境变量 LB2A_AUTHS  — JSON 数组，每个元素是一份 auth 文档
     （{"auth":{...},"account":{...}} 嵌套形或扁平形均可）。CI/云端用。
  2. 本地目录 ./auths/lobsterai-*.json — 登录工具（lobsterai-login）产出。

签到前会先用 refreshToken 续 accessToken（复刻 internal/upstream.Client.RefreshToken：
POST {BASE}/api/auth/refresh）。refreshToken 过期时需要重新本地登录一次。

其它环境变量：
  LB2A_UPSTREAM_BASE    上游 API（默认 https://lobsterai-server.youdao.com）
  LB2A_CLIENT_VERSION   手动指定 clientVersion（官方更新接口异常时的兜底）
"""
import json
import os
import pathlib
import re
import sys
import urllib.request
import uuid

BASE = os.environ.get("LB2A_UPSTREAM_BASE", "https://lobsterai-server.youdao.com").rstrip("/")
UPDATE_API = "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update"
HERE = pathlib.Path(__file__).resolve().parent
# 本地使用：优先脚本旁的 auths/，其次项目根的 auths/（登录工具默认输出位置）。
AUTHS_DIR = HERE / "auths"
if not AUTHS_DIR.exists() and (HERE.parent / "auths").exists():
    AUTHS_DIR = HERE.parent / "auths"
CLIENT_VERSION = os.environ.get("LB2A_CLIENT_VERSION") or None


def version_key(v):
    m = re.fullmatch(r"(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?", (v or "").strip())
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def resolve_client_version():
    global CLIENT_VERSION
    if CLIENT_VERSION:
        return CLIENT_VERSION
    try:
        req = urllib.request.Request(UPDATE_API, headers={"User-Agent": "LobsterAI-checkin"})
        with urllib.request.urlopen(req, timeout=15) as r:
            v = json.loads(r.read())["data"]["value"]["version"]
    except Exception as e:
        raise RuntimeError(f"官方更新接口取不到版本：{type(e).__name__}: {e}")
    if not version_key(v):
        raise RuntimeError(f"官方更新接口返回的版本格式异常：{v!r}")
    CLIENT_VERSION = v
    return v


def _request(method, url, token=None, body=None, ua=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "LobsterAI/" + (ua or CLIENT_VERSION or "0.1.0"),
    })
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def refresh_token(doc):
    """用 refreshToken 续 accessToken；成功时原地更新 doc 并返回 (ok, note)。"""
    a = doc.get("auth", doc)
    rt = a.get("refreshToken")
    if not rt:
        return False, "无 refreshToken，沿用现有 accessToken"
    body = {
        "firstKeyfrom": a.get("firstKeyfrom", ""),
        "latestKeyfrom": a.get("latestKeyfrom", ""),
        "version": "0.1.0",
        "refreshToken": rt,
    }
    if a.get("uuid"):
        body["uuid"] = a["uuid"]
    if a.get("userId"):
        body["userId"] = a["userId"]
    try:
        resp = _request("POST", BASE + "/api/auth/refresh", body=body)
    except Exception as e:
        return False, f"refresh 请求失败（沿用旧 token 再试）：{type(e).__name__}: {e}"
    tok = resp.get("data") if isinstance(resp, dict) else None
    if isinstance(resp, dict) and resp.get("code") not in (None, 0):
        return False, f"refresh code={resp.get('code')}（沿用旧 token 再试）"
    tok = tok if isinstance(tok, dict) else resp
    if not isinstance(tok, dict) or not tok.get("accessToken"):
        return False, "refresh 响应无 accessToken（需重新登录，沿用旧 token 再试）"
    a["accessToken"] = tok["accessToken"]
    if tok.get("refreshToken"):
        a["refreshToken"] = tok["refreshToken"]
    return True, "token 已续期"


def api(method, path, tok, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + tok,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "LobsterAI/" + CLIENT_VERSION,
        })
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if d.get("code") != 0:
        raise RuntimeError(f"code={d.get('code')} msg={d.get('message') or d.get('msg')}")
    if not isinstance(d.get("data"), dict):
        raise RuntimeError("data 为空（accessToken 可能已失效）")
    return d["data"]


def checkin(uid, tok):
    q = (f"placement=desktop_sidebar&clientVersion={CLIENT_VERSION}"
         f"&containerApiVersion=2&platform=win32")
    slot = api("GET", f"/api/client-activities/slot?{q}", tok)
    if slot.get("slotState") != "available" or not slot.get("activity"):
        return f"无可用活动（slotState={slot.get('slotState')!r}）", None
    code = slot["activity"]["activityCode"]
    rev = slot["activity"]["configRevision"]
    ctx = api("GET", f"/api/client-activities/{code}/context?configRevision={rev}", tok)
    if ctx["state"].get("claimedToday") or "check_in" not in (ctx.get("actions") or []):
        return "今天已签到，跳过", None
    res = api("POST", f"/api/client-activities/{code}/actions/check_in", tok,
              {"configRevision": rev, "idempotencyKey": str(uuid.uuid4()), "payload": {}})
    result = res.get("result") or {}
    gained = next((result[k] for k in ("creditsGranted", "rewardCredits", "credits")
                   if isinstance(result.get(k), (int, float))), None)
    return "签到成功", gained


def load_accounts():
    """返回 auth 文档列表。环境变量优先，其次本地 auths/ 目录。"""
    docs = []
    env = os.environ.get("LB2A_AUTHS", "").strip()
    if env:
        try:
            arr = json.loads(env)
        except json.JSONDecodeError as e:
            raise SystemExit(f"LB2A_AUTHS 不是合法 JSON：{e}")
        if isinstance(arr, dict):
            arr = [arr]
        if not isinstance(arr, list):
            raise SystemExit("LB2A_AUTHS 应为 JSON 数组（或单个 auth 对象）")
        for it in arr:
            if isinstance(it, dict):
                docs.append(it)
        if not docs:
            raise SystemExit("LB2A_AUTHS 解析后为空")
        return docs
    if AUTHS_DIR.exists():
        for f in sorted(AUTHS_DIR.glob("lobsterai-*.json")):
            try:
                docs.append(json.loads(f.read_text()))
            except Exception as e:
                print(f"跳过无法解析的文件 {f.name}：{e}")
    return docs


def uid_of(doc):
    acc = doc.get("account") or {}
    return acc.get("uid") or doc.get("uid") or "?"


def token_of(doc):
    a = doc.get("auth") or doc
    return a.get("accessToken")


def main():
    try:
        resolve_client_version()
    except Exception as e:
        print(f"解析 clientVersion 失败，本次不签到：{e}")
        return 1
    print(f"clientVersion={CLIENT_VERSION} base={BASE}")
    docs = load_accounts()
    if not docs:
        print(f"没找到账号：设置 LB2A_AUTHS 环境变量，或在 {AUTHS_DIR} 放 lobsterai-*.json")
        return 1
    fails = 0
    for doc in docs:
        uid = uid_of(doc)
        try:
            ok, note = refresh_token(doc)
            print(f"[{uid}] {note}")
            tok = token_of(doc)
            if not tok:
                raise RuntimeError("无 accessToken")
            msg, gained = checkin(uid, tok)
            print(f"[{uid}] {msg}" + (f" 积分 +{gained:g}" if gained else ""))
        except Exception as e:
            print(f"[{uid}] 签到失败：{e}")
            fails += 1
    print(f"完成：{len(docs)} 个账号，{fails} 个失败")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
