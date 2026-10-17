/* charts.js — 两块自绘 canvas：速率 sparkline 与消息瀑布。
   零依赖，全部按 devicePixelRatio 缩放，配色取 CSS 变量。 */

const Charts = (() => {
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* canvas 里 color-mix() 支持不稳，自己算 rgba */
  function withAlpha(color, a) {
    const hex = String(color || "").trim();
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // 与 graph.js 同一个坑：小数 DPR 下必须和"取整后的像素尺寸"比较，
    // 否则每帧都重分配 canvas → 画完即被清空（空白 + 闪烁）
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  /* ---------- 速率 sparkline ---------- */

  function sparkline(canvas, values) {
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;

    const max = Math.max(1, ...values);
    const pad = 3;
    const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
    const y = (v) => h - pad - (v / max) * (h - pad * 2);

    // 基线
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - pad + 0.5);
    ctx.lineTo(w, h - pad + 0.5);
    ctx.stroke();

    const accent = cssVar("--think") || "#4fb3a8";
    const pts = values.map((v, i) => [pad + i * step, y(v)]);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, withAlpha(accent, 0.34));
    grad.addColorStop(1, withAlpha(accent, 0));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h - pad);
    pts.forEach(([px, py]) => ctx.lineTo(px, py));
    ctx.lineTo(pts[pts.length - 1][0], h - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.stroke();

    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  /* ---------- 瀑布 ---------- */

  const LANES = {
    think: 0,
    "tool-call": 1,
    "tool-result": 1,
    answer: 2,
    user: 3,
    system: 3,
  };
  const KIND_COLOR = {
    think: "--think",
    "tool-call": "--tool",
    "tool-result": "--tool",
    answer: "--answer",
    user: "--fg-2",
    system: "--muted",
  };
  const KIND_LABEL = {
    think: "思考",
    "tool-call": "工具调用",
    "tool-result": "工具结果",
    answer: "回答",
    user: "用户",
    system: "系统",
  };

  function waterfall(canvas, bars, now, animate = true) {
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);

    const padX = 10;
    const axisH = 13;
    const topPad = 4;
    // 四条泳道按画布高度自适应，保证最下面那条不会被裁掉
    const laneGap = 3;
    const laneH = Math.max(7, Math.min(13, (h - axisH - topPad - laneGap * 3) / 4));

    if (!bars.length) {
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText("还没有可绘制的消息", padX, h / 2 + 4);
      return;
    }

    const t0 = bars[0].t0;
    const span = Math.max(30, now - t0);
    const x = (t) => padX + ((t - t0) / span) * (w - padX * 2);

    // 时间刻度
    const tickStep = span > 600 ? 120 : span > 240 ? 60 : span > 90 ? 30 : 10;
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;
    for (let t = Math.ceil(t0 / tickStep) * tickStep; t <= now; t += tickStep) {
      const px = Math.round(x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, topPad - 2);
      ctx.lineTo(px, h - axisH);
      ctx.stroke();
      const age = Math.round(now - t);
      ctx.fillText(age >= 60 ? `-${Math.round(age / 60)}m` : `-${age}s`, px + 3, h - 4);
    }

    // 条
    bars.forEach((bar) => {
      const lane = LANES[bar.kind] ?? 3;
      const py = topPad + lane * (laneH + laneGap);
      const x0 = x(bar.t0);
      const x1 = Math.max(x(bar.t1 || now), x0 + 3);
      const color = cssVar(KIND_COLOR[bar.kind] || "--muted") || "#7d858f";

      ctx.beginPath();
      const r = Math.min(3, (x1 - x0) / 2);
      ctx.roundRect(x0, py, x1 - x0, laneH, r);
      ctx.fillStyle = color;
      ctx.globalAlpha = bar.kind === "tool-result" ? 0.42 : bar.live ? 1 : 0.82;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (bar.live && animate) {
        const pulse = 0.45 + 0.4 * Math.sin(performance.now() / 320);
        ctx.strokeStyle = color;
        ctx.globalAlpha = pulse;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });

    // 当前游标
    const cx = Math.round(x(Math.min(now, t0 + span))) + 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.32)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, topPad - 2);
    ctx.lineTo(cx, h - axisH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function hitTest(canvas, bars, now, clientX) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const padX = 10;
    const t0 = bars.length ? bars[0].t0 : 0;
    const span = Math.max(30, now - t0);
    const toX = (t) => padX + ((t - t0) / span) * (rect.width - padX * 2);
    for (const bar of bars) {
      const x0 = toX(bar.t0);
      const x1 = Math.max(toX(bar.t1 || now), x0 + 3);
      if (px >= x0 - 2 && px <= x1 + 2) {
        const ms = Math.max(0, (bar.t1 || now) - bar.t0);
        return {
          label: `${KIND_LABEL[bar.kind] || bar.kind}${bar.name ? " · " + bar.name : ""}`,
          detail: `${(ms / 1000).toFixed(1)}s`,
          x: (x0 + x1) / 2,
          y: rect.top,
        };
      }
    }
    return null;
  }

  return { sparkline, waterfall, hitTest };
})();
