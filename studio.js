/* CodeAtlas Studio — chat shell: sessions, transcript, streaming tool trail. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const flow = $("flow");
  const stream = $("stream");
  const composer = $("composer");
  const promptInput = $("prompt");
  const sendButton = $("send");
  const HISTORY_KEY = "codeatlas.sessions.v1";
  const THEME_KEY = "codeatlas.theme";
  const MAX_SESSIONS = 30;
  const MAX_TURNS = 200;
  const DETAIL_LIMIT = 200;
  const SOURCE = /(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z]\w*:\d+/g;
  const CAPABILITIES = [
    "结论可追溯 —— 每条判断都挂 file:line 证据，点开就是真实源码",
    "无 key 也能跑 —— 没有模型凭证时走本地静态审查，界面明确标注",
    "过程可见 —— 工具调用逐步上屏，能看到 agent 查了什么、为什么查",
    "多轮追问 —— 同一会话保留上下文，不用每次从零开始",
    "服务端强边界 —— 路径越界、符号链接逃逸、密钥文件一律拒绝读取",
    "任意仓库 —— 本地路径或浅克隆地址都能构图，界面内可重构图",
    "不静默丢 —— 解析失败的文件与无法静态定位的调用点都进统计",
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  /* ------------------------------------------------------------ sessions */

  function newSession() {
    const now = Date.now();
    return { id: crypto.randomUUID(), title: "", createdAt: now, updatedAt: now, turns: [] };
  }

  function loadStore() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "");
      if (saved && Array.isArray(saved.sessions) && saved.sessions.length) return saved;
    } catch {
      /* A corrupt entry is not worth recovering; start clean. */
    }
    return null;
  }

  function save() {
    store.sessions = store.sessions.slice(0, MAX_SESSIONS);
    for (const session of store.sessions) session.turns = session.turns.slice(-MAX_TURNS);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
    } catch {
      /* Quota errors must not break the live conversation. */
    }
  }

  function when(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
  }

  const store = loadStore() || { activeId: "", sessions: [] };
  let active = store.sessions.find((session) => session.id === store.activeId);
  if (!active) {
    active = newSession();
    store.sessions.unshift(active);
    store.activeId = active.id;
  }
  let live = null;
  let controller = null;

  /* ----------------------------------------------------------- rendering */

  function renderSessions() {
    const list = $("sessions");
    list.replaceChildren();
    for (const session of store.sessions) {
      const row = el("button", "session" + (session.id === active.id ? " on" : ""));
      row.type = "button";
      row.append(el("span", null, session.title || "新对话"), el("em", null, when(session.updatedAt)));
      const drop = el("span", "drop", "✕");
      drop.title = "删除";
      drop.addEventListener("click", (event) => {
        event.stopPropagation();
        dropSession(session);
      });
      row.append(drop);
      row.addEventListener("click", () => openSession(session));
      list.append(row);
    }
  }

  function renderHeader() {
    $("chat-title").textContent = active.title || "新的代码审查";
  }

  function render() {
    flow.replaceChildren();
    renderHeader();
    if (!active.turns.length) flow.append(welcomeNode());
    for (const turn of active.turns) flow.append(turnNode(turn));
    scrollToEnd();
  }

  function welcomeNode() {
    const wrap = el("div", "turn assistant welcome");
    wrap.append(el("div", "prose", "这个仓库已经构图完成。下面是它相对通用代码问答的能力边界："));
    const prose = el("div", "prose");
    const list = el("ul");
    for (const item of CAPABILITIES) list.append(el("li", null, item));
    prose.append(list);
    wrap.append(prose);
    return wrap;
  }

  function turnNode(turn) {
    const wrap = el("div", "turn " + turn.role);
    if (turn.role === "user") {
      wrap.append(el("div", "bubble", turn.text));
      return wrap;
    }
    const tools = toolsNode(turn.tools);
    if (tools) wrap.append(tools);
    const prose = el("div", "prose");
    if (turn.text) {
      prose.innerHTML = markdown(turn.text);
      linkify(prose);
    } else {
      prose.classList.add("muted");
      prose.textContent = "（没有返回结论）";
    }
    wrap.append(prose);
    return wrap;
  }

  function toolsNode(tools) {
    if (!tools || !tools.length) return null;
    const details = el("details", "tools");
    details.append(el("summary"), toolRowsNode(tools));
    details.querySelector("summary").append(summaryLabel(tools));
    return details;
  }

  function summaryLabel(tools) {
    const running = tools.filter((tool) => tool.state === "running").length;
    const last = tools[tools.length - 1];
    if (running) return el("b", null, `正在调用 ${last.tool}…`);
    return el("b", null, `已完成 ${tools.length} 次工具调用`);
  }

  function toolRowsNode(tools) {
    const rows = el("div", "tool-rows");
    for (const tool of tools) {
      const row = el("div", "tool");
      row.dataset.state = tool.state;
      const detail = el("span", "tool-detail", tool.detail);
      linkify(detail);
      row.append(el("span", "tool-name", tool.tool), detail, el("em", null, tool.state));
      rows.append(row);
    }
    return rows;
  }

  function scrollToEnd() {
    stream.scrollTop = stream.scrollHeight;
  }

  /* ------------------------------------------------------------ markdown */

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  }

  function markdown(source) {
    const out = [];
    let buffer = [];
    let list = null;
    let fenced = false;
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of escapeHtml(source).split("\n")) {
      if (fenced) {
        if (line.trimStart().startsWith("```")) {
          out.push(`<pre><code>${buffer.join("\n")}</code></pre>`);
          buffer = [];
          fenced = false;
        } else buffer.push(line);
        continue;
      }
      if (line.trimStart().startsWith("```")) {
        closeList();
        fenced = true;
        continue;
      }
      const heading = /^#{1,3}\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        out.push(`<h2>${inline(heading[1])}</h2>`);
      } else if (bullet || numbered) {
        const want = bullet ? "ul" : "ol";
        if (list !== want) {
          closeList();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      } else if (/^>\s?/.test(line)) {
        closeList();
        out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    if (fenced && buffer.length) out.push(`<pre><code>${buffer.join("\n")}</code></pre>`);
    return out.join("\n");
  }

  /* ------------------------------------------------------- source evidence */

  function linkify(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || /^(PRE|CODE|A|BUTTON)$/.test(parent.tagName)) continue;
      SOURCE.lastIndex = 0;
      if (SOURCE.test(node.nodeValue)) targets.push(node);
    }
    for (const node of targets) {
      SOURCE.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of node.nodeValue.matchAll(SOURCE)) {
        fragment.append(node.nodeValue.slice(last, match.index));
        const [file, line] = match[0].split(/:(?=\d+$)/);
        const button = el("button", "src", match[0]);
        button.type = "button";
        button.title = "查看源码";
        button.dataset.file = file;
        button.dataset.line = line;
        button.addEventListener("click", () => showSource(file, line));
        fragment.append(button);
        last = match.index + match[0].length;
      }
      fragment.append(node.nodeValue.slice(last));
      node.replaceWith(fragment);
    }
  }

  async function showSource(file, line) {
    const dialog = $("source-dialog");
    const body = $("source-body");
    $("source-title").textContent = `${file}:${line}`;
    body.textContent = "读取中…";
    if (!dialog.open) dialog.showModal();
    try {
      const response = await fetch(
        `/api/source?file=${encodeURIComponent(file)}&line=${encodeURIComponent(line)}`,
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const width = String(result.start + result.lines.length).length;
      body.textContent = result.lines
        .map((text, index) => `${String(result.start + index).padStart(width)}  ${text}`)
        .join("\n");
    } catch (error) {
      body.textContent = `无法读取该源码：${error.message}`;
    }
  }

  /* -------------------------------------------------------------- streaming */

  function startTurn() {
    const turn = { role: "assistant", text: "", tools: [] };
    active.turns.push(turn);
    const wrap = el("div", "turn assistant");
    const details = el("details", "tools");
    details.open = true;
    details.hidden = true;
    const summary = el("summary");
    const rows = el("div", "tool-rows");
    details.append(summary, rows);
    const prose = el("div", "prose muted", "正在分析仓库…");
    wrap.append(details, prose);
    flow.append(wrap);
    scrollToEnd();
    live = { turn, details, summary, rows, prose };
  }

  function onTool(event) {
    const tools = live.turn.tools;
    const record = {
      id: event.id || null,
      tool: event.tool || event.phase || "step",
      state: event.state || "done",
      detail: String(event.detail || "").slice(0, DETAIL_LIMIT),
    };
    const index = record.id ? tools.findIndex((tool) => tool.id === record.id) : -1;
    if (index >= 0) tools[index] = record;
    else tools.push(record);

    live.details.hidden = false;
    live.rows.replaceChildren(...toolRowsNode(tools).children);
    live.summary.replaceChildren(summaryLabel(tools));
    scrollToEnd();
  }

  function onAnswer(event) {
    live.turn.text = String(event.text || "");
    live.prose.classList.remove("muted");
    live.prose.innerHTML = markdown(live.turn.text);
    linkify(live.prose);
    scrollToEnd();
  }

  function onEvent(event) {
    if (event.t === "tool") onTool(event);
    else if (event.t === "answer") onAnswer(event);
    else if (event.t === "done") live.turn.mode = event.mode;
    else if (event.t === "error") {
      live.turn.text = `审查失败：${event.error}`;
      live.prose.classList.remove("muted");
      live.prose.textContent = live.turn.text;
    }
  }

  async function streamChat(text) {
    controller = new AbortController();
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: active.id, prompt: text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // A chunk can end mid-line; hold the tail back.
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  async function ask(text) {
    flow.querySelector(".welcome")?.remove();
    active.turns.push({ role: "user", text });
    if (!active.title) {
      active.title = text.slice(0, 40);
      renderHeader();
    }
    active.updatedAt = Date.now();
    const wrap = el("div", "turn user");
    wrap.append(el("div", "bubble", text));
    flow.append(wrap);
    scrollToEnd();

    sendButton.disabled = true;
    startTurn();
    try {
      await streamChat(text);
    } catch (error) {
      if (error.name !== "AbortError") {
        live.prose.classList.remove("muted");
        live.prose.textContent = `请求失败：${error.message}`;
      }
    } finally {
      if (live && !live.turn.text && !live.prose.textContent) live.prose.textContent = "（没有返回结论）";
      live = null;
      controller = null;
      sendButton.disabled = false;
      save();
      renderSessions();
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text || sendButton.disabled) return;
    promptInput.value = "";
    autosize();
    ask(text);
  });

  promptInput.addEventListener("input", autosize);

  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  function autosize() {
    promptInput.style.height = "auto";
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 220)}px`;
  }

  /* ---------------------------------------------------------------- switching */

  function openSession(session) {
    if (session.id === active.id) return;
    if (controller) controller.abort();
    active = session;
    store.activeId = session.id;
    save();
    renderSessions();
    render();
  }

  function dropSession(session) {
    store.sessions = store.sessions.filter((item) => item.id !== session.id);
    if (session.id === active.id) {
      active = store.sessions[0] || newSession();
      if (!store.sessions.includes(active)) store.sessions.unshift(active);
      store.activeId = active.id;
      render();
    }
    save();
    renderSessions();
  }

  $("new-chat").addEventListener("click", () => {
    if (controller) controller.abort();
    active = newSession();
    store.sessions.unshift(active);
    store.activeId = active.id;
    save();
    renderSessions();
    render();
    promptInput.focus();
  });

  function setView(view) {
    document.body.dataset.view = view;
    for (const button of $("view-switch").children) {
      button.classList.toggle("on", button.dataset.view === view);
    }
    // The pane measures 0x0 while it is hidden, so the atlas can only re-render
    // once the browser has laid the atlas view out.
    if (view === "atlas") requestAnimationFrame(() => AtlasView.show());
    else promptInput.focus();
  }

  $("view-switch").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.dataset.view === "atlas") AtlasView.escape();
  });

  $("source-close").addEventListener("click", () => $("source-dialog").close());

  /* ------------------------------------------------------------ status/theme */

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $("theme-button").textContent = theme === "dark" ? "☾" : "☀";
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* Private mode: the theme simply does not persist. */
    }
  }

  $("theme-button").addEventListener("click", () =>
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  );

  async function refreshStatus() {
    try {
      const status = await (await fetch("/api/status")).json();
      $("status-text").textContent = status.mode === "llm" ? status.model : "离线 · 本地静态审查";
      $("status-chip").dataset.mode = status.mode;
      $("model-chip").textContent = status.mode === "llm" ? status.model : "本地静态审查";
      $("repo-chip").textContent = status.repo;
      $("repo-chip").title = status.repo;
      const stats = status.stats || {};
      $("mode-hint").textContent =
        `${stats.files || 0} 文件 · ${stats.functions || 0} 函数 · ` +
        `${stats.edges || 0} 关系 · ${stats.errors || 0} 解析失败`;
    } catch {
      $("status-text").textContent = "服务不可用";
    }
  }

  $("build-button").addEventListener("click", async () => {
    const button = $("build-button");
    button.disabled = true;
    button.textContent = "构图…";
    try {
      const response = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: $("repo-input").value.trim() || "." }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      await refreshStatus();
      AtlasView.refresh();
    } catch (error) {
      $("mode-hint").textContent = `构图失败：${error.message}`;
    } finally {
      button.disabled = false;
      button.textContent = "重新构图";
    }
  });

  $("repo-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("build-button").click();
  });

  /* ------------------------------------------------------------------- boot */

  setTheme(document.documentElement.dataset.theme || "dark");
  renderSessions();
  render();
  autosize();
  AtlasView.mount($("atlas-host"));
  refreshStatus();
})();
