import type { SharedMemorySnapshot } from "../shared-memory/types";

export type MemoryGraph = SharedMemorySnapshot["graph"];
export type MemoryGraphNode = MemoryGraph["nodes"][number];
export type MemoryGraphFilter = "all" | MemoryGraphNode["kind"];
export interface MemoryGraphPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Only actual recorded edges survive. Searching includes one hop so the matching claim keeps its evidence. */
export function filterMemoryGraph(graph: MemoryGraph, query: string, kind: MemoryGraphFilter): MemoryGraph {
  const known = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  const q = query.trim().toLocaleLowerCase();
  if (!q && kind === "all") return { nodes: graph.nodes, edges };
  const matches = new Set(
    graph.nodes
      .filter((node) => (kind === "all" || node.kind === kind) && (!q || node.label.toLocaleLowerCase().includes(q)))
      .map((node) => node.id),
  );
  const included = new Set(matches);
  for (const edge of edges) {
    if (matches.has(edge.from) || matches.has(edge.to)) {
      included.add(edge.from);
      included.add(edge.to);
    }
  }
  return {
    nodes: graph.nodes.filter((node) => included.has(node.id)),
    edges: edges.filter((edge) => included.has(edge.from) && included.has(edge.to)),
  };
}

/** A stable evidence map: original sources left, memories in the middle, destinations right. No inferred edges. */
export function layoutMemoryGraph(graph: MemoryGraph) {
  const byKind = (kind: MemoryGraphNode["kind"]) =>
    graph.nodes
      .filter((node) => node.kind === kind)
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const entries = byKind("entry");
  const sources = byKind("source");
  const workspaces = byKind("workspace");
  const width = 1200;
  const nodeWidth = 184;
  const positions = new Map<string, MemoryGraphPosition>();
  const heightOf = (node: MemoryGraphNode) => {
    // CJK and emoji occupy about twice a Latin character's width; preserve hard line breaks too.
    const lines = node.label.split(/\r?\n/).reduce((sum, line) => {
      const units = Array.from(line).reduce(
        (width, character) => width + ((character.codePointAt(0) ?? 0) > 255 ? 2 : 1),
        0,
      );
      return sum + Math.max(1, Math.ceil(units / 20));
    }, 0);
    return Math.max(88, 44 + lines * 20);
  };
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(entries.length))));
  let entryY = 72;
  for (let row = 0; row < Math.ceil(entries.length / columns); row++) {
    const batch = entries.slice(row * columns, (row + 1) * columns);
    const height = Math.max(...batch.map(heightOf));
    batch.forEach((node, column) => {
      positions.set(node.id, { x: 270 + column * 220, y: entryY, width: nodeWidth, height });
    });
    entryY += height + 48;
  }
  const stackHeight = (nodes: MemoryGraphNode[]) => nodes.reduce((sum, node) => sum + heightOf(node) + 48, 72);
  const height = Math.max(560, entryY, stackHeight(sources), stackHeight(workspaces));
  const placeSide = (nodes: MemoryGraphNode[], x: number) => {
    const contentHeight = nodes.reduce((sum, node) => sum + heightOf(node), 0);
    const gap = Math.max(48, (height - 96 - contentHeight) / Math.max(1, nodes.length));
    let y = 48 + gap / 2;
    for (const node of nodes) {
      const h = heightOf(node);
      positions.set(node.id, { x, y, width: nodeWidth, height: h });
      y += h + gap;
    }
  };
  placeSide(sources, 28);
  placeSide(workspaces, 988);
  return { width, height, positions };
}

/** Source references are data. Only ordinary web links and app-local paths become clickable. */
export function memorySourceHref(reference: string | null): string | null {
  if (
    !reference ||
    Array.from(reference).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return null;
  if (reference.startsWith("/") && !reference.startsWith("//") && !reference.includes("\\")) return reference;
  try {
    const url = new URL(reference);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
