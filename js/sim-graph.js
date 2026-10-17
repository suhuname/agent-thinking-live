/* sim-graph.js — 图谱演示：同一轮思考，改用"因果网"来讲。
   每一步同时喂两份数据：
     · AgentDeck（消息 + 计数）→ 阶段轨 / 仪表 / 瀑布照旧联动
     · AgentGraph（节点 + 因果边）→ 主舞台的图谱
   所有内容与数字都是编的。 */

window.AgentGraphSim = (() => {
  let stopped = true;
  let statsTimer = null;
  let activity = "starting new turn";
  let pace = 1;
  let paused = false;
  let runId = 0;
  let finished = false;

  const run = window.DemoCommon.createRun({ title: "演示 · 图谱：把小说第一章做成带字幕的视频" });
  const session = (extra) => run.session({ last_activity_description: activity, ...extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 演示脚本与图谱视图共吃一份（js/demo-script.js），避免两个视图的故事漂移 */
  const script = window.DemoScript.steps;

  function emitStats() {
    window.AgentDeck.ingest({ type: "stats", session: session() });
  }

  /* 暂停时把整条演示线都按住：脚本、物理、计数一起停 */
  async function gate(myId) {
    while (paused && !stopped && myId === runId) await sleep(100);
  }

  /* 一轮结束后清空重来：图谱上叠两轮会糊成一片 */
  function freshRound() {
    run.reset();
    window.AgentDeck.reset(false);
    window.AgentGraph.reset();
    window.AgentGraph.follow = true;
    window.AgentDeck.ingest({ type: "snapshot", session: session(), messages: [] });
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

      const node = window.AgentGraph.add({ ...step.node });
      if (step.node.kind === "result" && step.node.parent) window.AgentGraph.complete(step.node.parent);
      window.AgentGraph.setActive(node.id);
      emitStats();
    }
    activity = "";
    if (myId !== runId) return;
    await finishRound();
  }

  /* 一轮演完就停在这张成品图上：不循环、不清盘，留给用户看 */
  async function finishRound() {
    finished = true;
    window.clearInterval(statsTimer);
    statsTimer = null;
    const hint = document.getElementById("streamHint");
    if (hint) hint.textContent = "本轮演示结束 · 按「重播」再看一遍";
    document.dispatchEvent(new CustomEvent("graph:finished"));
    // 先让最后几个节点自己落位，再把物理/画面一起冻住（否则定格在未收敛的位置）
    await sleep(800);
    if (!finished) return;
    window.AgentGraph.fit(); // 收拢到整张图：小窗口下也不会被裁在画布外
    stopped = true;
    paused = true;
    window.AgentGraph.playing = false;
  }

  function start() {
    stopped = false;
    paused = false;
    finished = false;
    runId += 1;
    const myId = runId;
    activity = "";
    window.AgentGraph.playing = true;
    freshRound();
    document.getElementById("streamHint").textContent = "图谱演示：编造的一轮思考，画成因果网";
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
