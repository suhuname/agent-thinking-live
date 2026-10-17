/* demo-common.js — 演示模式共用的假会话与假计数（流式演示 / 图谱演示都吃这一份）。
   所有数字都是编的，只为让仪表、瀑布、卡片有东西可动。 */

window.DemoCommon = (() => {
  function createRun({ title = "演示：把小说第一章做成带字幕的视频", model = "deepseek-v4-pro · 演示" } = {}) {
    let startedAt = Date.now() / 1000;
    let nextId = 1;
    const counters = { messages: 0, tools: 0, input: 0, output: 0, cache: 0, reasoning: 0, cost: 0 };

    function session(extra = {}) {
      return {
        id: "demo-0000-演示会话-0000",
        model,
        title,
        display_name: "演示",
        cwd: "E:\\Project\\novel-game",
        started_at: startedAt,
        ended_at: null,
        last_activity_at: Date.now() / 1000,
        last_activity_description: "",
        message_count: counters.messages,
        tool_call_count: counters.tools,
        input_tokens: counters.input,
        output_tokens: counters.output,
        cache_read_tokens: counters.cache,
        reasoning_tokens: counters.reasoning,
        estimated_cost_usd: counters.cost,
        cache_hit_rate: counters.cache / Math.max(1, counters.cache + counters.input),
        reasoning_share: counters.reasoning / Math.max(1, counters.output),
        live: true,
        ...extra,
      };
    }

    function message(partial) {
      counters.messages += 1;
      if (partial.role === "assistant") {
        counters.output += partial.tokens || 0;
        counters.reasoning += Math.round(((partial.reasoning || "") + (partial.content || "")).length / 3.2);
        counters.input += 900;
        counters.cache += 41000;
        counters.cost += 0.0042;
      }
      if ((partial.tool_calls || []).length) counters.tools += partial.tool_calls.length;
      return {
        id: nextId++,
        ts: Date.now() / 1000,
        tokens: null,
        finish_reason: null,
        content: "",
        reasoning: "",
        tool_calls: [],
        tool_name: null,
        ...partial,
      };
    }

    function reset() {
      startedAt = Date.now() / 1000;
      nextId = 1;
      Object.keys(counters).forEach((k) => (counters[k] = 0));
    }

    return { session, message, reset, counters };
  }

  return { createRun };
})();
