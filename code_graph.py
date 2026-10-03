import hashlib
import json
import os
import posixpath
import re
import subprocess
import time
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from pathspec import GitIgnoreSpec
import languages
from languages import LANGUAGES, EXCLUDED, parse_file


TEMPLATE_NAME = "agent_visualizer.html"
SCRIPT_NAME = "atlas_graph.js"


def excluded(path):
    return bool(set(path.parts) & EXCLUDED) or path.name.startswith(".env") or path.name in {"auth.json", "credentials.json"} or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}


def source_files(root, output):
    try:
        result = subprocess.run(["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        result = None
    paths, pending = [], [(root, [])]
    if result is not None and result.returncode == 0:
        paths, pending = [root / os.fsdecode(p) for p in result.stdout.split(b"\0") if p], []
    while pending:
        directory, rules = pending.pop()
        ignore = directory / ".gitignore"
        if ignore.is_file():
            rules = rules + [(directory, GitIgnoreSpec.from_lines(ignore.read_text(errors="replace").splitlines()))]
        for path in directory.iterdir():
            if path.is_symlink() or excluded(path.relative_to(root)) or path.is_relative_to(output):
                continue
            matches = [spec.check_file(path.relative_to(base).as_posix() + ("/" if path.is_dir() else "")).include for base, spec in rules]
            if not next((match for match in reversed(matches) if match is not None), False):
                pending.append((path, rules)) if path.is_dir() else paths.append(path)
    return sorted({p for p in paths if p.is_file() and not p.is_symlink() and not excluded(p.relative_to(root))
                   and p.resolve().is_relative_to(root) and not p.resolve().is_relative_to(output)})


class CodeGraph:
    def __init__(self, root=".", output=None):
        self.root = Path(root).resolve()
        self.output = Path(output).resolve() if output else self.root / ".code-graph"
        if not self.root.is_dir() or self.root.is_relative_to(self.output):
            raise ValueError("Choose an existing repository and a separate output directory.")
        self.graph = None

    def build(self):
        start = time.perf_counter()
        template_path = Path(__file__).with_name(TEMPLATE_NAME)
        template = template_path.read_text("utf-8")
        script_path = template_path.with_name(SCRIPT_NAME)
        atlas_script = script_path.read_text("utf-8") if script_path.is_file() else ""
        revision = hashlib.sha256(
            Path(__file__).read_bytes()
            + Path(languages.__file__).read_bytes()
            + template.encode()
            + atlas_script.encode()
        ).hexdigest()
        view = hashlib.sha256((template + atlas_script).encode()).hexdigest()
        cache_path = self.output / "cache.json"
        try:
            saved = json.loads(cache_path.read_text("utf-8"))
            saved = saved if saved.get("revision") == revision and saved.get("root") == str(self.root) else {}
        except (OSError, ValueError):
            saved = {}
        nodes, edges, fresh, errors = {}, {}, {}, []
        parsed = reused = call_sites = linked_calls = 0
        for path in source_files(self.root, self.output):
            name, lang = path.relative_to(self.root).as_posix(), LANGUAGES.get(path.suffix.lower().lstrip("."))
            nodes[name] = dict(id=name, name=path.name, kind="file", file=name, line=1, language=lang or "other")
            if not lang:
                continue
            try:
                if path.stat().st_size > 8_000_000:
                    raise ValueError("Source exceeds 8 MB")
                data = path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                previous = saved.get("files", {}).get(name, {})
                hit = previous.get("hash") == digest
                fact = previous["facts"] if hit else parse_file(name, data, lang)
                reused, parsed = reused + hit, parsed + (not hit)
                fresh[name] = dict(hash=digest, facts=fact)
                nodes.update((s["id"], dict(s)) for s in fact["symbols"])
                if fact["partial"]:
                    errors.append(dict(file=name, reason="Syntax errors; valid syntax retained"))
            except (OSError, ValueError, LookupError, RuntimeError) as error:
                errors.append(dict(file=name, reason=str(error)))
        manifest = [n["file"] for n in nodes.values() if n["kind"] == "file"]
        if not parsed and saved.get("view") == view and fresh.keys() == saved.get("files", {}).keys() and manifest == saved.get("manifest") and (self.output / "graph.html").exists() and (self.output / SCRIPT_NAME).exists():
            try:
                self.graph = json.loads((self.output / "graph.json").read_text("utf-8"))
                self.graph["stats"].update(parsed_now=0, cached=reused, seconds=round(time.perf_counter() - start, 3))
                return self.summary()
            except (OSError, ValueError, KeyError):
                pass
        modules, definitions, aliases, bindings = defaultdict(set), defaultdict(list), defaultdict(list), {}
        def edge(source, target, kind, line=0, column=0):
            edges[source, target, kind, line, column] = dict(source=source, target=target, kind=kind, line=line, column=column)
        for path, cached in fresh.items():
            fact, stem = cached["facts"], path.rsplit(".", 1)[0]
            for variant in {stem, re.sub(r"/(?:__init__|index)$", "", stem)}:
                parts = variant.split("/")
                for i in range(len(parts)):
                    modules["/".join(parts[i:])].add(path)
            bindings.update((scope, set(names)) for scope, names in fact["bindings"].items())
            for symbol in fact["symbols"]:
                name = symbol.get("owner", "") + "." + symbol["name"] if symbol.get("owner") and symbol["parent"] == path else symbol["name"]
                definitions[symbol["parent"], name].append(symbol["id"])
                edge(symbol["parent"], symbol["id"], "contains")
            for scope, module, name, alias in fact["imports"]:
                aliases[scope, alias].append((module, name))
        @lru_cache(maxsize=None)
        def module_files(module, path):
            if nodes[path]["language"] == "python":
                dots = len(module) - len(module.lstrip("."))
                tail = module[dots:].replace(".", "/")
                module = posixpath.normpath(posixpath.join(posixpath.dirname(path), *([".."] * (dots - 1)), tail)) if dots else tail
            elif module.startswith("."):
                module = posixpath.normpath(posixpath.join(posixpath.dirname(path), module))
            elif nodes[path]["language"] in {"rust", "java"}:
                module = module.replace("::", "/").replace(".", "/").replace("crate/", "src/", 1)
            module = module.rsplit(".", 1)[0] if module.rsplit(".", 1)[-1] in LANGUAGES else module
            direct = {f for ext in LANGUAGES for f in (module + "." + ext, module + "/__init__." + ext, module + "/index." + ext) if f in fresh}
            found = direct or modules.get(module, set())
            return sorted(found) if len(found) == 1 else []
        def resolve(path, scope, name):
            first, *rest = re.split(r"\?\.|->|::|\.", name)
            current, candidates = scope, []
            if first in {"self", "this", "cls", "$this", "Self"} or first == nodes[scope].get("receiver"):
                while current != path and nodes[current]["kind"] != "class":
                    current = nodes[current]["parent"]
                candidates = [current] if current != path else []
            else:
                while True:
                    if current != scope and nodes[current]["kind"] == "class" and nodes[path]["language"] in {"python", "javascript", "typescript", "tsx"}:
                        current = nodes[current]["parent"]
                        continue
                    if first in bindings.get(current, ()):
                        return None
                    candidates, imported = list(definitions.get((current, first), [])), aliases.get((current, first), [])
                    if candidates or imported:
                        for module, symbol_name in imported:
                            for target in module_files(module, path):
                                candidates.extend([s["id"] for s in fresh[target]["facts"]["symbols"] if s.get("default")] if symbol_name == "default" else definitions.get((target, symbol_name), []) if symbol_name else [target])
                            if not candidates and symbol_name and nodes[path]["language"] == "python":
                                candidates = module_files(module + ("" if module.endswith(".") else ".") + symbol_name, path)
                        break
                    if current == path:
                        break
                    current = nodes[current]["parent"]
            for part in rest:
                candidates = [child for candidate in candidates for child in definitions.get((candidate, part), [])]
            return next(iter(set(candidates))) if len(set(candidates)) == 1 else None
        for path, cached in fresh.items():
            for scope, module, name, alias in cached["facts"]["imports"]:
                for target in module_files(module, path):
                    edge(scope, target, "imports")
            for scope, name, kind, line, column in cached["facts"]["refs"]:
                call_sites += kind == "calls"
                target = resolve(path, scope, name)
                if target is not None:
                    linked_calls += kind == "calls"
                    edge(scope, target, kind, line, column)
        ids = {key: index for index, key in enumerate(nodes)}
        for node in nodes.values():
            node["id"] = ids[node["id"]]
            if "parent" in node:
                node["parent"] = ids[node["parent"]]
            for key in ("default", "owner", "receiver"):
                node.pop(key, None)
        for item in edges.values():
            item.update(source=ids[item["source"]], target=ids[item["target"]])
        stats = dict(files=len(manifest), parsed_files=len(fresh), functions=sum(n["kind"] == "function" for n in nodes.values()),
                     nodes=len(nodes), edges=len(edges), call_sites=call_sites, linked_calls=linked_calls, parsed_now=parsed, cached=reused, errors=len(errors), seconds=round(time.perf_counter() - start, 3))
        self.graph = dict(name=self.root.name, stats=stats, nodes=list(nodes.values()), edges=list(edges.values()), errors=errors)
        self.output.mkdir(parents=True, exist_ok=True)
        for name, value in (("graph.json", self.graph), ("cache.json", dict(revision=revision, view=view, root=str(self.root), manifest=manifest, files=fresh))):
            (self.output / name).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), "utf-8")
        payload = json.dumps(self.graph, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        body = template.replace("__GRAPH_DATA__", payload).replace("__ATLAS_GRAPH_SCRIPT__", "")
        (self.output / SCRIPT_NAME).write_text(atlas_script, "utf-8")
        (self.output / "graph.html").write_text(body, "utf-8")
        return self.summary()

    def summary(self):
        return {**self.graph["stats"], "html": str(self.output / "graph.html"), "json": str(self.output / "graph.json"), "warnings": self.graph["errors"][:10]}

    def query(self, query, limit=12):
        if self.graph is None:
            self.build()
        matches = [n for n in self.graph["nodes"] if query.casefold() in (n["file"] + " " + n["name"]).casefold()]
        matches.sort(key=lambda n: (n["name"] != query, n["id"]))
        chosen = matches[:max(1, min(int(limit), 30))]
        selected = {n["id"] for n in chosen}
        edges = [e for e in self.graph["edges"] if e["source"] in selected or e["target"] in selected]
        neighbors = {e[k] for e in edges[:120] for k in ("source", "target")} - selected
        return dict(matches=chosen, total_matches=len(matches), edges=edges[:120], total_edges=len(edges),
                    neighbors=[n for n in self.graph["nodes"] if n["id"] in neighbors], truncated=len(chosen) < len(matches) or len(edges) > 120)
