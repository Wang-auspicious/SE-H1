# CodeAgent · 从变更到证据

Homework 1 的轻量代码助手。它保留原生 LLM API 和一个很小的 ReAct 循环，支持代码图谱、文件读取/写入、Python 执行和失败回流。展示页把一次任务串成：

`任务 → 决策 → 工具 → 文件/符号 → 测试结果 → 交付说明`

这条“变更到证据”的记录是本项目的设计机会：代码助手通常能展示工具调用，却很少把改动和验证结果放在同一条可检查的轨道上。这里把它做成了一个可见的工程对象，便于发现缺陷、复盘和继续维护。

## 运行

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python code_agent.py . --port 8768
```

服务启动后会打开 `/agent`，根地址 `/` 也会重定向到同一页。`agent_visualizer.html` 是 Homework 1 的展示页；`/graph.html` 是面向源码维护的函数关系图，不作为默认入口。

需要调用模型时设置一个 OpenAI-compatible API key：

```powershell
$env:OPENCODE_API_KEY = "your-key"
python code_agent.py . "修复并测试这个函数"
```

没有 API key 也可以只生成本地代码图：

```powershell
python code_agent.py . --graph --open
```

## 核心工具

| 工具 | 作用 |
| --- | --- |
| `build_graph` | 用 Tree-sitter 建立真实文件、符号和关系图 |
| `query_graph` | 只取与任务相关的邻域，收敛上下文 |
| `read_file` | 按行读取仓库内文件，限制单次窗口 |
| `write_file` | 在仓库边界内写入修改 |
| `run_python` | 在超时受限的子进程中执行代码并保留输出 |

运行失败会作为下一轮观察回传；达到最大步数或执行超时就停止。读写路径、敏感文件和相对路径都在工具层检查。

## 代码结构

- `code_agent.py`：API 客户端、工具契约、循环、服务入口。
- `code_graph.py`：增量解析、关系解析、查询和缓存。
- `languages.py`：语言表和 Tree-sitter 语法提取。
- `agent_visualizer.html`：Homework 1 的架构图、证据轨道和下钻交互。
- `graph_view.html`：源码级关系图，供维护时定位函数。
- `DESIGN.md`：设计决策、边界和验证记录。

## 验证

```powershell
python -m py_compile code_agent.py code_graph.py languages.py
python code_agent.py . --graph
```

展示页支持 H1 单 Agent、H2 协同验证、模块下钻、链路悬停、证据轨道和 `Esc` 返回全景；页面不上传本地源码。
