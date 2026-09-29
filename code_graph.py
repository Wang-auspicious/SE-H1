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
from tree_sitter_language_pack import get_parser


LANGUAGES = {ext: lang for lang, extensions in {
    "python": "py pyw pyi", "javascript": "js jsx mjs cjs", "typescript": "ts mts cts",
    "tsx": "tsx", "go": "go", "rust": "rs", "java": "java", "c": "c",
    "cpp": "cc cpp cxx h hpp hxx", "csharp": "cs", "ruby": "rb",
    "php": "php", "kotlin": "kt kts", "swift": "swift", "scala": "scala sc",
}.items() for ext in extensions.split()}
EXCLUDED = {".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
            ".code-graph", "dist", "build", "target", ".next", "vendor"}
FUNCTIONS = set("function_definition function_declaration function_item method_definition "
                "method_declaration constructor_declaration method singleton_method "
                "function_signature local_function_statement".split())
CLASSES = set("class_definition class_declaration class_specifier struct_specifier struct_item "
              "struct_declaration interface_declaration trait_item enum_item enum_declaration "
              "record_declaration object_declaration type_spec class".split())
CALLS = set("call call_expression invocation_expression method_invocation "
            "method_call_expression member_call_expression scoped_call_expression object_creation_expression new_expression".split())
IMPORTS = set("import_statement import_from_statement import_declaration import_spec "
              "use_declaration using_directive preproc_include export_statement".split())


