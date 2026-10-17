/* neural.js — 神经演示：把一轮思考铺成一片神经元，事件变成光效沿突触流转。
   零依赖自绘 canvas（和 graph.js 同一种做法）。

   设计：
   · 神经元按功能区套成同心球壳，**层序 = 使用频率**（最外圈最常用，取自本机 2.8 万条消息实测）：
     思考 20.7% → 运动 35.6%（读·列·改·其它四条月牙共用一层）→ 感知 3.7% → 技能 0.7% → 回传内核；
     回传是被动产出（每次工具调用后必有一条结果），不参与频率排序，固定放最内
   · 壳内近邻相连 + 跨壳长程通路；回传拆两条回路：内环回思考区，外环回感知区
   · 3D：世界坐标 (x,y,z) 落在球壳上，投影 = 旋转矩阵(yaw/pitch) + 透视（近大远小）；
     远侧压暗、按深度排序绘制；每层球壳画两个大圆当线框，帮助读出体积
   · 一次事件 = 在目标区点火，光点沿突触以「距离延迟」传播；神经元有膜电位、阈值、不应期
   · 拖拽 = 旋转球体（Shift / 右键拖动 = 平移），滚轮缩放，「适应」回到默认视角
   · 光效三件套：放电核 / 沿突触跑的光点 / 数秒不散的余晖（这一轮走过的路）
   · 悬停只改渲染态、点击出详情卡（沿用 graph.js 的意图延迟 + 迟滞，避免爆闪与自激） */

