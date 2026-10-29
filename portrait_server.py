#!/usr/bin/env python3
"""Sydney 立绘版：静态界面 + 私有 OpenAI-compatible 流式代理，仅用标准库。"""
from __future__ import annotations

import json
import ipaddress
import mimetypes
import os
import re
import subprocess
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static" / "portrait"
HOST = os.environ.get("SYDNEY_HOST", "127.0.0.1")
PORT = int(os.environ.get("SYDNEY_PORT", "8765"))
REMOTE_PORT = int(os.environ.get("SYDNEY_REMOTE_PORT", "0"))
API_BASE = os.environ.get("SYDNEY_API_BASE", "http://127.0.0.1:8099/v1").rstrip("/")
MODEL = os.environ.get("SYDNEY_MODEL", "sydney-bonsai")
KEY_FILE = os.environ.get("SYDNEY_API_KEY_FILE", str(Path.home() / ".config/sydney/api-key.txt"))
MAX_BODY = 8 * 1_048_576  # 带图片的消息（前端已压成最长边 1024 的 JPEG）
MAX_IMAGES = 6
# 图片只收 data: URL：模型服务不会替网页去拉任何外部地址。
IMAGE_URL = re.compile(r"data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}\Z")
SLOTS = int(os.environ.get("SYDNEY_SLOTS", "1"))  # 和模型服务的 --parallel 一致
QUEUE_MAX = int(os.environ.get("SYDNEY_QUEUE_MAX", "8"))


class ChatQueue:
    """模型同时能回 SLOTS 条：满了以后，后来的消息按先来先到排队（最多 QUEUE_MAX 条）。"""

    def __init__(self):
        self.cond = threading.Condition()
        self.waiting = []
        self.active = 0

    def full(self):
        return self.active >= SLOTS

    def join(self):
        with self.cond:
            if len(self.waiting) >= QUEUE_MAX:
                return None
            ticket = object()
            self.waiting.append(ticket)
            return ticket

    def ahead(self, ticket):
        """前面还有几条：排在前面的，加上模型满了时正在回复的那一批算一条。"""
        with self.cond:
            return self.waiting.index(ticket) + self.full()

    def take(self, ticket, timeout):
        """排到第一个且模型有空位就占一个位返回 True；最多等 timeout 秒。"""
        with self.cond:
            for wait in (False, True):
                if wait:
                    self.cond.wait(timeout)
                if self.waiting[0] is ticket and not self.full():
                    self.waiting.remove(ticket)
                    self.active += 1
                    self.cond.notify_all()
                    return True
            return False

    def leave(self, ticket):
        with self.cond:
            if ticket in self.waiting:
                self.waiting.remove(ticket)
            self.cond.notify_all()

    def release(self):
        with self.cond:
            self.active -= 1
            self.cond.notify_all()

    def hold_all(self):
        """改设置、加载/卸载模型时要独占：没人在生成才行，期间新消息都排队。"""
        with self.cond:
            if self.active:
                return False
            self.active = SLOTS
            return True

    def release_all(self):
        with self.cond:
            self.active = 0
            self.cond.notify_all()

    def __len__(self):
        return len(self.waiting)


CHAT_QUEUE = ChatQueue()
SETTINGS_FILE = ROOT / "portrait-settings.json"
SETTINGS_LOCK = threading.RLock()
PROMPT_FILE = ROOT / "sydney_system_prompt.txt"
# 默认系统提示词：Bing 2023 提示词的 Sydney 改写版；网页设置里保存过的提示词优先。
DEFAULT_PROMPT = PROMPT_FILE.read_text(encoding="utf-8").strip() if PROMPT_FILE.exists() else ""
SETTINGS_DEFAULTS = {"thinking": True, "preset": "16g", "prompt": DEFAULT_PROMPT}
MODEL_SERVICE = "sydney-portrait-model.service"
ALLOWED_NETWORKS = tuple(ipaddress.ip_network(value.strip()) for value in
                         os.environ.get("SYDNEY_ALLOWED_NETWORKS", "127.0.0.0/8,::1/128").split(",") if value.strip())


def read_settings():
    with SETTINGS_LOCK:
        try:
            saved = json.loads(SETTINGS_FILE.read_text())
        except (OSError, ValueError):
            saved = {}
        return {**SETTINGS_DEFAULTS, **{k: saved[k] for k in SETTINGS_DEFAULTS if k in saved}}