def excluded(path):
    return (bool(set(path.parts) & EXCLUDED) or path.name.startswith(".env")
            or path.name in {"auth.json", "credentials.json"}
            or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"})


def source_files(root, output):
    try:
        result = subprocess.run(["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
                                capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is not None and result.returncode == 0:
        paths = [root / os.fsdecode(p) for p in result.stdout.split(b"\0") if p]
    else:
        paths, pending = [], [(root, [])]
        while pending:
            directory, rules = pending.pop()
            ignore = directory / ".gitignore"
            if ignore.is_file():
                rules = rules + [(directory, GitIgnoreSpec.from_lines(ignore.read_text(errors="replace").splitlines()))]
            for path in directory.iterdir():
                if path.is_symlink() or excluded(path.relative_to(root)) or path.is_relative_to(output):
                    continue
                is_dir, ignored = path.is_dir(), False
                for base, spec in rules:
                    match = spec.check_file(path.relative_to(base).as_posix() + ("/" if is_dir else ""))
                    if match.include is not None:
                        ignored = match.include
                if not ignored:
                    if is_dir:
                        pending.append((path, rules))
                    else:
                        paths.append(path)
    return sorted({p for p in paths if p.is_file() and not p.is_symlink()
                   and p.resolve().is_relative_to(root) and not p.resolve().is_relative_to(output)
                   and not excluded(p.relative_to(root))})


def text(node):
    return node.text.decode("utf-8", errors="replace") if node else ""


def field(node, *names):
    return next((value for name in names if (value := node.child_by_field_name(name))), None)


def walk(node):
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.named_children))


def imports(node, scope, lang):
    module = text(field(node, "module_name", "source", "path")).strip("\"'<>")
    if lang == "python":
        if any(child.type == "wildcard_import" for child in node.named_children):
            yield {"scope": scope, "module": module, "name": "*", "alias": ""}
        for item in node.children_by_field_name("name"):
            name = text(field(item, "name") or item)
            alias = text(field(item, "alias"))
            yield {"scope": scope, "module": module or name, "name": name if module else "",
                   "alias": alias or (name if module else name.split(".")[0])}
    elif module:
        names = [n for n in walk(node) if n.type == "import_specifier"]
        for item in names:
            name = text(field(item, "name"))
            yield {"scope": scope, "module": module, "name": name,
                   "alias": text(field(item, "alias")) or name}
        clause = next((n for n in node.named_children if n.type == "import_clause"), None)
        for item in clause.named_children if clause else []:
            if item.type == "identifier":
                yield {"scope": scope, "module": module, "name": "default", "alias": text(item)}
            elif item.type == "namespace_import":
                yield {"scope": scope, "module": module, "name": "", "alias": text(item.named_children[-1])}
        yield {"scope": scope, "module": module, "name": "",
               "alias": (text(field(node, "name")) or module.rsplit("/", 1)[-1]) if lang == "go" else ""}
    elif node.type in {"use_declaration", "using_directive", "import_declaration"}:
        raw = re.sub(r"^(import|using|use)\s+(static\s+)?", "", text(node)).strip(" ;\n")
        if "{" not in raw and "\n" not in raw:
            parts = re.split(r"\s+as\s+", raw)
            yield {"scope": scope, "module": parts[0], "name": "",
                   "alias": parts[-1] if len(parts) > 1 else re.split(r"\.|::|/", parts[0])[-1]}


@lru_cache(maxsize=None)
def parser(lang):
    return get_parser(lang)


def parse_file(path, data, lang):
    tree = parser(lang).parse(data)
    facts = {"symbols": [], "imports": [], "refs": [], "bindings": {}, "partial": tree.root_node.has_error}
    stack = [(tree.root_node, path)]
    while stack:
        node, scope = stack.pop()
        kind = "class" if node.type in CLASSES else "function" if node.type in FUNCTIONS else ""
        value = field(node, "value")
        if node.type == "variable_declarator" and value and value.type in {"arrow_function", "function_expression"}:
            kind = "function"
        name_node = field(node, "name", "declarator") if kind else None
        if kind and name_node is None:
            name_node = next((n for n in node.named_children if n.type in {"simple_identifier", "type_identifier"}), None)
        while name_node and field(name_node, "declarator"):
            name_node = field(name_node, "declarator")
        if kind and name_node:
            name = text(name_node)
            symbol = {"id": f"{path}#{name}@{node.start_point.row + 1}:{node.start_point.column}",
                      "name": name, "kind": kind, "file": path, "line": node.start_point.row + 1,
                      "end": node.end_point.row + 1, "parent": scope,
                      "default": node.parent.type == "export_statement" and any(c.type == "default" for c in node.parent.children)}
            receiver = field(node, "receiver")
            if receiver:
                symbol["owner"] = next((text(n) for n in walk(receiver) if n.type == "type_identifier"), "")
                symbol["receiver"] = next((text(n) for n in walk(receiver) if n.type == "identifier"), "")
            ancestor = node.parent
            if lang == "rust" and ancestor and ancestor.parent and ancestor.parent.type == "impl_item":
                symbol["owner"] = text(field(ancestor.parent, "type")).split("<")[0]
            facts["symbols"].append(symbol)
            scope = symbol["id"]
            params = field(node, "parameters")
            if params:
                facts["bindings"][scope] = [text(p) for p in walk(params) if p.type == "identifier"]
            for base in node.named_children:
                if base.type in {"argument_list", "superclass", "super_interfaces", "class_heritage", "base_class_clause", "base_list"} and kind == "class":
                    for child in base.named_children:
                        if child.type != "access_specifier":
                            raw = re.sub(r"^(extends|implements|public|private|protected)\s+", "", text(child))
                            facts["refs"].append({"scope": scope, "name": raw, "kind": "inherits", "line": symbol["line"]})
        elif node.type in {"assignment", "variable_declarator", "short_var_declaration"}:
            target = field(node, "left", "name")
            if target:
                facts["bindings"].setdefault(scope, []).extend(text(n) for n in walk(target) if n.type == "identifier")
        if node.type in IMPORTS:
            facts["imports"].extend(imports(node, scope, lang))
        if node.type in CALLS:
            target = field(node, "function", "name", "method", "constructor", "type")
            if target is None and lang in {"kotlin", "swift"} and node.named_children:
                target = node.named_children[0]
            raw = text(target)
            receiver = field(node, "object", "receiver")
            if receiver:
                raw = text(receiver) + "." + raw
            if raw:
                facts["refs"].append({"scope": scope, "name": raw[:200], "kind": "calls", "line": node.start_point.row + 1, "column": node.start_point.column})
            if raw == "require":
                args = field(node, "arguments")
                if args and args.named_children and args.named_children[0].type == "string":
                    alias = text(field(node.parent, "name"))
                    facts["imports"].append({"scope": scope, "module": text(args.named_children[0]).strip("\"'"), "name": "", "alias": alias})
        stack.extend((child, scope) for child in reversed(node.named_children))
    owners = defaultdict(list)
    for symbol in facts["symbols"]:
        if symbol["kind"] == "class":
            owners[symbol["name"]].append(symbol["id"])
    for symbol in facts["symbols"]:
        candidates = owners.get(symbol.get("owner"), [])
        if len(candidates) == 1:
            symbol["parent"] = candidates[0]
    return facts


class CodeGraph:
    def __init__(self, root=".", output=None):
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise ValueError(f"Repository not found: {root}")
        self.output = Path(output).resolve() if output else self.root / ".code-graph"
        if self.root.is_relative_to(self.output):
            raise ValueError("Output must not be the repository or one of its parents.")
        self.graph = None

    def build(self):
        start = time.perf_counter()
        nodes, edges, facts, fresh, errors = {}, {}, {}, {}, []
        template = Path(__file__).with_name("graph_view.html").read_text("utf-8")
        revision = hashlib.sha256(Path(__file__).read_bytes() + template.encode()).hexdigest()
        cache_path = self.output / "cache.json"
        try:
            saved = json.loads(cache_path.read_text("utf-8"))
            cache = saved["files"] if saved.get("revision") == revision and saved.get("root") == str(self.root) else {}
        except (OSError, ValueError, KeyError, TypeError):
            saved, cache = {}, {}
        parsed = reused = 0

        def edge(source, target, kind, line=0, resolved=True, column=0):
            edges[(source, target, kind, line, column)] = dict(source=source, target=target, kind=kind, line=line, column=column, resolved=resolved)

        nodes["."] = dict(id=".", name=self.root.name, kind="directory", file="", line=0)
        for path in source_files(self.root, self.output):
            relative = path.relative_to(self.root).as_posix()
            parent = "."
            for directory in reversed(path.relative_to(self.root).parents):
                part = directory.as_posix()
                if part != ".":
                    nodes[part] = dict(id=part, name=directory.name, kind="directory", file=part, line=0)
                    edge(parent, part, "contains")
                    parent = part
            lang = LANGUAGES.get(path.suffix.lower().lstrip("."))
            nodes[relative] = dict(id=relative, name=path.name, kind="file", file=relative, line=1,
                                   language=lang or "other", status="file-only")
            edge(parent, relative, "contains")
            if not lang:
                continue
            try:
                if path.stat().st_size > 8_000_000:
                    raise ValueError("Source exceeds 8 MB; file node retained")
                data = path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                previous = cache.get(relative, {})
                if previous.get("hash") == digest:
                    fact = previous["facts"]
                    reused += 1
                else:
                    fact = parse_file(relative, data, lang)
                    parsed += 1
                facts[relative] = fact
                fresh[relative] = {"hash": digest, "facts": fact}
                nodes[relative]["status"] = "partial" if fact["partial"] else "parsed"
                if fact["partial"]:
                    errors.append({"file": relative, "reason": "Syntax errors; partial AST retained"})
                for symbol in fact["symbols"]:
                    nodes[symbol["id"]] = dict(symbol)
                    edge(symbol["parent"], symbol["id"], "contains")
            except (OSError, ValueError, LookupError, RuntimeError) as error:
                errors.append({"file": relative, "reason": str(error)})

        manifest = [n["file"] for n in nodes.values() if n["kind"] == "file"]
        if (saved.get("revision") == revision and saved.get("root") == str(self.root) and not parsed
                and fresh.keys() == cache.keys() and manifest == saved.get("manifest") and (self.output / "graph.html").exists()):
            try:
                self.graph = json.loads((self.output / "graph.json").read_text("utf-8"))
                self.graph["stats"].update(parsed_now=0, cached=reused, seconds=round(time.perf_counter() - start, 3))
                return self.summary()
            except (OSError, ValueError, KeyError, TypeError):
                pass

        modules, definitions, aliases = defaultdict(set), defaultdict(list), defaultdict(list)
        for path, fact in facts.items():
            stem = path.rsplit(".", 1)[0]
            variants = {stem, re.sub(r"/(?:__init__|index)$", "", stem)}
            for variant in variants:
                parts = variant.split("/")
                for index in range(len(parts)):
                    modules["/".join(parts[index:])].add(path)
            for symbol in fact["symbols"]:
                name = symbol["name"]
                if symbol.get("owner") and symbol["parent"] == path:
                    name = symbol["owner"] + "." + name
                definitions[(path, symbol["parent"], name)].append(symbol["id"])
            for item in fact["imports"]:
                aliases[(path, item["scope"], item["alias"])].append(item)

        @lru_cache(maxsize=None)
        def module_files(module, path):
            if nodes[path]["language"] == "python":
                dots = len(module) - len(module.lstrip("."))
                tail = module[dots:].replace(".", "/")
                module = posixpath.normpath(posixpath.join(posixpath.dirname(path), *([".."] * (dots - 1)), tail)) if dots else tail
            elif module.startswith("."):
                module = posixpath.normpath(posixpath.join(posixpath.dirname(path), module))
            module = module.replace("::", "/")
            if module.rsplit(".", 1)[-1] in LANGUAGES:
                module = module.rsplit(".", 1)[0]
            direct = [f for ext in LANGUAGES for f in (module + "." + ext, module + "/__init__." + ext, module + "/index." + ext) if f in facts]
            found = set(direct) or modules.get(module, set())
            return sorted(found) if len(found) == 1 else []

        def resolve(path, scope, name):
            parts = re.split(r"\?\.|->|::|\.", name)
            first, rest = parts[0], parts[1:]
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
                    if first in facts[path]["bindings"].get(current, []):
                        return None
                    candidates = definitions.get((path, current, first), [])
                    imported = aliases.get((path, current, first), [])
                    if candidates or imported:
                        for item in imported:
                            for target in module_files(item["module"], path):
                                symbol_name = item["name"]
                                if symbol_name == "default":
                                    candidates = candidates + [s["id"] for s in facts[target]["symbols"] if s.get("default")]
                                    continue
                                candidates = candidates + (definitions.get((target, target, symbol_name), []) if symbol_name else [target])
                            if not candidates and item["name"] and nodes[path]["language"] == "python":
                                module = item["module"] + ("" if item["module"].endswith(".") else ".") + item["name"]
                                candidates = module_files(module, path)
                        break
                    if current == path:
                        break
                    current = nodes[current]["parent"]
            for part in rest:
                candidates = [child for candidate in candidates
                              for child in definitions.get((nodes[candidate]["file"], candidate, part), [])]
            candidates = set(candidates)
            return next(iter(candidates)) if len(candidates) == 1 else None

        for path, fact in facts.items():
            for item in fact["imports"]:
                targets = module_files(item["module"], path)
                if not targets:
                    target = "external:" + item["module"]
                    nodes[target] = dict(id=target, name=item["module"], kind="external", file="", line=0)
                    targets = [target]
                for target in targets:
                    edge(item["scope"], target, "imports", resolved=not target.startswith("external:"))
            for ref in fact["refs"]:
                target = resolve(path, ref["scope"], ref["name"])
                resolved = target is not None
                if not target:
                    target = f"unresolved:{ref['scope']}:{ref['name']}"
                    nodes[target] = dict(id=target, name=ref["name"], kind="unresolved", file=path, line=ref["line"])
                edge(ref["scope"], target, ref["kind"], ref["line"], resolved, ref.get("column", 0))

        ids = {key: index for index, key in enumerate(nodes)}
        for node in nodes.values():
            node["id"] = ids[node["id"]]
            node.pop("default", None)
            if "parent" in node:
                node["parent"] = ids[node["parent"]]
        for item in edges.values():
            item.update(source=ids[item["source"]], target=ids[item["target"]])
        stats = dict(files=len(manifest), parsed_files=len(facts),
                     parsed_now=parsed, cached=reused, nodes=len(nodes), edges=len(edges),
                     unresolved=sum(n["kind"] == "unresolved" for n in nodes.values()),
                     errors=len(errors), seconds=round(time.perf_counter() - start, 3))
        self.graph = dict(name=self.root.name, stats=stats, nodes=list(nodes.values()), edges=list(edges.values()), errors=errors)
        self.output.mkdir(parents=True, exist_ok=True)
        for name, value in (("graph.json", self.graph), ("cache.json", {"revision": revision, "root": str(self.root), "manifest": manifest, "files": fresh})):
            (self.output / name).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), "utf-8")
        payload = json.dumps(self.graph, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        (self.output / "graph.html").write_text(template.replace("__GRAPH_DATA__", payload), "utf-8")
        return self.summary()

    def summary(self):
        return {**self.graph["stats"], "html": str(self.output / "graph.html"),
                "json": str(self.output / "graph.json"), "warnings": self.graph["errors"][:10]}

    def query(self, query, limit=12):
        if self.graph is None:
            self.build()
        limit = max(1, min(int(limit), 30))
        nodes = self.graph["nodes"]
        matches = [n for n in nodes if query.casefold() in (str(n["id"]) + " " + n["file"] + " " + n["name"]).casefold()]
        matches.sort(key=lambda n: (str(n["id"]) != query and n["name"] != query, n["kind"] in {"unresolved", "external"}, n["id"]))
        selected = {n["id"] for n in matches[:limit]}
        related = [e for e in self.graph["edges"] if e["source"] in selected or e["target"] in selected]
        shown = related[:120]
        neighbors = {e[key] for e in shown for key in ("source", "target")} - selected
        return dict(matches=matches[:limit], total_matches=len(matches), edges=shown, total_edges=len(related),
                    neighbors=[n for n in nodes if n["id"] in neighbors], truncated=len(matches) > limit or len(related) > 120)
