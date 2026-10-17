/* neural.js — 神经演示：把一轮思考铺成一片神经元，事件变成光效沿突触流转。
   零依赖自绘 canvas（和 graph.js 同一种做法）。

   设计：
   · 神经元按功能区成簇 —— 感知 / 技能 / 思考 / 运动（读文件·列目录·改文件·其它）/ 回传，
     簇内近邻相连 + 跨区长程通路；回传拆两条回路：内环回思考区，外环回感知区
   · 一次事件 = 在目标区点火，光点沿突触以「距离延迟」传播；神经元有膜电位、阈值、不应期
   · 传播带偏好（感知→思考→技能/运动四个子区→回传→再回思考/感知），所以读起来是从左流的
   · 光效三件套：放电核 / 沿突触跑的光点 / 数秒不散的余晖（这一轮走过的路）
   · 悬停只改渲染态、点击出详情卡（沿用 graph.js 的意图延迟 + 迟滞，避免爆闪与自激） */

window.AgentNeural = (() => {
  const ZONES = {
    sense: { label: "感知区", color: "--fg-2", level: 0 },
    skill: { label: "技能区", color: "--skill", level: 1 },
    think: { label: "思考区", color: "--think", level: 2 },
    read: { label: "读取文件", color: "--tool", level: 3, group: "运动区" },
    list: { label: "列出目录", color: "--tool", level: 3, group: "运动区" },
    edit: { label: "编辑文件", color: "--tool", level: 3, group: "运动区" },
    other: { label: "其它工具", color: "--tool", level: 3, group: "运动区" },
    out: { label: "回传区", color: "--answer", level: 4 },
  };

  /* 工具名 → 运动区子区（读文件 / 列目录 / 改文件 / 其它） */
  const TOOL_RULES = [
    ["edit", /write|patch|edit|replace|save|apply|create_file|append/],
    ["list", /(^|_)(ls|dir|list|glob|tree|find)(_|$)|list_directory|search_files/],
    ["read", /read|view|cat|head|tail|open|show|get_file|document|pdf|inspect|vision|screenshot/],
  ];
  const MOTOR_ZONES = ["read", "list", "edit", "other"];

  function toolZone(name) {
    const n = String(name || "").toLowerCase();
    for (const [zone, re] of TOOL_RULES) if (re.test(n)) return zone;
    return "other";
  }

  const KIND = {
    user: { zone: "sense", color: "--fg-2", label: "用户", r: 6.2 },
    think: { zone: "think", color: "--think", label: "思考", r: 4.6 },
    skill: { zone: "skill", color: "--skill", label: "技能", r: 7 },
    call: { zone: "other", color: "--tool", label: "工具", r: 5.8 }, // 具体子区按工具名分
    result: { zone: "out", color: "--tool", label: "结果", r: 5.4 },
    answer: { zone: "out", color: "--answer", label: "回答", r: 6.6 },
  };

  /* 世界坐标里的功能区（椭圆分布）：横向从感知流到回传，运动区在右侧竖排四个子区 */
  const LAYOUT = {
    sense: { cx: -620, cy: 30, rx: 92, ry: 212, n: 34, gap: 21 },
    skill: { cx: -90, cy: -420, rx: 166, ry: 54, n: 14, gap: 24 },
    think: { cx: -55, cy: 20, rx: 330, ry: 212, n: 148, gap: 24 },
    read: { cx: 468, cy: -300, rx: 88, ry: 50, n: 20, gap: 22 },
    list: { cx: 468, cy: -172, rx: 88, ry: 50, n: 20, gap: 22 },
    edit: { cx: 468, cy: -44, rx: 88, ry: 50, n: 20, gap: 22 },
    other: { cx: 468, cy: 84, rx: 88, ry: 50, n: 20, gap: 22 },
    out: { cx: 468, cy: 252, rx: 104, ry: 66, n: 26, gap: 22 },
  };

  /* 传播偏好：从哪里来，往哪里去更像"思考的流向" */
  const NEXT = {
    sense: ["think", "skill"],
    skill: ["think"],
    think: ["read", "list", "edit", "other", "think", "out"],
    read: ["out", "think"],
    list: ["out", "think"],
    edit: ["out", "think"],
    other: ["out", "think"],
    out: ["think", "sense"], // 内环先回思考区，外环再送去感知区
  };

  const THRESH = 0.34; // 放电阈值（配 spike 每跳 0.68 的衰减：一次点火能往外扩 4~5 层）
  const MAX_HOP = 9; // 一次点火最多跳几层（防止全网炸开）
  const SPIKE_CAP = 420; // 在途脉冲上限（性能闸）
  const TRAIL_MS = 4200; // 余晖停留时间
  const TAU = 640; // 膜电位泄漏常数

  const S = {
    nodes: [],
    edges: [],
    index: new Map(),
    byNode: new Map(), // 事件 nodeId → 神经元 id
    zoneIndex: {}, // 区 → 神经元数组（轮流点火用）
    cursors: {},
    queue: [], // 定时点火（[{at, neuron, amp, color, hop}]）
    spikes: [],
    trails: [],
    pending: new Map(), // 工具/技能执行中：nodeId → {neuron, next, color}
    selected: null,
    hover: null,
    active: null,
    vnow: 0, // 虚拟时钟（受倍速影响；冻结时停止推进）
    speed: 1,
    playing: true,
    frozenAt: null,
    fires: 0,
    order: 0,
    scale: 1,
    panX: 0,
    panY: 0,
    dirty: true,
    dragging: null,
    last: 0,
    ambient: 0,
  };

  let canvas = null;
  let tip = null;
  let detail = null;
  let css = {};
  const sprites = new Map();

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hexRgb = (hex) => {
    const h = (hex || "").trim().replace("#", "");
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    return [200, 208, 216];
  };
  const rgba = (hex, a) => {
    const [r, g, b] = hexRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  };
  const esc = (s) =>
    String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function readCss() {
    const g = getComputedStyle(document.documentElement);
    const pick = (n) => g.getPropertyValue(n).trim();
    css = {};
    Object.entries(ZONES).forEach(([k, v]) => (css[k] = pick(v.color)));
    Object.entries(KIND).forEach(([k, v]) => (css[k] = pick(v.color)));
    css.fg = pick("--fg");
    css.muted = pick("--muted");
    css.panel = pick("--panel");
  }

  /* ---------- 画布（小数 DPR 必须按取整后的像素比较，见 pitfalls exp-006） ---------- */

  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    return { w: rect.width, h: rect.height, dpr };
  }

  const originY = (h) => h / 2 + 12;

  function toScreen(n, w, h) {
    return [n.x * S.scale + S.panX + w / 2, n.y * S.scale + S.panY + originY(h)];
  }

  /* ---------- 拓扑 ---------- */

  function buildNodes() {
    S.nodes = [];
    S.index.clear();
    S.zoneIndex = {};
    S.cursors = {};
    let id = 0;
    Object.entries(LAYOUT).forEach(([zone, box]) => {
      const placed = [];
      let guard = 0;
      while (placed.length < box.n && guard < box.n * 80) {
        guard++;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random());
        const x = box.cx + Math.cos(a) * rr * box.rx;
        const y = box.cy + Math.sin(a) * rr * box.ry;
        if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < box.gap)) continue;
        const n = {
          id: "n" + id++,
          zone,
          x,
          y,
          r: KIND[Object.keys(KIND).find((k) => KIND[k].zone === zone)]?.r || 4.6,
          m: 0,
          refrUntil: -1,
          fired: 0,
          fireAt: -1e9,
          fireAmp: 0,
          fireColor: null,
          inColor: null,
          inHop: 0,
          info: null,
          neighbors: [],
        };
        n.r = n.r + Math.random() * 0.7;
        placed.push(n);
        S.nodes.push(n);
        S.index.set(n.id, n);
      }
      S.zoneIndex[zone] = placed.slice().sort((p, q) => p.y - q.y || p.x - q.x);
      S.cursors[zone] = 0;
    });
  }

  function buildEdges() {
    S.edges = [];
    S.nodes.forEach((n) => (n.neighbors = []));
    const seen = new Set();
    const push = (a, b, w) => {
      if (!a || !b || a === b) return;
      const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
      if (seen.has(key)) return;
      seen.add(key);
      const e = { a: a.id, b: b.id, w: clamp(w, 0.2, 1.3), act: 0 };
      S.edges.push(e);
      a.neighbors.push({ id: b.id, w: e.w, edge: e });
      b.neighbors.push({ id: a.id, w: e.w, edge: e });
    };

    // 簇内近邻（每颗接最近 3 颗）
    S.nodes.forEach((n) => {
      const sib = S.zoneIndex[n.zone].filter((o) => o !== n);
      sib
        .sort((p, q) => Math.hypot(p.x - n.x, p.y - n.y) - Math.hypot(q.x - n.x, q.y - n.y))
        .slice(0, 3)
        .forEach((o) => push(n, o, 0.4 + Math.random() * 0.45));
    });

    // 跨区通路：[源区, 目标区, 每颗源神经元的连线数(或概率), 基础权重]
    const roads = [
      ["sense", "think", 2, 0.68],
      ["skill", "think", 3, 0.94],
      ["think", "read", 0.12, 0.74],
      ["think", "list", 0.08, 0.68],
      ["think", "edit", 0.14, 0.74],
      ["think", "other", 0.1, 0.7],
      ["think", "think", 0.02, 0.42],
      // 四个子区各自把结果送到回传区
      ["read", "out", 1, 0.62],
      ["list", "out", 1, 0.62],
      ["edit", "out", 1, 0.62],
      ["other", "out", 1, 0.62],
      // 子区也留少量"边做边想"的回路
      ["read", "think", 0.12, 0.42],
      ["list", "think", 0.12, 0.42],
      ["edit", "think", 0.12, 0.42],
      ["other", "think", 0.12, 0.42],
      // 回传两条回路：内环（结果 → 思考）、外环（结果 → 感知）
      ["out", "think", 2, 0.62],
      ["out", "sense", 2, 0.54],
      ["sense", "skill", 0.5, 0.58],
      ["think", "skill", 0.04, 0.46],
    ];
    roads.forEach(([za, zb, per, w]) => {
      const A = S.zoneIndex[za] || [];
      const B = S.zoneIndex[zb] || [];
      if (!A.length || !B.length) return;
      A.forEach((a) => {
        const count = per >= 1 ? Math.round(per) : Math.random() < per ? 1 : 0;
        for (let i = 0; i < count; i++) {
          const b = B[Math.floor(Math.random() * B.length)];
          push(a, b, w * (0.82 + Math.random() * 0.3));
        }
      });
    });

    // 两条回传回路单独打标：渲染时用回路色（内环=思考青，外环=感知灰），比默认边显眼
    S.edges.forEach((e) => {
      const a = S.index.get(e.a);
      const b = S.index.get(e.b);
      if (!a || !b) return;
      if (a.zone === "out" && b.zone === "think") e.circuit = "inner";
      else if (a.zone === "out" && b.zone === "sense") e.circuit = "outer";
    });
  }

  /* ---------- 时钟 ---------- */

  const clock = () => S.vnow;

  function trail(n, t) {
    S.trails.push({ x: n.x, y: n.y, t, amp: n.fireAmp, color: n.fireColor });
    if (S.trails.length > 700) S.trails.splice(0, S.trails.length - 700);
  }

  /* ---------- 放电与传播 ---------- */

  function bias(fromZone, toZone) {
    if (fromZone === toZone) return 1;
    const pref = NEXT[fromZone] || [];
    return pref.includes(toZone) ? 1.9 : 0.72;
  }

  function fire(n, amp, color, hop) {
    const t = clock();
    if (!n || t < n.refrUntil) return false;
    n.m = 0;
    n.refrUntil = t + 210 + Math.random() * 160;
    n.fired += 1;
    n.fireAt = t;
    n.fireAmp = clamp(amp, 0.2, 1.8);
    n.fireColor = color || css[n.zone];
    S.fires += 1;
    trail(n, t);

    if (hop >= MAX_HOP || S.spikes.length > SPIKE_CAP) return true;

    const outs = n.neighbors
      .map((e) => {
        const to = S.index.get(e.id);
        const b = to ? bias(n.zone, to.zone) : 1;
        return { ...e, to, score: e.w * b * (0.6 + Math.random() * 0.8) };
      })
      .filter((e) => e.to)
      .sort((p, q) => q.score - p.score);

    const take = 1 + (amp > 0.85 ? 1 : 0) + (amp > 1.35 ? 1 : 0);
    outs.slice(0, take).forEach((e) => {
      const dist = Math.hypot(e.to.x - n.x, e.to.y - n.y);
      S.spikes.push({
        a: n.id,
        b: e.id,
        edge: e.edge,
        t0: t + 40 + dist * 0.16,
        dur: 180 + dist * 0.44,
        amp: clamp(amp * 0.68 * (0.62 + e.w * 0.55), 0.05, 1.4),
        color: n.fireColor,
        hop: hop + 1,
      });
    });
    return true;
  }

  /* ---------- 注入一次事件 ---------- */

  function pickFocus(zone) {
    const list = S.zoneIndex[zone] || [];
    if (!list.length) return null;
    const cur = S.cursors[zone] || 0;
    S.cursors[zone] = cur + 1;
    return list[cur % list.length];
  }

  function inject(ev) {
    const kind = KIND[ev.kind] ? ev.kind : "think";
    // 工具按名字落到运动区的四个子区，其余看类型
    const zone = kind === "call" ? toolZone(ev.tool) : KIND[kind].zone;
    const color = css[kind] || css[zone];
    const t = clock();
    const focus = pickFocus(zone);
    if (!focus) return null;

    S.order += 1;
    focus.info = {
      nodeId: ev.id,
      kind,
      zone,
      label: ev.label || KIND[kind].label,
      tool: ev.tool || "",
      text: ev.text || "",
      tokens: ev.tokens || 0,
      order: S.order,
      at: t,
    };
    if (ev.id) S.byNode.set(ev.id, focus.id);
    S.active = focus.id;
    focus.refrUntil = -1; // 刚注入的事件必须点得亮（别被背景自发放电的不应期挡住）

    const base = 1.0 + Math.min(0.7, Math.log2(Math.max(60, ev.tokens || ev.weight || 100) / 100) * 0.3);
    const amp = base + (kind === "skill" ? 0.5 : 0) + (kind === "answer" ? 0.25 : 0);

    fire(focus, amp, color, 0);

    // 一次事件不是单点：目标区里顺手带亮两颗邻居
    const sib = focus.neighbors
      .map((e) => S.index.get(e.id))
      .filter((o) => o && o.zone === zone)
      .slice(0, kind === "skill" ? 3 : 2);
    sib.forEach((nb, i) => S.queue.push({ at: t + 110 + i * 80, neuron: nb.id, amp: amp * 0.7, color, hop: 1 }));

    // 技能载入：先点技能区，再往思考区灌一波（"能力被装进脑子里"）
    if (kind === "skill") {
      const feed = pickFocus("think");
      if (feed) S.queue.push({ at: t + 520, neuron: feed.id, amp: 1.3, color, hop: 0 });
    }

    /* 回传拆两条回路：
       内层 —— 结果回思考区，让它拿这个结果想下一步；
       外层 —— 结果送去感知区，相当于"外界看到发生了什么"。 */
    if (kind === "result" || kind === "answer") {
      const inner = pickFocus("think");
      const outer = pickFocus("sense");
      if (inner) {
        S.queue.push({ at: t + 300, neuron: inner.id, amp: kind === "answer" ? 1.0 : 1.2, color: css.think, hop: 0 });
      }
      if (outer) {
        S.queue.push({ at: t + 660, neuron: outer.id, amp: kind === "answer" ? 0.95 : 0.9, color: css.sense, hop: 0 });
      }
    }

    // 工具 / 技能执行中：源神经元持续小幅放电
    if ((kind === "call" || kind === "skill") && ev.id) {
      S.pending.set(ev.id, { neuron: focus.id, next: t + 280, color });
    }

    S.dirty = true;
    return focus.id;
  }

  function complete(nodeId) {
    S.pending.delete(nodeId);
    S.dirty = true;
  }

  function reset() {
    buildNodes();
    buildEdges();
    S.byNode.clear();
    S.queue = [];
    S.spikes = [];
    S.trails = [];
    S.pending.clear();
    S.selected = null;
    S.hover = null;
    S.active = null;
    S.vnow = 0;
    S.fires = 0;
    S.order = 0;
    S.ambient = 0;
    S.dirty = true;
    if (detail) {
      detail.hidden = true;
      detail.innerHTML = "";
    }
    fit();
  }

  /* ---------- 动力学 ---------- */

  function dynamics(dt) {
    S.vnow += dt * S.speed;
    const t = clock();

    // 1) 定时点火（注入的副波 / 技能→思考 / 两条回传回路）
    S.queue = S.queue.filter((q) => {
      if (t >= q.at) {
        const n = S.index.get(q.neuron);
        fire(n, q.amp, q.color, q.hop || 1);
        return false;
      }
      return true;
    });

    // 2) 在途脉冲：到达 → 加膜电位 → 过阈值就继续放电
    const alive = [];
    for (const sp of S.spikes) {
      if (t < sp.t0) {
        alive.push(sp);
        continue;
      }
      if (t < sp.t0 + sp.dur) {
        alive.push(sp);
        continue;
      }
      const to = S.index.get(sp.b);
      if (to) {
        to.m += sp.amp;
        to.inColor = sp.color;
        to.inHop = sp.hop || 1;
        // Hebbian：这条被走过的突触会被强化一点点（一轮下来网络被这次的思考改造过）
        if (sp.edge) {
          sp.edge.w = Math.min(1.3, sp.edge.w + 0.008);
          sp.edge.act = Math.max(sp.edge.act, sp.amp);
        }
        if (to.m >= THRESH && t >= to.refrUntil) fire(to, Math.min(1.5, to.m), to.inColor, sp.hop || 1);
      }
    }
    S.spikes = alive;

    // 3) 泄漏 + 4) 自发背景活动（有活物感，但不抢主信号）
    const leak = Math.exp(-dt / TAU);
    for (const n of S.nodes) {
      n.m *= leak;
      if (n.m < 0.004) n.m = 0;
    }
    if (S.playing) {
      S.ambient += dt;
      if (S.ambient > 150) {
        S.ambient = 0;
        const pool = S.zoneIndex.think || [];
        const n = pool[Math.floor(Math.random() * pool.length)];
        if (n && t >= n.refrUntil) fire(n, 0.42, css.think, 6);
      }
    }

    // 5) 工具执行中的持续放电
    S.pending.forEach((p) => {
      if (t < p.next) return;
      p.next = t + 240 + Math.random() * 140;
      const n = S.index.get(p.neuron);
      if (n) fire(n, 0.72, p.color, 5);
    });

    // 6) 突触余温衰减 + 余晖过期
    for (const e of S.edges) if (e.act > 0) e.act = Math.max(0, e.act - dt / 2600);
    S.trails = S.trails.filter((p) => t - p.t < TRAIL_MS);
  }

  /* ---------- 绘制 ---------- */

  function sprite(colorKey) {
    let sp = sprites.get(colorKey);
    if (sp) return sp;
    const c = css[colorKey] || css.think;
    const size = 96;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const g = cv.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, rgba(c, 0.95));
    grad.addColorStop(0.32, rgba(c, 0.42));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    sprites.set(colorKey, cv);
    return cv;
  }

  function glowAt(ctx, x, y, radius, colorKey, alpha) {
    if (radius <= 0 || alpha <= 0.004) return;
    const sp = sprite(colorKey);
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.drawImage(sp, x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!canvas) return;
    const { w, h } = fitCanvas();
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = clock();
    const sc = S.scale;

    // 区域薄雾 + 区域名
    ctx.globalCompositeOperation = "lighter";
    Object.entries(LAYOUT).forEach(([zone, box]) => {
      const [cx, cy] = [box.cx * sc + S.panX + w / 2, box.cy * sc + S.panY + originY(h)];
      const R = Math.max(box.rx, box.ry) * sc * 1.35;
      if (R < 4) return;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, rgba(css[zone], 0.075));
      g.addColorStop(1, rgba(css[zone], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, box.rx * sc * 1.3, box.ry * sc * 1.25, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";

    ctx.font = "11px ui-monospace, monospace";

    /* 区名一律垫一层深色底：回传回路的长线会从区名附近穿过，不垫底会被光点糊住 */
    const labelAt = (text, wx, wy, hex, alpha, align = "center", font = "11px ui-monospace, monospace") => {
      const x = wx * sc + S.panX + w / 2;
      const y = wy * sc + S.panY + originY(h);
      ctx.font = font;
      const tw = ctx.measureText(text).width;
      const bx = align === "center" ? x - tw / 2 : align === "right" ? x - tw : x;
      ctx.fillStyle = "rgba(8,9,11,0.58)";
      ctx.beginPath();
      ctx.roundRect(bx - 5, y - 10, tw + 10, 15, 3);
      ctx.fill();
      ctx.fillStyle = rgba(hex, alpha);
      ctx.textAlign = align;
      ctx.fillText(text, x, y + 1);
      ctx.textAlign = "left";
    };

    Object.entries(LAYOUT).forEach(([zone, box]) => {
      if (ZONES[zone].group) return; // 运动区子区标签贴到各自簇的右边（见下）
      labelAt(ZONES[zone].label, box.cx, box.cy - box.ry - 26, css[zone], 0.72);
    });

    /* 运动区：四个子区竖排成一组，组标题 + 每个子区标签都放在不挡光线的位置 */
    const box = LAYOUT.read;
    labelAt("运 动 区", box.cx, box.cy - box.ry - 44, css.other, 0.85);
    MOTOR_ZONES.forEach((zone) => {
      const b = LAYOUT[zone];
      labelAt(ZONES[zone].label, b.cx + b.rx + 16, b.cy + 4, css[zone], 0.7, "left");
    });

    /* 回传区：把两条回路写在区名下面 */
    const o = LAYOUT.out; // 区名由上面的循环画，这里只补充两条回路的说明
    labelAt("内环 → 思考区 · 外环 → 感知区", o.cx, o.cy + o.ry + 26, css.out, 0.55, "center", "10px ui-monospace, monospace");

    // 突触
    for (const e of S.edges) {
      const a = S.index.get(e.a);
      const b = S.index.get(e.b);
      if (!a || !b) continue;
      const [ax, ay] = toScreen(a, w, h);
      const [bx, by] = toScreen(b, w, h);
      const hot = Math.max(
        clamp((t - a.fireAt) < 900 ? 1 - (t - a.fireAt) / 900 : 0, 0, 1) + Math.min(1.1, a.m * 0.5),
        clamp((t - b.fireAt) < 900 ? 1 - (t - b.fireAt) / 900 : 0, 0, 1) + Math.min(1.1, b.m * 0.5)
      );
      let alpha = 0.035 + e.w * 0.055 + Math.min(0.34, hot * 0.2) + e.act * 0.22;
      // 回传回路用自己的颜色，并且更显眼（内环=思考青，外环=感知灰）
      const strokeKey = e.circuit === "inner" ? "think" : e.circuit === "outer" ? "sense" : a.zone;
      if (e.circuit) alpha = Math.min(0.42, alpha * 1.5 + 0.02);
      if (alpha < 0.045) continue;
      ctx.strokeStyle = rgba(css[strokeKey] || css.think, alpha);
      ctx.lineWidth = 0.7 + e.w * 0.5 + e.act * 0.7 + (e.circuit ? 0.3 : 0);
      ctx.beginPath();
      const mx = (ax + bx) / 2 - (by - ay) * 0.09;
      const my = (ay + by) / 2 + (bx - ax) * 0.09;
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(mx, my, bx, by);
      ctx.stroke();
    }

    // 余晖：这一轮走过的路（数秒不散）
    ctx.globalCompositeOperation = "lighter";
    for (const p of S.trails) {
      const age = (t - p.t) / TRAIL_MS;
      if (age >= 1 || age < 0) continue;
      const [x, y] = [p.x * sc + S.panX + w / 2, p.y * sc + S.panY + originY(h)];
      glowAt(ctx, x, y, 26 * (0.7 + p.amp) * (0.5 + age * 0.6), colorKeyOf(p.color), p.amp * (1 - age) * 0.34);
    }

    // 在途光点
    for (const sp of S.spikes) {
      if (t < sp.t0) continue;
      const p = clamp((t - sp.t0) / sp.dur, 0, 1);
      const a = S.index.get(sp.a);
      const b = S.index.get(sp.b);
      if (!a || !b) continue;
      const [ax, ay] = toScreen(a, w, h);
      const [bx, by] = toScreen(b, w, h);
      const mx = (ax + bx) / 2 - (by - ay) * 0.09;
      const my = (ay + by) / 2 + (bx - ax) * 0.09;
      const mt = 1 - p;
      const x = mt * mt * ax + 2 * mt * p * mx + p * p * bx;
      const y = mt * mt * ay + 2 * mt * p * my + p * p * by;
      glowAt(ctx, x, y, 13 + sp.amp * 17, colorKeyOf(sp.color), 0.55 + sp.amp * 0.4);
    }
    ctx.globalCompositeOperation = "source-over";

    // 神经元
    for (const n of S.nodes) {
      const [x, y] = toScreen(n, w, h);
      const base = css[n.zone];
      const since = t - n.fireAt;
      const flash = since >= 0 && since < 760 ? 1 - since / 760 : 0;
      const hot = clamp(n.m, 0, 1.5);
      const r = n.r * sc;

      // 核
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(base, 0.2 + hot * 0.45 + flash * 0.5);
      ctx.fill();
      ctx.lineWidth = n.info ? 1.25 : 1;
      ctx.strokeStyle = rgba(base, 0.34 + hot * 0.4 + flash * 0.5);
      ctx.stroke();

      // 膜电位环：攒到阈值就放
      if (hot > 0.06) {
        ctx.beginPath();
        ctx.arc(x, y, r * (1.55 + hot * 1.7), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colorHex(n.inColor) || base, hot * 0.3);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 放电冲击环
      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(x, y, r * (1.5 + (1 - flash) * 3.6), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colorHex(n.fireColor) || base, flash * 0.5);
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      // 光晕
      if (hot > 0.02 || flash > 0) {
        ctx.globalCompositeOperation = "lighter";
        glowAt(ctx, x, y, r * (4 + hot * 2.4 + flash * 2), colorKeyOf(n.fireColor || n.inColor || base), hot * 0.28 + flash * 0.55);
        ctx.globalCompositeOperation = "source-over";
      }

      // 悬停 / 选中
      if (n === S.hover || n.id === S.selected) {
        const sel = n.id === S.selected;
        ctx.beginPath();
        ctx.arc(x, y, r + (sel ? 7 : 5.5), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colorHex(n.info ? css[KIND[n.info.kind].color] : base) || base, sel ? 0.95 : 0.7);
        ctx.lineWidth = sel ? 1.8 : 1.3;
        ctx.stroke();
        if (n.info) {
          const text = n.info.label;
          ctx.font = "11.5px ui-monospace, monospace";
          const tw = ctx.measureText(text).width;
          const lx = x - tw / 2;
          const ly = y + r + 15;
          ctx.fillStyle = "rgba(8,9,11,0.78)";
          ctx.beginPath();
          ctx.roundRect(lx - 5, ly - 11, tw + 10, 15, 3);
          ctx.fill();
          ctx.fillStyle = css.fg;
          ctx.fillText(text, lx, ly + 0.5);
        }
      }
    }

    // HUD
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.34)";
    ctx.fillText(
      `${S.nodes.length} 神经元 · ${S.edges.length} 突触 · 在途 ${S.spikes.length} · 本轮放电 ${S.fires}`,
      10,
      h - 12
    );
    ctx.textAlign = "right";
    ctx.fillText("悬停看简写 · 点击看详情 · 滚轮缩放 · 拖动平移", w - 10, h - 12);
    ctx.textAlign = "left";
  }

  function colorKeyOf(color) {
    if (!color) return "think";
    const found = Object.keys(KIND).find((k) => css[k] === color);
    if (found) return found;
    const zone = Object.keys(ZONES).find((z) => css[z] === color);
    return zone || "think";
  }

  function colorHex(color) {
    return color || null;
  }

  /* ---------- 相机 ---------- */

  function fit() {
    if (!canvas || !S.nodes.length) return;
    const { w, h } = fitCanvas();
    const xs = S.nodes.map((n) => n.x);
    const ys = S.nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padX = 110;
    const padTop = 96;
    const padBottom = 64;
    const spanX = maxX - minX + padX * 2;
    const spanY = maxY - minY + padTop + padBottom;
    S.scale = clamp(Math.min(w / spanX, h / spanY), 0.24, 1.5);
    S.panX = -((minX + maxX) / 2) * S.scale;
    S.panY = -((minY + maxY) / 2) * S.scale - (padTop - padBottom) / 2;
    S.dirty = true;
  }

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = fitCanvas();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const n of S.nodes) {
      const [x, y] = toScreen(n, w, h);
      const d = Math.hypot(x - sx, y - sy);
      const rr = Math.max(7, n.r * S.scale + 7);
      if (d < rr && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /* ---------- 悬停：只改渲染态（悬停加热物理会自激抖动，见 pitfalls） ---------- */

  const HOVER_INTENT_MS = 120;
  let intentTimer = null;
  let candidate = null;
  let tipParts = null;

  function ensureTip() {
    if (!tip) return null;
    if (!tipParts) {
      tip.innerHTML = '<span class="tip-a"></span><span class="tip-b"></span>';
      tipParts = { a: tip.querySelector(".tip-a"), b: tip.querySelector(".tip-b") };
    }
    return tipParts;
  }

  function showTip(n, x, y) {
    const parts = ensureTip();
    if (!parts) return;
    const zone = ZONES[n.zone].label;
    const a = n.info ? `${zone} · ${KIND[n.info.kind].label}` : `${zone} · 静息`;
    const raw = n.info ? n.info.label : `放电 ${n.fired} 次 · ${n.neighbors.length} 条突触`;
    const b = raw.length > 26 ? raw.slice(0, 26) + "…" : raw;
    if (parts.a.textContent !== a) parts.a.textContent = a;
    if (parts.b.textContent !== b) parts.b.textContent = b;
    if (tip.hidden) tip.hidden = false;
    tip.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y - 12)}px, 0) translate(-50%, -100%)`;
  }

  function hideTip() {
    if (tip && !tip.hidden) tip.hidden = true;
  }

  function hoverAt(x, y) {
    const hit = hitTest(x, y);
    const anchor = S.hover || candidate;
    if (anchor && anchor !== hit) {
      const rect = canvas.getBoundingClientRect();
      const { w, h } = fitCanvas();
      const [sx, sy] = toScreen(anchor, w, h);
      if (Math.hypot(rect.left + sx - x, rect.top + sy - y) < Math.max(7, anchor.r * S.scale + 12)) return anchor;
    }
    return hit;
  }

  function setHover(n) {
    if (S.hover === n) return;
    S.hover = n;
    S.dirty = true;
  }

  function onMove(x, y) {
    if (S.dragging) return;
    const hit = hoverAt(x, y);
    if (hit === S.hover) {
      clearTimeout(intentTimer);
      intentTimer = null;
      candidate = hit;
      if (hit) showTip(hit, x, y);
      else hideTip();
      return;
    }
    if (hit === candidate && intentTimer) return;
    candidate = hit;
    clearTimeout(intentTimer);
    intentTimer = null;
    hideTip();
    if (!hit) {
      setHover(null);
      return;
    }
    intentTimer = window.setTimeout(() => {
      intentTimer = null;
      if (candidate !== hit) return;
      setHover(hit);
      showTip(hit, x, y);
    }, HOVER_INTENT_MS);
  }

  /* ---------- 详情卡 ---------- */

  function renderDetail(n) {
    if (!detail) return;
    if (!n) {
      detail.hidden = true;
      detail.innerHTML = "";
      return;
    }
    const zone = ZONES[n.zone];
    const info = n.info;
    const kindLabel = info ? KIND[info.kind].label : "静息";
    const text = info
      ? info.text || "（这一步没有附带文本）"
      : "这颗神经元没有被本轮事件绑定。它只是网络里的一颗，靠邻居传导才会亮 —— 越是靠近通路的中继点，越容易频繁放电。";
    const meta = [
      ["放电", `${n.fired} 次`],
      ["突触", `${n.neighbors.length} 条`],
    ];
    if (info && info.tokens) meta.push(["tokens", String(info.tokens)]);
    if (info) meta.push(["本轮第", `${info.order} 步`]);
    meta.push(["此刻膜电位", `${Math.round(clamp(n.m, 0, 1) * 100)}%`]);

    detail.innerHTML = `
      <div class="nd-head">
        <span class="nd-badge" data-kind="${info ? info.kind : "rest"}">${esc(zone.label)} · ${esc(kindLabel)}</span>
        <button class="nd-close" type="button" aria-label="关闭详情">×</button>
      </div>
      <h3 class="nd-title">${esc(info ? info.label : "静息神经元")}</h3>
      ${info && info.tool ? `<code class="nd-tool">${esc(info.tool)}</code>` : ""}
      <p class="nd-text">${esc(text)}</p>
      <dl class="nd-meta">${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    `;
    detail.hidden = false;
    const close = detail.querySelector(".nd-close");
    if (close) close.addEventListener("click", () => select(null));
  }

  function select(n) {
    S.selected = n ? n.id : null;
    S.dirty = true;
    renderDetail(n);
  }

  /* ---------- 交互 ---------- */

  function bind() {
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const { w, h } = fitCanvas();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const wx = (sx - S.panX - w / 2) / S.scale;
        const wy = (sy - S.panY - originY(h)) / S.scale;
        S.scale = clamp(S.scale * (e.deltaY > 0 ? 0.92 : 1.08), 0.2, 3.2);
        S.panX = sx - w / 2 - wx * S.scale;
        S.panY = sy - originY(h) - wy * S.scale;
        S.dirty = true;
      },
      { passive: false }
    );

    canvas.addEventListener("pointerdown", (e) => {
      S.dragging = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY, moved: false };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {
        /* 合成事件（自动化测试）没有活跃指针，捕获会抛 NotFoundError —— 忽略即可 */
      }
      hideTip();
    });

    let movePending = null;
    let moveQueued = false;
    canvas.addEventListener("pointermove", (e) => {
      if (S.dragging) {
        const dx = e.clientX - S.dragging.x;
        const dy = e.clientY - S.dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) S.dragging.moved = true;
        S.panX = S.dragging.panX + dx;
        S.panY = S.dragging.panY + dy;
        return;
      }
      // 一帧只处理最后一次移动；兜底 setTimeout（后台标签 rAF 不跑，本项目老坑）
      movePending = [e.clientX, e.clientY];
      if (moveQueued) return;
      moveQueued = true;
      let done = false;
      const flush = () => {
        if (done) return;
        done = true;
        moveQueued = false;
        const p = movePending;
        movePending = null;
        if (p) onMove(p[0], p[1]);
      };
      requestAnimationFrame(flush);
      window.setTimeout(flush, 40);
    });

    canvas.addEventListener("pointerup", (e) => {
      const dragged = S.dragging && S.dragging.moved;
      S.dragging = null;
      if (dragged) return;
      select(hitTest(e.clientX, e.clientY));
      hideTip();
    });

    canvas.addEventListener("pointerleave", () => {
      hideTip();
      if (S.hover) setHover(null);
    });

    window.addEventListener("resize", () => fit());
  }

  /* ---------- 主循环（setInterval：后台标签 rAF 会冻帧） ---------- */

  let lastSig = "";

  function sig() {
    const { w, h } = fitCanvas();
    return `${w}x${h}|${S.scale.toFixed(3)}|${Math.round(S.panX)}|${Math.round(S.panY)}|${
      S.hover ? S.hover.id : "-"
    }|${S.selected || "-"}|${S.vnow.toFixed(0)}|${S.spikes.length}|${S.trails.length}`;
  }

  function loop() {
    window.setInterval(() => {
      const t = performance.now();
      const dt = clamp(t - (S.last || t), 8, 60);
      S.last = t;
      if (S.frozenAt == null) {
        if (S.playing) dynamics(dt);
        draw();
        lastSig = sig();
        return;
      }
      // 冻结（暂停 / 播完）：画面签名没变就不重绘
      const cur = sig();
      if (cur === lastSig && !S.dirty) return;
      S.dirty = false;
      lastSig = cur;
      draw();
    }, 16);
  }

  function init(canvasEl, tipEl, detailEl) {
    canvas = canvasEl;
    tip = tipEl;
    detail = detailEl;
    readCss();
    buildNodes();
    buildEdges();
    bind();
    fit();
    loop();
  }

  return {
    init,
    reset,
    inject,
    complete,
    fit,
    select: (id) => select(id ? S.index.get(id) : null),
    get playing() {
      return S.playing;
    },
    set playing(v) {
      S.playing = !!v;
      S.frozenAt = S.playing ? null : S.vnow;
      S.dirty = true;
    },
    get speed() {
      return S.speed;
    },
    set speed(v) {
      S.speed = v || 1;
    },
    get frozen() {
      return S.frozenAt != null;
    },
    get nodeCount() {
      return S.nodes.length;
    },
    get edgeCount() {
      return S.edges.length;
    },
    get spikeCount() {
      return S.spikes.length;
    },
    get fires() {
      return S.fires;
    },
    get hoverId() {
      return S.hover ? S.hover.id : null;
    },
    get selectedId() {
      return S.selected;
    },
    get detailOpen() {
      return !!(detail && !detail.hidden);
    },
    /* 测试与调试：屏幕坐标快照（按画布 rect 过滤后再做鼠标测试） */
    screenPositions() {
      const { w, h } = fitCanvas();
      const rect = canvas.getBoundingClientRect();
      return S.nodes
        .filter((n) => n.info)
        .map((n) => {
          const [x, y] = toScreen(n, w, h);
          return {
            id: n.id,
            zone: n.zone,
            label: n.info.label,
            kind: n.info.kind,
            cx: rect.left + x,
            cy: rect.top + y,
            r: n.r * S.scale,
          };
        });
    },
    stats() {
      const by = {};
      S.nodes.forEach((n) => (by[n.zone] = (by[n.zone] || 0) + 1));
      return by;
    },
    /* 接入真实数据用：一次事件 → 一次点火（渲染层不用改，见 exp-002 的接口约定） */
    ingestStep(ev) {
      return inject(ev);
    },
  };
})();
