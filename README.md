# CodeAgent · 本地代码图谱

Homework 1 是一个本地代码助手：它接收任务，按需调用工具，并把当前 checkout 的真实文件、符号和调用关系整理成可浏览的图。`/agent` 只读取本地图谱接口，不上传源码，也不依赖参考录屏或远程资源。

## 运行

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python code_agent.py . --port 8768
```

服务启动后打开 `http://127.0.0.1:8768/agent`；根地址 `/` 会重定向到 `/agent`。源码关系图仍可通过 `/graph.html` 查看，作为维护用的兼容入口。

没有模型 key 时可以只构建本地图谱：

```powershell
python code_agent.py . --graph --open
```

需要调用模型时设置 OpenAI-compatible key：

```powershell
$env:OPENCODE_API_KEY = "your-key"
python code_agent.py . "修复并测试这个函数"
```

## 本地接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/graph` | 返回服务当前分析仓库的图谱；构建失败时返回明确的 HTTP 错误 |
| `GET` | `/api/source?file=code_agent.py&line=120` | 返回图谱中已知源码的最多 120 行片段 |
| `POST` | `/api/build` | 按 `{ "repo": "..." }` 重新分析本地目录或浅克隆地址 |

源码接口只接受当前图谱中的文件名，路径必须留在仓库内；凭证文件、私钥、`.env` 文件和越界或外部 symlink 均拒绝读取。

## 工具

| 工具 | 作用 |
| --- | --- |
| `build_graph` | 用 Tree-sitter 建立真实文件、符号和关系图 |
| `query_graph` | 查询符号及其入边、出边，限制上下文规模 |
| `read_file` | 按行读取仓库内文件，单次最多 200 行 |
| `write_file` | 在仓库边界内写入修改 |
| `run_python` | 在超时受限的子进程中执行 Python 并保留输出 |

工具错误会回传到下一轮，步数和执行时限共同限制循环。API key 只从环境变量或本地配置读取，不写入图谱。

## 代码结构

- `code_agent.py`：API 客户端、工具契约、HTTP 服务和本地边界检查。
- `code_graph.py`：增量解析、调用关系、缓存和离线 HTML 生成。
- `languages.py`：各语言的 Tree-sitter 提取规则。
- `agent_visualizer.html`、`atlas_graph.js`：本地图谱的交互展示模板与确定性布局、路由逻辑。
- `graph_view.html`：保留的旧版源码关系图入口。
- `DESIGN.md`：架构边界和验证记录。

## 验证

```powershell
python -m py_compile code_agent.py code_graph.py languages.py
python code_agent.py . --graph
```

构建输出会写入 `.code-graph/graph.json` 和 `.code-graph/graph.html`。页面应能加载 `/api/graph`，节点悬停可查看关系，模块点击可进入局部图，`Esc` 返回全景；`/api/source` 只能返回当前图谱中的安全源码片段。

## 边界

静态解析无法覆盖所有动态调用，未能解析的关系会被省略并保留统计信息。`run_python` 是超时受限的本地子进程，并不等同于操作系统级沙箱；处理不可信仓库时仍应使用专用隔离环境。
