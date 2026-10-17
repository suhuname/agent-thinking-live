/* real-feed.js — 真实会话 → 图谱 / 神经。
   把 state.db 的消息流映射成"节点流"喂给当前视图：
     user       → 用户节点（每轮的根）
     assistant  → 思考节点（reasoning）+ 每个 tool_call 一个工具节点
     tool       → 结果节点（挂在对应工具节点下）
     末条回答    → 回答节点
   父子链就是因果链，所以图谱往下长、神经网络按类型落到对应功能区点火。

   演示脚本走 sim-graph.js / sim-neural.js，不进这里；这里只处理真实数据。 */

window.RealFeed = (() => {
  const MAX_HISTORY = 60; // 实时视图也只回放 60 条；建图同样只取最近 60 条，免得一屏塞爆

  let view = null; // 'graph' | 'neural' | null
  let cursor = null; // 上一步的节点 id（因果链的"当下位置"）
  let nodeCount = 0;

  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };

  function firstLine(text) {
    const s = String(text || "");
    const line = s.split("\n").find((l) => l.trim().length > 0) || "";
    return line.trim();
  }

  /* 工具参数太长：抽第一个能读的值当提示（path / command / query …） */
  function argHint(args) {
    const raw = String(args || "");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      /* 不是 JSON 就直接用原文 */
    }
    if (parsed && typeof parsed === "object") {
      const prefer = ["path", "file_path", "command", "query", "name", "url", "pattern", "prompt"];
      for (const k of prefer) {
        if (typeof parsed[k] === "string" && parsed[k].trim()) return parsed[k];
      }
      const firstStr = Object.values(parsed).find((v) => typeof v === "string" && v.trim());
      if (firstStr) return firstStr;
    }
    return raw.replace(/^[\s{[]+|[\s}\]]+$/g, "");
  }

  function hint(text) {
    const el = document.getElementById("streamHint");
    if (el) el.textContent = text;
  }

  function push(spec) {
    if (!view) return;
    nodeCount += 1;
    const parent = spec.parent === undefined ? cursor : spec.parent;
    if (view === "graph") {
      const n = window.AgentGraph.add({ ...spec, parent });
      if (spec.kind === "result" && parent) window.AgentGraph.complete(parent);
      window.AgentGraph.setActive(n.id);
    } else if (view === "neural") {
      window.AgentNeural.inject({ ...spec, parent: undefined });
      if (spec.kind === "result" && parent) window.AgentNeural.complete(parent);
    }
    cursor = spec.id;
  }

  function fromMessage(m) {
    if (!m || !m.role) return;
    const id = m.id != null ? m.id : `x${nodeCount}`;

    if (m.role === "user") {
      push({
        id: `u${id}`,
        kind: "user",
        label: clip(firstLine(m.content) || "用户消息", 22),
        text: m.content || "",
      });
      return;
    }

    if (m.role === "tool") {
      push({
        id: `r${id}`,
        kind: "result",
        label: clip(firstLine(m.content) || m.tool_name || "结果", 22),
        text: m.content || "",
        tool: m.tool_name || "",
      });
      return;
    }

    if (m.role !== "assistant") return; // system / 其他角色不进图

    const calls = m.tool_calls || [];
    const reasoning = (m.reasoning || "").trim();
    const content = (m.content || "").trim();

    // 思考段：有推理原文就单独一颗；没有就退化成"想了一下"的占位，免得链断
    const thinkId = `t${id}`;
    if (reasoning) {
      push({ id: thinkId, kind: "think", label: clip(firstLine(reasoning), 22), text: reasoning, tokens: m.tokens });
    }

    if (calls.length) {
      const parent = reasoning ? thinkId : cursor;
      calls.forEach((c, i) => {
        const tool = c.name || "tool";
        // 技能加载单独成一种类型：会在神经视图点亮"技能区"、图谱里走技能车道
        const isSkill = tool === "skill_view" || tool === "load_skill";
        push({
          id: `c${id}-${i}`,
          kind: isSkill ? "skill" : "call",
          label: `${tool} · ${clip(argHint(c.args), 22)}`,
          tool,
          text: c.args || "",
          parent,
        });
      });
      return;
    }

    if (content) {
      // 有推理又有正文（同一轮先想说再答）时，正文单独成节点并挂在思考下面
      const isAnswer = m.finish_reason === "stop";
      push({
        id: `a${id}`,
        kind: isAnswer ? "answer" : "think",
        label: clip(firstLine(content), 22),
        text: content,
        tokens: m.tokens,
        parent: reasoning ? thinkId : cursor,
      });
    }
  }

  function clear() {
    cursor = null;
    nodeCount = 0;
    window.AgentDeck.reset(false);
    window.AgentDeck.unfreeze();
    if (view === "graph") {
      window.AgentGraph.reset();
      window.AgentGraph.follow = true;
      window.AgentGraph.playing = true;
    } else if (view === "neural") {
      window.AgentNeural.reset();
      window.AgentNeural.playing = true;
    }
  }

  function rebuild(messages) {
    const list = (messages || []).slice(-MAX_HISTORY);
    clear();
    list.forEach(fromMessage);
    const dropped = (messages || []).length - list.length;
    hint(
      `真实会话 · 已重建 ${nodeCount} 个节点${dropped > 0 ? `（更早的 ${dropped} 条消息未建图）` : ""} · 等待新动作…`
    );
  }

  /* SSE 里每条 payload 都会进来（boot 转发 live:event） */
  function ingest(payload) {
    if (!view || !payload) return;
    if (payload.type === "snapshot" || payload.type === "switch") {
      rebuild(payload.messages || []);
      return;
    }
    if (payload.type === "message" && payload.message) fromMessage(payload.message);
  }

  function start(nextView) {
    view = nextView;
    clear();
    hint("真实会话 · 正在读取 state.db…");
  }

  function stop() {
    view = null;
  }

  return {
    start,
    stop,
    ingest,
    rebuild,
    get active() {
      return view;
    },
    get count() {
      return nodeCount;
    },
  };
})();
