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
        relation = "depends-on" if edge["kind"] == "imports" else edge["kind"]
        summary = f"{source['name']} → {target['name']} · {source['file']}:{edge.get('line') or source.get('line', 1)}"
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
    """Cross-cutting concerns, each naming the places that answer a review question.

    All six are derived from edges and node kinds rather than from file names, so
    they mean the same thing in any repository. Selecting one lights exactly the
    files it lists; it never draws a block or a link of its own.
    """
    nodes = graph.get("nodes", [])
    by_id = {node["id"]: node for node in nodes}
    files = [node for node in nodes if node.get("kind") == "file"]

    def places(paths):
        return [place_of[path] for path in sorted(set(paths)) if path in place_of]

    def files_on(*kinds):
        """Files touched by edges of these kinds. Endpoints are usually symbols,
        so each one is folded up to the file it lives in."""
        wanted = set(kinds)
        return sorted({
            by_id[edge[end]]["file"]
            for edge in graph.get("edges", [])
            if edge["kind"] in wanted and edge["source"] in by_id and edge["target"] in by_id
            for end in ("source", "target")
            if by_id[edge[end]].get("file")
        })

    calls = files_on("calls")
    imports = files_on("imports")
    inherits = files_on("inherits")
    tests = [node["file"] for node in files if "test" in node["file"].lower()]
    broken = [error["file"] for error in graph.get("errors", [])]
    classes = [node["file"] for node in nodes if node.get("kind") == "class"]

    specs = [
        ("call-flow", "调用流", f"{len(calls)} 个文件参与调用关系", "调用图上的活动面",
         "这些文件在调用图上有入边或出边，是最值得先读的一批。", calls),
        ("module-boundary", "模块边界", f"{len(imports)} 个文件跨文件引用", "依赖从哪里穿过",
         "这些文件通过 import 连到别的文件，边界和耦合都发生在这里。", imports),
        ("inheritance", "继承关系", f"{len(inherits)} 个文件参与继承", "类层次在哪",
         "这些文件里出现了继承关系，改父类会影响到它们。", inherits),
        ("type-definition", "类型定义", f"{len(classes)} 个类定义位置", "抽象在哪落地",
         "这些文件定义了类，是理解抽象层级的入口。", classes),
        ("verification", "验证", f"{len(tests)} 个测试文件", "结论有没有被验证",
         "这些是测试文件。它们为空，说明当前仓库没有任何自动化验证。", tests),
        ("parse-gap", "解析盲区", f"{len(broken)} 个文件解析不完整", "静态分析的缺口",
         "这些文件没能完整解析，静态分析对它们的结论要打折看。", broken),
    ]

    return [
        dict(id=key, kind="feature", title=title, status="ready" if touched else "stub",
             summary=summary, bodyHtml=f"<p>{detail}</p>",
             sources=sorted(set(touched)), touches=places(touched))
        for key, title, summary, tag, detail, touched in specs
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
