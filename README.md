# Code Agent

在原 `code_agent.py` 上改的单一 ReAct Agent：保留读文件、写文件、运行 Python，新增建图和查图。三个实现文件，不用 Agent 框架。

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

输出在目标代码库的 `.code-graph/`：`graph.html` 可离线打开，支持搜索、缩放、邻接关系和 JSON 导出；`graph.json` 保存整张图。`--output` 可改输出目录。未变化的代码复用缓存，新增、修改、删除文件都会更新。

图包含文件、目录、类、函数，以及包含、导入、调用、继承关系。Tree-sitter 提取 Python、JS/TS/TSX、Go、Rust、Java、C/C++、C#、Ruby、PHP、Kotlin、Swift、Scala 的语法结构；按作用域及导入解析能确定的引用，同名或动态引用保留为未解析节点。列表和模型查询有显示上限，完整数据保存在 JSON 中。

扫描遵循 Git 忽略规则；无 Git 的目录也支持嵌套 `.gitignore`。默认排除依赖、构建产物、符号链接及常见密钥文件。其他格式保留文件节点；超过 8 MB 的源码及解析错误会明确记录。静态图不能保证还原反射、运行时注入、所有模块别名或跨语言调用。

建图只做本地静态解析；Agent 模式会向 Go 发送任务和工具返回的必要上下文。读写限制在目标目录内，`run_python` 是本机执行器，应用于可信任务。

参考 [GitNexus](https://github.com/abhigyanpatwari/GitNexus) 的 AST、符号表和关系图思路；建图与展示独立实现。