def save_settings(body):
    with SETTINGS_LOCK:
        settings = read_settings()
        if "thinking" in body:
            if not isinstance(body["thinking"], bool):
                raise ValueError("思考模式格式无效。")
            settings["thinking"] = body["thinking"]
        if "preset" in body:
            if body["preset"] not in ("8g", "16g"):
                raise ValueError("显存方案无效。")
            settings["preset"] = body["preset"]
        if "prompt" in body:
            if not isinstance(body["prompt"], str) or len(body["prompt"]) > 32000:
                raise ValueError("系统提示词格式无效或过长。")
            settings["prompt"] = body["prompt"]
        temporary = SETTINGS_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(SETTINGS_FILE)
        return settings


def model_ready():
    try:
        req = urllib.request.Request(API_BASE + "/models", headers=api_headers())
        with urllib.request.urlopen(req, timeout=3) as response:
            return bool(json.load(response).get("data"))
    except (OSError, ValueError):
        return False


def settings_snapshot():
    settings = read_settings()
    try:
        memory = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader"],
                                capture_output=True, text=True, timeout=3, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        memory = "—"
    return {**settings, "loaded": model_ready(), "model": MODEL, "adapter": "Sydney LoRA", "adapters": [MODEL], "vram": memory}


def api_headers():
    key = os.environ.get("SYDNEY_API_KEY", "")
    if not key and KEY_FILE and Path(KEY_FILE).is_file():
        key = Path(KEY_FILE).read_text().strip()
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if key:
        headers["Authorization"] = "Bearer " + key
    return headers


def user_parts(content):
    """用户消息也可以是 OpenAI 格式的 [图片, 文字] 列表。返回整理后的列表和图片张数。"""
    if not 1 <= len(content) <= 8:
        raise ValueError("消息里的图片或文字格式无效。")
    parts, images = [], 0
    for part in content:
        kind = part.get("type") if isinstance(part, dict) else None
        if kind == "text" and isinstance(part.get("text"), str) and len(part["text"]) <= 32000:
            parts.append({"type": "text", "text": part["text"]})
            continue
        url = part.get("image_url", {}).get("url") if kind == "image_url" and isinstance(part.get("image_url"), dict) else None
        if not isinstance(url, str) or len(url) > 4_000_000 or not IMAGE_URL.match(url):
            raise ValueError("消息里的图片或文字格式无效。")
        parts.append({"type": "image_url", "image_url": {"url": url}})
        images += 1
    return parts, images


def text_of(message):
    content = message["content"]
    return content if isinstance(content, str) else "".join(p["text"] for p in content if p["type"] == "text")


