/* graph.js — 力导向因果图谱：把 agent 的一轮思考画成一张自己长出来的网。
   零依赖自绘 canvas。节点按"因果深度"纵向分层（用户 → 思考 → 工具 → 结果 → … → 回答），
   横向由斥力/弹簧自由展开；相机跟随最新节点，所以看的过程就是"思考往下长"的过程。 */

window.AgentGraph = (() => {
  const KIND = {
    user: { color: "--fg-2", label: "用户", r: 9 },
    think: { color: "--think", label: "思考", r: 8 },
    skill: { color: "--skill", label: "技能", r: 9 },
    call: { color: "--tool", label: "工具", r: 10 },
    result: { color: "--tool", label: "结果", r: 8 },
    answer: { color: "--answer", label: "回答", r: 11 },
  };
  const RANK_H = 44; // 每层高度（世界坐标）
  const X_ANCHOR = { user: 0, think: 0, skill: -120, call: 130, result: 262, answer: 30 }; // 横向锚点：思考走中轴，技能向左、工具向右分叉
  const EDGE_REST = { derive: 66, return: 92, ref: 200 };
  const EDGE_COLOR = { derive: "--think", return: "--tool", ref: "--muted" };

  const S = {
    nodes: [],
    edges: [],
    index: new Map(),
    alpha: 1,
    focus: null,
    hover: null,
    scale: 1,
    panX: 0,
    panY: 0,
    follow: true,
    playing: true,
    speed: 1,
    dragging: null,
    lastTick: 0,
    painted: false,
    frozenAt: null,
    dirty: false,
  };

  let canvas = null;
  let tip = null;
  let css = {};

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();

  function readCss() {
    const g = getComputedStyle(document.documentElement);
    const pick = (n) => g.getPropertyValue(n).trim();
    css = {};
    Object.entries(KIND).forEach(([k, v]) => (css[k] = pick(v.color)));
    Object.entries(EDGE_COLOR).forEach(([k, v]) => (css["edge_" + k] = pick(v)));
    css.panelHi = pick("--panel-hi");
    css.line = "rgba(255,255,255,0.14)";
    css.fg = pick("--fg");
    css.muted = pick("--muted");
    css.faint = pick("--faint");
  }

  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // 关键：比较时必须用"取整后的像素尺寸"。小数 DPR（125%/90%/1.25 等）下
    // canvas.width 是整数，直接跟 rect.width * dpr 比会永远不等 → 每帧重分配 canvas
    // → 画完立刻被清空（画面空白 + 闪）
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    return { w: rect.width, h: rect.height, dpr };
  }

  /* ---------- 世界 ↔ 屏幕 ---------- */

  function toScreen(node, w, h) {
    return [node.x * S.scale + S.panX + w / 2, node.y * S.scale + S.panY + h * 0.3];
  }

  function toWorld(sx, sy, w, h) {
    return [(sx - S.panX - w / 2) / S.scale, (sy - S.panY - h * 0.3) / S.scale];
  }

  /* ---------- 增删 ---------- */

  function add(spec) {
    const kind = KIND[spec.kind] ? spec.kind : "think";
    const parent = spec.parent && S.index.has(spec.parent) ? spec.parent : null;
    const parentNode = parent ? S.index.get(parent) : null;
    const node = {
      id: spec.id,
      kind,
      label: spec.label || KIND[kind].label,
      tool: spec.tool || "",
      rank: parentNode ? parentNode.rank + 1 : 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: (spec.r || KIND[kind].r) + Math.min(6, Math.log2((spec.weight || 100) / 60)),
      born: now(),
      pending: kind === "call" || kind === "skill",
      complete: kind !== "call",
      tokens: spec.tokens || 0,
      text: spec.text || "",
    };
    node.y = node.rank * RANK_H;
    if (parentNode) node.x = parentNode.x + (kind === "result" ? 118 : (Math.random() - 0.5) * 24);

    S.nodes.push(node);
    S.index.set(node.id, node);

    const chain = parent || spec.linkFrom;
    if (chain && S.index.has(chain)) link(chain, node.id, spec.edge || "derive");
    (spec.refs || []).forEach((r) => S.index.has(r) && link(r, node.id, "ref"));

    S.alpha = 1;
    S.hover = null;
    return node;
  }

  function link(from, to, kind = "derive") {
    if (!S.index.has(from) || !S.index.has(to)) return;
    S.edges.push({ from, to, kind, born: now(), progress: 0 });
  }

  function complete(id) {
    const node = S.index.get(id);
    if (!node) return;
    node.pending = false;
    node.complete = true;
    S.alpha = Math.max(S.alpha, 0.55);
  }

  function setActive(id) {
    S.nodes.forEach((n) => (n.active = n.id === id));
    S.alpha = Math.max(S.alpha, 0.35);
  }

  function reset() {
    S.nodes = [];
    S.edges = [];
    S.index.clear();
    S.focus = null;
    S.hover = null;
    S.scale = 1;
    S.panX = 0;
    S.panY = 0;
    S.alpha = 1;
    S.painted = false;
  }

  /* ---------- 物理 ---------- */

  function step(dt) {
    const k = dt / 16.67;
    for (const n of S.nodes) {
      n.fx = 0;
      n.fy = 0;
    }

    // 斥力
    for (let i = 0; i < S.nodes.length; i++) {
      for (let j = i + 1; j < S.nodes.length; j++) {
        const a = S.nodes[i];
        const b = S.nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = dx * dx + dy * dy + 1;
        }
        const d = Math.sqrt(d2);
        const f = 5200 / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.fx -= fx;
        a.fy -= fy;
        b.fx += fx;
        b.fy += fy;
      }
    }

    // 边的弹簧
    for (const e of S.edges) {
      const a = S.index.get(e.from);
      const b = S.index.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const rest = EDGE_REST[e.kind] || 80;
      const f = 0.014 * (d - rest);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.fx += fx;
      a.fy += fy;
      b.fx -= fx;
      b.fy -= fy;
    }

    for (const n of S.nodes) {
      // 纵向锚到因果层，横向锚到该类型的车道（思考中轴 / 工具与结果向右）
      n.fy += (n.rank * RANK_H - n.y) * 0.085;
      n.fx += ((X_ANCHOR[n.kind] || 0) - n.x) * 0.02;
      n.vx = (n.vx + n.fx * k) * 0.86;
      n.vy = (n.vy + n.fy * k) * 0.86;
      const v = Math.hypot(n.vx, n.vy);
      if (v > 26) {
        n.vx = (n.vx / v) * 26;
        n.vy = (n.vy / v) * 26;
      }
      n.x += n.vx * k;
      n.y += n.vy * k;
    }

    S.alpha = Math.max(0.03, S.alpha * Math.pow(0.985, k));
    if (S.dragging) S.alpha = Math.max(S.alpha, 0.6);
  }

  /* ---------- 绘制 ---------- */

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function focusedSet() {
    if (!S.focus || !S.index.has(S.focus)) return null;
    const keep = new Set([S.focus]);
    let cur = S.index.get(S.focus);
    while (cur && cur.id !== undefined) {
      keep.add(cur.id);
      const parentEdge = S.edges.find((e) => e.to === cur.id && e.kind !== "ref");
      cur = parentEdge ? S.index.get(parentEdge.from) : null;
    }
    S.edges.forEach((e) => {
      if (keep.has(e.from) || keep.has(e.to)) {
        keep.add(e.from);
        keep.add(e.to);
      }
    });
    return keep;
  }

  function draw() {
    if (!canvas) return;
    const { w, h } = fitCanvas();
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 暂停/播完后时间也冻住：呼吸光晕、粒子、生长动画全部定格
    const t = S.frozenAt != null ? S.frozenAt : now();
    const keep = focusedSet();

    // 层参考线（因果深度）
    if (S.nodes.length) {
      const lastRank = Math.max(...S.nodes.map((n) => n.rank));
      ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, monospace";
      for (let r = 0; r <= lastRank; r++) {
        const y = r * RANK_H * S.scale + S.panY + h * 0.3;
        if (y < -20 || y > h + 20) continue;
        ctx.strokeStyle = "rgba(255,255,255,0.035)";
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.13)";
        ctx.fillText("L" + r, 6, y - 4);
      }
    }

    // 边
    for (const e of S.edges) {
      const a = S.index.get(e.from);
      const b = S.index.get(e.to);
      if (!a || !b) continue;
      const age = (t - e.born) / 420;
      e.progress = clamp(age, 0, 1);
      const [ax, ay] = toScreen(a, w, h);
      const [bx, by] = toScreen(b, w, h);
      const dx = bx - ax;
      const dy = by - ay;
      const dist = Math.hypot(dx, dy) || 1;
      const bow = e.kind === "ref" ? 0.34 : 0.16;
      const cx = (ax + bx) / 2 - (dy / dist) * dist * bow;
      const cy = (ay + by) / 2 + (dx / dist) * dist * bow;

      const dim = keep && !(keep.has(e.from) && keep.has(e.to)) ? 0.2 : 1;
      const p = e.progress;
      const color = css["edge_" + e.kind] || css.think;

      ctx.save();
      ctx.globalAlpha = (e.kind === "ref" ? 0.4 : 0.62) * dim * (0.35 + 0.65 * p);
      ctx.strokeStyle = color;
      ctx.lineWidth = e.kind === "ref" ? 1 : 1.4;
      if (e.kind === "ref") ctx.setLineDash([5, 4]);
      // 用 dash 偏移做"线在生长"的动画
      const approx = dist * (1 + bow);
      ctx.setLineDash(e.kind === "ref" ? [5, 4] : [approx * p, approx]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 箭头
      if (p > 0.96) {
        const ang = Math.atan2(by - cy, bx - cx);
        const rr = b.r * S.scale + 3;
        const hx = bx - Math.cos(ang) * rr;
        const hy = by - Math.sin(ang) * rr;
        ctx.globalAlpha = 0.75 * dim;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - Math.cos(ang - 0.42) * 7, hy - Math.sin(ang - 0.42) * 7);
        ctx.lineTo(hx - Math.cos(ang + 0.42) * 7, hy - Math.sin(ang + 0.42) * 7);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // 工具执行中的粒子：沿 return 边跑
    for (const e of S.edges) {
      if (e.kind !== "return") continue;
      const target = S.index.get(e.to);
      const call = S.index.get(e.from);
      if (!target || !call || !call.pending) continue;
      const a = S.index.get(e.from);
      const b = S.index.get(e.to);
      const [ax, ay] = toScreen(a, w, h);
      const [bx, by] = toScreen(b, w, h);
      const dx = bx - ax;
      const dy = by - ay;
      const dist = Math.hypot(dx, dy) || 1;
      const cx = (ax + bx) / 2 - (dy / dist) * dist * 0.16;
      const cy = (ay + by) / 2 + (dx / dist) * dist * 0.16;
      for (let i = 0; i < 3; i++) {
        const q = ((t / 900 + i / 3) % 1);
        const mt = 1 - q;
        const px = mt * mt * ax + 2 * mt * q * cx + q * q * bx;
        const py = mt * mt * ay + 2 * mt * q * cy + q * q * by;
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, Math.PI * 2);
        ctx.fillStyle = css.tool;
        ctx.globalAlpha = 0.85 * (1 - Math.abs(q - 0.5) * 1.2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // 节点
    for (const n of S.nodes) {
      const [x, y] = toScreen(n, w, h);
      const grow = clamp((t - n.born) / 380, 0, 1);
      const r = Math.max(2, n.r * S.scale * easeOut(grow));
      const dim = keep && !keep.has(n.id) ? 0.22 : 1;
      const color = css[n.kind];

      // 出生冲击环
      if (grow < 1) {
        ctx.beginPath();
        ctx.arc(x, y, r * (1 + 1.9 * (1 - grow)), 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.5 * (1 - grow) * dim;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 激活节点的呼吸光晕
      if (n.active) {
        const pulse = 0.5 + 0.5 * Math.sin(t / 420);
        const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * (2.6 + pulse));
        g.addColorStop(0, color);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = 0.22 * dim;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * (2.6 + pulse), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.arc(x, y, r + 4 + pulse * 2, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.65 * dim;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = css.panelHi || "#14171c";
      ctx.globalAlpha = dim;
      ctx.fill();
      ctx.lineWidth = n.hovered || n.id === S.focus ? 2.4 : 1.6;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 工具执行中：外圈虚线旋转
      if (n.pending) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((t / 1400) % (Math.PI * 2));
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = css.tool;
        ctx.globalAlpha = 0.8 * dim;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, r + 6.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // 标签
      const showLabel = n.kind === "call" || n.active || n.id === S.focus || n.hovered || S.scale > 1.15;
      if (showLabel && grow > 0.6) {
        const text = n.tool && n.kind === "call" ? n.tool : n.label;
        ctx.font = "12px ui-monospace, monospace";
        const tw = ctx.measureText(text).width;
        const lx = x - tw / 2;
        const ly = y + r + 15;
        ctx.globalAlpha = 0.9 * dim;
        ctx.fillStyle = "rgba(8,9,11,0.72)";
        ctx.beginPath();
        ctx.roundRect(lx - 5, ly - 11, tw + 10, 15, 3);
        ctx.fill();
        ctx.fillStyle = n.kind === "call" || n.active ? css.fg : css.muted;
        ctx.fillText(text, lx, ly + 0.5);
        ctx.globalAlpha = 1;
      }
    }

    // HUD
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText(`${S.nodes.length} 节点 · ${S.edges.length} 边 · α ${S.alpha.toFixed(2)}`, 8, h - 10);
    ctx.fillText("拖动平移 · 滚轮缩放 · 单击节点看链路", w - 232, h - 10);
  }

  /* ---------- 相机 ---------- */

  function camera() {
    if (!canvas) return;
    const { w, h } = fitCanvas();
    if (!S.nodes.length) return;
    if (S.frozenAt != null) return; // 暂停/播完：镜头也定格，别继续缓动

    if (S.follow) {
      const ys = S.nodes.map((n) => n.y);
      const xs = S.nodes.map((n) => n.x);
      const minY = Math.min(...ys) - 26;
      const maxY = Math.max(...ys) + 54;
      const minX = Math.min(...xs) - 84;
      const maxX = Math.max(...xs) + 84;

      // 装得下就缩到刚好看全（一屏读懂整张网），装不下才退到跟随最新节点
      const wantScale = clamp(Math.min((w * 0.94) / (maxX - minX), (h * 0.9) / (maxY - minY)), 0.45, 1.25);
      S.scale += (wantScale - S.scale) * 0.07;

      const fits = (maxY - minY) * S.scale <= h * 0.92;
      const target = S.nodes.find((n) => n.active) || S.nodes[S.nodes.length - 1];
      const anchorY = fits ? (minY + maxY) / 2 : target.y - (maxY - minY) * 0.12;

      const wantPanY = -(anchorY * S.scale) - h * 0.3 + h / 2;
      const wantPanX = -((minX + maxX) / 2) * S.scale;
      S.panY += (wantPanY - S.panY) * 0.08;
      S.panX += (wantPanX - S.panX) * 0.08;
    }
  }

  function fit() {
    const { w, h } = fitCanvas();
    if (!S.nodes.length) return;
    const xs = S.nodes.map((n) => n.x);
    const ys = S.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 40;
    const maxY = Math.max(...ys) + 60;
    S.scale = clamp(Math.min(w / (maxX - minX), h / (maxY - minY)), 0.3, 1.6);
    S.panX = -((minX + maxX) / 2) * S.scale;
    S.panY = -((minY + maxY) / 2) * S.scale - h * 0.3 + h / 2;
    S.follow = false;
    S.painted = true;
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
      if (d < n.r * S.scale + 8 && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /* ---------- 悬停：只改渲染态，绝不碰物理（否则"悬停→抖动→换节点→再加热"会自激闪烁） ---------- */

  let movePending = null;
  let moveQueued = false;
  let tipParts = null;

  function ensureTip() {
    if (!tip) return null;
    if (!tipParts) {
      tip.innerHTML = '<span class="tip-a"></span><span class="tip-b"></span>';
      tipParts = { a: tip.querySelector(".tip-a"), b: tip.querySelector(".tip-b") };
    }
    return tipParts;
  }

  function showTip(node, x, y) {
    const parts = ensureTip();
    if (!parts) return;
    const isCall = node.kind === "call";
    const a = isCall ? `工具 · ${node.tool || node.label}` : KIND[node.kind].label;
    const b = isCall ? node.label : `${node.label}${node.tokens ? " · " + node.tokens + " tok" : ""}`;
    // 只在内容真的变了才写 DOM，避免每帧重建节点
    if (parts.a.textContent !== a) parts.a.textContent = a;
    if (parts.b.textContent !== b) parts.b.textContent = b;
    if (tip.hidden) tip.hidden = false;
    tip.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y - 10)}px, 0) translate(-50%, -100%)`;
  }

  function hideTip() {
    if (tip && !tip.hidden) tip.hidden = true;
  }

  function hoverAt(x, y) {
    const hit = hitTest(x, y);
    // 迟滞：已点亮或待点亮的节点，指针还在它周围（r + 12px）内就别换人
    const anchor = S.hover || candidate;
    if (anchor && anchor !== hit) {
      const rect = canvas.getBoundingClientRect();
      const { w, h } = fitCanvas();
      const [sx, sy] = toScreen(anchor, w, h);
      if (Math.hypot(rect.left + sx - x, rect.top + sy - y) < anchor.r * S.scale + 12) return anchor;
    }
    return hit;
  }

  function setHover(node) {
    if (S.hover === node) return;
    if (S.hover) S.hover.hovered = false;
    S.hover = node;
    if (node) node.hovered = true;
    S.dirty = true;
  }

  /* 悬停意图延迟：扫过不停留不点亮；但指针在同一颗节点内移动时**不重置**计时器
     （真实鼠标一直在小抖，每动一下就重置会导致永远凑不满时间 → 灯永远不亮） */
  const HOVER_INTENT_MS = 140;
  let intentTimer = null;
  let candidate = null;

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

    if (hit === candidate && intentTimer) return; // 同一颗候选上移动：保留计时，别打断

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

  /* ---------- 交互 ---------- */

  function bind() {
    const rectOf = () => canvas.getBoundingClientRect();

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = rectOf();
      const { w, h } = fitCanvas();
      const before = toWorld(e.clientX - rect.left, e.clientY - rect.top, w, h);
      S.scale = clamp(S.scale * (e.deltaY > 0 ? 0.92 : 1.08), 0.25, 3);
      S.follow = false;
      const after = toWorld(e.clientX - rect.left, e.clientY - rect.top, w, h);
      S.panX += (after[0] - before[0]) * S.scale;
      S.panY += (after[1] - before[1]) * S.scale;
      S.painted = true;
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => {
      S.dragging = { x: e.clientX, y: e.clientY, panX: S.panX, panY: S.panY, moved: false };
      canvas.setPointerCapture(e.pointerId);
      hideTip();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (S.dragging) {
        const dx = e.clientX - S.dragging.x;
        const dy = e.clientY - S.dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          S.dragging.moved = true;
          S.follow = false;
          S.painted = true;
        }
        S.panX = S.dragging.panX + dx;
        S.panY = S.dragging.panY + dy;
        return;
      }
      // 一帧只处理最后一次移动，鼠标高频事件不直接驱动命中测试；
      // 兜底定时器：后台标签页 rAF 不跑，不能只靠 rAF（本项目老坑）
      movePending = [e.clientX, e.clientY];
      if (moveQueued) return;
      moveQueued = true;
      let done = false;
      const flushMove = () => {
        if (done) return;
        done = true;
        moveQueued = false;
        const p = movePending;
        movePending = null;
        if (p) onMove(p[0], p[1]);
      };
      requestAnimationFrame(flushMove);
      window.setTimeout(flushMove, 40);
    });

    canvas.addEventListener("pointerup", (e) => {
      const dragged = S.dragging && S.dragging.moved;
      S.dragging = null;
      if (dragged) return;
      const hit = hitTest(e.clientX, e.clientY);
      S.focus = hit ? hit.id : null;
      if (!hit) hideTip();
    });

    canvas.addEventListener("pointerleave", () => {
      hideTip();
      if (S.hover) {
        S.hover.hovered = false;
        S.hover = null;
      }
    });
  }

  let lastSig = "";

  /* 冻结态的"画面签名"：只有真的变了才值得重绘（鼠标划过不重绘，就不会闪） */
  function frameSig() {
    const { w, h } = fitCanvas();
    let s = `${w}x${h}|${S.scale.toFixed(3)}|${Math.round(S.panX)}|${Math.round(S.panY)}|${
      S.hover ? S.hover.id : "-"
    }|${S.focus || "-"}|${S.nodes.length}|${S.edges.length}`;
    for (const n of S.nodes) {
      s += `|${Math.round(n.x)},${Math.round(n.y)}${n.active ? "A" : ""}${n.hovered ? "H" : ""}${n.pending ? "P" : ""}`;
    }
    return s;
  }

  function loop() {
    window.setInterval(() => {
      const t = now();
      const dt = clamp(t - (S.lastTick || t), 8, 50);
      S.lastTick = t;
      const animating = S.frozenAt == null; // 演示中/未冻结：动画需要连续帧
      if (S.playing) {
        for (let i = 0; i < 3; i++) step(dt * S.speed);
      }
      if (animating) camera();
      if (S.nodes.length) S.painted = true;

      if (animating) {
        draw();
        lastSig = frameSig();
        return;
      }
      const cur = frameSig();
      if (cur === lastSig && !S.dirty) return; // 冻结且没变化：跳过重绘
      S.dirty = false;
      lastSig = cur;
      draw();
    }, 16);
  }

  function init(canvasEl, tipEl) {
    canvas = canvasEl;
    tip = tipEl;
    readCss();
    bind();
    loop();
  }

  return {
    init,
    reset,
    add,
    link,
    complete,
    setActive,
    fit,
    get playing() { return S.playing; },
    set playing(v) {
      S.playing = !!v;
      S.frozenAt = S.playing ? null : now();
    },
    get speed() { return S.speed; },
    set speed(v) { S.speed = v; },
    get follow() { return S.follow; },
    set follow(v) { S.follow = v; if (v) S.painted = false; },
    get nodeCount() { return S.nodes.length; },
    get edgeCount() { return S.edges.length; },
    get alpha() { return S.alpha; },
    get focus() { return S.focus; },
    get hoverId() { return S.hover ? S.hover.id : null; },
    /* 屏幕坐标快照（测试与调试用） */
    screenPositions() {
      const { w, h } = fitCanvas();
      const rect = canvas.getBoundingClientRect();
      return S.nodes.map((n) => {
        const [x, y] = toScreen(n, w, h);
        return { id: n.id, kind: n.kind, label: n.label, cx: rect.left + x, cy: rect.top + y, r: n.r * S.scale };
      });
    },
    stats() {
      const by = {};
      S.nodes.forEach((n) => (by[n.kind] = (by[n.kind] || 0) + 1));
      return by;
    },
  };
})();
