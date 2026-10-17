/* app.js — 核心：把事件流渲染成舞台、阶段、仪表与瀑布。
   live.js（真实 SSE）与 simulator.js（演示）都只往 AgentDeck.ingest() 喂同一种事件。 */

window.AgentDeck = (() => {
  const $ = (id) => document.getElementById(id);

  const dom = {
    stream: $("stream"),
    empty: $("empty"),
    hint: $("streamHint"),
    jump: $("jumpBtn"),
    pill: $("statePill"),
    stateText: $("stateText"),
    stages: $("stages"),
    toolList: $("toolList"),
    brandSub: $("brandSub"),
    sessionTitle: $("sessionTitle"),
    sessionId: $("sessionId"),
    wf: $("waterfall"),
    wfTip: $("wfTip"),
    wfRange: $("wfRange"),
    sparkRate: $("sparkRate"),
    mRate: $("mRate"),
    mOut: $("mOut"),
    barOut: $("barOut"),
    mCache: $("mCache"),
    barCache: $("barCache"),
    mReason: $("mReason"),
    barReason: $("barReason"),
    mCost: $("mCost"),
    facts: {
      model: $("factModel"),
      messages: $("factMessages"),
      tools: $("factTools"),
      input: $("factIn"),
      output: $("factOut"),
      cache: $("factCache"),
      elapsed: $("factElapsed"),
    },
  };

  const STAGE_LABEL = { think: "思考中", tool: "执行工具", answer: "输出回答" };

  const state = {
    mode: "live",
    session: null,
    messages: [],
    bars: [],
    runningCalls: [],
    toolRows: new Map(),
    rateSamples: new Array(60).fill(0),
    lastOutputTokens: null,
    lastOutputAt: 0,
    currentStage: null,
    autoFollow: true,
    lastActivityAt: 0,
    activityText: "",
    typingCount: 0,
    frozenAt: null,
  };

  /* 统一时钟：演示暂停/播完后冻住，瀑布窗口、已用时、状态灯一起停 */
  const clockNow = () => (state.frozenAt == null ? Date.now() / 1000 : state.frozenAt);

  /* ---------- 小工具 ---------- */

  const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const compact = (n) => {
    if (n == null) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  };
  const secs = () => Date.now() / 1000;
  const dur = (ms) => (ms < 1000 ? `${Math.max(0, ms).toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`);
  const shortId = (id) => (id ? id.replace(/^local-/, "").slice(0, 12) : "—");

  function metric(node, value, digits = 0) {
    const to = Number(value || 0);
    const from = Number(node.dataset.v || 0);
    node.dataset.v = String(to);
    if (from === to) return;
    const write = (v) => {
      if (node.firstChild) node.firstChild.textContent = v.toFixed(digits);
    };
    // 后台标签页 rAF 会被冻结：直接把终值写上，别让仪表停在旧数字上
    if (document.hidden) {
      write(to);
      return;
    }
    const started = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - started) / 420);
      const eased = 1 - Math.pow(1 - p, 3);
      write(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
      else write(to);
    };
    requestAnimationFrame(step);
  }

  /* ---------- 打字机 ---------- */

  const TYPERS = new Set();

  function typeInto(node, text, caretParent) {
    const caret = document.createElement("span");
    caret.className = "caret";
    caretParent.appendChild(caret);
    const total = text.length;
    const cps = total > 1500 ? total / 1.6 : total > 300 ? total / 1.2 : total / 0.5;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(guard);
      node.textContent = text;
      caret.remove();
      TYPERS.delete(finish);
      state.typingCount = Math.max(0, state.typingCount - 1);
      if (state.autoFollow) scrollToBottom();
    };
    // 兜底：后台标签页 rAF 冻结时，定时器仍会走 —— 保证正文不会一直空着
    const guard = window.setTimeout(finish, Math.max(1500, (total / cps) * 1000 + 900));
    const alreadyDone = () => done;
    if (state.typingCount >= 3) {
      finish();
      return;
    }
    state.typingCount += 1;
    TYPERS.add(finish);
    let shown = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now) => {
      if (alreadyDone()) return;
      const dt = (now - last) / 1000;
      last = now;
      carry += cps * dt;
      const add = Math.floor(carry);
      if (add > 0) {
        carry -= add;
        shown = Math.min(total, shown + add);
        node.textContent = text.slice(0, shown);
        if (state.autoFollow) scrollToBottom();
      }
      if (shown >= total) return finish();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function flushTypers() {
    [...TYPERS].forEach((f) => f());
  }

  /* ---------- 滚动 ---------- */

  function nearBottom() {
    const s = dom.stream;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  }
  function scrollToBottom() {
    dom.stream.scrollTop = dom.stream.scrollHeight;
  }
  dom.stream.addEventListener("scroll", () => {
    state.autoFollow = nearBottom();
    dom.jump.hidden = state.autoFollow;
  });
  dom.jump.addEventListener("click", () => {
    state.autoFollow = true;
    dom.jump.hidden = true;
    flushTypers();
    scrollToBottom();
  });

  /* ---------- 阶段 ---------- */

  function setStage(stage, activityText) {
    state.currentStage = stage;
    if (stage) {
      state.activityText = activityText || STAGE_LABEL[stage];
      dom.pill.dataset.state = stage === "tool" ? "tool" : stage === "answer" ? "waiting" : "thinking";
      dom.stateText.textContent = activityText || STAGE_LABEL[stage];
    }
  }

  /* 阶段耗时一律由消息时间戳推出来（回放与实时口径一致），不用墙钟累加 */
  function totalsFromBars(now) {
    const totals = { think: 0, tool: 0, answer: 0 };
    state.bars.forEach((b) => {
      const end = b.t1 || (b.live ? now : b.t0);
      const span = Math.max(0, end - b.t0);
      if (b.kind === "think" || b.kind === "tool-result") totals.think += span;
      else if (b.kind === "tool-call") totals.tool += span;
      else if (b.kind === "answer") totals.answer += span;
    });
    return totals;
  }

  function updateStageRail(now) {
    const totals = totalsFromBars(now);
    [...dom.stages.children].forEach((li) => {
      const s = li.dataset.stage;
      const isNow = s === state.currentStage;
      li.dataset.state = isNow ? "now" : totals[s] > 0 ? "done" : "";
      const t = li.querySelector("[data-time]");
      t.textContent = totals[s] > 0 ? dur(totals[s] * 1000) : "";
    });
  }

  function updatePill() {
    if (state.currentStage) return; // 阶段活动时由 setStage 管
    const idleFor = clockNow() - (state.lastActivityAt || 0);
    dom.pill.dataset.state = "waiting";
    dom.stateText.textContent = idleFor < 20 ? "等待输入" : "空闲";
  }

  /* ---------- 消息渲染 ---------- */

  function head(kind, label, right) {
    const wrap = document.createElement("div");
    wrap.className = "msg-head";
    wrap.innerHTML = `<span class="chip">${label}</span>${right ? `<span class="lat">${right}</span>` : ""}`;
    return wrap;
  }

  function block(kind, ...children) {
    const node = document.createElement("article");
    node.className = "msg";
    node.dataset.kind = kind;
    children.forEach((c) => c && node.appendChild(c));
    return node;
  }

  function push(node) {
    if (dom.empty && dom.empty.parentNode) dom.empty.remove();
    dom.stream.appendChild(node);
    if (state.autoFollow) scrollToBottom();
  }

  function makeThink(m, typed) {
    const p = document.createElement("p");
    p.className = "think-text";
    const node = block("think", head("think", "思考", m.tokens ? `${m.tokens} tok` : ""), p);
    if (typed) typeInto(p, m.reasoning, node);
    else p.textContent = m.reasoning;
    return node;
  }

  function makeToolCard(call, m) {
    const card = document.createElement("div");
    card.className = "call";
    card.dataset.status = "running";
    card.dataset.name = call.name;

    const top = document.createElement("div");
    top.className = "call-top";
    top.innerHTML = `<span class="chip" style="--c: var(--tool)">工具</span><span class="call-name">${escapeHtml(
      call.name
    )}</span><span class="call-status">执行中…</span>`;
    card.appendChild(top);

    const args = document.createElement("pre");
    args.className = "args";
    args.textContent = String(call.args || "").trim() || "(无参数)";
    card.appendChild(args);

    const node = block("tool-call", card);
    state.runningCalls.push({ name: call.name, card, startedAt: (m.ts || secs()) * 1000 });
    addToolRow(call.name, "running");
    return node;
  }

  function attachResult(m) {
    const call =
      state.runningCalls.find((c) => c.name === m.tool_name) ||
      state.runningCalls.find((c) => c.card.dataset.status === "running") ||
      state.runningCalls[state.runningCalls.length - 1];
    const text = String(m.content || "").trim() || "(无输出)";
    const ms = call ? Math.max(0, (m.ts || secs()) * 1000 - call.startedAt) : 0;
    const failed = /"error"|^\s*Traceback|Error:|失败/i.test(text.slice(0, 400));

    const result = document.createElement("div");
    result.className = "result";
    result.dataset.open = "false";
    result.innerHTML = `<div class="result-head"><span>${text.length} 字符</span><span>·</span><span>${
      failed ? "返回异常" : "返回"
    }</span><span>·</span><span>${dur(ms)}</span><button class="result-toggle" type="button">展开</button></div>`;
    const pre = document.createElement("pre");
    pre.textContent = text.slice(0, 620) + (text.length > 620 ? "\n… 展开查看全文" : "");
    result.appendChild(pre);

    const toggle = result.querySelector(".result-toggle");
    toggle.addEventListener("click", () => {
      const open = result.dataset.open === "true";
      result.dataset.open = open ? "false" : "true";
      pre.textContent = open ? text.slice(0, 620) + (text.length > 620 ? "\n… 展开查看全文" : "") : text;
      toggle.textContent = open ? "展开" : "收起";
    });

    if (call) {
      call.card.dataset.status = failed ? "error" : "done";
      call.card.querySelector(".call-status").textContent = `${failed ? "异常" : "完成"} · ${dur(ms)}`;
      call.card.appendChild(result);
      setToolRow(call.name, failed ? "error" : "done", dur(ms));
      state.runningCalls = state.runningCalls.filter((c) => c !== call);
    } else {
      push(block("tool-result", head("tool-result", `结果 · ${m.tool_name || "工具"}`, dur(ms)), result));
    }
    return { ms, failed };
  }

  function addToolRow(name, status) {
    const existing = dom.toolList.querySelector(".none");
    if (existing) existing.remove();
    const li = document.createElement("li");
    li.dataset.name = name;
    li.dataset.status = status;
    li.innerHTML = `<span class="n">${escapeHtml(name)}</span><span class="t">执行中…</span>`;
    dom.toolList.appendChild(li);
    dom.toolList.scrollTop = dom.toolList.scrollHeight;
  }

  function setToolRow(name, status, text) {
    const rows = [...dom.toolList.querySelectorAll("li")];
    const li = rows.reverse().find((r) => r.dataset.name === name && r.dataset.status === "running") || rows[0];
    if (!li) return;
    li.dataset.status = status;
    li.querySelector(".t").textContent = text;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function makeAnswer(m, typed) {
    const p = document.createElement("p");
    p.className = "answer-text";
    const node = block("answer", head("answer", "回答", m.tokens ? `${m.tokens} tok` : ""), p);
    if (typed) typeInto(p, m.content, node);
    else p.textContent = m.content;
    return node;
  }

  function makeUser(m) {
    const p = document.createElement("p");
    p.className = "user-text";
    p.textContent = m.content || "(空消息)";
    return block("user", head("user", "用户"), p);
  }

  /* ---------- 消息摄入 ---------- */

  function kindOf(m) {
    if (m.role === "user") return "user";
    if (m.role === "tool") return "tool-result";
    if (m.role === "system") return "system";
    if ((m.tool_calls || []).length) return "tool-call";
    return m.content ? "answer" : "think";
  }

  function ingestMessage(m, typed) {
    state.messages.push(m);
    state.lastActivityAt = m.ts || secs();
    if (m.role === "user") {
      state.currentStage = null;
      state.runningCalls = [];
      state.toolRows.clear();
      closeBars(m.ts);
    }
    pushBarFor(m);

    const calls = m.tool_calls || [];
    if (m.role === "user") push(makeUser(m));
    if (m.role === "assistant" && m.reasoning) {
      push(makeThink(m, typed));
      setStage("think");
    }
    if (calls.length) {
      calls.forEach((c) => push(makeToolCard(c, m)));
      setStage("tool", calls.length === 1 ? `执行工具 · ${calls[0].name}` : `执行 ${calls.length} 个工具`);
    } else if (m.role === "assistant" && m.content) {
      push(makeAnswer(m, typed));
      setStage("answer");
      if (m.finish_reason === "stop") {
        window.setTimeout(() => setStage(null), 600);
      }
    }
    if (m.role === "tool") {
      const res = attachResult(m);
      setStage("think", "整理工具返回…");
      void res;
    }
    if (m.role === "user") setStage(null);
  }

  /* ---------- 瀑布 ---------- */

  function pushBarFor(m) {
    const kind = kindOf(m);
    closeBars(m.ts);
    const name = (m.tool_calls && m.tool_calls[0] && m.tool_calls[0].name) || m.tool_name || "";
    state.bars.push({ t0: m.ts || secs(), t1: null, kind, name, live: true, id: m.id });
    if (state.bars.length > 400) state.bars.shift();
  }

  function closeBars(ts) {
    if (!state.bars.length) return;
    const last = state.bars[state.bars.length - 1];
    last.t1 = Math.max(last.t0 + 0.4, ts || secs());
    last.live = false;
  }

  /* ---------- 会话与统计 ---------- */

  function applySession(s) {
    if (!s) return;
    state.session = s;
    dom.brandSub.textContent = `${s.model || "?"} · ${shortId(s.id)}`;
    dom.sessionTitle.textContent = s.title || s.display_name || "(未命名会话)";
    dom.sessionId.textContent = shortId(s.id) + (s.live ? " · 进行中" : " · 已结束");
    dom.facts.model.textContent = s.model || "—";
    dom.facts.messages.textContent = num(s.message_count);
    dom.facts.tools.textContent = num(s.tool_call_count);
    dom.facts.input.textContent = compact(s.input_tokens);
    dom.facts.output.textContent = compact(s.output_tokens);
    dom.facts.cache.textContent = compact(s.cache_read_tokens);

    const hit = Math.round((s.cache_hit_rate || 0) * 100);
    metric(dom.mCache, hit, 0);
    dom.barCache.style.width = `${Math.min(100, hit)}%`;

    const reason = Math.round((s.reasoning_share || 0) * 100);
    metric(dom.mReason, reason, 0);
    dom.barReason.style.width = `${Math.min(100, reason)}%`;

    metric(dom.mCost, Number(s.estimated_cost_usd || 0), 3);
    metric(dom.mOut, Number(s.output_tokens || 0), 0);
    dom.barOut.style.width = `${Math.min(100, ((s.output_tokens || 0) / 60000) * 100)}%`;

    const out = Number(s.output_tokens || 0);
    const t = secs();
    if (state.lastOutputTokens != null && t - state.lastOutputAt > 0) {
      const rate = Math.max(0, (out - state.lastOutputTokens) / (t - state.lastOutputAt));
      state.rateSamples.push(rate);
      if (state.rateSamples.length > 60) state.rateSamples.shift();
      metric(dom.mRate, rate, 1);
      Charts.sparkline(dom.sparkRate, state.rateSamples);
    }
    state.lastOutputTokens = out;
    state.lastOutputAt = t;

    state.activityText = s.last_activity_description || state.activityText;
    if (/tool running:\s*(\S+)/.test(state.activityText)) {
      setStage("tool", state.activityText);
    } else if (/thinking|new turn|starting/i.test(state.activityText)) {
      setStage("think", state.activityText);
    }
    state.lastActivityFromServer = s.last_activity_at || state.lastActivityFromServer;
  }

  /* ---------- 事件入口 ---------- */

  function reset(keepSession = true) {
    flushTypers();
    state.frozenAt = null;
    state.messages = [];
    state.bars = [];
    state.runningCalls = [];
    state.rateSamples = new Array(60).fill(0);
    state.lastOutputTokens = null;
    state.currentStage = null;
    dom.stream.innerHTML = "";
    dom.stream.appendChild(dom.empty);
    dom.empty.hidden = false;
    dom.toolList.innerHTML = '<li class="none">本轮还没有工具调用</li>';
    Charts.sparkline(dom.sparkRate, []);
    setStage(null);
    if (!keepSession) state.session = null;
  }

  function renderHistory(messages, { typeLast = true } = {}) {
    reset();
    if (!messages || !messages.length) return;
    messages.forEach((m, i) => ingestMessage(m, typeLast && i === messages.length - 1));
    closeBars(secs());
    state.autoFollow = true;
    scrollToBottom();
  }

  function ingest(event) {
    if (!event || !event.type) return;
    state.lastEventAt = Date.now();

    if (event.type === "snapshot" || event.type === "switch") {
      applySession(event.session);
      renderHistory(event.messages || [], { typeLast: false });
      dom.hint.textContent = `已载入 ${(event.messages || []).length} 条历史消息，等待新增…`;
      if (event.type === "switch") {
        dom.hint.textContent = "已切换到新的活跃会话";
      }
      setStage(null);
      return;
    }

    if (event.type === "message") {
      const m = event.message;
      if (!m) return;
      if (state.messages.some((x) => x.id === m.id)) return;
      dom.hint.textContent = `最新：${
        { think: "思考", "tool-call": "工具调用", "tool-result": "工具返回", answer: "回答", user: "用户", system: "系统" }[
          kindOf(m)
        ]
      } · ${new Date((m.ts || secs()) * 1000).toLocaleTimeString("zh-CN")}`;
      ingestMessage(m, event.typed !== false);
      return;
    }

    if (event.type === "stats") {
      applySession(event.session);
      return;
    }

    if (event.type === "error") {
      dom.hint.textContent = event.message || "服务端报错";
      return;
    }

    if (event.type === "offline") {
      dom.pill.dataset.state = "offline";
      dom.stateText.textContent = event.message || "连接断开";
    }
  }

  /* ---------- 常驻渲染循环 ---------- */

  function tick() {
    const now = clockNow();
    Charts.waterfall(dom.wf, state.bars, now, state.frozenAt == null);
    updateStageRail(now);

    if (state.session) {
      const turnStart = [...state.messages].reverse().find((m) => m.role === "user");
      const base = (turnStart && turnStart.ts) || state.session.started_at || now;
      dom.facts.elapsed.textContent = dur((now - base) * 1000);
    }

    const span = state.bars.length ? now - state.bars[0].t0 : 0;
    dom.wfRange.textContent = state.bars.length
      ? `${state.bars.length} 条消息 · 窗口 ${span >= 60 ? (span / 60).toFixed(1) + " 分钟" : span.toFixed(0) + " 秒"}`
      : "—";

    if (!state.currentStage) updatePill();
  }

  /* 用定时器而不是 rAF 驱动：后台标签页里 rAF 会被整帧冻结，定时器只是被降频 */
  window.setInterval(tick, 400);
  tick();

  /* ---------- 瀑布悬停 ---------- */

  dom.wf.addEventListener("mousemove", (e) => {
    const now = secs();
    const hit = Charts.hitTest(dom.wf, state.bars, now, e.clientX);
    if (!hit) {
      dom.wfTip.hidden = true;
      return;
    }
    dom.wfTip.hidden = false;
    dom.wfTip.style.left = `${hit.x}px`;
    dom.wfTip.style.top = `${hit.y - 8}px`;
    dom.wfTip.textContent = `${hit.label} · ${hit.detail}`;
  });
  dom.wf.addEventListener("mouseleave", () => (dom.wfTip.hidden = true));
  window.addEventListener("resize", () => {
    Charts.waterfall(dom.wf, state.bars, secs());
    Charts.sparkline(dom.sparkRate, state.rateSamples);
  });

  return {
    ingest,
    reset,
    renderHistory,
    applySession,
    /* 冻结/恢复时间轴（演示暂停或播完时用；实时模式永远走真时钟） */
    freeze(at) {
      state.frozenAt = at == null ? Date.now() / 1000 : at;
      tick();
    },
    unfreeze() {
      state.frozenAt = null;
      tick();
    },
    get frozen() {
      return state.frozenAt != null;
    },
    get mode() {
      return state.mode;
    },
    set mode(v) {
      state.mode = v;
    },
  };
})();
