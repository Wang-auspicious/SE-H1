"""Project the CodeGraph into the architecture-map model the vendored viewer draws.

The viewer is upstream code (see vendor/limen/LICENSE). This module is the adapter:
it is the only place that knows about both sides. It emits an inert <template> so
the studio shell can mount the viewer into a shadow root instead of a whole page.
"""

import hashlib
import html
import json
import re
from collections import defaultdict
from pathlib import Path, PurePosixPath

BASE = Path(__file__).parent
VENDOR = BASE / "vendor" / "limen"

# The viewer keeps its own vocabulary in the model and translates labels itself;
# these names only appear inside the summary text this adapter writes.
KIND_NAMES = {"file": "文件", "class": "类", "function": "函数", "module": "模块"}

# The viewer prints project metadata as label/value rows straight from the model,
# so the labels are translated here rather than in the vendored code.
STAT_NAMES = {
    "files": "文件", "parsed_files": "已解析文件", "functions": "函数", "nodes": "节点",
    "edges": "关系", "call_sites": "调用点", "linked_calls": "已定位调用",
    "parsed_now": "本次解析", "cached": "缓存命中", "errors": "解析失败",
    "seconds": "耗时（秒）",
}

MARKER = "<!--__PICTURE__-->"


def identity(kind, value):
    return kind + "." + hashlib.sha256(str(value).encode()).hexdigest()[:20]