window.AgentNeural = (() => {
  /* level = 球壳层序（0 最外）：按使用频率排 —— 本机 28,186 条消息实测的事件占比：
     思考 20.7% → 运动 35.6%（四子区合计，共用一层）→ 感知 3.7% → 技能 0.7% → 回传（被动产出，不计频，固定内核） */
  const ZONES = {
    think: { label: "思考区", color: "--think", level: 0 },
    read: { label: "读取文件", color: "--tool", level: 1, group: "运动区" },
    list: { label: "列出目录", color: "--tool", level: 1, group: "运动区" },
    edit: { label: "编辑文件", color: "--tool", level: 1, group: "运动区" },
    other: { label: "其它工具", color: "--tool", level: 1, group: "运动区" },
    sense: { label: "感知区", color: "--fg-2", level: 2 },
    skill: { label: "技能区", color: "--skill", level: 3 },
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

  /* 世界坐标里的同心球壳：**层序 = 使用频率**（本机 28,186 条消息实测的事件占比），最外 = 最常用：
     思考 20.7% → 运动 35.6%（读/列/改/其它四条月牙共用一层）→ 感知 3.7% → 技能 0.7% → 回传内核。
     回传是"被动产出"（每次工具调用后必有一条结果），不参与频率排序，固定放最内。 */
  const R0 = 360; // 最外层半径（世界单位）
  const SHELL = {
    think: { r: 1.0, n: 170 },
    // 运动区四个子区贴同一层球壳，按方位角切成四条等面积的月牙（lune = 起始方位角，单位度）
    read: { r: 0.78, n: 20, lune: 0 },
    list: { r: 0.78, n: 20, lune: 90 },
    edit: { r: 0.78, n: 20, lune: 180 },
    other: { r: 0.78, n: 20, lune: 270 },
    sense: { r: 0.58, n: 40 },
    skill: { r: 0.4, n: 18 },
    out: { r: 0.23, n: 20 },
  };

  /* 区名按球壳半径排一圈：同心层里"方向"没有语义，"第几层"才是含义，
     所以名字钉在各自圆盘的边上（不跟旋转跑），永远不挤到球心；
     ang = 屏幕极角（度，0°=右、90°=下），r = 该壳半径占外层的比例 */
  const LABEL_RING = {
    think: { ang: 200, r: 1.0, pct: "20.7%" },
    sense: { ang: 165, r: 0.58, pct: "3.7%" },
    skill: { ang: 300, r: 0.4, pct: "0.7%" },
    out: { ang: 90, r: 0.23, pct: "39.4% · 被动" },
  };
  const MOTOR_RING = {
    group: { ang: 286, r: 0.78, pct: "35.6%" },
    read: { ang: 330, r: 0.78, pct: "5.0%" },
    list: { ang: 358, r: 0.78, pct: "0.8%" },
    edit: { ang: 22, r: 0.78, pct: "7.5%" },
    other: { ang: 50, r: 0.78, pct: "22.3%" },
  };

  /* 传播偏好：从哪里来，往哪里去更像"思考的流向" */
  const NEXT = {
    sense: ["think", "skill"],
    skill: ["think"],
    think: ["read", "list", "edit", "other", "think", "out"],
    read: ["out", "think", "list"],
    list: ["out", "think", "edit"],
    edit: ["out", "think", "other"],
    other: ["out", "think", "read"],
    out: ["think", "sense"], // 内环先回思考区，外环再送去感知区
  };

  const THRESH = 0.34; // 放电阈值（配 spike 每跳 0.68 的衰减：一次点火能往外扩 4~5 层）
  const MAX_HOP = 9; // 一次点火最多跳几层（防止全网炸开）
  const SPIKE_CAP = 420; // 在途脉冲上限（性能闸）
  const TRAIL_MS = 4200; // 余晖停留时间
  const HEAT_MS = 1600; // 区被触发后，区名/轮廓高亮衰减的时间
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
    zoneHeat: {}, // 区 → {at, amp}：这一区刚被触发过，区名/轮廓要亮起来
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
    yaw: -0.44, // 偏航（绕 Y 轴）
    pitch: 0.3, // 俯仰（绕 X 轴）
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
    String(s || "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function readCss() {
    const g = getComputedStyle(document.documentElement);
    const pick = (n) => g.getPropertyValue(n).trim();
    css = {};
    Object.entries(ZONES).forEach(([k, v]) => (css[k] = pick(v.color)));
    Object.entries(KIND).forEach(([k, v]) => (css[k] = pick(v.color)));
    css.fg = pick("--fg");
    css.muted = pick("--muted");
    css.panel = pick("--panel");
    // 3D 网格（经纬线 + 壳层轮廓）单独一个中性色：结构线不跟节点/突触的区色混在一起
    css.shellGrid = pick("--grid-3d") || pick("--fg-2");
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

  /* ---------- 3D → 屏幕：先按 yaw/pitch 旋转，再走透视（近大远小） ---------- */

  const CAM_D = 2400; // 相机到球心的距离（对 R0=360：近端放大约 16%，远端缩小约 13%，有体积又不夸张）

  function projectPoint(x, y, z) {
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const x1 = x * cy + z * sy; // 绕 Y 轴（偏航）
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp; // 绕 X 轴（俯仰）
    const z2 = y * sp + z1 * cp;
    const s = CAM_D / (CAM_D - clamp(z2, -CAM_D * 0.8, CAM_D * 0.8));
    return { x: x1 * s, y: -y2 * s, s, d: z2 }; // 世界 y 朝上，屏幕 y 朝下；d>0 表示更靠前
  }

  /* 远侧压暗：d 从 -R0 到 +R0 映射成 0.34 → 1 */
  const depthFade = (d) => 0.34 + 0.66 * clamp((d / R0 + 1) / 2, 0, 1);

  const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  /* 球面均匀撒点（Fibonacci 螺旋：不用拒绝采样，间距天然均匀） */
  function fibPoint(i, n) {
    const ga = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    return [Math.cos(th) * rad, y, Math.sin(th) * rad];
  }

  function toScreen(n, w, h) {
    const p = projectPoint(n.x, n.y, n.z);
    n._d = p.d;
    n._s = p.s;
    n._sx = p.x * S.scale + S.panX + w / 2;
    n._sy = p.y * S.scale + S.panY + originY(h);
    return [n._sx, n._sy];
  }

  const toPx = (p, w, h) => [p.x * S.scale + S.panX + w / 2, p.y * S.scale + S.panY + originY(h)];

  /* ---------- 拓扑 ---------- */

  function buildNodes() {
    S.nodes = [];
    S.index.clear();
    S.zoneIndex = {};
    S.cursors = {};
    let id = 0;
    Object.entries(SHELL).forEach(([zone, box]) => {
      const placed = [];
      const spacing = Math.sqrt((4 * Math.PI) / box.n); // 大致角间距，用来定抖动幅度
      const jitter = spacing * 0.34;
      for (let i = 0; i < box.n; i++) {
        let u;
        if (box.lune != null) {
          // 四条月牙：同一层球壳按方位角各占 90°，仰角按等面积分层
          const cols = 4;
          const rows = Math.max(2, Math.round(box.n / cols));
          const yi = i % rows;
          const ai = Math.floor(i / rows);
          const uy = -1 + (2 * (yi + 0.5)) / rows;
          const rad = Math.sqrt(Math.max(0, 1 - uy * uy));
          const az = ((box.lune + ((ai + 0.5) / cols) * 90) * Math.PI) / 180;
          u = [Math.cos(az) * rad, uy, Math.sin(az) * rad];
        } else {
          u = fibPoint(i, box.n);
        }
        u = norm3([
          u[0] + (Math.random() - 0.5) * jitter * 2,
          u[1] + (Math.random() - 0.5) * jitter * 2,
          u[2] + (Math.random() - 0.5) * jitter * 2,
        ]);
        // 球壳带一点厚度：看着是球体而不是球面上的一张纸；回传内核更厚一点
        const thick = zone === "out" ? 0.22 : 0.05;
        const rr = box.r * (1 + (Math.random() - 0.5) * thick) * R0;
        const n = {
          id: "n" + id++,
          zone,
          x: u[0] * rr,
          y: u[1] * rr,
          z: u[2] * rr,
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
          _d: 0,
          _s: 1,
          _sx: 0,
          _sy: 0,
        };
        n.r = n.r + Math.random() * 0.7;
        placed.push(n);
        S.nodes.push(n);
        S.index.set(n.id, n);
      }
      S.zoneIndex[zone] = placed.slice().sort((p, q) => p.y - q.y || p.z - q.z);
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

    // 壳内近邻（每颗接最近的 3 颗）
    S.nodes.forEach((n) => {
      const sib = S.zoneIndex[n.zone].filter((o) => o !== n);
      sib
        .sort((p, q) => dist3(p, n) - dist3(q, n))
        .slice(0, 3)
        .forEach((o) => push(n, o, 0.4 + Math.random() * 0.45));
    });

    // 跨壳通路：[源区, 目标区, 每颗源神经元的连线数(或概率), 基础权重]
    const roads = [
      ["sense", "think", 2, 0.68],
      ["skill", "think", 3, 0.94],
      ["think", "read", 0.12, 0.74],
      ["think", "list", 0.08, 0.68],
      ["think", "edit", 0.14, 0.74],
      ["think", "other", 0.1, 0.7],
      ["think", "think", 0.02, 0.42],
      // 四条月牙首尾相接，让运动层是一整圈而不是四块孤岛
      ["read", "list", 0.4, 0.42],
      ["list", "edit", 0.4, 0.42],
      ["edit", "other", 0.4, 0.42],
      ["other", "read", 0.4, 0.42],
      // 四个子区各自把结果送回内核
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
    S.trails.push({ x: n.x, y: n.y, z: n.z, t, amp: n.fireAmp, color: n.fireColor });
    if (S.trails.length > 700) S.trails.splice(0, S.trails.length - 700);
  }

  /* ---------- 放电与传播 ---------- */

  function bias(fromZone, toZone) {
    if (fromZone === toZone) return 1;
    const pref = NEXT[fromZone] || [];
    return pref.includes(toZone) ? 1.9 : 0.72;
  }

  /* 区级热度：这一区刚被触发过 → 区名和那层轮廓亮一下，1.6s 内衰减。
     跟着虚拟时钟走，所以暂停/播完时高亮也一起停住，不会假装还在动。 */
  function heat(zone, amp, t) {
    if (!zone) return;
    const cur = S.zoneHeat[zone];
    const left = cur ? cur.amp * clamp(1 - (t - cur.at) / HEAT_MS, 0, 1) : 0;
    S.zoneHeat[zone] = { at: t, amp: Math.max(left, clamp(amp, 0, 1)) };
  }

  function zoneHeatOf(zone, t) {
    const h = S.zoneHeat[zone];
    if (!h) return 0;
    return clamp((1 - (t - h.at) / HEAT_MS) * h.amp, 0, 1);
  }

  function fire(n, amp, color, hop, quiet) {
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
    // 只有"事件真的落在这个区"才点亮区名（hop=0）；级联传播不点，否则满屏区名一直亮着就没了指示意义
    if (!quiet && !hop) heat(n.zone, 0.68 + n.fireAmp * 0.22, t);

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
      const dist = dist3(e.to, n);
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
    heat(zone, 1, t); // 事件直接落在这个区：区名要最亮

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
    S.zoneHeat = {};
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
    fit(true);
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
        if (n && t >= n.refrUntil) fire(n, 0.42, css.think, 6, true);
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

  /* 每层球壳的唯一半径（运动区四条月牙共用一层，只画一次线框） */
  const SHELLS_R = (() => {
    const seen = new Map();
    Object.entries(SHELL).forEach(([zone, box]) => {
      const key = box.r.toFixed(3);
      if (!seen.has(key)) seen.set(key, { r: box.r, zone });
    });
    return [...seen.values()].sort((a, b) => b.r - a.r);
  })();

  /* 一个大圆的屏幕路径。前半球/后半球分两条 Path2D：前面的亮一倍，体积感就出来了 */
  function ringPath(R, axis, sc, w, h) {
    const N = 64;
    const front = new Path2D();
    const back = new Path2D();
    let prevSide = 0;
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const c = Math.cos(ang) * R;
      const s = Math.sin(ang) * R;
      const p = axis === 0 ? projectPoint(c, 0, s) : axis === 1 ? projectPoint(0, c, s) : projectPoint(c, s, 0);
      const x = p.x * sc + S.panX + w / 2;
      const y = p.y * sc + S.panY + originY(h);
      const side = p.d >= 0 ? 1 : -1;
      const path = side > 0 ? front : back;
      if (i === 0 || side !== prevSide) path.moveTo(x, y);
      else path.lineTo(x, y);
      prevSide = side;
    }
    return { front, back };
  }

  function drawShells(ctx, w, h) {
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;
    const gridHex = css.shellGrid || css.fg;
    SHELLS_R.forEach(({ r }, idx) => {
      const R = r * R0;
      // 两个正交大圆（最外层三个）：前半球亮、后半球暗，才有纵深；颜色统一用中性网格色
      const axes = idx === 0 ? [0, 1, 2] : [0, 1];
      axes.forEach((axis) => {
        const { front, back } = ringPath(R, axis, S.scale, w, h);
        ctx.strokeStyle = rgba(gridHex, 0.18);
        ctx.stroke(front);
        ctx.strokeStyle = rgba(gridHex, 0.08);
        ctx.stroke(back);
      });
    });
    ctx.globalCompositeOperation = "source-over";
  }

  /* 每层球壳的轮廓圆：画在突触之后、神经元之前 —— 压在网格上才数得清有几层。
     半径取透视下球剪影的闭式解：R·CAM_D/√(CAM_D²−R²)（比 R 略大，约 1%） */
  function drawShellRings(ctx, w, h) {
    ctx.globalCompositeOperation = "lighter";
    const cx = w / 2 + S.panX;
    const cy = originY(h) + S.panY;
    const t = clock();
    SHELLS_R.forEach(({ r, zone }, idx) => {
      const R = r * R0;
      const persp = CAM_D / Math.sqrt(Math.max(1, CAM_D * CAM_D - R * R));
      // 这一区刚被触发 → 它那圈轮廓跟着亮（运动层取四条月牙里最热的）；颜色同样走中性网格色
      const hot = zone === "read" ? Math.max(...MOTOR_ZONES.map((z) => zoneHeatOf(z, t))) : zoneHeatOf(zone, t);
      ctx.beginPath();
      ctx.arc(cx, cy, R * S.scale * persp, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(css.shellGrid || css.fg, (idx === 0 ? 0.32 : 0.26) + hot * 0.5);
      ctx.lineWidth = (idx === 0 ? 1.4 : 1) + hot * 0.9;
      ctx.stroke();
    });
    ctx.globalCompositeOperation = "source-over";
  }

  /* 区名胶囊。hot > 0 时整块亮起来：底色透出区色、加描边、文字发光、胶囊略微放大 */
  function labelPill(ctx, text, x, y, hex, alpha, align = "center", font = "11px ui-monospace, monospace", hot = 0) {
    if (alpha <= 0.03) return;
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    const bx = align === "center" ? x - tw / 2 : align === "right" ? x - tw : x;
    const grow = 2 * hot;
    ctx.beginPath();
    ctx.roundRect(bx - 5 - grow, y - 10 - grow * 0.7, tw + 10 + grow * 2, 15 + grow * 1.4, 3 + grow * 0.5);
    ctx.fillStyle = "rgba(8,9,11,0.82)";
    ctx.fill();
    if (hot > 0.02) {
      ctx.shadowColor = rgba(hex, 0.75 * hot);
      ctx.shadowBlur = 14 * hot;
      ctx.fillStyle = rgba(hex, 0.26 * hot);
      ctx.fill();
      ctx.strokeStyle = rgba(hex, 0.85 * hot);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = rgba(hex, clamp(alpha + (1 - alpha) * hot, 0, 1));
    if (hot > 0.12) {
      ctx.shadowColor = rgba(hex, 0.85 * hot);
      ctx.shadowBlur = 11 * hot;
    }
    ctx.textAlign = align;
    ctx.fillText(text, x, y + 1);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.textAlign = "left";
  }

  /* 名字钉在球壳圆盘的边上：半径本身就说明了它在第几层，方向随旋转跑反而会挤成一团 */
  function ringLabel(ctx, w, h, text, angDeg, radiusWorld, hex, alphaBase, hot = 0, align = "center", font = "11px ui-monospace, monospace") {
    const a = (angDeg * Math.PI) / 180;
    const R = radiusWorld * S.scale * 1.05;
    const x = w / 2 + S.panX + Math.cos(a) * R;
    const y = originY(h) + S.panY + Math.sin(a) * R;
    labelPill(ctx, text, x, y, hex, alphaBase, align, font, hot);
  }

  function drawZoneLabels(ctx, w, h) {
    const t = clock();
    const items = [];
    Object.entries(LABEL_RING).forEach(([zone, cfg]) => {
      items.push({ text: `${ZONES[zone].label} ${cfg.pct}`, cfg, hex: css[zone], alpha: 0.9, hot: zoneHeatOf(zone, t) });
    });
    // 运动区：一条组标题 + 四条月牙的名字；组标题跟着最热的子区一起亮
    const motorHot = Math.max(...MOTOR_ZONES.map((z) => zoneHeatOf(z, t)));
    items.push({
      text: `运 动 区 ${MOTOR_RING.group.pct}（工具合计）`,
      cfg: MOTOR_RING.group,
      hex: css.other,
      alpha: 0.9,
      hot: motorHot,
    });
    MOTOR_ZONES.forEach((zone) => {
      items.push({
        text: `${ZONES[zone].label} ${MOTOR_RING[zone].pct}`,
        cfg: MOTOR_RING[zone],
        hex: css[zone],
        alpha: 0.82,
        hot: zoneHeatOf(zone, t),
      });
    });
    // 热的最后画：被点着的那条不会被别的胶囊压住
    items.sort((a, b) => a.hot - b.hot);
    items.forEach((it) => ringLabel(ctx, w, h, it.text, it.cfg.ang, it.cfg.r * R0, it.hex, it.alpha, it.hot));
  }

  /* 突触中点往外推多少：短边弯得明显一点，长边几乎笔直 */
  function arcBow(len) {
    return 1 + (0.055 * R0) / Math.max(40, len);
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

    // 每帧先把全部神经元投影一次：突触、光点、命中拾取都复用这组屏幕坐标
    for (const n of S.nodes) toScreen(n, w, h);

    drawShells(ctx, w, h);

    /* 突触：按深度排序，远的先画、更淡；中点从球心往外推一点，弯成绕球的弧 */
    const arcs = [];
    for (const e of S.edges) {
      const a = S.index.get(e.a);
      const b = S.index.get(e.b);
      if (!a || !b) continue;
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
      const len = Math.hypot(mid[0], mid[1], mid[2]) || 1;
      const bow = arcBow(len);
      const m = projectPoint(mid[0] * bow, mid[1] * bow, mid[2] * bow);
      const [mx, my] = toPx(m, w, h);
      arcs.push({ e, a, b, mx, my, d: (a._d + b._d + m.d) / 3 });
    }
    arcs.sort((p, q) => p.d - q.d);

    for (const { e, a, b, mx, my, d } of arcs) {
      const hot = Math.max(
        clamp(t - a.fireAt < 900 ? 1 - (t - a.fireAt) / 900 : 0, 0, 1) + Math.min(1.1, a.m * 0.5),
        clamp(t - b.fireAt < 900 ? 1 - (t - b.fireAt) / 900 : 0, 0, 1) + Math.min(1.1, b.m * 0.5)
      );
      // 回传回路用自己的颜色，并且更显眼（内环=思考青，外环=感知灰）
      const strokeKey = e.circuit === "inner" ? "think" : e.circuit === "outer" ? "sense" : a.zone;
      let alpha = (0.024 + e.w * 0.042 + Math.min(0.26, hot * 0.17) + e.act * 0.18) * depthFade(d);
      if (e.circuit) alpha = Math.min(0.4, alpha * 1.6 + 0.02);
      if (alpha < 0.02) continue;
      ctx.strokeStyle = rgba(css[strokeKey] || css.think, alpha);
      ctx.lineWidth = 0.6 + e.w * 0.45 + e.act * 0.7 + (e.circuit ? 0.3 : 0);
      ctx.beginPath();
      ctx.moveTo(a._sx, a._sy);
      ctx.quadraticCurveTo(mx, my, b._sx, b._sy);
      ctx.stroke();
    }

    // 壳层轮廓压在网格之上：越密的地方越需要这条"层线"来读数
    drawShellRings(ctx, w, h);

    /* 余晖：这一轮走过的路（数秒不散） */
    ctx.globalCompositeOperation = "lighter";
    for (const p of S.trails) {
      const age = (t - p.t) / TRAIL_MS;
      if (age >= 1 || age < 0) continue;
      const pr = projectPoint(p.x, p.y, p.z);
      const [x, y] = toPx(pr, w, h);
      glowAt(
        ctx,
        x,
        y,
        24 * (0.7 + p.amp) * (0.5 + age * 0.6) * pr.s,
        colorKeyOf(p.color),
        p.amp * (1 - age) * 0.28 * depthFade(pr.d)
      );
    }

    /* 在途光点：沿同一条 3D 弧插值再逐点投影，才不会和画出来的突触错位 */
    for (const sp of S.spikes) {
      if (t < sp.t0) continue;
      const k = clamp((t - sp.t0) / sp.dur, 0, 1);
      const a = S.index.get(sp.a);
      const b = S.index.get(sp.b);
      if (!a || !b) continue;
      const bow = arcBow(Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2) || 1);
      const mx3 = ((a.x + b.x) / 2) * bow;
      const my3 = ((a.y + b.y) / 2) * bow;
      const mz3 = ((a.z + b.z) / 2) * bow;
      const mt = 1 - k;
      const x3 = mt * mt * a.x + 2 * mt * k * mx3 + k * k * b.x;
      const y3 = mt * mt * a.y + 2 * mt * k * my3 + k * k * b.y;
      const z3 = mt * mt * a.z + 2 * mt * k * mz3 + k * k * b.z;
      const pr = projectPoint(x3, y3, z3);
      const [x, y] = toPx(pr, w, h);
      glowAt(ctx, x, y, (11 + sp.amp * 16) * pr.s, colorKeyOf(sp.color), (0.5 + sp.amp * 0.4) * depthFade(pr.d));
    }
    ctx.globalCompositeOperation = "source-over";

    /* 神经元：远的先画、压暗缩小，近的压在上面 */
    const ordered = S.nodes.slice().sort((p, q) => p._d - q._d);
    for (const n of ordered) {
      const x = n._sx;
      const y = n._sy;
      const fade = depthFade(n._d);
      const base = css[n.zone];
      const since = t - n.fireAt;
      const flash = since >= 0 && since < 760 ? 1 - since / 760 : 0;
      const hot = clamp(n.m, 0, 1.5);
      const r = n.r * sc * n._s;

      // 核
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(base, (0.16 + hot * 0.45 + flash * 0.5) * fade);
      ctx.fill();
      ctx.lineWidth = n.info ? 1.2 : 0.9;
      ctx.strokeStyle = rgba(base, (0.3 + hot * 0.4 + flash * 0.5) * fade);
      ctx.stroke();

      // 膜电位环：攒到阈值就放
      if (hot > 0.06) {
        ctx.beginPath();
        ctx.arc(x, y, r * (1.5 + hot * 1.7), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colorHex(n.inColor) || base, hot * 0.28 * fade);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 放电冲击环
      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(x, y, r * (1.5 + (1 - flash) * 3.6), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colorHex(n.fireColor) || base, flash * 0.45 * fade);
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      // 光晕
      if (hot > 0.02 || flash > 0) {
        ctx.globalCompositeOperation = "lighter";
        glowAt(
          ctx,
          x,
          y,
          r * (4 + hot * 2.4 + flash * 2),
          colorKeyOf(n.fireColor || n.inColor || base),
          // 内核只有几颗挨在一起，光晕再打满就糊成一片白
          (hot * 0.28 + flash * 0.55) * fade * (n.zone === "out" ? 0.72 : 1)
        );
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

    // 区名最后画：压在网格和节点之上，字才不会被连线吃掉
    drawZoneLabels(ctx, w, h);

    // HUD
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.34)";
    ctx.fillText(
      `${S.nodes.length} 神经元 · ${S.edges.length} 突触 · 在途 ${S.spikes.length} · 本轮放电 ${S.fires}`,
      10,
      h - 12
    );
    ctx.textAlign = "right";
    ctx.fillText("拖动旋转 · Shift+拖动平移 · 滚轮缩放 · 悬停看简写 · 点击看详情", w - 10, h - 12);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.26)";
    ctx.fillText("球壳由外到内 = 使用频率：思考 → 运动 → 感知 → 技能 → 回传内核（回传是被动产出，不计频）", w / 2, h - 12);
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

  function fit(resetRotation = true) {
    if (!canvas || !S.nodes.length) return;
    const { w, h } = fitCanvas();
    if (resetRotation) {
      S.yaw = -0.44;
      S.pitch = 0.3;
    }
    S.scale = clamp(Math.min(w / (2 * R0 + 300), h / (2 * R0 + 240)), 0.2, 3.2);
    S.panX = 0;
    S.panY = 0;
    S.dirty = true;
  }

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = fitCanvas();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best = null;
    let bestScore = Infinity;
    for (const n of S.nodes) {
      toScreen(n, w, h);
      const d = Math.hypot(n._sx - sx, n._sy - sy);
      const rr = Math.max(6, n.r * S.scale * n._s + 6);
      if (d > rr) continue;
      // 屏幕上一样近时优先选靠前的，否则会点到被挡住的远侧神经元
      const score = d - (n._d / R0) * 7;
      if (score < bestScore) {
        bestScore = score;
        best = n;
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
        S.scale = clamp(S.scale * (e.deltaY > 0 ? 0.92 : 1.08), 0.2, 3.2);
        S.dirty = true;
      },
      { passive: false }
    );

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("pointerdown", (e) => {
      S.dragging = {
        x: e.clientX,
        y: e.clientY,
        panMode: e.shiftKey || e.button === 2 || e.button === 1, // Shift / 右键 / 中键 = 平移，其余 = 旋转
        panX: S.panX,
        panY: S.panY,
        yaw: S.yaw,
        pitch: S.pitch,
        moved: false,
      };
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
        if (S.dragging.panMode) {
          S.panX = S.dragging.panX + dx;
          S.panY = S.dragging.panY + dy;
        } else {
          // 拖动 = 把球拧过去（像转一颗地球仪），跟手的方向一致
          S.yaw = S.dragging.yaw + dx * 0.0062;
          S.pitch = clamp(S.dragging.pitch + dy * 0.0062, -1.35, 1.35);
          S.dirty = true;
        }
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

    // 窗口尺寸变化只重算缩放与居中，别把用户转好的角度拧回去
    window.addEventListener("resize", () => fit(false));
  }

  /* ---------- 主循环（setInterval：后台标签 rAF 会冻帧） ---------- */

  let lastSig = "";

  function sig() {
    const { w, h } = fitCanvas();
    return `${w}x${h}|${S.scale.toFixed(3)}|${Math.round(S.panX)}|${Math.round(S.panY)}|${S.yaw.toFixed(
      3
    )}|${S.pitch.toFixed(3)}|${S.hover ? S.hover.id : "-"}|${S.selected || "-"}|${S.vnow.toFixed(0)}|${
      S.spikes.length
    }|${S.trails.length}`;
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
      // 冻结（暂停 / 播完）：画面签名没变就不重绘；但用户转球时 yaw/pitch 变了，签名会变
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
    fit(true);
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
    /* 视角（调试 / 自动化用） */
    get view() {
      return { yaw: S.yaw, pitch: S.pitch, scale: S.scale, panX: S.panX, panY: S.panY };
    },
    set view(v) {
      if (!v) return;
      if (typeof v.yaw === "number") S.yaw = v.yaw;
      if (typeof v.pitch === "number") S.pitch = clamp(v.pitch, -1.35, 1.35);
      if (typeof v.scale === "number") S.scale = clamp(v.scale, 0.2, 3.2);
      if (typeof v.panX === "number") S.panX = v.panX;
      if (typeof v.panY === "number") S.panY = v.panY;
      S.dirty = true;
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
            r: n.r * S.scale * n._s,
            depth: n._d,
          };
        });
    },
    stats() {
      const by = {};
      S.nodes.forEach((n) => (by[n.zone] = (by[n.zone] || 0) + 1));
      return by;
    },
    /* 层序自检用：区 → 球壳半径比例 / 颗数 / 世界半径 */
    layers() {
      const out = {};
      Object.entries(SHELL).forEach(([zone, box]) => {
        out[zone] = { ratio: box.r, world: box.r * R0, n: box.n, level: ZONES[zone].level };
      });
      return out;
    },
    /* 区高亮自检用：此刻各区热度 0..1（区被触发后 1.6s 内衰减） */
    zoneHeat() {
      const t = clock();
      const out = {};
      Object.keys(SHELL).forEach((z) => (out[z] = +zoneHeatOf(z, t).toFixed(3)));
      return out;
    },
    /* 接入真实数据用：一次事件 → 一次点火（渲染层不用改，见 exp-002 的接口约定） */
    ingestStep(ev) {
      return inject(ev);
    },
  };
})();
