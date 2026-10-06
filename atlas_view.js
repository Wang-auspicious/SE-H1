(function atlasView() {
      "use strict";
      // The atlas shares a document with the chat studio, so it lives in its own
      // shadow root: the global reset, the z-index scale and the SVG marker ids
      // all stay contained instead of leaking into — or colliding with — the shell.
      let host = null;
      let shadow = null;
      const META = Object.freeze({
        calls: { color: "#58a6ff", dash: "" },
        imports: { color: "#d29922", dash: "6 4" },
        contains: { color: "#8b949e", dash: "2 4" },
        related: { color: "#bc8cff", dash: "2 5" },
      });
      const LANE_COLORS = {
        calls: ["#58a6ff", "#2dd4bf", "#bc8cff", "#db61a2", "#f78166", "#79c0ff"],
        imports: ["#d29922", "#f2cc60", "#ffa657"],
        related: ["#bc8cff", "#3fb950", "#ff7b72"],
      };
      const state = {
        graph: null,
        atlas: null,
        children: new Map(),
        features: [],
        view: null,
        layout: null,
        scopeStack: [],
        selection: { type: "project" },
        hover: null,
        query: "",
      };
      const $ = (id) => shadow.querySelector("#" + id);
      const SVG_NS = "http://www.w3.org/2000/svg";
      const esc = (value) =>
        String(value ?? "").replace(
          /[&<>\"']/g,
          (character) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[character],
        );

      function rawNode(id) {
        return state.atlas?.rawNodes.get(Number(id));
      }

      function edgeMeta(edge) {
        const base = META[edge.kind] || META.related;
        const colors = LANE_COLORS[edge.kind] || LANE_COLORS.related;
        return { ...base, color: colors[(edge.lane || 0) % colors.length] };
      }

      function moduleTitle(node) {
        const label = String(node.file || node.label || "module");
        return label.split("/").pop().replace(/\.[^.]+$/, "") || label;
      }

      function fileIdForRaw(id) {
        const node = rawNode(id);
        if (!node) return undefined;
        if (node.kind === "file") return node.id;
        return state.atlas.ancestors(node.id).find((ancestor) => {
          return rawNode(ancestor)?.kind === "file";
        });
      }

      function moduleIdForRaw(id) {
        if (state.atlas?.moduleById?.has(Number(id))) return Number(id);
        return state.atlas?.moduleOfRaw?.(Number(id));
      }

      function selectedViewNode() {
        if (state.selection.type !== "node") return null;
        return (
          state.layout?.nodes.find((node) => node.id === state.selection.id) ||
          state.atlas?.moduleById?.get(Number(state.selection.id)) ||
          state.atlas?.rawNodes.get(state.selection.id) ||
          null
        );
      }

      function makeFeature(id, tag, name, detail, kind, modules) {
        return {
          id,
          tag,
          name,
          detail,
          kind,
          modules: Array.from(new Set(modules)),
        };
      }

      function buildFeatures(graph, atlas) {
        const modules = atlas.modules || [];
        const edges = Array.isArray(graph.edges) ? graph.edges : [];
        const kindEdges = (kind) => edges.filter((edge) => edge.kind === kind);
        const moduleIdsFor = (kind) =>
          Array.from(new Set(kindEdges(kind).flatMap((edge) => [
            atlas.moduleOfRaw(edge.source),
            atlas.moduleOfRaw(edge.target),
          ]).filter((id) => id !== undefined)));
        const functionCount = atlas.rawNodes.size
          ? Array.from(atlas.rawNodes.values()).filter(
              (node) => node.kind === "function",
            ).length
          : 0;
        const errors = Array.isArray(graph.errors) ? graph.errors.length : 0;
        const modulesFor = (pattern) => modules
          .filter((module) => pattern.test(module.label + " " + module.description))
          .map((module) => module.id);
        const allModules = modules.map((module) => module.id);
        return [
          makeFeature(
            "flow",
            "FLOW",
            "Call flow",
            kindEdges("calls").length + " linked relations",
            "calls",
            moduleIdsFor("calls").length ? moduleIdsFor("calls") : allModules,
          ),
          makeFeature(
            "agent",
            "AGENT",
            "Agent loop",
            "tools, review, and execution",
            "agent",
            modulesFor(/agent runtime/i),
          ),
          makeFeature(
            "graph",
            "GRAPH",
            "Graph build",
            functionCount + " functions indexed",
            "graph",
            modulesFor(/graph engine/i),
          ),
          makeFeature(
            "surface",
            "SURFACE",
            "Source evidence",
            "files and symbols stay traceable",
            "surface",
            modulesFor(/interface/i),
          ),
          makeFeature(
            "checks",
            "CHECKS",
            "Verification",
            errors + " parse errors · tests stay local",
            "checks",
            modulesFor(/verification/i),
          ),
          makeFeature(
            "imports",
            "IMPORTS",
            "Module boundaries",
            kindEdges("imports").length + " import links",
            "imports",
            moduleIdsFor("imports"),
          ),
        ];
      }

      function activeScope() {
        return state.scopeStack.length
          ? state.scopeStack[state.scopeStack.length - 1]
          : null;
      }

      function currentView() {
        return activeScope() === null
          ? state.atlas.projectView("architecture")
          : state.atlas.scopeView(activeScope());
      }

      function currentScopeLabel() {
        const labels = state.scopeStack.map((id) => state.atlas.label(id));
        return labels.length ? labels.join(" / ") : "repository";
      }

      function setGraph(graph) {
        state.graph = graph;
        state.atlas = AtlasGraph.model(graph);
        state.children = new Map();
        state.atlas.rawNodes.forEach((node) => {
          if (!state.children.has(node.id)) state.children.set(node.id, []);
          if (node.parent !== undefined) {
            const siblings = state.children.get(node.parent) || [];
            siblings.push(node.id);
            state.children.set(node.parent, siblings);
          }
        });
        state.atlas.modules.forEach((module) => {
          state.children.set(module.id, module.fileIds || []);
        });
        state.features = buildFeatures(graph, state.atlas);
        state.scopeStack = [];
        state.selection = { type: "project" };
        state.view = null;
        state.layout = null;
        $("source-preview").textContent =
          "Select a source to inspect a bounded excerpt.";
        renderAll();
      }

      function renderLegend(view) {
        const counts = new Map();
        view.edges.forEach((edge) => {
          counts.set(edge.kind, (counts.get(edge.kind) || 0) + edge.count);
        });
        const keys = ["calls", "imports", "related"];
        $("connections-legend").innerHTML =
          '<span class="legend-label">RELATIONS</span>' +
          keys
            .filter((kind) => counts.has(kind))
            .map((kind) => {
              const meta = META[kind] || META.related;
              return (
                '<button class="legend-pill" data-kind="' +
                esc(kind) +
                '">' +
                '<span class="legend-swatch" style="background:' +
                meta.color +
                '"></span>' +
                esc(kind) +
                " " +
                counts.get(kind) +
                "</button>"
              );
            })
            .join("");
        $("connections-legend")
          .querySelectorAll("[data-kind]")
          .forEach((button) => {
            button.addEventListener("mouseenter", () =>
              setHover({ type: "kind", kind: button.dataset.kind }),
            );
            button.addEventListener("mouseleave", clearHover);
          });
        const stats = state.atlas.stats || {};
        $("secondary-legend").innerHTML =
          '<span class="legend-label">GRAPH</span>' +
          '<span class="legend-pill">' +
          (stats.files || 0) +
          " files</span>" +
          '<span class="legend-pill">' +
          (stats.nodes || 0) +
          " symbols</span>" +
          '<span class="legend-pill">' +
          (stats.edges || 0) +
          " relations</span>" +
          '<span class="legend-pill">' +
          (stats.errors || 0) +
          " parse errors</span>";
      }

      function columnsFor(width, height) {
        // The pane is narrower than the window and the media queries cannot see it.
        const compact = height < 850;
        const card = compact ? 164 : 188;
        const gap = compact ? 22 : 30;
        return Math.max(
          1,
          Math.min(5, Math.floor((width + gap) / (card + gap))),
        );
      }

      function createSvgElement(tag, attributes) {
        const element = document.createElementNS(SVG_NS, tag);
        Object.entries(attributes || {}).forEach(([key, value]) => {
          element.setAttribute(key, value);
        });
        return element;
      }

      function renderTopology(view) {
        const canvas = $("canvas-container");
        const nodesContainer = $("nodes-container");
        const graphSvg = $("graph-svg");
        const bridgeSvg = $("bridge-svg");
        const width = Math.max(360, canvas.clientWidth - 32);
        state.view = view;
        state.layout = AtlasGraph.layout(view, {
          width,
          height: canvas.clientHeight,
          columns: columnsFor(width, canvas.clientHeight),
        });
        const layout = state.layout;
        const graphWidth = Math.max(width, layout.width);
        const graphHeight = Math.max(190, layout.height);
        nodesContainer.innerHTML = "";
        graphSvg.innerHTML = "";
        bridgeSvg.innerHTML = "";
        canvas.querySelector(".graph-spacer")?.remove();
        nodesContainer.style.width = graphWidth + "px";
        nodesContainer.style.height = graphHeight + "px";
        graphSvg.setAttribute("width", graphWidth);
        graphSvg.setAttribute("height", graphHeight);
        graphSvg.style.width = graphWidth + "px";
        graphSvg.style.height = graphHeight + "px";
        bridgeSvg.setAttribute("width", graphWidth);
        bridgeSvg.setAttribute("height", graphHeight);
        bridgeSvg.style.width = graphWidth + "px";
        bridgeSvg.style.height = graphHeight + "px";
        const spacer = document.createElement("div");
        spacer.className = "graph-spacer";
        spacer.style.width = graphWidth + "px";
        spacer.style.height = graphHeight + "px";
        canvas.prepend(spacer);
        const defs = createSvgElement("defs");
        Object.entries(META).forEach(([kind, meta]) => {
          const marker = createSvgElement("marker", {
            id: "arrow-" + kind,
            viewBox: "0 0 10 10",
            refX: "8",
            refY: "5",
            markerWidth: "5",
            markerHeight: "5",
            orient: "auto-start-reverse",
          });
          marker.appendChild(
            createSvgElement("path", {
              d: "M 1 2 L 8 5 L 1 8 z",
              fill: meta.color,
            }),
          );
          defs.appendChild(marker);
        });
        graphSvg.appendChild(defs);
        layout.edges.forEach((edge, index) => {
          if (!edge.path) return;
           const meta = edgeMeta(edge);
          const path = createSvgElement("path", {
            d: edge.path,
            class: "wire wire-" + (META[edge.kind] ? edge.kind : "related"),
            stroke: meta.color,
            "marker-end":
              "url(#arrow-" + (META[edge.kind] ? edge.kind : "related") + ")",
          });
          path.dataset.index = String(index);
          path.dataset.kind = edge.kind;
          path.dataset.from = String(edge.source);
          path.dataset.to = String(edge.target);
          const title = createSvgElement("title");
          title.textContent =
            state.atlas.label(edge.source) +
            " → " +
            state.atlas.label(edge.target) +
            " · " +
            edge.kind +
            (edge.count > 1 ? " ×" + edge.count : "");
          path.appendChild(title);
          path.addEventListener("mouseenter", () =>
            setHover({ type: "edge", index, edge }),
          );
          path.addEventListener("mouseleave", clearHover);
          graphSvg.appendChild(path);
           if (edge.lane === 0 && edge.count > 1 && edge.badge) {
            const badge = createSvgElement("g", { class: "wire-badge" });
            badge.appendChild(
              createSvgElement("circle", {
                cx: edge.badge.x,
                cy: edge.badge.y,
                r: "9",
                fill: "#15191d",
                stroke: meta.color,
              }),
            );
            const text = createSvgElement("text", {
              x: edge.badge.x,
              y: edge.badge.y + 3,
              fill: "#c9d1d9",
              "font-size": "9",
              "font-family": "ui-monospace,monospace",
              "text-anchor": "middle",
            });
            text.textContent = String(edge.count);
            badge.appendChild(text);
            graphSvg.appendChild(badge);
          }
        });
        layout.nodes.forEach((node) => {
          const card = document.createElement("article");
          const outside = Boolean(node.outside);
          const isModule = node.kind === "module";
          const kind = outside
            ? "OUTSIDE"
            : isModule || view.mode === "files"
              ? "MODULE"
              : String(node.kind || "symbol").toUpperCase();
          const detail = outside
            ? "external boundary"
            : isModule
              ? String(node.parts || node.children || 0) + " parts"
              : view.mode === "files"
                ? String(node.children || 0) + " symbols"
                : node.kind === "file"
                  ? String(node.children || 0) + " symbols"
                  : (node.file || "local") + ":" + (node.line || "—");
          const title = isModule
            ? node.label
            : view.mode === "files"
              ? moduleTitle(node)
              : node.label;
          card.className = "module-card" + (outside ? " outside" : "");
          card.id = "node-" + node.id;
          card.dataset.nodeId = String(node.id);
          card.style.left = node.x + "px";
          card.style.top = node.y + "px";
          card.style.width = node.width + "px";
          card.style.height =
            (outside ? Math.min(node.height, 60) : node.height) + "px";
          card.innerHTML =
            '<div class="card-top"><span class="card-type">' +
            esc(kind) +
            '</span><span class="mini-status">' +
            (isModule ? "READY" : "LIVE") +
            "</span></div>" +
            '<div class="card-title" title="' +
            esc(title) +
            '">' +
            esc(title) +
            "</div>" +
            '<div class="card-bottom"><span>' +
            esc(detail) +
            "</span>" +
            (outside ? "" : '<span class="card-arrow">›</span>') +
            "</div>";
          card.addEventListener("mouseenter", () =>
            setHover({ type: "node", id: node.id }),
          );
          card.addEventListener("mouseleave", clearHover);
          card.addEventListener("click", () => {
            if (!outside && canDrill(node.id)) goInto(node.id);
            else selectNode(node);
          });
          nodesContainer.appendChild(card);
        });
        if (!layout.nodes.length) {
          const empty = document.createElement("div");
          empty.className = "empty-state";
          empty.style.padding = "60px 32px";
          empty.textContent = "No symbols or relations in this scope.";
          nodesContainer.appendChild(empty);
        }
        applyQuery();
        if (state.selection.type === "node") {
          const card = $("node-" + state.selection.id);
          if (card) card.classList.add("selected");
        }
      }

      function canDrill(id) {
        const scope = activeScope();
        if (state.atlas?.moduleById?.has(Number(id))) {
          return Number(id) !== scope && Boolean(state.atlas.moduleById.get(Number(id)).fileIds.length);
        }
        return (
          id !== scope &&
          state.children.has(Number(id)) &&
          state.children.get(Number(id)).length > 0
        );
      }

      function drawBridges(feature) {
        const bridge = $("bridge-svg");
        bridge.innerHTML = "";
        if (!feature || !state.layout) return;
        const source = $("feature-" + feature.id);
        if (!source) return;
        const base = bridge.getBoundingClientRect();
        const sourceRect = source.getBoundingClientRect();
        const targets = state.layout.nodes
          .filter((node) => {
          const owner = moduleIdForRaw(node.id);
            return (
              feature.modules.indexOf(node.id) >= 0 ||
              feature.modules.indexOf(owner) >= 0
            );
          })
          .slice(0, 28);
        targets.forEach((node, index) => {
          const target = $("node-" + node.id);
          if (!target) return;
          const rect = target.getBoundingClientRect();
          const x1 = sourceRect.left + sourceRect.width / 2 - base.left;
          const y1 = sourceRect.top - base.top;
          const x2 = rect.left + rect.width / 2 - base.left;
          const y2 = rect.bottom - base.top;
          const bend = Math.max(28, Math.abs(y1 - y2) * 0.3);
          const path = createSvgElement("path", {
            class: "feature-bridge",
            d:
              "M " +
              x1 +
              " " +
              y1 +
              " C " +
              x1 +
              " " +
              (y1 - bend) +
              ", " +
              x2 +
              " " +
              (y2 + bend) +
              ", " +
              x2 +
              " " +
              y2,
          });
          path.style.animationDelay = index * -0.08 + "s";
          bridge.appendChild(path);
        });
      }

      function renderFeatures() {
        const grid = $("features-grid");
        grid.innerHTML = "";
        state.features.forEach((feature) => {
          const card = document.createElement("article");
          card.className = "feature-card";
          card.id = "feature-" + feature.id;
          card.innerHTML =
            '<div class="feature-top"><span>✦ ' +
            esc(feature.tag) +
            "</span><span>" +
            esc(feature.detail) +
            "</span></div>" +
            '<div class="feature-name">' +
            esc(feature.name) +
            "</div>";
          card.addEventListener("mouseenter", () =>
            setHover({ type: "feature", feature }),
          );
          card.addEventListener("mouseleave", clearHover);
          card.addEventListener("click", () => selectFeature(feature));
          grid.appendChild(card);
        });
        if (state.selection.type === "feature") {
          const selected = $("feature-" + state.selection.feature.id);
          if (selected) selected.classList.add("selected");
        }
      }

      function setHover(hover) {
        state.hover = hover;
        shadow.querySelectorAll(".module-card,.wire")
          .forEach((element) =>
            element.classList.remove("dimmed", "highlighted"),
          );
        if (!hover) return;
        if (hover.type === "feature") {
          setFeatureHover(hover.feature);
          return;
        }
        const activeNodes = new Set();
        const activeEdges = new Set();
        if (hover.type === "node") {
          activeNodes.add(String(hover.id));
          state.layout.edges.forEach((edge, index) => {
            if (edge.source === hover.id || edge.target === hover.id) {
              activeNodes.add(String(edge.source));
              activeNodes.add(String(edge.target));
              activeEdges.add(index);
            }
          });
        } else if (hover.type === "edge") {
          activeNodes.add(String(hover.edge.source));
          activeNodes.add(String(hover.edge.target));
          activeEdges.add(hover.index);
        } else if (hover.type === "kind") {
          state.layout.edges.forEach((edge, index) => {
            if (edge.kind === hover.kind) {
              activeEdges.add(index);
              activeNodes.add(String(edge.source));
              activeNodes.add(String(edge.target));
            }
          });
        }
        shadow.querySelectorAll(".module-card").forEach((card) => {
          if (!activeNodes.has(card.dataset.nodeId))
            card.classList.add("dimmed");
        });
        shadow.querySelectorAll(".wire").forEach((wire) => {
          if (!activeEdges.has(Number(wire.dataset.index)))
            wire.classList.add("dimmed");
          else if (hover.type === "edge") wire.classList.add("highlighted");
        });
      }

      function setFeatureHover(feature) {
        state.hover = { type: "feature", feature };
        shadow.querySelectorAll(".module-card").forEach((card) => {
          const node = state.layout.nodes.find(
            (item) => String(item.id) === card.dataset.nodeId,
          );
          const owner = node ? fileIdForRaw(node.id) : undefined;
          const active =
            node &&
            (feature.modules.indexOf(node.id) >= 0 ||
              feature.modules.indexOf(owner) >= 0);
          card.classList.toggle("dimmed", !active);
        });
        shadow.querySelectorAll(".wire").forEach((wire) => {
          const sourceOwner = moduleIdForRaw(Number(wire.dataset.from));
          const targetOwner = moduleIdForRaw(Number(wire.dataset.to));
          const active =
            feature.modules.indexOf(Number(wire.dataset.from)) >= 0 ||
            feature.modules.indexOf(Number(wire.dataset.to)) >= 0 ||
            feature.modules.indexOf(sourceOwner) >= 0 ||
            feature.modules.indexOf(targetOwner) >= 0;
          wire.classList.toggle("dimmed", !active);
        });
        drawBridges(feature);
      }

      function clearHover() {
        state.hover = null;
        shadow.querySelectorAll(".module-card,.wire")
          .forEach((element) =>
            element.classList.remove("dimmed", "highlighted"),
          );
        if (state.selection.type === "feature")
          setFeatureHover(state.selection.feature);
        else $("bridge-svg").innerHTML = "";
      }

      function applyQuery() {
        const query = state.query.trim().toLowerCase();
        shadow.querySelectorAll(".module-card").forEach((card) => {
          card.classList.toggle(
            "dimmed",
            Boolean(query && !card.textContent.toLowerCase().includes(query)),
          );
        });
      }

      function sourceEntries(selection) {
        if (selection.type === "project") {
          return state.atlas.files.map((node) => ({
            file: node.label,
            line: 1,
            label: node.label,
          }));
        }
        if (selection.type === "feature") {
          return selection.feature.modules.flatMap((id) => {
            const module = state.atlas.moduleById?.get(Number(id));
            return module
              ? module.files.map((file) => ({ file, line: 1, label: file }))
              : [];
          });
        }
        const node = selectedViewNode();
        if (node?.kind === "module") {
          return (node.files || []).map((file) => ({ file, line: 1, label: file }));
        }
        const raw = node ? rawNode(node.id) : null;
        if (!raw) return [];
        return [
          {
            file: raw.file || "unknown",
            line: raw.line || 1,
            label: (raw.file || "unknown") + ":" + (raw.line || 1),
          },
        ];
      }

      function relationText(edge) {
        return (
          state.atlas.label(edge.source) +
          " → " +
          state.atlas.label(edge.target) +
          " · " +
          edge.kind +
          (edge.count > 1 ? " ×" + edge.count : "")
        );
      }

      function renderInspector() {
        const selection = state.selection;
        const view = state.view || currentView();
        const isProject = selection.type === "project";
        const feature = selection.type === "feature" ? selection.feature : null;
        const selected = selection.type === "node" ? selectedViewNode() : null;
        const raw = selected ? rawNode(selected.id) : null;
        const module = selected?.kind === "module"
          ? state.atlas.moduleById?.get(Number(selected.id))
          : null;
        $("inspector-badge").textContent = isProject
          ? "PROJECT · LIVE"
          : feature
            ? "FEATURE · " + feature.tag
            : module
              ? "MODULE · READY"
            : (selected?.kind || "SYMBOL").toUpperCase() + " · LIVE";
        $("inspector-title").textContent = isProject
          ? state.atlas.name
          : feature
            ? feature.name
            : module
              ? module.label
            : selected?.label || "Selection";
        $("inspector-namespace").textContent = isProject
          ? "local.checkout"
          : feature
            ? "cross-cutting." + feature.id
            : module
              ? "module." + module.tag.toLowerCase()
            : (raw?.file || "local.scope") + (raw?.line ? ":" + raw.line : "");
        $("inspector-desc").textContent = isProject
          ? "A live architecture map of this checkout. Every route ends at a real symbol or source file."
          : feature
            ? feature.detail + ". Hover the view to trace participating files."
            : module
              ? module.description + ". Click a source below to inspect the actual checkout."
            : selected?.outside
              ? "This relation leaves the current scope. Open the connected file from the root view."
              : "A source-backed symbol in " + currentScopeLabel() + ".";
        const stats = state.atlas.stats || {};
        const metrics = isProject
          ? [
              ["Files", stats.files || 0],
              ["Symbols", stats.nodes || 0],
              ["Relations", stats.edges || 0],
              ["Functions", stats.functions || 0],
              ["Parse errors", stats.errors || 0],
            ]
          : feature
            ? [
                ["Kind", "feature"],
                ["Linked files", feature.modules.length],
                ["Status", "live"],
              ]
            : module
              ? [
                  ["Kind", "module"],
                  ["Files", module.fileIds.length],
                  ["Parts", module.parts],
                  ["Status", "ready"],
                ]
            : [
                ["Kind", raw?.kind || selected?.kind || "symbol"],
                ["Line", raw?.line || "—"],
                ["Child symbols", selected?.children || 0],
              ];
        $("metrics").innerHTML = metrics
          .map(
            (pair) =>
              '<div class="metric-row"><span>' +
              esc(pair[0]) +
              "</span><strong>" +
              esc(pair[1]) +
              "</strong></div>",
          )
          .join("");
        const entries = sourceEntries(selection);
        $("sources").innerHTML = entries.length
          ? entries
              .map(
                (entry, index) =>
                  '<div class="source-item" data-source-index="' +
                  index +
                  '">' +
                  esc(entry.label) +
                  "</div>",
              )
              .join("")
          : '<div class="empty-state">No source references</div>';
        $("sources")
          .querySelectorAll("[data-source-index]")
          .forEach((element) => {
            const entry = entries[Number(element.dataset.sourceIndex)];
            element.addEventListener("click", () =>
              loadSource(entry.file, entry.line),
            );
          });
        const relationEdges = isProject
          ? view.edges.slice(0, 12)
          : selected
            ? view.edges.filter(
                (edge) =>
                  edge.source === selected.id || edge.target === selected.id,
              )
            : view.edges.slice(0, 12);
        $("relations").innerHTML = relationEdges.length
          ? relationEdges
              .slice(0, 12)
              .map(
                (edge) =>
                  '<div class="relation-item"><span class="relation-kind">' +
                  esc(edge.kind) +
                  "</span> · " +
                  esc(relationText(edge)) +
                  "</div>",
              )
              .join("")
          : '<div class="empty-state">No direct relations in this scope</div>';
      }

      async function loadSource(file, line) {
        const preview = $("source-preview");
        preview.textContent = "Loading " + file + ":" + line + "…";
        try {
          const response = await fetch(
            "/api/source?file=" +
              encodeURIComponent(file) +
              "&line=" +
              encodeURIComponent(line),
          );
          if (!response.ok) throw new Error("source endpoint unavailable");
          const payload = await response.json();
          const first = payload.start || line;
          preview.textContent =
            payload.file +
            "  (" +
            first +
            "–" +
            (first + payload.lines.length - 1) +
            " / " +
            payload.total +
            ")\n\n" +
            payload.lines
              .map(
                (text, index) =>
                  String(first + index).padStart(4) + "  " + text,
              )
              .join("\n");
        } catch (error) {
          preview.textContent =
            file +
            ":" +
            line +
            "\n\nSource preview is available while the live agent server is running.";
        }
      }

      function updateHeader() {
        const stats = state.atlas.stats || {};
        $("stage-title").textContent = state.atlas.name || "Code Atlas";
        $("stage-status").textContent =
          activeScope() === null ? "LIVE" : "SCOPE";
        $("stage-desc").textContent =
          activeScope() === null
            ? "A source-backed architecture map: modules, calls, imports, and evidence stay attached to their files."
            : "Inside " +
              currentScopeLabel() +
              " · local symbols, external ports, and evidence paths.";
        $("stats-summary").textContent =
          (stats.files || 0) +
          " files · " +
          (stats.nodes || 0) +
          " symbols · " +
          (stats.edges || 0) +
          " relations · " +
          (stats.errors || 0) +
          " parse errors";
        $("inspector-panel").setAttribute("data-scope", currentScopeLabel());
      }

      function renderAll() {
        if (!state.atlas) return;
        const view = currentView();
        updateHeader();
        renderLegend(view);
        renderTopology(view);
        renderFeatures();
        renderInspector();
        if (state.selection.type === "feature")
          requestAnimationFrame(() => setFeatureHover(state.selection.feature));
      }

      function selectNode(node) {
        state.selection = { type: "node", id: Number(node.id) };
        renderInspector();
        shadow.querySelectorAll(".module-card")
          .forEach((card) =>
            card.classList.toggle(
              "selected",
              card.dataset.nodeId === String(node.id),
            ),
          );
      }

      function selectFeature(feature) {
        state.selection = { type: "feature", feature };
        renderFeatures();
        renderInspector();
        setFeatureHover(feature);
      }

      function transition(callback) {
        host.classList.add("is-transitioning");
        window.setTimeout(() => {
          callback();
          renderAll();
          requestAnimationFrame(() =>
            host.classList.remove("is-transitioning"),
          );
        }, 130);
      }

      function goInto(id) {
        const numericId = Number(id);
        if (!canDrill(numericId)) return selectNode({ id: numericId });
        transition(() => {
          state.scopeStack.push(numericId);
          state.selection = { type: "node", id: numericId };
        });
      }

      // Returns whether it consumed the step, so the shell knows if Esc is still its own.
      function goBack() {
        if (!state.scopeStack.length) {
          state.selection = { type: "project" };
          renderInspector();
          return false;
        }
        transition(() => {
          state.scopeStack.pop();
          state.selection = state.scopeStack.length
            ? {
                type: "node",
                id: state.scopeStack[state.scopeStack.length - 1],
              }
            : { type: "project" };
        });
      }

      async function loadGraph(repo, build) {
        $("build-button").disabled = true;
        $("stage-status").textContent = build ? "BUILDING" : "LOADING";
        try {
          const options = build
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo }),
              }
            : {};
          const response = await fetch(
            build ? "/api/build" : "/api/graph",
            options,
          );
          if (!response.ok)
            throw new Error("graph endpoint returned HTTP " + response.status);
          setGraph(await response.json());
          $("stage-status").textContent = "LIVE";
        } catch (error) {
          $("stage-status").textContent = "ERROR";
          $("stage-desc").textContent = error.message;
        } finally {
          $("build-button").disabled = false;
        }
      }

      function mount(element) {
        host = element;
        shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("link");
        style.rel = "stylesheet";
        style.href = "atlas.css";
        shadow.append(
          style,
          document.getElementById("atlas-markup").content.cloneNode(true),
        );
        $("build-button").addEventListener("click", () =>
          loadGraph($("repo-input").value.trim() || ".", true),
        );
        $("repo-input").addEventListener("keydown", (event) => {
          if (event.key === "Enter")
            loadGraph($("repo-input").value.trim() || ".", true);
        });
        $("search-input").addEventListener("input", (event) => {
          state.query = event.target.value;
          applyQuery();
        });
        window.addEventListener("resize", () => {
          if (state.atlas && host.offsetWidth) renderAll();
        });
        // The pane has no layout while the chat view is showing, so the first
        // render has to wait for the stylesheet and for a real box to measure.
        style.addEventListener("load", () => loadGraph(".", false));
      }

      window.AtlasView = {
        mount,
        show: () => {
          if (state.atlas) renderAll();
        },
        escape: goBack,
        refresh: () => loadGraph(".", false),
      };
})();
