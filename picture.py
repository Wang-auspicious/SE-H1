"""Project CodeGraph evidence into Limen's offline architecture-map viewer."""

import hashlib
import html
import json
import re
from collections import defaultdict
from pathlib import Path, PurePosixPath

BASE = Path(__file__).parent
VENDOR = BASE / "vendor" / "limen"


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
                        status="partial", summary=f"Source directory: {directory}",
                        bodyHtml="<p>Grouped by the repository's directory structure.</p>",
                        sources=[str(directory) + "/"], meta={"boundary": "directory"})
            directories[str(directory)] = item
            nodes.append(item)
        parent = ids.get(source.get("parent"))
        if parent is None and str(path.parent) in directories:
            parent = directories[str(path.parent)]["id"]
        line = source.get("line", 1)
        kind = source["kind"]
        summary = f"{kind} · {source['file']}:{line}"
        location = html.escape(source["file"], quote=True)
        body = (f"<p>{html.escape(summary)}</p><p><button type=\"button\" class=\"d-link\" "
                f"data-source=\"{location}\" data-line=\"{int(line)}\">查看源码 · {int(line)}</button></p>")
        nodes.append(dict(id=ids[source["id"]], title=source["name"],
                          kind="module" if kind == "file" else kind, parent=parent,
                          status="partial" if source["file"] in errors or source.get("language") == "other" else "ready",
                          summary=summary, bodyHtml=body, sources=[source["file"]],
                          meta={"kind": kind, "file": source["file"], "line": line,
                                "end": source.get("end", line), "graph_id": source["id"]}))
    edges = []
    for index, edge in enumerate(graph.get("edges", [])):
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
    summary = "Source-backed map · directories, files and symbols. Static analysis; dynamic calls may be missing."
    return dict(schema="architecture-map-model/2", project=dict(
        id="h1", rootId="h1", title=graph.get("name", "H1"), status="partial",
        summary=summary, descriptionHtml=f"<p>{summary}</p>", sources=[],
        meta=graph.get("stats", {})), nodes=nodes, edges=edges,
        features=[], journeys=[], diagnostics=diagnostics)


def viewer_revision():
    paths = [Path(__file__), BASE / "picture_ui.js", BASE / "picture_ui.css",
             *(VENDOR / name for name in ("template.html", "viewer.css", "viewer.js"))]
    return hashlib.sha256(b"".join(path.read_bytes() for path in paths)).hexdigest()


def render_picture(graph, live=False):
    """Inline the original viewer so exported HTML also works without a server."""
    template = (VENDOR / "template.html").read_text("utf-8")
    css = (VENDOR / "viewer.css").read_text("utf-8") + (BASE / "picture_ui.css").read_text("utf-8")
    script = (VENDOR / "viewer.js").read_text("utf-8") + (BASE / "picture_ui.js").read_text("utf-8")
    model = json.dumps(picture_model(graph), ensure_ascii=False).replace("<", "\\u003c")
    template = template.replace('<body>', f'<body data-live="{str(live).lower()}">')
    template = template.replace('<span>Picture<small>Project atlas</small></span>',
                                '<span>H1<small>Code atlas · Limen Picture</small></span>')
    template = template.replace('</header>', '<button type="button" id="h1-fit" class="tbtn" aria-pressed="true">Fit</button>'
                                '<button type="button" id="h1-tools" class="tbtn">审查 / 工具</button></header>')
    template = template.replace('A local picture. Feature state lives in the spec.',
                                'Limen Picture · MIT © 2026 Adam Gospodarczyk · H1 source adapter')
    template = template.replace('</main>', '</main><dialog id="h1-dialog" aria-labelledby="h1-dialog-title">'
        '<div class="h1-dialog-head"><h2 id="h1-dialog-title">H1</h2>'
        '<button type="button" class="tbtn" id="h1-close">关闭</button></div><div id="h1-content"></div></dialog>')
    parts = {"CSS": f"<style>{css}</style>",
             "DATA": f'<script type="application/json" id="archmap-data">{model}</script>',
             "JS": "<script>" + script.replace("</script", "<\\/script") + "</script>"}
    return re.sub(r"<!-- ARCHMAP:(CSS|DATA|JS) -->", lambda match: parts[match[1]], template)
