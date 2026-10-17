"""自检：`python main.py test`。不联网、不改数据，只验证运行时依赖是否齐。"""

from __future__ import annotations

import socket
import sys
from pathlib import Path

from . import db
from .server import ROOT, STATIC_SUFFIXES

REQUIRED_COLUMNS = {
    "messages": {"id", "session_id", "role", "content", "tool_calls", "tool_name", "timestamp",
                 "token_count", "finish_reason", "reasoning", "reasoning_content"},
    "sessions": {"id", "model", "message_count", "tool_call_count", "input_tokens",
                 "output_tokens", "cache_read_tokens", "reasoning_tokens",
                 "last_activity_at", "last_activity_description", "ended_at"},
}
STATIC_FILES = ["index.html", "css/style.css", "js/app.js", "js/live.js", "js/simulator.js",
                "js/charts.js", "js/boot.js", "js/graph.js", "js/sim-graph.js", "js/demo-common.js",
                "js/demo-script.js", "js/neural.js", "js/sim-neural.js", "js/real-feed.js"]


def _check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f" — {detail}" if detail else ""))
    return ok


def run_selftest() -> int:
    results: list[bool] = []
    print("[agent-thinking-live] 自检")

    ok = db.DEFAULT_DB.is_file()
    results.append(_check("state.db 存在", ok, str(db.DEFAULT_DB)))
    if not ok:
        return 1

    with db._connect(db.DEFAULT_DB) as conn:
        for table, columns in REQUIRED_COLUMNS.items():
            have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            missing = columns - have
            results.append(_check(f"{table} 表字段齐全", not missing, f"缺 {sorted(missing)}" if missing else ""))

        rows = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE reasoning_content IS NOT NULL "
            "AND reasoning_content <> ''"
        ).fetchone()[0]
        results.append(_check("有推理原文可展示", rows > 0, f"{rows} 条"))

        calls = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE tool_calls NOT IN ('', '[]')"
        ).fetchone()[0]
        results.append(_check("有工具调用可展示", calls > 0, f"{calls} 条"))

    sessions = db.list_sessions(db.DEFAULT_DB, 5)
    results.append(_check("会话列表可读", len(sessions) > 0, f"{len(sessions)} 条"))

    active = db.active_session_id(db.DEFAULT_DB)
    results.append(_check("能定位活跃会话", active is not None, (active or "")[:24]))

    if sessions:
        hist = db.recent_messages(db.DEFAULT_DB, sessions[0]["id"], 5)
        results.append(_check("历史消息可读", bool(hist), f"{len(hist)} 条"))

    for rel in STATIC_FILES:
        path = ROOT / rel
        results.append(_check(f"静态资源 {rel}", path.is_file() and path.suffix in STATIC_SUFFIXES))

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        free = sock.connect_ex(("127.0.0.1", 9028)) != 0
    if free:
        results.append(_check("端口 9028 可用", True))
    else:
        import json as _json
        import urllib.request

        ours = False
        try:
            with urllib.request.urlopen("http://127.0.0.1:9028/api/health", timeout=2) as res:
                ours = bool(_json.loads(res.read()).get("ok"))
        except Exception:
            ours = False
        results.append(
            _check("端口 9028", ours, "本服务已在运行（不用重复启动）" if ours else "被别的程序占用")
        )

    bad = results.count(False)
    print(f"\n结果：{len(results) - bad}/{len(results)} 通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(run_selftest())
