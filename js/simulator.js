/* simulator.js — 演示模式：不连后端，用同一套事件形状回放一个拟真回合。
   用途：给别人演示 / 录屏 / 后端没起来时也能看效果。所有数字都是编的。 */

window.AgentSim = (() => {
  let timer = null;
  let stopped = true;

  const run = window.DemoCommon.createRun();
  const session = (extra) => run.session(extra);
  const message = (partial) => run.message(partial);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const script = [
    {
      wait: 600,
      make: () =>
        message({
          role: "user",
          content: "第一章的插画我已经放好了，帮我把这章做成一条带字幕的视频，能发的那种。",
        }),
    },
    {
      wait: 900,
      make: () =>
        message({
          role: "assistant",
          reasoning:
            "用户要把 novel-game 第一章做成可发布的视频。先确认三件事：\n1) 章节数据在 js/script.js 的 scenes 数组里，插画在 assets/illustrations/；\n2) 已经有 7 张 16:9 的图（1920×1080），配在 scene 0/8/10/13/24/29/38；\n3) 没有音频 —— 要么走 TTS 旁白，要么做纯文字+插画节奏片。\n先按项目惯例读经验库，再决定用哪条渲染路线。",
          tokens: 268,
          finish_reason: "tool_calls",
          tool_calls: [
            {
              name: "read_file",
              args: '{\n  "path": "E:/Project/novel-game/.roo/skills/interactive-fiction-game/memory/INDEX.md"\n}',
            },
          ],
        }),
    },
    { wait: 420, make: () => message({ role: "tool", tool_name: "read_file", content: "# 经验库索引\n- exp-20260811-001：插画生成流水线（model_video MCP → assets/illustrations）\n- exp-20260812-002：scene.image 为空时沿用上一张图的渲染约定\n- exp-20260915-003：构建脚本 `npm run build` 会把 script.js 内联进 index.html" }) },
    {
      wait: 1100,
      make: () =>
        message({
          role: "assistant",
          reasoning:
            "经验库确认了数据形状。现在选渲染路线：这条流水线本质是「按帧读取场景 → 画插画 + 文字 + 字幕 → 编码 MP4」。\n两个候选：\n- Remotion：React 描述每一帧，Chrome 逐帧截图 + 自带 ffmpeg 合成。参数化、可批量、可复用项目里的 CSS 与字体。这套技能刚导进来。\n- ffmpeg 直接拼：快，但做文字排版和转场要写 filter 表达式，改一次痛一次。\n选 Remotion。先看它的脚手架，别用交互式向导（非 tty 会卡住）。",
          tokens: 412,
          finish_reason: "tool_calls",
          tool_calls: [
            { name: "skill_view", args: '{\n  "name": "remotion-create"\n}' },
          ],
        }),
    },
    { wait: 380, make: () => message({ role: "tool", tool_name: "skill_view", content: "skill_view(name=\"remotion-create\") 已加载：脚手架、目录约定、`--browser-executable` 的坑（墙内别让它自己下 Chrome Headless Shell）。" }) },
    {
      wait: 1500,
      make: () =>
        message({
          role: "assistant",
          reasoning:
            "脚手架清楚了。现在把章节数据取出来：需要每段的文本、插画路径、以及每段的时长估计。\n中文按每秒 5.2 字读，插画段最少停 2.4 秒，纯对话段按字数推。先把 40 段算出来看看总时长会不会超过 8 分钟（超过就得分集）。",
          tokens: 196,
          finish_reason: "tool_calls",
          tool_calls: [
            {
              name: "terminal",
              args: '{\n  "command": "node -e \\"const s=require(\'./js/script.js\'); console.log(s.scenes.length)\\"",\n  "workdir": "E:/Project/novel-game"\n}',
            },
          ],
        }),
    },
    { wait: 1400, make: () => message({ role: "tool", tool_name: "terminal", content: "40\n\n（40 个场景，其中 7 个带插画；按 5.2 字/秒估算总时长 6 分 12 秒，单条发得动。）" }) },
    {
      wait: 1700,
      make: () =>
        message({
          role: "assistant",
          reasoning:
            "6 分 12 秒，单条够用，不用分集。\n渲染方案定了：\n- 1280×720 / 30fps（竖屏短视频以外都够，渲染也快）\n- 每段：插画铺底 + 文字逐行淡入 + 上一条插画留白的那一段沿用上一张图\n- 字幕走 Whisper 转写是不行的（没有音频），改用场景文本直接烧进画面下半区\n- 全部帧都必须是帧号的纯函数：不留任何 Date.now()\n先跑一版 3 个场景的试片，确认排版和节奏，再全量渲染。",
          tokens: 388,
          finish_reason: "tool_calls",
          tool_calls: [
            {
              name: "terminal",
              args: '{\n  "command": "npx remotion render ChapterOne out/ch1-preview.mp4 --frames=0-90 --browser-executable=\\"C:/Program Files/Google/Chrome/Application/chrome.exe\\"",\n  "workdir": "E:/Project/novel-game"\n}',
            },
          ],
        }),
    },
    { wait: 2600, make: () => message({ role: "tool", tool_name: "terminal", content: "Bundling 100%\nRendered 90/90\nEncoded 90/90\n+                    out/ch1-preview.mp4 1.9 MB\n\n（试片渲染完成，用时 11.4s。）" }) },
    {
      wait: 1200,
      make: () =>
        message({
          role: "assistant",
          tokens: 342,
          finish_reason: "stop",
          content:
            "试片出来了：out/ch1-preview.mp4（前 3 段，11 秒渲染完）。\n\n排版按暖纸色系走，插画淡入 12 帧，文字逐行入场，逐段切换用 8 帧交叉。总时长估算 6 分 12 秒，单条可发。\n\n下一步你定：\n1. 就这样全量渲染（约 4 分钟出片）；\n2. 先加 TTS 旁白（Kokoro，中文音色 8 个可选），再渲染；\n3. 先看试片，改完排版再全量。",
        }),
    },
  ];

  async function beat() {
    for (const step of script) {
      if (stopped) return;
      await sleep(step.wait);
      if (stopped) return;
      window.AgentDeck.ingest({ type: "message", message: step.make() });
      window.AgentDeck.ingest({ type: "stats", session: session() });
    }
    await sleep(5200);
  }

  function start() {
    stopped = false;
    run.reset();
    window.AgentDeck.reset(false);
    window.AgentDeck.ingest({ type: "snapshot", session: session(), messages: [] });
    document.getElementById("streamHint").textContent = "演示模式：编造的事件流，节奏与真实回合接近";
    (async () => {
      while (!stopped) await beat();
    })();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  return { start, stop };
})();
