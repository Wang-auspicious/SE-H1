import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

from code_agent import source_excerpt
from code_graph import CodeGraph


class BackendGraphTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
