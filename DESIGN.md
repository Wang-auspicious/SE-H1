# CodeAgent 设计说明

## 目标

Homework 1 要求一个能工作的代码助手：接收任务、调用工具并返回结果。本实现把本地代码解析成文件、符号和调用关系，再让 agent 在这个受限邻域内选择读取、写入、执行或查询操作。展示页的作用是让这些真实关系可检查，而不是生成一套与 checkout 脱节的演示数据。

## 架构

```mermaid
flowchart LR
  U[任务] --> A[CodeAgent.run]
  A --> T[本地工具]
  T --> G[CodeGraph]
  G --> J[graph.json]
  J --> V[/agent]
  V --> S[/api/source]
```

`code_agent.py` 负责模型循环、工具契约和 HTTP 服务；`code_graph.py` 负责增量解析、关系解析、缓存和 HTML 构建；`languages.py` 提供语言提取规则；`agent_visualizer.html` 与 `atlas_graph.js` 负责浏览器中的图布局和交互。服务从模块文件位置解析模板，因此不依赖启动时的工作目录。

## 图谱生命周期

1. 服务启动时对当前仓库运行一次 `CodeGraph.build()`。
2. `/api/graph` 返回当前内存图谱，展示页直接读取它，不需要先发送构建请求。
3. `POST /api/build` 才会切换分析目标或刷新图谱；成功后替换当前图谱，失败时保留错误并返回 HTTP 400。
4. `--graph` 使用同一份 `agent_visualizer.html` 模板，把 `__GRAPH_DATA__` 替换后写入 `.code-graph/graph.html`，并把 `atlas_graph.js` 复制到同一目录，保证离线输出与在线页面使用相同渲染逻辑。

## 工具边界

| 工具 | 输入 | 约束 |
| --- | --- | --- |
| `build_graph` | 仓库根目录 | 忽略 `.git`、构建产物、虚拟环境和敏感文件 |
| `query_graph` | 查询词、数量上限 | 最多返回 30 个匹配和 120 条关系 |
| `read_file` | 相对路径、起止行 | 单次最多 200 行，路径必须在仓库内 |
| `write_file` | 相对路径、完整文本 | 禁止越界和凭证文件 |
| `run_python` | 文件名或短代码 | 独立子进程，30 秒超时并截断输出 |

`GET /api/source` 只接受图谱中登记过的文件名，返回从指定行开始的最多 120 行。路径会解析并再次检查仓库边界；`.env`、认证 JSON、私钥和指向仓库外的 symlink 都拒绝读取。

## 关系与交互

节点代表真实文件或符号，边保留 `imports`、`calls`、`contains` 等解析得到的语义及调用位置。未能唯一解析的动态调用会被省略并计入统计信息。页面悬停节点时只突出直接相邻关系，点击模块进入该模块的局部邻域，`Esc` 返回全景；源码入口通过 `/api/source` 打开对应文件片段。

图谱的连线、箭头、节点卡片和横切 feature 都由 SVG/CSS 绘制，页面没有录屏覆盖层、远程图片或字体依赖。动效只服务于状态切换和关系聚焦，减少动效设置时仍可完成导航。

## 课程要求对应关系

| 要求 | 实现 |
| --- | --- |
| 输入 → 推理 → 工具 → 输出 | `CodeAgent.run()` 消息循环 |
| 至少一种工具 | 读取、写入、执行、构图和关系查询 |
| 记忆与上下文 | 消息列表 + 图谱邻域查询 |
| 错误处理与重试 | 工具错误作为观察回流，步数和超时双重停止 |
| 可维护性 | Agent、图谱、语言规则和展示层分离 |

## 验证

```powershell
python -m py_compile code_agent.py code_graph.py languages.py
python code_agent.py . --graph
```

构图后应生成 `.code-graph/graph.json` 和 `.code-graph/graph.html`；服务应能从 `/api/graph` 返回同一图谱，从 `/api/source` 返回受限源码片段。没有模型 key 时也可以完成上述本地验证。

## 已知边界

静态解析无法覆盖所有动态调用，未知关系会被省略。`run_python` 是超时受限的本地子进程，不等同于操作系统级沙箱；处理不可信仓库时仍应使用专用隔离环境。
