/* H1 tools around the upstream Limen viewer. No graph styling or routing here. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const model = JSON.parse($("archmap-data").textContent);
  const live = document.body.dataset.live === "true";
  const dialog = $("h1-dialog"), content = $("h1-content");
  let generation = 0;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function open(title) {
    generation++;
    $("h1-dialog-title").textContent = title;
    content.replaceChildren();
    if (!dialog.open) dialog.showModal();
    return generation;
  }
  async function request(path, data) {
    const response = await fetch(path, data ? {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)
    } : undefined);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  async function showSource(file, line = 1) {
    const id = open(`${file}:${line}`);
    if (!live) {
      content.append(element("p", "离线地图保留文件和行号证据；查看源码或运行审查请启动 H1 本地服务。", "h1-notice"));
      return;
    }
    const output = element("pre", "读取源码…", "h1-source");
    content.append(output);
    try {
      const result = await request(`/api/source?file=${encodeURIComponent(file)}&line=${line}`);
      if (id === generation) output.textContent = result.lines.map((text, i) => `${result.start + i}  ${text}`).join("\n");
    } catch (error) { if (id === generation) output.textContent = error.message; }
  }
  function download() {
    const blob = new Blob([JSON.stringify(model, null, 2)], {type: "application/json"});
    const link = element("a");
    link.href = URL.createObjectURL(blob);
    link.download = "h1-evidence.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function form(label, multiline, initial, action, run) {
    const box = element("form", null, "h1-form");
    const input = element(multiline ? "textarea" : "input");
    input.value = initial;
    input.setAttribute("aria-label", label);
    const submit = element("button", action, "tbtn");
    submit.type = "submit";
    const output = element("div", "", "h1-result");
    output.setAttribute("aria-live", "polite");
    box.append(element("label", label), input, submit, output);
    box.onsubmit = async event => {
      event.preventDefault();
      if (!input.value.trim()) return;
      submit.disabled = true;
      output.textContent = "正在处理…";
      try { await run(input.value.trim(), output); }
      catch (error) { output.textContent = error.message; }
      finally { submit.disabled = false; }
    };
    content.append(box);
  }
  $("h1-tools").onclick = () => {
    open("H1 · 代码审查与证据");
    const exportButton = element("button", "下载图谱证据 JSON", "tbtn");
    exportButton.onclick = download;
    content.append(element("p", "Limen Picture · MIT © 2026 Adam Gospodarczyk · H1 数据适配", "h1-notice"), exportButton);
    if (!live) {
      content.append(element("p", "当前为离线地图。启动 H1 本地服务后可构图、查看源码和运行单 Agent 审查。", "h1-notice"));
      return;
    }
    form("单 Agent 审查任务", true, "审查这个代码库的结构、调用关系和测试风险", "运行审查", async (prompt, output) => {
      const result = await request("/api/review", {prompt});
      const mode = result.mode === "llm" ? "模型审查" : "本地静态审查（未调用模型）";
      output.textContent = `${mode}\n\n${result.answer}\n\n` + (result.events || []).map(e => `${e.tool || e.phase}: ${e.detail || e.state || ""}`).join("\n");
    });
    form("本地仓库路径或仓库地址（留空路径时请输入 .）", false, ".", "重新构图", async (repo, output) => {
      await request("/api/build", {repo});
      output.textContent = "构图完成";
      location.href = location.pathname;
    });
  };
  $("h1-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { generation++; });
  document.addEventListener("click", event => {
    const target = event.target.closest("[data-source]");
    if (target) showSource(target.dataset.source, Number(target.dataset.line || 1));
    const source = event.target.closest(".d-sources code");
    if (source && !source.textContent.endsWith("/")) showSource(source.textContent);
  });
})();