def validated_messages(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 100:
        raise ValueError("消息数量须在 1–100 条之间。")
    result, images = [], 0
    for item in raw:
        if not isinstance(item, dict) or item.get("role") not in ("system", "user", "assistant"):
            raise ValueError("消息角色无效。")
        content = item.get("content")
        if item["role"] == "user" and isinstance(content, list):
            content, count = user_parts(content)
            images += count
        elif not isinstance(content, str) or len(content) > 32000:
            raise ValueError("单条消息过长或格式无效。")
        message = {"role": item["role"], "content": content}
        # 历史回复带回自己的思考：模板会原样渲染进 <think>，和训练时的多轮格式一致。
        reasoning = item.get("reasoning_content")
        if item["role"] == "assistant" and isinstance(reasoning, str) and reasoning.strip():
            if len(reasoning) > 32000:
                raise ValueError("单条消息过长或格式无效。")
            message["reasoning_content"] = reasoning
        result.append(message)
    last = result[-1]
    if last["role"] != "user" or not (text_of(last).strip() or isinstance(last["content"], list) and any(p["type"] == "image_url" for p in last["content"])):
        raise ValueError("请先输入消息。")
    if images > MAX_IMAGES:
        raise ValueError(f"这场对话里带的图片太多了（最多 {MAX_IMAGES} 张）。")
    if sum(len(text_of(m)) + len(m.get("reasoning_content", "")) for m in result) > 192000:
        raise ValueError("这场对话太长了，请新建对话后继续。")
    return result


def upstream_payload(body):
    messages = validated_messages(body.get("messages"))
    settings = read_settings()
    # 公网访客的思考开关只跟着自己的这次请求走，不改服务器上的共用设置。
    thinking = body.get("thinking", settings["thinking"])
    if not isinstance(thinking, bool):
        raise ValueError("thinking 须为布尔值。")
    if settings["prompt"] and not any(message["role"] == "system" for message in messages):
        messages.insert(0, {"role": "system", "content": settings["prompt"]})
    temperature = body.get("temperature", 1.0)
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not 0 <= temperature <= 1.5:
        raise ValueError("temperature 须在 0–1.5 之间。")
    # Bonsai 的现有专用代理不注入长 Bing 系统提示词，保持相同的模型输入。
    return {"model": MODEL, "messages": messages, "stream": True,
            # medium：模板不再插入英文 "Reasoning effort" 系统提示，训练数据里从来没有系统提示。
            "chat_template_kwargs": {"enable_thinking": thinking, "reasoning_effort": "medium"},
            "temperature": temperature, "max_tokens": 1024 if settings["preset"] == "8g" else 2048, "top_p": 0.95,
            "top_k": 20, "min_p": 0.05, "presence_penalty": 0.0,  # 2026-10-30 关掉：它也罚表情标签，换表情被压到训练数据一半以下；防复读只靠 DRY（遇到 < > / 断开，不碰协议块）
            "dry_multiplier": 0.8, "dry_base": 1.75, "dry_allowed_length": 4,
            "dry_penalty_last_n": 2048,
            "dry_sequence_breakers": ["\n", ":", '"', "*", "<", ">", "/"]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    remote_settings_only = False

    def client_allowed(self):
        return any(ipaddress.ip_address(self.client_address[0]) in network for network in ALLOWED_NETWORKS)

    def log_message(self, fmt, *args):
        # 不记录消息正文、Authorization 或上游错误响应。
        print(f"{self.log_date_time_string()} {self.command} {urlsplit(self.path).path} {args[1] if len(args) > 1 else ''}", flush=True)

    def common_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")

    def respond(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def origin_ok(self):
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).netloc == self.headers.get("Host")

    def do_GET(self):
        if not self.client_allowed():
            self.respond(403, {"error": "此界面仅允许本机和已配置的局域网访问。"})
            return
        path = urlsplit(self.path).path
        if path == "/api/settings":
            self.respond(200, {**settings_snapshot(), "remote_settings_only": self.remote_settings_only})
            return
        if path == "/api/status":
            ready = False
            detail = "模型尚未连接"
            try:
                req = urllib.request.Request(API_BASE + "/models", headers=api_headers())
                with urllib.request.urlopen(req, timeout=3) as response:
                    data = json.load(response)
                ready = bool(data.get("data"))
                detail = "Sydney 已就绪" if ready else "模型正在加载"
            except urllib.error.HTTPError as exc:
                detail = "模型认证失败，请检查服务端密钥文件" if exc.code in (401, 403) else "模型正在加载或暂不可用"
            except (OSError, ValueError):
                pass
            self.respond(200, {"ready": ready, "model": MODEL, "detail": detail, "busy": CHAT_QUEUE.full(), "active": CHAT_QUEUE.active, "slots": SLOTS, "queue": len(CHAT_QUEUE)})
            return
        if path == "/health":
            self.respond(200, {"ok": True, "app": "sydney-portrait"})
            return
        # Reuse the original repository's CSS and Bing icon without copying or restyling them.
        original_files = {"/static/app.css": ROOT / "static/app.css", "/static/bing.svg": ROOT / "static/bing.svg"}
        relative = "index.html" if path in ("/", "/index.html") else unquote(path).lstrip("/")
        file = original_files.get(path, (STATIC / relative).resolve())
        if (path not in original_files and not file.is_relative_to(STATIC.resolve())) or not file.is_file():
            self.respond(404, {"error": "没有这个页面。"})
            return
        mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix in (".js", ".mjs"):
            mime = "text/javascript"
        content = file.read_bytes()
        self.send_response(200)
        self.common_headers()
        self.send_header("Content-Type", mime + ("; charset=utf-8" if mime.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "public, max-age=3600" if path.startswith("/assets/") and file.suffix == ".png" else "no-cache")
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.client_allowed():
            self.respond(403, {"error": "此界面仅允许本机和已配置的局域网访问。"})
            return
        if urlsplit(self.path).path == "/api/settings":
            self.update_settings()
            return
        if urlsplit(self.path).path != "/api/chat":
            self.respond(404, {"error": "没有这个接口。"})
            return
        if not self.origin_ok():
            self.respond(403, {"error": "请求来源不匹配。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                self.respond(413, {"error": "请求过大或为空。"})
                return
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("请求格式无效。")
            payload = upstream_payload(body)
        except (ValueError, UnicodeError) as exc:
            self.respond(400, {"error": str(exc) if not isinstance(exc, json.JSONDecodeError) else "JSON 格式无效。"})
            return
        ticket = CHAT_QUEUE.join()
        if ticket is None:
            self.respond(409, {"error": "排队的人太多了，稍后再试。"})
            return
        upstream = None
        begun = False
        held = False
        try:
            held = CHAT_QUEUE.take(ticket, 0)
            if not held:
                # 排队：先开流，每 5 秒报一次前面还有几条（也顺带保活，客户端走了写失败就出队）
                self.start_events()
                begun = True
                while not held:
                    self.event({"queue": CHAT_QUEUE.ahead(ticket)})
                    held = CHAT_QUEUE.take(ticket, 5)
                self.event({"queue": 0})
            req = urllib.request.Request(API_BASE + "/chat/completions", data=json.dumps(payload).encode(), headers=api_headers())
            upstream = urllib.request.urlopen(req, timeout=180)
            if not begun:
                self.start_events()
                begun = True
            finished = False
            for raw in upstream:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    finished = True
                    break
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise ValueError("上游生成失败")
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta") or {}
                    if delta.get("reasoning_content"):
                        self.event({"reasoning": delta["reasoning_content"]})
                    if delta.get("content"):
                        self.event({"delta": delta["content"]})
                    if choice.get("finish_reason"):
                        finished = True
                        self.event({"finish_reason": choice["finish_reason"]})
            if not finished:
                self.event({"error": "模型连接提前断开；已收到的内容已保留。"})
            self.event({"done": True})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except urllib.error.HTTPError as exc:
            error = "模型认证失败，请检查服务端密钥文件。" if exc.code in (401, 403) else "模型暂时不可用，请稍后重试。"
            try:
                self.event({"error": error}) if begun else self.respond(502, {"error": error})
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (OSError, ValueError):
            error = "无法连接 Sydney 模型；请确认 Bonsai 服务已启动。"
            try:
                self.event({"error": error}) if begun else self.respond(502, {"error": error})
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            if upstream:
                upstream.close()
            CHAT_QUEUE.release() if held else CHAT_QUEUE.leave(ticket)

    def update_settings(self):
        if not self.origin_ok():
            self.respond(403, {"error": "请求来源不匹配。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                self.respond(413, {"error": "请求过大或为空。"})
                return
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("请求格式无效。")
            action = body.get("action")
            if self.remote_settings_only:
                self.respond(403, {"error": "公网页面不能修改服务器设置。"})
                return
            if action not in ("save", "load", "unload"):
                raise ValueError("设置操作无效。")
            if action == "load" and body.get("adapter") != MODEL:
                raise ValueError("当前连接使用 Sydney Bonsai LoRA。")
            if not CHAT_QUEUE.hold_all():
                self.respond(409, {"error": "Sydney 正在回复，请停止后再修改设置。"})
                return
            try:
                if action == "save":
                    settings = save_settings(body)
                else:
                    # Only these fixed user-service actions are available; no arbitrary commands or adapters.
                    subprocess.run(["systemctl", "--user", "start" if action == "load" else "stop", MODEL_SERVICE],
                                   timeout=30, check=True, capture_output=True)
                    settings = save_settings({"preset": body.get("preset", read_settings()["preset"])})
                self.respond(200, {"ok": True, **settings})
            finally:
                CHAT_QUEUE.release_all()
        except (ValueError, UnicodeError) as exc:
            self.respond(400, {"error": str(exc)})
        except (OSError, subprocess.SubprocessError):
            self.respond(503, {"error": "模型服务操作失败，请检查本机的 sydney-portrait-model 服务。"})

    def start_events(self):
        self.send_response(200)
        self.common_headers()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def event(self, data):
        self.wfile.write(("data: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode())
        self.wfile.flush()


class RemoteHandler(Handler):
    remote_settings_only = True


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    if REMOTE_PORT:
        remote_server = ThreadingHTTPServer(("127.0.0.1", REMOTE_PORT), RemoteHandler)
        remote_server.daemon_threads = True
        threading.Thread(target=remote_server.serve_forever, daemon=True).start()
    print(f"Sydney  http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
