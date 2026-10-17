"""只读访问 Hermes 的 state.db，把会话/消息/计数整理成前端要的事件形状。"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any


def _default_db() -> Path:
    """默认库路径：HERMES_STATE_DB > %LOCALAPPDATA%/hermes/state.db > ~/.local/share/hermes/state.db。"""
    env = os.environ.get("HERMES_STATE_DB")
    if env:
        return Path(env)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "hermes" / "state.db"
    return Path.home() / ".local" / "share" / "hermes" / "state.db"


DEFAULT_DB = _default_db()

MAX_REASONING = 8000
MAX_CONTENT = 4000
MAX_ARGS = 2000

SESSION_FIELDS = (
    "id, model, title, display_name, cwd, started_at, ended_at, last_activity_at, "
    "last_activity_description, message_count, tool_call_count, api_call_count, "
    "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, "
    "estimated_cost_usd, profile_name"
)


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def _clip(text: Any, limit: int) -> str:
    if not text:
        return ""
    text = str(text)
    return text if len(text) <= limit else text[:limit] + f"\n… [截断，共 {len(text)} 字符]"


def _session_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    cache_read = d.get("cache_read_tokens") or 0
    miss = d.get("input_tokens") or 0
    total = cache_read + miss
    d["cache_hit_rate"] = round(cache_read / total, 4) if total else 0.0
    d["reasoning_share"] = (
        round((d.get("reasoning_tokens") or 0) / d["output_tokens"], 4)
        if d.get("output_tokens")
        else 0.0
    )
    d["live"] = d.get("ended_at") is None
    return d


def list_sessions(db_path: Path, limit: int = 40) -> list[dict[str, Any]]:
    with _connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT {SESSION_FIELDS} FROM sessions "
            "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_session_dict(r) for r in rows]


def active_session_id(db_path: Path) -> str | None:
    """最近有活动的未结束会话。"""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT id FROM sessions WHERE ended_at IS NULL "
            "ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1"
        ).fetchone()
    return row["id"] if row else None


def get_session(db_path: Path, session_id: str) -> dict[str, Any] | None:
    with _connect(db_path) as conn:
        row = conn.execute(
            f"SELECT {SESSION_FIELDS} FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
    return _session_dict(row) if row else None


def resolve_session(db_path: Path, token: str) -> str | None:
    """支持完整 id 或唯一前缀（URL/界面上显示的是短 id）。'auto' = 当前活跃会话。"""
    if not token or token == "auto":
        return active_session_id(db_path)
    with _connect(db_path) as conn:
        row = conn.execute("SELECT id FROM sessions WHERE id = ?", (token,)).fetchone()
        if row:
            return row["id"]
        rows = conn.execute(
            "SELECT id FROM sessions WHERE id LIKE ? LIMIT 2", (token + "%",)
        ).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def _message_dict(row: sqlite3.Row) -> dict[str, Any]:
    calls: list[dict[str, str]] = []
    raw = row["tool_calls"]
    if raw and raw not in ("", "[]"):
        try:
            for item in json.loads(raw):
                fn = item.get("function") or item
                calls.append(
                    {
                        "name": fn.get("name") or "unknown",
                        "args": _clip(fn.get("arguments"), MAX_ARGS),
                    }
                )
        except (ValueError, AttributeError):
            calls.append({"name": "unparsed", "args": _clip(raw, MAX_ARGS)})

    reasoning = row["reasoning_content"] or row["reasoning"] or ""
    return {
        "id": row["id"],
        "role": row["role"],
        "ts": row["timestamp"],
        "reasoning": _clip(reasoning, MAX_REASONING),
        "content": _clip(row["content"], MAX_CONTENT),
        "tool_name": row["tool_name"],
        "tool_calls": calls,
        "tokens": row["token_count"],
        "finish_reason": row["finish_reason"],
    }


MESSAGE_FIELDS = (
    "id, role, content, tool_calls, tool_name, timestamp, token_count, finish_reason, "
    "reasoning, reasoning_content"
)


def recent_messages(db_path: Path, session_id: str, limit: int = 80) -> list[dict[str, Any]]:
    with _connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT {MESSAGE_FIELDS} FROM messages WHERE session_id = ? "
            "ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
    return [_message_dict(r) for r in reversed(rows)]


def messages_after(
    db_path: Path, session_id: str, after_id: int, limit: int = 60
) -> list[dict[str, Any]]:
    with _connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT {MESSAGE_FIELDS} FROM messages WHERE session_id = ? AND id > ? "
            "ORDER BY id ASC LIMIT ?",
            (session_id, after_id, limit),
        ).fetchall()
    return [_message_dict(r) for r in rows]


def tail_cursor(db_path: Path, session_id: str) -> int:
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE session_id = ?", (session_id,)
        ).fetchone()
    return int(row["m"] or 0)