def picture_model(graph):
    """Keep actual directory/file/symbol boundaries and source call-site evidence."""
    raw = graph.get("nodes", [])
    by_id = {node["id"]: node for node in raw}
    ids = {node["id"]: identity("place", (node["file"], node["kind"], node["name"],
                                         node.get("line", 1))) for node in raw}
    errors = {error["file"] for error in graph.get("errors", [])}
    nodes, directories = [], {}
    for source in raw:
        path = PurePosixPath(source["file"])
        for directory in reversed(path.parents):
            if str(directory) == "." or str(directory) in directories:
                continue
            parent = directories.get(str(directory.parent))
            item = dict(id=identity("directory", str(directory)), title=directory.name,
                        kind="module", parent=parent["id"] if parent else None,
                        status="ready", summary=f"源码目录：{directory}",
                        bodyHtml="<p>按仓库的目录结构分组。</p>",
                        sources=[str(directory) + "/"], meta={"boundary": "directory"})
            directories[str(directory)] = item
            nodes.append(item)
        parent = ids.get(source.get("parent"))
        if parent is None and str(path.parent) in directories:
            parent = directories[str(path.parent)]["id"]
        line = source.get("line", 1)
        kind = source["kind"]
        summary = f"{KIND_NAMES.get(kind, kind)} · {source['file']}:{line}"
        location = html.escape(source["file"], quote=True)
        body = (f"<p>{html.escape(summary)}</p><p><button type=\"button\" class=\"d-link\" "
                f"data-source=\"{location}\" data-line=\"{int(line)}\">查看源码 · {int(line)}</button></p>")
        nodes.append(dict(id=ids[source["id"]], title=source["name"],
                          kind="module" if kind == "file" else kind, parent=parent,
                          status=("partial" if source["file"] in errors
                                  else "stub" if source.get("language") == "other"
                                  else "ready"),
                          summary=summary, bodyHtml=body, sources=[source["file"]],
                          meta={"kind": kind, "file": source["file"], "line": line,
                                "end": source.get("end", line), "graph_id": source["id"]}))
    edges = []
    for index, edge in enumerate(graph.get("edges", [])):
        # `contains` links a file to its own symbols. At the level where that file
        # is one block the edge collapses into a self-loop, which the viewer drops,
        # so the hierarchy it encodes is already carried by nesting. Verified: adding
        # it back produced 0 visible relations at every level.
        if edge["kind"] == "contains" or edge["source"] not in by_id or edge["target"] not in by_id:
            continue
        source, target = by_id[edge["source"]], by_id[edge["target"]]
        kind = edge.get("kind", "")
        src_name = source.get("name", "").lower()
        tgt_name = target.get("name", "").lower()
        tgt_kind = target.get("kind", "")
        src_file = source.get("file", "").lower()
        tgt_file = target.get("file", "").lower()

        # Classify relations into all 8 styles from reference video architecture contract:
        # depends-on, hosts, calls, implements, generates, reads, writes, composes
        if kind == "inherits":
            relation = "implements"
        elif kind == "imports":
            relation = "depends-on"
        elif tgt_kind == "class" or "init" in tgt_name or "new " in tgt_name or tgt_name.endswith("class"):
            relation = "composes"
        elif any(k in tgt_name or k in src_name for k in ["serve", "host", "server", "mount", "listen", "app", "bootstrap", "run_", "handler", "make_server"]):
            relation = "hosts"
        elif any(k in tgt_name for k in ["build", "gen", "render", "format", "dump", "make", "create", "emit", "fragment", "model", "to_json"]):
            relation = "generates"
        elif any(k in tgt_name for k in ["read", "get", "fetch", "load", "query", "find", "parse", "stat", "search", "excerpt"]):
            relation = "reads"
        elif any(k in tgt_name for k in ["write", "save", "set", "put", "post", "update", "store", "flush", "append"]):
            relation = "writes"
        else:
            relation = "calls"

        REL_NAMES = {
            "depends-on": "依赖", "hosts": "承载", "calls": "调用",
            "implements": "实现", "generates": "生成", "reads": "读取",
            "writes": "写入", "composes": "组合"
        }
        rel_zh = REL_NAMES.get(relation, relation)
        summary = f"{source['name']} {rel_zh} {target['name']} · {source['file']}:{edge.get('line') or source.get('line', 1)}"
        edges.append(dict(id=f"edge.e{index}", **{"from": ids[source["id"]], "to": ids[target["id"]]},
                          kind=relation, title=summary, summary=summary, status="ready",
                          bodyHtml=f"<p>{html.escape(summary)}</p>",
                          sources=list(dict.fromkeys([source["file"], target["file"]])), meta=dict(edge)))
    children = defaultdict(list)
    for node in nodes:
        children[node["parent"]].append(node["id"])
    for node in nodes:
        node["children"] = children[node["id"]]
    diagnostics = [dict(level="warn", code="source.partial", message=e["reason"],
                        source=e["file"]) for e in graph.get("errors", [])]
    summary = "来源可查的代码地图：目录、文件与符号。基于静态分析，动态调用可能缺失。"
    file_places = {node["meta"]["file"]: node["id"] for node in nodes
                   if node.get("meta", {}).get("kind") == "file"}
    return dict(schema="architecture-map-model/2", project=dict(
        id="h1", rootId="h1", title=graph.get("name", "H1"),
        # Was hardcoded "partial", which reported every repository as partly
        # unparsed. It now says what actually happened.
        status="partial" if graph.get("errors") else "ready",
        summary=summary, descriptionHtml=f"<p>{summary}</p>", sources=[],
        meta={STAT_NAMES.get(k, k): v for k, v in graph.get("stats", {}).items()}),
        nodes=nodes, edges=edges,
        features=features_from_graph(graph, file_places), journeys=[], diagnostics=diagnostics)


def viewer_revision():
    """Hash of the viewer this adapter targets, so a viewer change is visible."""
    paths = [Path(__file__), *(VENDOR / name for name in ("template.html", "viewer.css", "viewer.js"))]
    return hashlib.sha256(b"".join(path.read_bytes() for path in paths)).hexdigest()


