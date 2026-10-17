/* boot.js — 启动装配：四个视图、会话下拉（数据源）、URL 参数、图谱与神经工具条。

   两个维度分开了：
     · 视图（页签）  = 怎么画    实时/演示 走思考流；图谱 走因果图；神经 走神经网络
     · 数据源（下拉）= 画什么
         「实时」页签  → 自动跟随 / 某个真实会话
         「演示」页签  → 固定跑脚本（下拉禁用）
         「图谱」「神经」→ 演示（脚本）/ 自动跟随 / 某个真实会话
   选真实会话时，同一份 SSE 数据同时喂 AgentDeck（阶段/仪表/瀑布）和 RealFeed（建节点）。 */

(() => {
  const DEMO = "__demo__";
  const params = new URLSearchParams(location.search);
  const select = document.getElementById("sessionSelect");
  const hint = document.getElementById("streamHint");
  const buttons = [...document.querySelectorAll(".seg-btn")];
  const VIEWS = ["live", "demo", "graph", "neural"];
  const fromUrl = params.get("mode");

  let mode = VIEWS.includes(fromUrl) ? fromUrl : "live";
  let graphReady = false;
  let neuralReady = false;
  let sessionsCache = [];
  let sessionsLoaded = false;
  let selectionTouched = false; // 用户手动选过（或 URL 指定过）才算"明确的偏好"
  let initialPreferred = null; // 首屏 URL 指定的会话（只用于第一次填下拉）

  const isScripted = () => mode === "demo" || select.value === DEMO;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- 会话下拉 ---------- */

  async function ensureSessions() {
    if (sessionsLoaded) return sessionsCache;
    sessionsLoaded = true;
    sessionsCache = await window.AgentLive.loadSessions(select);
    return sessionsCache;
  }

  function sessionOptions() {
    if (mode === "demo") return [{ v: DEMO, t: "演示（脚本）" }]; // 演示页签固定跑脚本
    const opts = [];
    if (mode === "graph" || mode === "neural") opts.push({ v: DEMO, t: "演示（脚本）" });
    opts.push({ v: "auto", t: "● 自动跟随当前活跃会话" });
    let marked = false;
    sessionsCache.forEach((s) => {
      let t = window.AgentLive.sessionLabel(s);
      if (s.live && !marked) {
        t = `当前活跃 · ${t}`;
        marked = true;
      }
      opts.push({ v: s.id, t });
    });
    if (!opts.length) opts.push({ v: DEMO, t: "演示（脚本）" });
    return opts;
  }

  function defaultChoice() {
    if (mode === "demo") return DEMO;
    if (mode === "graph" || mode === "neural") return DEMO; // 刚进来先跑脚本，手动选了会话才变真实数据
    const wanted = params.get("session");
    if (wanted) {
      const hit = sessionsCache.find((s) => s.id.startsWith(wanted));
      if (hit) return hit.id;
    }
    const live = sessionsCache.find((s) => s.live);
    return live ? live.id : "auto";
  }

  function fillSelect(preferred) {
    const opts = sessionOptions();
    // 首屏别把 loadSessions 顺手填进去的"第一个会话"当成用户选择，
    // 否则图谱 / 神经一进来就是真实数据，跟"默认先跑脚本"的约定相反
    const prev = preferred || (selectionTouched ? select.value : "");
    select.innerHTML = opts.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join("");
    select.disabled = mode === "demo";
    const want = opts.some((o) => o.v === prev) ? prev : defaultChoice();
    select.value = opts.some((o) => o.v === want) ? want : opts[0].v;
  }

  /* ---------- 图谱工具条（第一次进图谱视图时装上） ---------- */

  function ensureGraph() {
    if (graphReady) return;
    graphReady = true;
    window.AgentGraph.init(document.getElementById("graph"), document.getElementById("graphTip"));

    const play = document.getElementById("graphPlay");
    const speed = document.getElementById("graphSpeed");
    const follow = document.getElementById("graphFollow");

    const replay = () => {
      if (!isScripted()) {
        applySource(); // 真实数据：重连一次，从快照重建
        return;
      }
      window.AgentGraphSim.stop();
      window.AgentGraph.reset();
      window.AgentGraph.follow = true;
      window.AgentDeck.unfreeze();
      window.AgentGraphSim.start();
      play.textContent = "暂停";
      play.setAttribute("aria-pressed", "false");
    };

    document.getElementById("graphReplay").addEventListener("click", replay);

    /* 一轮演完：停在成品图上，播放键变成「重播」，时间轴也冻住 */
    document.addEventListener("graph:finished", () => {
      play.textContent = "重播";
      play.setAttribute("aria-pressed", "true");
      window.AgentDeck.freeze();
    });

    play.addEventListener("click", () => {
      if (window.AgentGraphSim.finished) {
        replay();
        return;
      }
      const paused = window.AgentGraph.playing;
      window.AgentGraph.playing = !paused;
      window.AgentGraphSim.paused = paused;
      if (paused) window.AgentDeck.freeze();
      else window.AgentDeck.unfreeze();
      play.textContent = paused ? "继续" : "暂停";
      play.setAttribute("aria-pressed", String(paused));
    });

    speed.addEventListener("click", () => {
      const levels = [1, 2, 4];
      const next = levels[(levels.indexOf(window.AgentGraph.speed) + 1) % levels.length];
      window.AgentGraph.speed = next;
      window.AgentGraphSim.speed = next;
      speed.textContent = `×${next}`;
    });

    document.getElementById("graphFit").addEventListener("click", () => {
      window.AgentGraph.fit();
      follow.classList.remove("is-on");
      follow.setAttribute("aria-pressed", "true");
    });

    follow.addEventListener("click", () => {
      const next = !window.AgentGraph.follow;
      window.AgentGraph.follow = next;
      follow.classList.toggle("is-on", next);
      follow.setAttribute("aria-pressed", String(!next));
    });
  }

  /* ---------- 神经工具条（第一次进神经视图时装上） ---------- */

  function ensureNeural() {
    if (neuralReady) return;
    neuralReady = true;
    window.AgentNeural.init(
      document.getElementById("neural"),
      document.getElementById("neuralTip"),
      document.getElementById("neuralDetail")
    );

    const play = document.getElementById("neuralPlay");
    const speed = document.getElementById("neuralSpeed");

    const replay = () => {
      if (!isScripted()) {
        applySource();
        return;
      }
      window.AgentNeuralSim.stop();
      window.AgentNeural.reset();
      window.AgentDeck.unfreeze();
      window.AgentNeuralSim.start();
      play.textContent = "暂停";
      play.setAttribute("aria-pressed", "false");
    };

    document.getElementById("neuralReplay").addEventListener("click", replay);

    /* 一轮演完：停在这片网上，播放键变「重播」，时间轴一起冻 */
    document.addEventListener("neural:finished", () => {
      play.textContent = "重播";
      play.setAttribute("aria-pressed", "true");
      window.AgentDeck.freeze();
    });

    play.addEventListener("click", () => {
      if (window.AgentNeuralSim.finished) {
        replay();
        return;
      }
      const paused = window.AgentNeural.playing;
      window.AgentNeural.playing = !paused;
      window.AgentNeuralSim.paused = paused;
      if (paused) window.AgentDeck.freeze();
      else window.AgentDeck.unfreeze();
      play.textContent = paused ? "继续" : "暂停";
      play.setAttribute("aria-pressed", String(paused));
    });

    speed.addEventListener("click", () => {
      const levels = [1, 2, 4];
      const next = levels[(levels.indexOf(window.AgentNeural.speed) + 1) % levels.length];
      window.AgentNeural.speed = next;
      window.AgentNeuralSim.speed = next;
      speed.textContent = `×${next}`;
    });

    document.getElementById("neuralFit").addEventListener("click", () => window.AgentNeural.fit());
  }

  /* 真实数据没有"播放 / 重播"的语义：藏起暂停键，把重播改成「重建」 */
  function setScriptControls(which, scripted) {
    const play = document.getElementById(which === "graph" ? "graphPlay" : "neuralPlay");
    const replay = document.getElementById(which === "graph" ? "graphReplay" : "neuralReplay");
    if (play) play.hidden = !scripted;
    if (replay) replay.textContent = scripted ? "重播" : "重建";
    if (scripted && play) {
      play.textContent = "暂停";
      play.setAttribute("aria-pressed", "false");
    }
  }

  /* ---------- 数据源 → 视图 ---------- */

  function stopSims() {
    window.AgentGraphSim.stop();
    window.AgentNeuralSim.stop();
    AgentSim.stop();
  }

  function applySource() {
    const src = mode === "demo" ? DEMO : select.value || "auto";

    stopSims();
    window.RealFeed.stop();
    window.AgentLive.close();
    window.AgentDeck.unfreeze();

    /* 脚本源 */
    if (mode === "demo" || src === DEMO) {
      window.AgentDeck.reset(false);
      if (mode === "graph") {
        ensureGraph();
        setScriptControls("graph", true);
        window.AgentGraph.follow = true;
        document.getElementById("graphFollow").classList.add("is-on");
        window.AgentGraphSim.start();
        return;
      }
      if (mode === "neural") {
        ensureNeural();
        setScriptControls("neural", true);
        window.AgentNeuralSim.start();
        return;
      }
      AgentSim.start();
      return;
    }

    /* 真实会话 */
    window.AgentDeck.reset();
    hint.textContent = "正在读取 state.db…";
    if (mode === "graph") {
      ensureGraph();
      setScriptControls("graph", false);
      window.AgentGraph.follow = true;
      document.getElementById("graphFollow").classList.add("is-on");
      window.RealFeed.start("graph");
    } else if (mode === "neural") {
      ensureNeural();
      setScriptControls("neural", false);
      window.RealFeed.start("neural");
    }
    window.AgentLive.connect(src === "auto" ? "auto" : src);
  }

  async function setMode(next) {
    mode = next;
    window.AgentDeck.mode = next;
    buttons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === next)));
    document.body.dataset.view = next === "graph" || next === "neural" ? next : "stream";

    await ensureSessions();
    if (next === "graph") ensureGraph();
    if (next === "neural") ensureNeural();
    fillSelect(initialPreferred);
    initialPreferred = null;
    applySource();
  }

  /* ---------- 接线 ---------- */

  buttons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  select.addEventListener("change", () => {
    if (mode === "demo") return;
    selectionTouched = true;
    hint.textContent = "切换数据源，重建中…";
    applySource();
  });

  /* 同一份 SSE 数据转发给 RealFeed（图谱 / 神经视图建节点用） */
  document.addEventListener("live:event", (e) => {
    if (window.RealFeed.active) window.RealFeed.ingest(e.detail);
  });

  /* 服务端解析出的实际会话同步回下拉框（选了「自动跟随」就保持显示自动） */
  document.addEventListener("deck:session", (e) => {
    const s = e.detail;
    if (!s || mode === "demo") return;
    if (select.value === "auto" || select.value === DEMO) return;
    if (select.value !== s.id) select.value = s.id;
  });

  (async () => {
    await ensureSessions();
    const wanted = params.get("session");
    const hit = wanted ? sessionsCache.find((s) => s.id.startsWith(wanted)) : null;
    if (hit) {
      selectionTouched = true;
      initialPreferred = hit.id;
    }
    /* 必须走 setMode：它才会同步页签 aria-selected / body[data-view] / 面板显隐，
       否则直接带 ?mode=neural 进来时内部 mode 是神经、界面还停在思考流（踩过） */
    await setMode(mode);
  })();
})();
