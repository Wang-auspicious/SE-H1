import http.client
import json
import re
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs

import code_agent
from code_agent import CodeAgent, local_review, make_server, source_excerpt
from code_graph import CodeGraph


ROOT = Path(__file__).resolve().parents[1]


def reply(content=None, tool_calls=None, finish="stop"):
    """Minimal stand-in for an OpenAI chat completion response."""
    message = types.SimpleNamespace(
        content=content,
        tool_calls=tool_calls,
        model_dump=lambda **_: {"role": "assistant", "content": content},
    )
    usage = types.SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2)
    return types.SimpleNamespace(usage=usage, choices=[types.SimpleNamespace(message=message, finish_reason=finish)])


class RecordingClient:
    """Returns queued responses and records the requests it was asked to make."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        completions = types.SimpleNamespace(create=self.create)
        self.chat = types.SimpleNamespace(completions=completions)

    def create(self, **kwargs):
        self.requests.append(kwargs)
        return self.responses.pop(0)


class BackendGraphTests(unittest.TestCase):
    def test_local_review_returns_tool_trail_and_findings(self):
        result = local_review(
            {
                "stats": {"files": 2, "edges": 3, "call_sites": 4, "linked_calls": 2, "errors": 0},
                "nodes": [
                    {"id": 0, "kind": "file", "file": "main.py", "name": "main.py", "line": 1},
                    {"id": 1, "kind": "function", "file": "main.py", "name": "main", "line": 4},
                ],
                "edges": [{"source": 0, "target": 1, "kind": "contains", "line": 4, "column": 0}],
            },
            "检查结构",
        )
        self.assertEqual(result["mode"], "local")
        self.assertEqual(len(result["events"]), 3)
        self.assertIn("结构提醒", result["answer"])
        # Offline answers must still cite real positions; the chat renders them as links.
        self.assertIn("main.py:4", result["answer"])
        self.assertIn("2 个调用点无法静态定位", result["answer"])

    def test_source_excerpt_is_bounded_and_graph_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "main.py"
            source.write_text("\n".join(f"line {i}" for i in range(1, 180)), "utf-8")
            graph = CodeGraph(root)
            graph.build()

            excerpt = source_excerpt(
                graph.graph, root, parse_qs("file=main.py&line=20")
            )
            self.assertEqual(excerpt["file"], "main.py")
            self.assertEqual(excerpt["start"], 20)
            self.assertEqual(len(excerpt["lines"]), 120)
            self.assertEqual(excerpt["total"], 179)

            with self.assertRaises(FileNotFoundError):
                source_excerpt(graph.graph, root, parse_qs("file=../main.py"))

    def test_sensitive_files_are_not_graph_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "main.py").write_text("print('ok')\n", "utf-8")
            (root / ".env").write_text("TOKEN=secret\n", "utf-8")
            graph = CodeGraph(root)
            graph.build()
            with self.assertRaises(FileNotFoundError):
                source_excerpt(graph.graph, root, parse_qs("file=.env"))


class AgentEventTests(unittest.TestCase):
    def test_run_reports_tool_and_answer_events_to_a_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "main.py").write_text("def main():\n    return 1\n", "utf-8")
            call = types.SimpleNamespace(
                id="call-1",
                function=types.SimpleNamespace(name="query_graph", arguments='{"query": "main"}'),
            )
            client = RecordingClient([
                reply(tool_calls=[call], finish="tool_calls"),
                reply(content="main is the entry point"),
            ])
            agent = CodeAgent(repo=directory, client=client)
            events = []
            answer = agent.run("where is main", on_event=events.append)

            self.assertEqual(answer, "main is the entry point")
            self.assertEqual([event["t"] for event in events], ["tool", "tool", "answer"])
            self.assertEqual(events[0]["state"], "running")
            self.assertEqual(events[1]["state"], "done")
            self.assertEqual(events[2]["text"], "main is the entry point")
            self.assertEqual(agent.events, events)

    def test_run_keeps_working_without_a_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            client = RecordingClient([reply(content="ok")])
            agent = CodeAgent(repo=directory, client=client)
            self.assertEqual(agent.run("hi"), "ok")
            self.assertEqual([event["t"] for event in agent.events], ["answer"])


class SessionStoreTests(unittest.TestCase):
    def setUp(self):
        code_agent.SESSIONS.clear()

    def tearDown(self):
        code_agent.SESSIONS.clear()

    def test_sessions_are_reused_and_capped(self):
        first = code_agent.session_entry("a")
        self.assertIs(first, code_agent.session_entry("a"))
        self.assertEqual(len(code_agent.SESSIONS), 1)

        for name in "bcdef":
            code_agent.session_entry(name)
        self.assertEqual(len(code_agent.SESSIONS), code_agent.MAX_SESSIONS)
        self.assertNotIn("a", code_agent.SESSIONS)


class ServerTestCase(unittest.TestCase):
    """Boots the real handler on an ephemeral port; no network, no API key."""

    def serve(self, directory):
        httpd, _ = make_server(directory, 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return httpd.server_address[1]

    def get(self, port, path):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.getheader("Content-Type"), response.read()


class StudioPageTests(ServerTestCase):
    def test_the_studio_page_embeds_the_atlas_fragment(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "main.py").write_text("print('ok')\n", "utf-8")
            port = self.serve(directory)
            status, content_type, body = self.get(port, "/")
            page = body.decode("utf-8")

        self.assertEqual(status, 200)
        self.assertTrue(content_type.startswith("text/html"))
        # The atlas markup ships inside the page as an inert template.
        self.assertIn('class="atlas-view"', page)
        self.assertIn('id="atlas-markup"', page)
        for marker in ("__ATLAS__", "__GRAPH_DATA__", "__ATLAS_GRAPH_SCRIPT__"):
            self.assertNotIn(marker, page)

    def test_every_front_end_asset_is_served_with_the_right_type(self):
        with tempfile.TemporaryDirectory() as directory:
            port = self.serve(directory)
            for name, kind in (
                ("studio.css", "text/css"),
                ("atlas.css", "text/css"),
                ("studio.js", "javascript"),
                ("atlas_view.js", "javascript"),
                ("atlas_graph.js", "javascript"),
            ):
                status, content_type, body = self.get(port, f"/{name}")
                self.assertEqual(status, 200, name)
                self.assertIn(kind, content_type, name)
                self.assertTrue(body, name)


class AtlasStyleTests(unittest.TestCase):
    def selectors(self):
        css = re.sub(r"/\*.*?\*/", "", (ROOT / "atlas.css").read_text("utf-8"), flags=re.S)
        preludes = re.findall(r"(?:^|[{};])\s*([^{}@;]+?)\s*\{", css)
        return [part.strip() for prelude in preludes for part in prelude.split(",")], css

    def test_styles_target_the_shadow_host_not_the_document(self):
        selectors, _ = self.selectors()
        # Tokens and sizing have to sit on the host, or nothing inherits inward.
        self.assertIn(":host", selectors)
        # These would silently match nothing inside a shadow root.
        for dead in ("html", "body", ":root"):
            self.assertNotIn(dead, selectors)

    def test_the_atlas_measures_its_pane_not_the_viewport(self):
        _, css = self.selectors()
        self.assertNotIn("100vw", css)
        self.assertNotIn("100vh", css)


class ChatStreamTests(ServerTestCase):
    def test_chat_streams_ndjson_without_a_model_key(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "main.py").write_text("def main():\n    return 1\n", "utf-8")
            with mock.patch.object(code_agent, "key_available", return_value=False):
                port = self.serve(directory)
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                connection.request(
                    "POST", "/api/chat",
                    json.dumps({"prompt": "检查结构", "session": "s1"}),
                    {"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                body = response.read().decode("utf-8")

            self.assertTrue(response.getheader("Content-Type").startswith("application/x-ndjson"))
            events = [json.loads(line) for line in body.splitlines() if line]
            self.assertEqual(events[0], {"t": "session", "session": "s1"})
            self.assertTrue(any(event["t"] == "tool" for event in events))
            self.assertEqual(events[-1]["t"], "done")
            self.assertEqual(events[-1]["mode"], "local")
            self.assertFalse(any(event["t"] == "error" for event in events))

    def test_status_reports_offline_mode_and_repo(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "main.py").write_text("print('ok')\n", "utf-8")
            with mock.patch.object(code_agent, "key_available", return_value=False):
                port = self.serve(directory)
                _, _, body = self.get(port, "/api/status")
                status = json.loads(body)

            self.assertEqual(status["mode"], "local")
            self.assertEqual(status["repo"], str(Path(directory).resolve()))
            self.assertEqual(status["stats"]["files"], 1)
            self.assertNotIn("key", json.dumps(status).lower().replace("token", ""))


if __name__ == "__main__":
    unittest.main()
