import json
import unittest

from picture import picture_model, render_picture


class PictureAdapterTests(unittest.TestCase):
    def test_projects_real_graph_into_upstream_viewer_model(self):
        graph = {
            "name": "sample",
            "stats": {"files": 1, "edges": 2},
            "nodes": [
                {"id": "main.py", "kind": "file", "file": "main.py", "name": "main.py", "line": 1, "language": "python"},
                {"id": "main", "kind": "function", "file": "main.py", "name": "main", "line": 4, "parent": "main.py", "language": "python"},
            ],
            "edges": [{"source": "main.py", "target": "main", "kind": "contains"}],
            "errors": [],
        }
        model = picture_model(graph)
        self.assertEqual(model["schema"], "architecture-map-model/2")
        self.assertEqual(len(model["nodes"]), 2)  # root-level file and function
        self.assertEqual(model["nodes"][-1]["sources"], ["main.py"])

    def test_render_inlines_data_without_upstream_markers(self):
        graph = {"name": "sample", "stats": {}, "nodes": [], "edges": [], "errors": []}
        page = render_picture(graph, live=False)
        self.assertIn('id="archmap-data"', page)
        self.assertIn("Limen Picture", page)
        self.assertNotIn("ARCHMAP:DATA", page)
        self.assertNotIn("__GRAPH_DATA__", page)
        json.loads(page.split('id="archmap-data">', 1)[1].split("</script>", 1)[0])


if __name__ == "__main__":
    unittest.main()
