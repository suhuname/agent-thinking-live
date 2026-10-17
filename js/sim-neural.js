/* sim-neural.js — 神经演示：同一轮思考，改由一片神经元用光效讲。
   每一步同时喂两份数据：
     · AgentDeck（消息 + 计数）→ 阶段轨 / 仪表 / 瀑布照旧联动
     · AgentNeural（事件 → 点火）→ 主舞台的神经元网络
   内容与数字都是编的（脚本唯一副本在 js/demo-script.js）。 */

window.AgentNeuralSim = (() => {
  let stopped = true;
  let paused = false;
  let finished = false;
  let pace = 1;
  let runId = 0;
  let statsTimer = null;
  let activity = "";

  const run = window.DemoCommon.createRun({ title: "演示 · 神经：把小说第一章做成带字幕的视频" });
  const session = (extra) => run.session({ last_activity_description: activity, ...extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const script = window.DemoScript.steps;

  function emitStats() {
    window.AgentDeck.ingest({ type: "stats", session: session() });
  }

  /* 暂停时把整条演示线（脚本 / 光效 / 计数）一起按住 */
  async function gate(myId) {
    while (paused && !stopped && myId === runId) await sleep(100);
  }

  function freshRound() {
    run.reset();
    window.AgentDeck.reset(false);
    window.AgentNeural.reset();
    window.AgentDeck.ingest({ type: "snapshot", session: session(), messages: [] });
  }

  function stepText(step) {
    if (step.node.text) return step.node.text;
    const m = step.msg;
    if (!m) return "";
    return m.reasoning || m.content || "";
  }

  async function beat(myId) {
    for (const step of script) {
      if (stopped || myId !== runId) return;
      await gate(myId);
      await sleep(step.wait / pace);
      await gate(myId);
      if (stopped || myId !== runId) return;

      if (step.activity) activity = step.activity;
      else if (step.stage === "tool") activity = "";
      else if (step.node.kind === "think" || step.node.kind === "answer") activity = "thinking";
      else if (step.node.kind === "user") activity = "";

      if (step.msg) {
        const message = run.message(step.msg);
        window.AgentDeck.ingest({ type: "message", message, typed: false });
      }

      window.AgentNeural.inject({
        id: step.node.id,
        kind: step.node.kind,
        label: step.node.label,
        tool: step.node.tool || "",
        tokens: step.node.tokens || 0,
        weight: step.node.weight || 100,
        text: stepText(step),
      });

      // 结果回来 = 那次工具/技能执行结束（运动区不再持续放电）
      if (step.node.kind === "result" && step.node.parent) {
        window.AgentNeural.complete(step.node.parent);
      }

      emitStats();
    }
    activity = "";
    if (myId !== runId) return;
    await finishRound();
  }

  /* 一轮演完停在这片网上：不循环、不清盘、时间也冻住 */
  async function finishRound() {
    finished = true;
    window.clearInterval(statsTimer);
    statsTimer = null;
    const hint = document.getElementById("streamHint");
    if (hint) hint.textContent = "本轮演示结束 · 按「重播」再看一遍";
    document.dispatchEvent(new CustomEvent("neural:finished"));
    await sleep(900); // 让最后几波光效自己走完再定格
    if (!finished) return;
    window.AgentNeural.fit();
    stopped = true;
    paused = true;
    window.AgentNeural.playing = false;
  }

  function start() {
    stopped = false;
    paused = false;
    finished = false;
    runId += 1;
    const myId = runId;
    activity = "";
    window.AgentNeural.playing = true;
    freshRound();
    const hint = document.getElementById("streamHint");
    if (hint) hint.textContent = "神经演示：编造的一轮思考，光效沿突触流转";
    window.clearInterval(statsTimer);
    statsTimer = window.setInterval(() => {
      if (!stopped && !paused) emitStats();
    }, 900);
    (async () => {
      while (myId === runId && !stopped) await beat(myId);
    })();
  }

  function stop() {
    stopped = true;
    window.clearInterval(statsTimer);
    statsTimer = null;
  }

  return {
    start,
    stop,
    get finished() {
      return finished;
    },
    get paused() {
      return paused;
    },
    set paused(v) {
      paused = !!v;
    },
    get speed() {
      return pace;
    },
    set speed(v) {
      pace = v || 1;
    },
  };
})();
