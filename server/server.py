"""HTTP 层：静态页面 + /api/* + SSE 实时流。

静态资源白名单：只暴露 index.html、css/**、js/**（main.py 与 server/ 不外泄）。
SSE 用分块传输，前端用原生 EventSource 消费。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import db

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = db.DEFAULT_DB
STATIC_SUFFIXES = {".html", ".css", ".js", ".svg", ".png", ".ico", ".woff2", ".map"}
POLL_SECONDS = 0.5
STATS_SECONDS = 1.5
AUTO_RESOLVE_SECONDS = 5.0
HEARTBEAT_SECONDS = 15.0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "agent-thinking-live"

    # ---------- helpers ----------

    def log_message(self, fmt: str, *args) -> None:  # 静一点：只留一行访问日志
        if "/api/stream" in self.path:
            return
        print(f"  {self.address_string()} {fmt % args}")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _sse_headers(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _sse(self, payload: dict) -> None:
        # SSE 帧格式：字段名 + 冒号 + 正文，最后空行结束（少了它就是一堆没人理会的字节）
        body = json.dumps(payload, ensure_ascii=False)
        self._chunk(f"data: {body}\n\n".encode("utf-8"))

    def _comment(self, text: str) -> None:
        self._chunk(f": {text}\n\n".encode("utf-8"))

    def _chunk(self, data: bytes) -> None:
        self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def handle(self) -> None:  # 客户端断连是常态，别刷一屏 traceback
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError):
            pass

    def _static(self, path: str) -> None:
        rel = unquote(path.lstrip("/")) or "index.html"
        target = (ROOT / rel).resolve()
        allowed_root = ROOT.resolve()
        ok = (
            target.is_file()
            and target.suffix.lower() in STATIC_SUFFIXES
            and allowed_root in target.parents
            and (target.name == "index.html" or target.parent.name in ("css", "js", "assets"))
        )
        if not ok:
            self._json({"error": "not found", "path": rel}, 404)
            return
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or target.suffix in (".js", ".css", ".html", ".svg"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- routes ----------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        route = parsed.path

        if route == "/api/health":
            self._json(
                {
                    "ok": True,
                    "db": str(DB_PATH),
                    "db_exists": DB_PATH.is_file(),
                    "active_session": db.active_session_id(DB_PATH),
                    "sessions": len(db.list_sessions(DB_PATH, 200)),
                }
            )
            return

        if route == "/api/sessions":
            limit = int((query.get("limit") or ["40"])[0])
            self._json({"sessions": db.list_sessions(DB_PATH, limit)})
            return

        if route.startswith("/api/session/") and route.endswith("/messages"):
            token = unquote(route[len("/api/session/") : -len("/messages")]).strip("/")
            limit = int((query.get("limit") or ["80"])[0])
            sid = db.resolve_session(DB_PATH, token)
            if not sid:
                self._json({"error": "session not found", "token": token}, 404)
                return
            self._json(
                {
                    "session": db.get_session(DB_PATH, sid),
                    "messages": db.recent_messages(DB_PATH, sid, limit),
                }
            )
            return

        if route == "/api/stream":
            token = (query.get("session") or ["auto"])[0]
            try:
                self._stream(token)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return

        self._static(route)

    # ---------- SSE ----------

    def _stream(self, token: str) -> None:
        session_id = db.resolve_session(DB_PATH, token)
        if not session_id:
            self._sse_headers()
            self._sse({"type": "error", "message": f"找不到会话 {token}"})
            time.sleep(1.0)
            self._sse_end()
            return

        session = db.get_session(DB_PATH, session_id)
        history = db.recent_messages(DB_PATH, session_id, 60)
        cursor = history[-1]["id"] if history else db.tail_cursor(DB_PATH, session_id)

        self._sse_headers()
        self._sse({"type": "snapshot", "session": session, "messages": history})
        last_stats = 0.0
        last_auto = 0.0
        last_beat = time.time()
        follow_auto = token in ("", "auto")

        while True:
            now = time.time()
            for msg in db.messages_after(DB_PATH, session_id, cursor):
                cursor = msg["id"]
                self._sse({"type": "message", "message": msg})

            if now - last_stats >= STATS_SECONDS:
                last_stats = now
                fresh = db.get_session(DB_PATH, session_id)
                if fresh:
                    session = fresh
                    self._sse({"type": "stats", "session": fresh})

            if follow_auto and now - last_auto >= AUTO_RESOLVE_SECONDS:
                last_auto = now
                active = db.active_session_id(DB_PATH)
                if active and active != session_id:
                    session_id = active
                    history = db.recent_messages(DB_PATH, session_id, 40)
                    cursor = history[-1]["id"] if history else 0
                    self._sse(
                        {
                            "type": "switch",
                            "session": db.get_session(DB_PATH, session_id),
                            "messages": history,
                        }
                    )

            if now - last_beat >= HEARTBEAT_SECONDS:
                last_beat = now
                self._comment("ping")

            time.sleep(POLL_SECONDS)

    def _sse_end(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-thinking-live")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9028)
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args(argv or [])

    if not DB_PATH.is_file():
        print(f"[agent-thinking-live] 找不到 Hermes 数据库：{DB_PATH}")
        print("  用 HERMES_STATE_DB 环境变量指定其它路径。")
        return 2

    active = db.active_session_id(DB_PATH)
    print(f"[agent-thinking-live] db       : {DB_PATH}")
    print(f"[agent-thinking-live] 活跃会话 : {active or '(无未结束会话)'}")
    print(f"[agent-thinking-live] 打开     : http://{args.host}:{args.port}/")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    if args.open:
        webbrowser.open(f"http://{args.host}:{args.port}/")
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\n[agent-thinking-live] 已停止")
    finally:
        httpd.server_close()
    return 0
