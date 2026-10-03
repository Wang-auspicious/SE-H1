/*
 * A small, deterministic view model for CodeGraph.
 * The renderer only receives views and routed paths; it never needs to know
 * about parser parent chains or graph-specific numeric ids.
 */
(function attachAtlasGraph(global) {
  "use strict";

  const NON_RELATION = "contains";
  const DEFAULT_CARD_WIDTH = 188;
  const DEFAULT_CARD_HEIGHT = 78;

  function asGraph(graph) {
    const source = graph || {};
    const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
    const rawEdges = Array.isArray(source.edges) ? source.edges : [];
    return { source, rawNodes, rawEdges };
  }

  function makeNodeMap(nodes) {
    return new Map(nodes.map((node) => [node.id, node]));
  }

  function makeChildren(nodes) {
    const children = new Map(nodes.map((node) => [node.id, []]));
    nodes.forEach((node) => {
      if (node.parent !== undefined && children.has(node.parent)) {
        children.get(node.parent).push(node.id);
      }
    });
    children.forEach((list) => list.sort((a, b) => a - b));
    return children;
  }

  function makeFileLookup(nodes, byId) {
    const cache = new Map();
    function fileId(id) {
      if (cache.has(id)) return cache.get(id);
      const seen = new Set();
      let current = byId.get(id);
      while (current && current.kind !== "file") {
        if (seen.has(current.id)) return undefined;
        seen.add(current.id);
        current = byId.get(current.parent);
      }
      const result = current ? current.id : undefined;
      cache.set(id, result);
      return result;
    }
    nodes.forEach((node) => fileId(node.id));
    return fileId;
  }

  function descendants(id, children) {
    const result = [];
    const pending = [...(children.get(id) || [])];
    let cursor = 0;
    while (cursor < pending.length) {
      const child = pending[cursor++];
      result.push(child);
      pending.push(...(children.get(child) || []));
    }
    return result;
  }

  function topSymbolId(id, byId, children) {
    let node = byId.get(id);
    if (!node) return undefined;
    if (node.kind === "file") return node.id;
    let parent = byId.get(node.parent);
    while (parent && parent.kind !== "file") {
      node = parent;
      parent = byId.get(node.parent);
    }
    return node.id;
  }

  function qualifiedLabel(id, byId) {
    const node = byId.get(id);
    if (!node) return String(id);
    if (node.kind === "file") return node.file || node.name;
    const parts = [node.name];
    let parent = byId.get(node.parent);
    while (parent && parent.kind !== "file") {
      parts.unshift(parent.name);
      parent = byId.get(parent.parent);
    }
    return parts.join(".");
  }

  function viewNode(rawId, byId, children, members, outside) {
    const node = byId.get(rawId);
    if (!node) return undefined;
    const allMembers = members || [rawId, ...descendants(rawId, children)];
    return {
      id: rawId,
      label: qualifiedLabel(rawId, byId),
      kind: node.kind,
      file: node.file,
      line: node.line,
      end: node.end,
      children: (children.get(rawId) || []).length,
      members: [...new Set(allMembers)],
      outside: Boolean(outside)
    };
  }

  function aggregateEdges(edges, endpoint, byId, edgeFilter) {
    const groups = new Map();
    edges.forEach((edge) => {
      if (edge.kind === NON_RELATION || !byId.has(edge.source) || !byId.has(edge.target)) return;
      if (edgeFilter && !edgeFilter(edge)) return;
      const source = endpoint(edge.source);
      const target = endpoint(edge.target);
      if (source === undefined || target === undefined || source === target) return;
      const key = `${source}:${target}:${edge.kind || "related"}`;
      let group = groups.get(key);
      if (!group) {
        group = { id: key, source, target, kind: edge.kind || "related", count: 0, sites: [] };
        groups.set(key, group);
      }
      group.count += 1;
      group.sites.push(edge);
    });
    return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  function fileRoots(files, byId, children) {
    const roots = [];
    files.forEach((file) => {
      const direct = children.get(file.id) || [];
      if (direct.length) {
        direct.forEach((id) => roots.push(viewNode(id, byId, children)));
      } else {
        roots.push(viewNode(file.id, byId, children));
      }
    });
    return roots.filter(Boolean);
  }

  function fileView(files, byId, children) {
    return files.map((file) => viewNode(
      file.id,
      byId,
      children,
      [file.id, ...descendants(file.id, children)]
    )).filter(Boolean);
  }

  function projectView(mode, context) {
    const { source, rawNodes, rawEdges, byId, children, files, fileId } = context;
    const architecture = mode !== "files";
    const nodes = architecture ? context.roots : context.files;
    const endpoint = architecture
      ? (id) => context.rootEndpoint(id)
      : (id) => fileId(id);
    const edges = aggregateEdges(rawEdges, endpoint, byId);
    return {
      title: source.name || "Code Atlas",
      scopeId: null,
      mode: architecture ? "architecture" : "files",
      nodes,
      edges,
      stats: source.stats || {},
      rawNodes: rawNodes.length
    };
  }

  function scopeView(rawId, context) {
    const { byId, children, rawEdges, fileId } = context;
    const selected = byId.get(rawId);
    if (!selected) return { title: "Unknown scope", scopeId: rawId, nodes: [], edges: [] };
    const direct = children.get(rawId) || [];
    const local = new Set(direct);
    const localIds = new Set([rawId, ...descendants(rawId, children)]);
    const hasChild = direct.length > 0;
    const endpoint = (id) => {
      if (id === rawId) return rawId;
      if (localIds.has(id)) {
        let current = byId.get(id);
        while (current && current.parent !== rawId) current = byId.get(current.parent);
        return current ? current.id : rawId;
      }
      return id;
    };
    const touching = rawEdges.filter((edge) => {
      if (edge.kind === NON_RELATION) return false;
      return localIds.has(edge.source) || localIds.has(edge.target);
    });
    const edgeGroups = aggregateEdges(touching, endpoint, byId);
    const used = new Set();
    edgeGroups.forEach((edge) => { used.add(edge.source); used.add(edge.target); });
    if (!hasChild) used.add(rawId);
    if (selected.kind === "file") used.add(rawId);
    const nodes = [...used].map((id) => {
      const outside = id !== rawId && !local.has(id);
      const member = byId.get(id);
      const isNestedLocal = local.has(id);
      return viewNode(
        id,
        byId,
        children,
        isNestedLocal ? [id, ...descendants(id, children)] : undefined,
        outside && !localIds.has(id)
      );
    }).filter(Boolean);
    const seen = new Set(nodes.map((node) => node.id));
    direct.forEach((id) => {
      if (!seen.has(id)) nodes.push(viewNode(id, byId, children));
    });
    return {
      title: `Inside ${qualifiedLabel(rawId, byId)}`,
      scopeId: rawId,
      nodes,
      edges: edgeGroups,
      stats: { file: fileId(rawId), members: descendants(rawId, children).length }
    };
  }

  function model(graph) {
    const { source, rawNodes, rawEdges } = asGraph(graph);
    const byId = makeNodeMap(rawNodes);
    const children = makeChildren(rawNodes);
    const fileId = makeFileLookup(rawNodes, byId);
    const files = rawNodes.filter((node) => node.kind === "file").sort((a, b) => a.id - b.id);
    const roots = fileRoots(files, byId, children);
    const rootByFile = new Map();
    files.forEach((file) => {
      const direct = children.get(file.id) || [];
      rootByFile.set(file.id, direct.length ? direct[0] : file.id);
    });
    const rootEndpoint = (id) => {
      const file = fileId(id);
      if (file !== undefined && byId.get(id)?.kind === "file") return rootByFile.get(file);
      return topSymbolId(id, byId, children);
    };
    const context = {
      source,
      rawNodes,
      rawEdges,
      byId,
      children,
      files: fileView(files, byId, children),
      roots,
      fileId,
      rootEndpoint
    };
    const api = {
      name: source.name || "Code Atlas",
      stats: source.stats || {},
      rawNodes: byId,
      rawEdges: [...rawEdges],
      roots,
      files: context.files,
      projectView: (mode = "architecture") => projectView(mode, context),
      scopeView: (rawId) => scopeView(rawId, context),
      label: (rawId) => qualifiedLabel(rawId, byId),
      ancestors: (rawId) => {
        const result = [];
        let current = byId.get(rawId);
        while (current) {
          result.push(current.id);
          current = byId.get(current.parent);
        }
        return result;
      }
    };
    return api;
  }

  function stronglyConnected(nodes, edges) {
    const adjacency = new Map(nodes.map((node) => [node.id, []]));
    edges.forEach((edge) => {
      if (adjacency.has(edge.source) && adjacency.has(edge.target)) adjacency.get(edge.source).push(edge.target);
    });
    let index = 0;
    const stack = [];
    const active = new Set();
    const indexes = new Map();
    const low = new Map();
    const components = [];
    function visit(id) {
      indexes.set(id, index);
      low.set(id, index++);
      stack.push(id);
      active.add(id);
      (adjacency.get(id) || []).forEach((next) => {
        if (!indexes.has(next)) {
          visit(next);
          low.set(id, Math.min(low.get(id), low.get(next)));
        } else if (active.has(next)) {
          low.set(id, Math.min(low.get(id), indexes.get(next)));
        }
      });
      if (low.get(id) !== indexes.get(id)) return;
      const component = [];
      let item;
      do {
        item = stack.pop();
        active.delete(item);
        component.push(item);
      } while (item !== id);
      components.push(component.sort((a, b) => a - b));
    }
    nodes.slice().sort((a, b) => a.id - b.id).forEach((node) => {
      if (!indexes.has(node.id)) visit(node.id);
    });
    return components;
  }

  function roundedPath(points, radius = 12) {
    if (points.length < 2) return "";
    let path = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i += 1) {
      const previous = points[i - 1];
      const current = points[i];
      const next = points[i + 1];
      const before = Math.hypot(current[0] - previous[0], current[1] - previous[1]);
      const after = Math.hypot(next[0] - current[0], next[1] - current[1]);
      const bend = Math.min(radius, before / 2, after / 2);
      const beforePoint = [
        current[0] - (current[0] - previous[0]) * bend / Math.max(before, 1),
        current[1] - (current[1] - previous[1]) * bend / Math.max(before, 1)
      ];
      const afterPoint = [
        current[0] + (next[0] - current[0]) * bend / Math.max(after, 1),
        current[1] + (next[1] - current[1]) * bend / Math.max(after, 1)
      ];
      path += ` L ${beforePoint[0]} ${beforePoint[1]} Q ${current[0]} ${current[1]} ${afterPoint[0]} ${afterPoint[1]}`;
    }
    const last = points[points.length - 1];
    path += ` L ${last[0]} ${last[1]}`;
    return path;
  }

  function compactPoints(points) {
    return points.filter((point, index) => {
      const previous = points[index - 1];
      return !previous || previous[0] !== point[0] || previous[1] !== point[1];
    });
  }

  function layout(view, options = {}) {
    const width = Math.max(360, Number(options.width) || 1000);
    const columns = Math.max(1, Math.min(8, Number(options.columns) || 4));
    const inputNodes = (view && view.nodes) || [];
    const inputEdges = (view && view.edges) || [];
    const nodeMap = new Map(inputNodes.map((node) => [node.id, node]));
    const components = stronglyConnected(inputNodes, inputEdges);
    const componentOf = new Map();
    components.forEach((component, index) => component.forEach((id) => componentOf.set(id, index)));
    const dag = new Map(components.map((_, index) => [index, new Set()]));
    inputEdges.forEach((edge) => {
      const from = componentOf.get(edge.source);
      const to = componentOf.get(edge.target);
      if (from !== undefined && to !== undefined && from !== to) dag.get(from).add(to);
    });
    const ranks = new Map();
    function rank(component) {
      if (ranks.has(component)) return ranks.get(component);
      const next = [...dag.get(component)];
      const result = next.length ? Math.max(...next.map(rank)) + 1 : 0;
      ranks.set(component, result);
      return result;
    }
    components.forEach((_, index) => rank(index));
    const buckets = new Map();
    const maximumRank = Math.max(0, ...ranks.values());
    inputNodes.slice().sort((a, b) => a.id - b.id).forEach((node) => {
      const visualRank = maximumRank - ranks.get(componentOf.get(node.id));
      const bucket = buckets.get(visualRank) || [];
      bucket.push(node);
      buckets.set(visualRank, bucket);
    });
    const cardWidth = Math.min(DEFAULT_CARD_WIDTH, Math.max(150, (width - 40 - (columns - 1) * 32) / columns));
    const cardHeight = DEFAULT_CARD_HEIGHT;
    const colGap = Math.max(28, (width - 40 - columns * cardWidth) / Math.max(1, columns - 1));
    const contentWidth = Math.max(width, 40 + columns * cardWidth + (columns - 1) * colGap);
    const rowGap = 54;
    const positioned = new Map();
    let row = 0;
    [...buckets.keys()].sort((a, b) => a - b).forEach((rankValue) => {
      const bucket = buckets.get(rankValue);
      for (let offset = 0; offset < bucket.length; offset += columns) {
        bucket.slice(offset, offset + columns).forEach((node, column) => {
          const x = 20 + column * (cardWidth + colGap);
          const y = 20 + row * (cardHeight + rowGap);
          positioned.set(node.id, { ...node, x, y, width: cardWidth, height: cardHeight });
        });
        row += 1;
      }
    });
    const pairCounts = new Map();
    inputEdges.forEach((edge) => {
      const key = `${edge.source}:${edge.target}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    });
    const pairIndex = new Map();
    const routed = inputEdges.map((edge) => {
      const source = positioned.get(edge.source);
      const target = positioned.get(edge.target);
      if (!source || !target) return { ...edge, points: [], path: "", badge: { x: 0, y: 0 } };
      const pair = `${edge.source}:${edge.target}`;
      const lane = pairIndex.get(pair) || 0;
      pairIndex.set(pair, lane + 1);
      const lanes = pairCounts.get(pair) || 1;
      const laneOffset = (lane - (lanes - 1) / 2) * 9;
      const down = target.y > source.y + source.height / 2;
      const sameRow = Math.abs(target.y - source.y) < 20;
      const points = [];
      if (sameRow) {
        const leftToRight = target.x >= source.x;
        const sourceX = leftToRight ? source.x + source.width : source.x;
        const targetX = leftToRight ? target.x : target.x + target.width;
        const sourceY = source.y + source.height / 2 + laneOffset;
        const targetY = target.y + target.height / 2 + laneOffset;
        const y = Math.min(source.y, target.y) - 28 - lane * 10;
        points.push([sourceX, sourceY], [sourceX, y], [targetX, y], [targetX, targetY]);
      } else if (down) {
        const start = [source.x + source.width / 2 + laneOffset, source.y + source.height];
        const end = [target.x + target.width / 2 + laneOffset, target.y];
        const sourceRow = Math.floor(source.y / (cardHeight + rowGap));
        const targetRow = Math.floor(target.y / (cardHeight + rowGap));
        if (targetRow - sourceRow <= 1) {
          const mid = (start[1] + end[1]) / 2;
          points.push(start, [start[0], mid], [end[0], mid], end);
        } else {
          const rail = contentWidth - 12 + (lane % 3) * 14;
          const firstGap = start[1] + rowGap / 2;
          const lastGap = end[1] - rowGap / 2;
          points.push(start, [start[0], firstGap], [rail, firstGap], [rail, lastGap], [end[0], lastGap], end);
        }
      } else {
        const start = [source.x + source.width / 2 + laneOffset, source.y];
        const end = [target.x + target.width / 2 + laneOffset, target.y + target.height];
        const rail = 12 - (lane % 3) * 14;
        const firstGap = start[1] - rowGap / 2;
        const lastGap = end[1] + rowGap / 2;
        points.push(start, [start[0], firstGap], [rail, firstGap], [rail, lastGap], [end[0], lastGap], end);
      }
      const routedPoints = compactPoints(points);
      const middle = routedPoints[Math.floor(routedPoints.length / 2)];
      return { ...edge, points: routedPoints, path: roundedPath(routedPoints), badge: { x: middle[0], y: middle[1] } };
    });
    return {
      nodes: [...positioned.values()],
      edges: routed,
      width: contentWidth,
      height: Math.max(180, 40 + row * (cardHeight + rowGap))
    };
  }

  const AtlasGraph = Object.freeze({ model, layout });
  global.AtlasGraph = AtlasGraph;
  if (typeof module !== "undefined" && module.exports) module.exports = AtlasGraph;
})(typeof globalThis !== "undefined" ? globalThis : window);
