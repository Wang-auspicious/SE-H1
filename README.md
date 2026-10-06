# CodeAtlas Studio

一个面向代码库审查的单 Agent 工作台。它接收提问，按需调用工具，把当前 checkout 的真实文件、符号和调用关系整理成可下钻的架构图，再用这些证据返回结论。

界面上有两块：**对话**（多轮追问，工具调用逐步上屏，每条结论挂 `file:line` 证据）和**架构图**（模块全景、关系连线、下钻局部邻域、源码片段）。两个视图共享一个外壳，主题可切换。

服务只读取本地代码，不上传源码，不依赖任何远程资源。运行时除了 `openai` SDK 和 `tree-sitter` 之外只用 Python 标准库。

## 运行

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python code_agent.py . --port 8768
```

浏览器会打开 `http://127.0.0.1:8768/`。

没有模型 key 时**同样可以完整使用**：界面右上角会标成「离线 · 本地静态审查」，对话走本地图结构审查，结论依然带可点开的源码位置。配置 key 后走真实的多步工具循环：

```powershell
$env:OPENCODE_API_KEY = "your-key"
$env:OPENCODE_MODEL = "deepseek-v4.1-flash"   # 可选
python code_agent.py . --port 8768
```

只构建图谱、不起服务：

```powershell
python code_agent.py . --graph
```

## 界面

**对话视图** —— 左侧是会话列表（存在浏览器本地，刷新后还在），中间是消息流。提问后可以先看着工具调用一行行出现，再读结论；结论和工具详情里出现的 `文件.py:120` 都是可点开的，弹窗里显示该位置的真实源码片段。

**架构视图** —— 模块全景图，悬停节点高亮直接相邻关系，点击模块进入局部邻域，`Esc` 返回全景。右侧 inspector 显示选中范围的度量、来源和关系，顶部搜索框可以按文件名或符号名过滤。侧栏可以改仓库路径并就地重新构图，本地目录和浅克隆地址都支持。

**主题** —— 右上角在深色与浅色之间切换，选择记在本地下次打开仍然生效。

## 本地接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/chat` | 按 `{ "session": "…", "prompt": "…" }` 运行一次对话，返回 NDJSON 事件流 |
| `GET` | `/api/status` | 当前模式（`llm` / `local`）、模型名、仓库路径、图谱统计 |
| `GET` | `/api/graph` | 服务当前分析仓库的完整图谱；构建失败时返回明确的 HTTP 错误 |
| `GET` | `/api/source?file=code_agent.py&line=120` | 图谱中已知源码的最多 120 行片段 |
| `POST` | `/api/build` | 按 `{ "repo": "…" }` 重新分析本地目录或浅克隆地址 |

`/api/chat` 的事件流是一行一个 JSON：

```
{"t":"session","session":"…"}
{"t":"tool","id":"call_1","phase":"Agent step 1","tool":"query_graph","state":"running","detail":"…"}
{"t":"tool","id":"call_1","phase":"Agent step 1","tool":"query_graph","state":"done","detail":"…"}
{"t":"answer","text":"…"}
{"t":"done","mode":"llm","steps":3,"tokens":412}
```

`/api/source` 只接受当前图谱中的文件名，路径必须留在仓库内；凭证文件、私钥、`.env` 文件和越界或外部符号链接一概拒绝读取。

## 工具

| 工具 | 作用 |
| --- | --- |
| `build_graph` | 用 Tree-sitter 建立真实文件、符号和关系图 |
| `query_graph` | 查询符号及其入边、出边，限制上下文规模并报告截断 |
| `read_file` | 按行读取仓库内文件，单次最多 200 行 |
| `write_file` | 在仓库边界内写入修改 |
| `run_python` | 在超时受限的子进程中执行 Python 并保留输出 |

工具错误会回流到下一轮，步数和执行时限共同限制循环。API key 只从环境变量或本地配置读取，不写进图谱，也不回显给前端。

## 这个系统好在哪

1. **结论可追溯** —— 每条判断都能点开对应 `file:line` 的真实源码，不是黑箱输出。离线模式同样如此，结论直接引用关系最密集的符号位置、解析不完整的文件和测试文件。
2. **无 key 也能跑** —— 没有模型凭证时自动降级为本地图结构审查，界面明确标注当前模式，不会假装调用了模型。两条路径产出同一种事件流。
3. **过程可见** —— 工具调用按 `running` → `done` 逐步上屏，能看到 agent 查了什么、查了几次、哪一步失败，而不是等一个转圈结束后蹦出一段文字。
4. **多轮追问** —— 配置模型时服务端按会话保留消息上下文，可以就同一份图谱连续追问；会话记录存在浏览器本地，刷新后继续。没有 key 时每个问题各自从图结构独立作答（离线审查不做语义理解），但会话仍然完整保留在界面上。
5. **服务端强边界** —— 路径越界、符号链接逃逸、`.env` / `auth.json` / 私钥文件一律拒绝读取，判定在服务端而不是前端，且有测试覆盖。
6. **任意仓库** —— 本地路径或浅克隆地址都能构图，界面内可重新构图，不需要重启服务。
7. **不静默丢** —— 解析失败的文件数、无法静态定位的调用点数都进统计并在界面上显示，覆盖率的缺口是可见的。

## 代码结构

- `code_agent.py`：模型循环、工具契约、会话表、HTTP 服务、NDJSON 事件流、本地边界检查。
- `code_graph.py`：增量解析、调用关系解析、缓存。缓存 revision 只由分析器自身的源码决定。
- `languages.py`：各语言的 Tree-sitter 提取规则。
- `studio.html` / `studio.css` / `studio.js`：工作台外壳——标题栏、会话列表、对话渲染、composer、主题、视图切换、流式客户端。
- `atlas_view.html` / `atlas_view.js` / `atlas.css`：架构图视图。挂在 Shadow DOM 里，与外壳样式完全隔离。
- `atlas_graph.js`：图谱的视图模型与确定性布局，不接触 DOM。
- `DESIGN.md`：架构决策、并发模型、隔离方案和验证记录。

## 验证

```powershell
python -m pytest tests -q
python -m py_compile code_agent.py code_graph.py languages.py
python code_agent.py . --port 8768
```

测试覆盖：工具事件回调与假模型客户端、NDJSON 对话流、会话复用与淘汰、离线审查的证据引用、源码读取的行数限制与仓库边界、敏感文件拒绝。

手工走一遍：打开 `/` → 提问，工具行逐步出现 → 点开结论里的 `file:line` 看源码 → 追问一句，确认还记得上文 → 切到架构图，点模块下钻，`Esc` 返回 → 切回对话，状态还在 → 切浅色主题，刷新后保持。

## 边界

静态解析无法覆盖所有动态调用，未能唯一解析的关系会被省略并计入统计；图谱是静态近似，不是运行时事实。`run_python` 是超时受限的本地子进程，不等同于操作系统级沙箱；处理不可信仓库时仍应使用专用隔离环境。离线审查不做语义理解，只从图结构推导结论。
