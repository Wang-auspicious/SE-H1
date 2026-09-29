# Code Agent

在原 `code_agent.py` 上改的单一 ReAct Agent：保留读文件、写文件、运行 Python，新增建图和查图。`code_graph.py` 负责图，`languages.py` 独立管理语言规则和语法提取，`graph_view.html` 负责展示。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python code_agent.py . --open
```

将 `.` 换成任意本地代码库路径。macOS / Linux 用 `source .venv/bin/activate` 激活环境。

默认通过 [OpenCode Go](https://opencode.ai/docs/go/) 调用 `deepseek-v4.1-flash`，自动读取本机 OpenCode 的 `opencode-go` 登录配置；也可设置 `OPENCODE_API_KEY`。密钥不写进代码、图或日志。模型可用 `--model` 修改。

只建图，无需模型或 key：

```powershell
python code_agent.py . --graph --open
```

让 Agent 查代码：

```powershell
python code_agent.py . "建图，找出 CodeAgent 的调用关系"
```

输出在目标代码库的 `.code-graph/`：`graph.html` 是可旋转的球形函数图，支持文件筛选、搜索、缩放、关联高亮和 JSON 导出；「结构」可查看文件与类。`graph.json` 保存全部节点及关系。`--output` 可改输出目录；新增、修改、删除文件都会更新缓存，仅改 HTML 不重新解析源码。

图只包含真实文件、类、函数，以及可静态确定的包含、导入、调用、继承关系，不生成占位节点。Tree-sitter 支持 Python、JS/TS/TSX、Go、Rust、Java、C/C++、C#、Ruby、PHP、Kotlin、Swift、Scala。外部库和无法确定的动态调用不连线，JSON 的 `call_sites` / `linked_calls` 保留实际调用覆盖统计；列表和模型查询有显示上限，完整图数据不截断。

扫描遵循 Git 忽略规则；无 Git 的目录也支持嵌套 `.gitignore`。默认排除依赖、构建产物、符号链接及常见密钥文件。其他格式保留文件节点；超过 8 MB 的源码及解析错误会明确记录。静态图不能保证还原反射、运行时注入、所有模块别名或跨语言调用。

建图只做本地静态解析；Agent 模式会向 Go 发送任务和工具返回的必要上下文。读写限制在目标目录内，`run_python` 是本机执行器，应用于可信任务。

全界面统一使用 [Anthropic 官网](https://www.anthropic.com/) 的 Anthropic Serif；字体从官方页面使用的 CDN 加载，中文及离线环境由本机衬线字体补齐。图本身无需联网。

参考 [GitNexus](https://github.com/abhigyanpatwari/GitNexus) 的 AST 与符号表、[Understand Anything](https://github.com/Egonex-AI/Understand-Anything) 的分组与邻域聚焦，以及 [Obsidian](https://obsidian.md/help/plugins/graph) 的图谱交互；保留独立实现与单 Agent。
