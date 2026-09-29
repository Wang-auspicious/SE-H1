import hashlib
import re
from collections import defaultdict
from functools import lru_cache
from tree_sitter_language_pack import get_parser

LANGUAGES = {ext: lang for lang, extensions in {
    "python": "py pyw pyi", "javascript": "js jsx mjs cjs", "typescript": "ts mts cts", "tsx": "tsx",
    "go": "go", "rust": "rs", "java": "java", "c": "c", "cpp": "cc cpp cxx h hpp hxx",
    "csharp": "cs", "ruby": "rb", "php": "php", "kotlin": "kt kts", "swift": "swift", "scala": "scala sc",
}.items() for ext in extensions.split()}
EXCLUDED = {".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".code-graph", "dist", "build", "target", ".next", "vendor"}
FUNCTIONS = set("function_definition function_declaration function_item method_definition method_declaration constructor_declaration method singleton_method function_signature local_function_statement".split())
CLASSES = set("class_definition class_declaration class_specifier struct_specifier struct_item struct_declaration interface_declaration trait_item enum_item enum_declaration record_declaration object_declaration type_spec class".split())
CALLS = set("call call_expression invocation_expression method_invocation method_call_expression member_call_expression scoped_call_expression object_creation_expression new_expression".split())
IMPORTS = set("import_statement import_from_statement import_declaration import_spec use_declaration using_directive preproc_include export_statement".split())
BINDINGS = {"assignment", "variable_declarator", "short_var_declaration"}
TARGETS = FUNCTIONS | CLASSES | CALLS | IMPORTS | BINDINGS


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


@lru_cache(maxsize=None)
def grammar(lang):
    return get_parser(lang)


def imports(node, scope, lang):
    module = text(field(node, "module_name", "source", "path")).strip("\"'<>")
    if lang == "python":
        for item in node.children_by_field_name("name"):
            name = text(field(item, "name") or item)
            yield [scope, module or name, name if module else "", text(field(item, "alias")) or (name if module else name.split(".")[0])]
        if module:
            yield [scope, module, "", ""]
    elif module:
        for item in walk(node):
            if item.type == "import_specifier":
                name = text(field(item, "name"))
                yield [scope, module, name, text(field(item, "alias")) or name]
            elif item.type == "import_clause":
                for child in item.named_children:
                    if child.type == "identifier":
                        yield [scope, module, "default", text(child)]
                    elif child.type == "namespace_import":
                        yield [scope, module, "", text(child.named_children[-1])]
        yield [scope, module, "", (text(field(node, "name")) or module.rsplit("/", 1)[-1]) if lang == "go" else ""]
    elif node.type in {"use_declaration", "using_directive", "import_declaration"}:
        parts = re.split(r"\s+as\s+", re.sub(r"^(import|using|use)\s+(static\s+)?", "", text(node)).strip(" ;\n"))
        if "{" not in parts[0] and "\n" not in parts[0]:
            module, name = parts[0], ""
            if lang == "rust" and "::" in module:
                module, name = module.rsplit("::", 1)
            if lang == "java":
                name = module.rsplit(".", 1)[-1]
            yield [scope, module, name, parts[1] if len(parts) > 1 else re.split(r"\.|::|/", parts[0])[-1]]


def parse_file(path, data, lang):
    tree = grammar(lang).parse(data)
    facts = dict(symbols=[], imports=[], refs=[], bindings={}, partial=tree.root_node.has_error)
    scopes, owners = [(len(data) + 1, path)], defaultdict(list)
    for node in walk(tree.root_node):
        if node.type not in TARGETS:
            continue
        while node.start_byte >= scopes[-1][0]:
            scopes.pop()
        scope = scopes[-1][1]
        kind = "class" if node.type in CLASSES else "function" if node.type in FUNCTIONS else ""
        if node.type in {"struct_specifier", "class_specifier"} and field(node, "body") is None:
            kind = ""
        value = field(node, "value")
        if node.type == "variable_declarator" and value and value.type in {"arrow_function", "function_expression"}:
            kind = "function"
        name = field(node, "name", "declarator") or next((n for n in node.named_children if n.type in {"simple_identifier", "type_identifier"}), None)
        while name and field(name, "declarator"):
            name = field(name, "declarator")
        if kind and name:
            sid = hashlib.blake2s(f"{path}:{node.type}:{node.start_byte}:{node.end_byte}".encode(), digest_size=8).hexdigest()
            symbol = dict(id=sid, name=text(name), kind=kind, file=path, line=node.start_point.row + 1, end=node.end_point.row + 1, parent=scope)
            symbol["default"] = node.parent.type == "export_statement" and any(c.type == "default" for c in node.parent.children)
            receiver = field(node, "receiver")
            if receiver:
                symbol["owner"] = next((text(n) for n in walk(receiver) if n.type == "type_identifier"), "")
                symbol["receiver"] = next((text(n) for n in walk(receiver) if n.type == "identifier"), "")
            if lang == "rust" and node.parent.parent and node.parent.parent.type == "impl_item":
                symbol["owner"] = text(field(node.parent.parent, "type")).split("<")[0]
            facts["symbols"].append(symbol)
            owners[text(name)].append(sid) if kind == "class" else None
            scope = sid
            scopes.append((node.end_byte, scope))
            params = field(node, "parameters", "parameter")
            if params:
                facts["bindings"][scope] = [text(p) for p in walk(params) if p.type == "identifier"]
            if kind == "class":
                bases = field(node, "superclasses", "superclass") or next((n for n in node.named_children if n.type in {"class_heritage", "base_class_clause", "base_list"}), None)
                for base in bases.named_children if bases else []:
                    if base.type != "access_specifier":
                        facts["refs"].append([scope, re.sub(r"^(extends|implements|public|private|protected)\s+", "", text(base)), "inherits", node.start_point.row + 1, 0])
        elif node.type in BINDINGS and (target := field(node, "left", "name")):
            facts["bindings"].setdefault(scope, []).extend(text(n) for n in walk(target) if n.type == "identifier")
        if node.type in IMPORTS:
            facts["imports"].extend(imports(node, scope, lang))
        if node.type in CALLS:
            target = field(node, "function", "name", "method", "constructor", "type")
            raw = text(target or (node.named_children[0] if node.named_children and lang in {"kotlin", "swift"} else None))
            receiver = field(node, "object", "receiver")
            raw = text(receiver) + "." + raw if receiver else raw
            if raw:
                facts["refs"].append([scope, raw[:200], "calls", node.start_point.row + 1, node.start_point.column])
            args = field(node, "arguments")
            if raw == "require" and args and args.named_children and args.named_children[0].type == "string":
                facts["imports"].append([scope, text(args.named_children[0]).strip("\"'"), "", text(field(node.parent, "name"))])
    for symbol in facts["symbols"]:
        candidates = owners.get(symbol.get("owner"), [])
        if len(candidates) == 1:
            symbol["parent"] = candidates[0]
    return facts