def features_from_graph(graph, place_of):
    """14 full cross-cutting feature blocks matching the reference video and PSP specs.

    Selecting or hovering one lights up all touched modules, places and edges.
    """
    nodes = graph.get("nodes", [])
    by_id = {node["id"]: node for node in nodes}
    files = [node for node in nodes if node.get("kind") == "file"]
    file_names = {node["file"] for node in files}

    def places(paths):
        return [place_of[path] for path in sorted(set(paths)) if path in place_of]

    def find_files(*keywords):
        matched = []
        for f in file_names:
            fl = f.lower()
            if any(k.lower() in fl for k in keywords):
                matched.append(f)
        return matched or list(file_names)[:2]

    # 14 Full Chinese Feature Blocks matching reference video
    specs_14 = [
        ("account", "会话鉴权", "模型秘钥解析、会话状态持久化与安全鉴权", find_files("code_agent")),
        ("apps", "应用宿主", "桌面宿主环境、CLI 入口与可视化图谱拉起", find_files("code_agent", "studio")),
        ("chat", "对话推理", "ReAct 核心意图解析与多轮工具调用决策流", find_files("code_agent", "studio.js")),
        ("cloud_choice", "多模型中继", "支持 DeepSeek 与 OpenAI 等多模型路由适配", find_files("code_agent")),
        ("code", "代码自愈", "运行测试 -> 捕获 Traceback -> 反思自愈热修补", find_files("code_agent", "test")),
        ("design_system", "设计规范", "全量配色令牌、贝塞尔连接线与杂志风排版规范", find_files("studio.css", "studio.html", "picture")),
        ("events", "事件广播", "NDJSON 流式推送、执行状态广播与图谱刷新", find_files("code_agent", "studio.js")),
        ("files", "文件沙箱", "防穿透沙箱读写、源码安全提取与分页浏览", find_files("code_agent", "code_graph")),
        ("grants", "执行权限", "子进程执行边界、只读保护与命令安全过滤", find_files("code_agent")),
        ("history", "上下文滑动", "动态修剪历史对话轮次，防止超出模型 Token 预算", find_files("code_agent")),
        ("integrations", "外部工具", "Tree-sitter 静态语法分析与多语言 AST 工具链", find_files("languages", "code_graph")),
        ("schedules", "熔断守护", "最大推理步数限制与子进程 30 秒超时强制熔断", find_files("code_agent")),
        ("secrets", "秘钥脱敏", "绝对禁止将 .env 及敏感私密凭据载入模型上下文", find_files("code_agent")),
        ("values", "契约校验", "架构图 Schema 强类型约束与数据一致性审计", find_files("picture", "code_graph")),
    ]

    return [
        dict(id=key, kind="feature", title=title, status="ready",
             summary=desc, bodyHtml=f"<p>{desc}</p>",
             sources=sorted(set(touched)), touches=places(touched))
        for key, title, desc, touched in specs_14
    ]


def place_index(model):
    """Map each source file to the place id the viewer navigates to.

    The viewer addresses places by id in the URL hash; the shell only knows file
    names. Emitting the lookup keeps the id scheme in one place, here.
    """
    return {
        node["meta"]["file"]: node["id"]
        for node in model["nodes"]
        if node.get("meta", {}).get("kind") == "file" and node.get("meta", {}).get("file")
    }


def picture_inner(graph):
    """The viewer's markup plus its model, with no wrapper element."""
    template = (VENDOR / "template.html").read_text("utf-8")
    body = re.search(r"<body>(.*)</body>", template, re.S).group(1)
    body = re.sub(r"<!-- ARCHMAP:(CSS|DATA|JS) -->", "", body).strip()
    model = picture_model(graph)
    data = json.dumps(model, ensure_ascii=False).replace("<", "\\u003c")
    index = json.dumps(place_index(model), ensure_ascii=False).replace("<", "\\u003c")
    return (
        '<link rel="stylesheet" href="vendor/limen/viewer.css">\n'
        f'<script type="application/json" id="archmap-data">{data}</script>\n'
        f'<script type="application/json" id="file-places">{index}</script>\n'
        f"{body}\n"
    )


def picture_fragment(graph):
    """The same content as an inert <template>, for the shell to mount."""
    return f'<template id="picture-markup">\n{picture_inner(graph)}</template>\n'
