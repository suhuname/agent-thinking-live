/* demo-script.js — 演示脚本的唯一副本：图谱视图与神经视图讲的是同一轮思考，
   两处各抄一份必然漂移，所以抽到这里。所有内容与数字都是编的。

   每个 step：
     wait     停顿（ms，除以倍速）
     node     喂给视图的节点（kind / label / parent / refs / tokens / tool / text / weight）
     msg      喂给 AgentDeck 的消息（阶段轨 / 仪表 / 瀑布联动），null = 不发消息
     stage    activity 文案分支
     activity 会话活动描述（右栏/头部状态） */

window.DemoScript = (() => {
  const title = "把小说第一章做成带字幕的视频";

  const script = [
    {
      wait: 700,
      node: { id: "u1", kind: "user", label: "做一条带字幕的视频", weight: 120 },
      msg: { role: "user", content: "第一章的插画我已经放好了，帮我把这章做成一条带字幕的视频，能发的那种。" },
      stage: null,
    },
    {
      /* 技能调用：不是聊天消息，但它是"能力从外部载入"的关键一步 —— 神经视图会单独点亮技能区 */
      wait: 850,
      node: {
        id: "s1",
        kind: "skill",
        label: "加载技能 · interactive-fiction-game",
        parent: "u1",
        weight: 220,
        text: "技能命中：把小说章节做成可发布视频的完整流水线 —— 章节数据取法 / 插画为空时沿用上一张 / 构建脚本约定 / 交付前检查清单",
      },
      msg: null,
      stage: "tool",
      activity: "skill load: interactive-fiction-game",
    },
    {
      /* 技能载入的回执：顺带让"回传区"亮一下（技能不是空中楼阁，它把约定吐回来了） */
      wait: 620,
      node: {
        id: "r0",
        kind: "result",
        label: "技能已载入 · 4 条约定",
        parent: "s1",
        weight: 110,
        text: "拿到 4 条约定：章节数据取法 / 插画为空沿用上一张 / 构建脚本会内联 script.js / 交付前跑一遍检查清单",
      },
      msg: null,
      stage: "think",
    },
    {
      wait: 1100,
      node: { id: "t1", kind: "think", label: "先核对三件事", parent: "s1", tokens: 268, weight: 260 },
      msg: {
        role: "assistant",
        tokens: 268,
        reasoning:
          "用户要把 novel-game 第一章做成可发布的视频。先确认三件事：\n1) 章节数据在 js/script.js 的 scenes 数组里，插画在 assets/illustrations/；\n2) 已经有 7 张 16:9 的图（1920×1080），配在 scene 0/8/10/13/24/29/38；\n3) 没有音频 —— 要么走 TTS 旁白，要么做纯文字+插画节奏片。\n先按项目惯例读经验库，再决定用哪条渲染路线。",
        tool_calls: [
          { name: "read_file", args: '{\n  "path": "E:/Project/novel-game/.roo/skills/interactive-fiction-game/memory/INDEX.md"\n}' },
        ],
      },
      stage: "think",
    },
    {
      wait: 900,
      node: {
        id: "c1",
        kind: "call",
        label: "读经验库",
        tool: "read_file",
        parent: "t1",
        weight: 150,
        text: "E:/Project/novel-game/.roo/skills/interactive-fiction-game/memory/INDEX.md",
      },
      msg: null,
      stage: "tool",
      activity: "tool running: read_file",
    },
    {
      wait: 1200,
      node: { id: "r1", kind: "result", label: "经验库 3 条", parent: "c1", weight: 120, text: "插画流水线 / 空 image 沿用上一张 / 构建脚本约定" },
      msg: { role: "tool", tool_name: "read_file", content: "# 经验库索引\n- exp-20260811-001：插画生成流水线（model_video MCP → assets/illustrations）\n- exp-20260812-002：scene.image 为空时沿用上一张图的渲染约定\n- exp-20260915-003：构建脚本 `npm run build` 会把 script.js 内联进 index.html" },
      stage: "think",
    },
    {
      wait: 1400,
      node: { id: "t2", kind: "think", label: "选渲染路线", parent: "r1", tokens: 412, weight: 380 },
      msg: {
        role: "assistant",
        tokens: 412,
        reasoning:
          "经验库确认了数据形状。现在选渲染路线：这条流水线本质是「按帧读取场景 → 画插画 + 文字 + 字幕 → 编码 MP4」。\n两个候选：\n- Remotion：React 描述每一帧，Chrome 逐帧截图 + 自带 ffmpeg 合成。参数化、可批量、可复用项目里的 CSS 与字体。\n- ffmpeg 直接拼：快，但做文字排版和转场要写 filter 表达式，改一次痛一次。\n选 Remotion。先看它的脚手架，别用交互式向导（非 tty 会卡住）。",
        tool_calls: [{ name: "skill_view", args: '{\n  "name": "remotion-create"\n}' }],
      },
      stage: "think",
    },
    {
      wait: 900,
      node: { id: "c2", kind: "skill", label: "加载技能 · remotion-create", tool: "skill_view", parent: "t2", weight: 170, text: "remotion-create" },
      msg: null,
      stage: "tool",
      activity: "tool running: skill_view",
    },
    {
      wait: 1100,
      node: { id: "r2", kind: "result", label: "脚手架 + 坑", parent: "c2", weight: 140, text: "目录约定 / --browser-executable 必须指向本机 Chrome" },
      msg: { role: "tool", tool_name: "skill_view", content: "已加载 remotion-create：脚手架 6 个文件、目录约定、以及墙内必须带 --browser-executable 指向本机 Chrome 的坑。" },
      stage: "think",
    },
    {
      wait: 1300,
      node: { id: "t3", kind: "think", label: "取章节数据", parent: "r2", tokens: 196, weight: 240 },
      msg: {
        role: "assistant",
        tokens: 196,
        reasoning:
          "脚手架清楚了。现在把章节数据取出来：需要每段的文本、插画路径、以及每段的时长估计。\n中文按每秒 5.2 字读，插画段最少停 2.4 秒，纯对话段按字数推。先把 40 段算出来看看总时长会不会超过 8 分钟（超过就得分集）。",
        tool_calls: [
          {
            name: "terminal",
            args: '{\n  "command": "node -e \\"const s=require(\'./js/script.js\'); console.log(s.scenes.length)\\"",\n  "workdir": "E:/Project/novel-game"\n}',
          },
        ],
      },
      stage: "think",
    },
    {
      wait: 700,
      node: { id: "c3", kind: "call", label: "数场景 + 估时长", tool: "terminal", parent: "t3", weight: 150, text: "node -e … scenes.length" },
      msg: null,
      stage: "tool",
      activity: "tool running: terminal",
    },
    {
      wait: 2000,
      node: { id: "r3", kind: "result", label: "40 场 · 6分12秒", parent: "c3", weight: 130, text: "40 个场景，7 张插画，按 5.2 字/秒估总时长 6 分 12 秒" },
      msg: { role: "tool", tool_name: "terminal", content: "40\n\n（40 个场景，其中 7 个带插画；按 5.2 字/秒估算总时长 6 分 12 秒，单条发得动。）" },
      stage: "think",
    },
    {
      /* 运动区细分后的两个演示步骤：列目录、改文件 —— 让四个工具子区都亮一遍 */
      wait: 800,
      node: {
        id: "c3b",
        kind: "call",
        label: "列插画目录",
        tool: "list_directory",
        parent: "r3",
        weight: 140,
        text: '{"path": "E:/Project/novel-game/assets/illustrations"}',
      },
      msg: null,
      stage: "tool",
      activity: "tool running: list_directory",
    },
    {
      wait: 900,
      node: { id: "r3b", kind: "result", label: "7 张插画 · 1920×1080", parent: "c3b", weight: 120, text: "ch1-00 / 08 / 10 / 13 / 24 / 29 / 38 共 7 张，全部 16:9" },
      msg: {
        role: "tool",
        tool_name: "list_directory",
        content:
          "7 张：ch1-00.jpg、ch1-08.jpg、ch1-10.jpg、ch1-13.jpg、ch1-24.jpg、ch1-29.jpg、ch1-38.jpg\n（均为 1920×1080，16:9）",
      },
      stage: "think",
    },
    {
      wait: 1500,
      node: { id: "t4", kind: "think", label: "定方案 + 试片", parent: "r3b", refs: ["r1", "r3"], tokens: 388, weight: 360 },
      msg: {
        role: "assistant",
        tokens: 388,
        reasoning:
          "6 分 12 秒，单条够用，不用分集。\n渲染方案定了：\n- 1280×720 / 30fps\n- 每段：插画铺底 + 文字逐行淡入 + 上一条插画留白的那一段沿用上一张图\n- 字幕烧进画面下半区（没有音频，走不了 Whisper 转写）\n- 全部帧都必须是帧号的纯函数：不留任何 Date.now()\n先跑一版 3 个场景的试片，确认排版和节奏，再全量渲染。",
        tool_calls: [
          {
            name: "terminal",
            args: '{\n  "command": "npx remotion render ChapterOne out/ch1-preview.mp4 --frames=0-90 --browser-executable=\\"C:/Program Files/Google/Chrome/Application/chrome.exe\\"",\n  "workdir": "E:/Project/novel-game"\n}',
          },
        ],
      },
      stage: "think",
    },
    {
      wait: 900,
      node: { id: "c4", kind: "call", label: "渲染试片", tool: "terminal", parent: "t4", weight: 150, text: "remotion render --frames=0-90" },
      msg: null,
      stage: "tool",
      activity: "tool running: terminal",
    },
    {
      wait: 2600,
      node: { id: "r4", kind: "result", label: "试片 1.9MB · 11.4s", parent: "c4", weight: 140, text: "Bundling → Rendered 90/90 → Encoded → out/ch1-preview.mp4" },
      msg: { role: "tool", tool_name: "terminal", content: "Bundling 100%\nRendered 90/90\nEncoded 90/90\n+                    out/ch1-preview.mp4 1.9 MB\n\n（试片渲染完成，用时 11.4s。）" },
      stage: "think",
    },
    {
      wait: 800,
      node: {
        id: "c4b",
        kind: "call",
        label: "写渲染配置",
        tool: "write_file",
        parent: "r4",
        weight: 140,
        text: '{"path": "E:/Project/novel-game/remotion.config.ts", "note": "1920x1080 / 30fps"}',
      },
      msg: null,
      stage: "tool",
      activity: "tool running: write_file",
    },
    {
      wait: 900,
      node: { id: "r4b", kind: "result", label: "配置已写入", parent: "c4b", weight: 110, text: "remotion.config.ts：1920×1080 / 30fps / 每帧由帧号推导" },
      msg: {
        role: "tool",
        tool_name: "write_file",
        content: "已写入 remotion.config.ts（1920×1080 / 30fps，所有帧由帧号推导，不留 Date.now()）",
      },
      stage: "think",
    },
    {
      wait: 1300,
      node: { id: "a1", kind: "answer", label: "交付试片 + 3 个下一步", parent: "r4b", refs: ["r3"], tokens: 342, weight: 300 },
      msg: {
        role: "assistant",
        tokens: 342,
        finish_reason: "stop",
        content:
          "试片出来了：out/ch1-preview.mp4（前 3 段，11 秒渲染完）。\n\n排版按暖纸色系走，插画淡入 12 帧，文字逐行入场，逐段切换用 8 帧交叉。总时长估算 6 分 12 秒，单条可发。\n\n下一步你定：1. 全量渲染；2. 先加 TTS 旁白再渲染；3. 先看试片改排版。",
      },
      stage: "answer",
    },
  ];

  return { steps: script, title };
})();
