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

  // The root view is intentionally a small architecture map rather than a
  // dump of every function.  Files are grouped into responsibilities using
  // names that can be inferred from any checkout; the raw graph remains the
  // source of truth behind every module.
  function moduleSpec(file) {
    const path = String(file.file || file.name || "").toLowerCase();
    if (/studio/.test(path)) {
      return { label: "Studio shell", tag: "SHELL", description: "chat surface, sessions, and the view switch" };
    }
    if (/atlas_view/.test(path)) {
      return { label: "Atlas view", tag: "VIEW", description: "mounted repository graph and inspector" };
    }
    if (/atlas_graph/.test(path)) {
      return { label: "Graph canvas", tag: "CANVAS", description: "layout and routed connections" };
    }
    if (/\.(html?|css|tsx?|jsx?)$/.test(path)) {
      return { label: "Interface", tag: "SURFACE", description: "browser and presentation files" };
    }
    if (/(^|\/)(test|tests|spec|specs)(\/|$)|visual_regression|benchmark/.test(path)) {
      return { label: "Verification", tag: "CHECKS", description: "tests and quality checks" };
    }
    if (/readme|design|requirement|\.md$|\.txt$|\.gitignore/.test(path)) {
      return { label: "Project docs", tag: "DOCS", description: "project notes and configuration" };
    }
    if (/language|parser|syntax|grammar|tree.?sitter/.test(path)) {
      return { label: "Language parser", tag: "PARSER", description: "language extraction rules" };
    }
    if (/graph|atlas|index|model/.test(path)) {
      return { label: "Graph engine", tag: "GRAPH", description: "relationships, layout, and indexing" };
    }
    if (/agent|runner|server|api|service|tool/.test(path)) {
      return { label: "Agent runtime", tag: "AGENT", description: "agent loop and local tools" };
    }
    return { label: "Project core", tag: "CORE", description: "application source" };
  }

  function makeModules(files, rawNodes, fileId) {
    const buckets = new Map();
    files.forEach((file) => {
      const spec = moduleSpec(file);
      const bucket = buckets.get(spec.label) || { ...spec, fileIds: [] };
      bucket.fileIds.push(file.id);
      buckets.set(spec.label, bucket);
    });
    const ordered = [...buckets.values()].sort((a, b) => {
      const order = ["Interface", "Project docs", "Agent runtime", "Verification", "Graph engine", "Language parser", "Graph canvas", "Legacy view", "Project core"];
      return order.indexOf(a.label) - order.indexOf(b.label) || a.label.localeCompare(b.label);
    });
    const moduleByFile = new Map();
    const modules = ordered.map((bucket, index) => {
      const id = -(index + 1);
      const fileSet = new Set(bucket.fileIds);
      const members = rawNodes.filter((node) => fileSet.has(fileId(node.id)));
      bucket.fileIds.forEach((file) => moduleByFile.set(file, id));
      return {
        id,
        label: bucket.label,
        name: bucket.label,
        kind: "module",
        tag: bucket.tag,
        description: bucket.description,
        fileIds: [...bucket.fileIds],
        files: files.filter((file) => fileSet.has(file.id)).map((file) => file.file || file.name),
        members: members.map((node) => node.id),
        children: bucket.fileIds.length,
        parts: Math.max(bucket.fileIds.length, members.filter((node) => node.kind !== "file").length),
        file: bucket.fileIds[0],
        line: 1,
      };
    });
    const moduleById = new Map(modules.map((module) => [module.id, module]));
    return { modules, moduleByFile, moduleById };
  }

  function projectView(mode, context) {
    const { source, rawNodes, rawEdges, byId, files, fileId } = context;
    const architecture = mode !== "files";
    const nodes = architecture ? context.modules : context.files;
    const endpoint = architecture
      ? (id) => context.moduleOfRaw(id)
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
    const { byId, children, rawEdges, fileId, moduleById, moduleOfRaw } = context;
    const selected = byId.get(rawId);
    const module = moduleById.get(rawId);
    if (module) {
      const localFiles = new Set(module.fileIds);
      const touching = rawEdges.filter((edge) => {
        if (edge.kind === NON_RELATION) return false;
        return localFiles.has(fileId(edge.source)) || localFiles.has(fileId(edge.target));
      });
      const endpoint = (id) => {
        const file = fileId(id);
        return localFiles.has(file) ? file : moduleOfRaw(id);
      };
      const edgeGroups = aggregateEdges(touching, endpoint, byId);
      const used = new Set(module.fileIds);
      edgeGroups.forEach((edge) => { used.add(edge.source); used.add(edge.target); });
      const nodes = [...used].map((id) => {
        if (localFiles.has(id)) return viewNode(id, byId, children, [id, ...descendants(id, children)]);
        const outside = moduleById.get(id);
        return outside ? { ...outside, outside: true } : undefined;
      }).filter(Boolean);
      return {
        title: `Inside ${module.label}`,
        scopeId: rawId,
        mode: "scope",
        nodes,
        edges: edgeGroups,
        stats: { module: module.label, files: module.fileIds.length, members: module.members.length }
      };
    }
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
    const moduleData = makeModules(files, rawNodes, fileId);
    const moduleOfRaw = (id) => moduleData.moduleByFile.get(fileId(id));
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
      modules: moduleData.modules,
      moduleById: moduleData.moduleById,
      moduleOfRaw,
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
      modules: context.modules,
      moduleById: context.moduleById,
      moduleOfRaw: context.moduleOfRaw,
      projectView: (mode = "architecture") => projectView(mode, context),
      scopeView: (rawId) => scopeView(rawId, context),
      label: (rawId) => context.moduleById.get(rawId)?.label || qualifiedLabel(rawId, byId),
      ancestors: (rawId) => {
        if (context.moduleById.has(rawId)) return [rawId];
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

  function moduleLayout(view, width, height = 600) {
    const compact = height < 420 || width < 760;
    const cardWidth = Math.min(210, Math.max(140, (width - 80) / 3));
    const cardHeight = compact ? 64 : 76;
    const columns = width >= 500 ? 3 : width >= 320 ? 2 : 1;
    const gap = columns === 1
      ? 0
      : Math.max(22, Math.min(70, (width - columns * cardWidth) / (columns - 1)));
    const rowStep = compact ? 70 : 112;
    const nodes = (view?.nodes || []).slice();
    const edges = (view?.edges || []).filter((edge) => edge.source !== edge.target);
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    edges.forEach((edge) => {
      degree.set(edge.source, (degree.get(edge.source) || 0) + edge.count);
      degree.set(edge.target, (degree.get(edge.target) || 0) + edge.count);
    });
    function rank(node) {
      const label = String(node.label || "");
      if (/Interface|Project docs/i.test(label)) return 0;
      if (/Agent runtime|Verification/i.test(label)) return 1;
      if (/Graph engine|Graph canvas/i.test(label)) return 2;
      if (/Language parser|Legacy view/i.test(label)) return 3;
      return 1;
    }
    const buckets = new Map();
    nodes.sort((a, b) => rank(a) - rank(b) || (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || a.id - b.id);
    nodes.forEach((node) => {
      const key = rank(node);
      const bucket = buckets.get(key) || [];
      bucket.push(node);
      buckets.set(key, bucket);
    });
    const contentWidth = Math.max(width, columns * cardWidth + (columns - 1) * gap);
    const positioned = new Map();
    let row = 0;
    [...buckets.keys()].sort((a, b) => a - b).forEach((key) => {
      const bucket = buckets.get(key) || [];
      for (let offset = 0; offset < bucket.length; offset += columns) {
        const group = bucket.slice(offset, offset + columns);
        const rowWidth = group.length * cardWidth + (group.length - 1) * gap;
        const start = Math.max(compact ? 0 : 40, (contentWidth - rowWidth) / 2);
        group.forEach((node, column) => {
          positioned.set(node.id, { ...node, x: start + column * (cardWidth + gap), y: (compact ? 12 : 24) + row * rowStep, width: cardWidth, height: cardHeight });
        });
        row += 1;
      }
    });
    const routed = [];
    edges.forEach((edge) => {
      const source = positioned.get(edge.source);
      const target = positioned.get(edge.target);
      if (!source || !target) return;
      const lanes = Math.min(6, Math.max(1, edge.count));
      for (let lane = 0; lane < lanes; lane += 1) {
        const offset = (lane - (lanes - 1) / 2) * 10;
        const down = target.y > source.y;
        const points = [];
        if (down) {
          const start = [source.x + source.width / 2 + offset, source.y + source.height];
          const end = [target.x + target.width / 2 + offset, target.y];
          const mid = (start[1] + end[1]) / 2;
          const bundle = (Math.abs(edge.source * 37 + edge.target * 17) % 7 - 3) * 18;
          const laneX = Math.max(24, Math.min(contentWidth - 24, start[0] + (end[0] - start[0]) * 0.3 + bundle + offset * 1.6));
          points.push(start, [start[0], start[1] + 18], [laneX, mid], [end[0], end[1] - 18], end);
        } else {
          const start = [source.x + source.width / 2 + offset, source.y];
          const end = [target.x + target.width / 2 + offset, target.y + target.height];
          const mid = (start[1] + end[1]) / 2;
          const bundle = (Math.abs(edge.source * 37 + edge.target * 17) % 7 - 3) * 18;
          const laneX = Math.max(24, Math.min(contentWidth - 24, start[0] + (end[0] - start[0]) * 0.3 + bundle + offset * 1.6));
          points.push(start, [start[0], start[1] - 18], [laneX, mid], [end[0], end[1] + 18], end);
        }
        const routedPoints = compactPoints(points);
        const middle = routedPoints[Math.floor(routedPoints.length / 2)] || [0, 0];
        routed.push({ ...edge, lane, lanes, bundle: edge.id, points: routedPoints, path: roundedPath(routedPoints), badge: { x: middle[0], y: middle[1] } });
      }
    });
    return { nodes: [...positioned.values()], edges: routed, width: contentWidth, height: Math.max(compact ? 252 : 300, (compact ? 28 : 44) + row * rowStep), moduleMode: true };
  }

  function layout(view, options = {}) {
    const width = Math.max(360, Number(options.width) || 1000);
    if (view?.mode === "architecture") return moduleLayout(view, width, Number(options.height) || 600);
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
