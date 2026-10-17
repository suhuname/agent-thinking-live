/* live.js — 真实数据通道：连 SSE，推给 AgentDeck。数据来自本机 Hermes state.db（只读）。 */

window.AgentLive = (() => {
  let source = null;
  let current = "auto";

  /* 会话下拉里显示的一行文案（boot 重建下拉时也用它） */
  function sessionLabel(s) {
    const when = s.last_activity_at ? new Date(s.last_activity_at * 1000) : null;
    const stamp = when
      ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(
          when.getMinutes()
        ).padStart(2, "0")}`
      : "—";
    return `${s.live ? "● " : ""}${stamp} · ${s.model || "?"} · ${s.message_count} 条${
      s.title ? " · " + s.title.slice(0, 26) : ""
    }`;
  }

  async function loadSessions(select) {
    try {
      const res = await fetch("/api/sessions?limit=40");
      const data = await res.json();
      const sessions = (data.sessions || []).filter((s) => (s.message_count || 0) > 0);
      select.innerHTML = "";
      sessions.forEach((s, i) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = sessionLabel(s);
        if (i === 0 && s.live) opt.textContent = `当前活跃 · ${opt.textContent}`;
        select.appendChild(opt);
      });
      select.disabled = false;
      return sessions;
    } catch (err) {
      select.innerHTML = "<option>会话列表读取失败</option>";
      return [];
    }
  }

  function connect(token) {
    close();
    current = token || "auto";
    source = new EventSource(`/api/stream?session=${encodeURIComponent(current)}`);
    source.onopen = () => {
      document.getElementById("streamHint").textContent = "已连接 state.db，等待 agent 输出…";
    };
    source.onmessage = (e) => {
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      window.AgentDeck.ingest(payload);
      // 图谱 / 神经视图还要用同一份数据建节点（RealFeed 在 boot 里转发进来）
      document.dispatchEvent(new CustomEvent("live:event", { detail: payload }));
      if (payload.type === "snapshot" || payload.type === "switch") {
        document.dispatchEvent(new CustomEvent("deck:session", { detail: payload.session }));
      }
    };
    source.onerror = () => {
      window.AgentDeck.ingest({ type: "offline", message: "连接断开，重连中…" });
    };
  }

  function close() {
    if (source) {
      source.close();
      source = null;
    }
  }

  return { connect, close, loadSessions, sessionLabel, get current() { return current; } };
})();
