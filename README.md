# Code Agent

在原 `code_agent.py` 上改的单一 ReAct Agent：保留读文件、写文件、运行 Python，新增建图和查图。`code_graph.py` 负责图，`languages.py` 独立管理语言规则和语法提取，`graph_view.html` 负责展示。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python code_agent.py
```

默认启动本地可视化服务并打开浏览器。在页面顶部输入框中填入任意 GitHub 仓库的 `.git` 链接或本地文件夹路径，点击「构建」即可自动在本地拉取、解析并渲染星系图谱。

也可指定本地代码库或结合 Agent 使用：

```powershell
python code_agent.py D:\my-repo           # 打开指定目录
python code_agent.py . --graph --open     # 仅本地静态建图，不启服务
python code_agent.py . "找出 CodeAgent 的调用关系"  # 调用 Agent 查代码
```

输出在目标代码库的 `.code-graph/`：`graph.html` 是轻量至极的 Obsidian 风格 2D 代码关系图谱，去除了冗余侧边栏，全屏沉浸；支持函数/节点筛选、实时搜索定位、缩放平移、调用链邻域聚焦与 JSON 导出。`graph.json` 保存全部节点及关系。`--output` 可改输出目录；新增、修改、删除文件都会更新缓存，仅改 HTML 不重新解析源码。

图只包含真实文件、类、函数，以及可静态确定的包含、导入、调用、继承关系，不生成占位节点。Tree-sitter 支持 Python、JS/TS/TSX、Go、Rust、Java、C/C++、C#、Ruby、PHP、Kotlin、Swift、Scala。外部库和无法确定的动态调用不连线，JSON 的 `call_sites` / `linked_calls` 保留实际调用覆盖统计；列表和模型查询有显示上限，完整图数据不截断。

全界面统一使用 Anthropic Serif 衬线字体，保持优雅、克制、清晰的学术与工具美感。
