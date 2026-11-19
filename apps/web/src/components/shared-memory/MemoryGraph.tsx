import type { SharedMemorySnapshot } from "@agenteschat/client";
import {
  filterMemoryGraph,
  layoutMemoryGraph,
  type MemoryGraphFilter,
  type MemoryGraphNode,
} from "@agenteschat/client/lib/shared-memory-graph";
import { Button, Chip, EmptyState, Icon, type IconName, SearchField, Select, Toolbar } from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const icons: Record<MemoryGraphNode["kind"], IconName> = { entry: "bulb", source: "book", workspace: "members" };

export function MemoryGraph({
  graph,
  inspect,
}: {
  graph: SharedMemorySnapshot["graph"];
  inspect: (node: MemoryGraphNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryGraphFilter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const [zoom, setZoom] = useState(0.8);
  const viewport = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const shown = filterMemoryGraph(graph, query, kind);
  const layout = layoutMemoryGraph(shown);
  const picked = shown.nodes.find((node) => node.id === selected);
  const related = picked ? shown.edges.filter((edge) => edge.from === picked.id || edge.to === picked.id) : [];
  const byId = new Map(shown.nodes.map((node) => [node.id, node]));
  const neighbors = new Set(related.flatMap((edge) => [edge.from, edge.to]));
  const choose = (node: MemoryGraphNode) => setSelected((current) => (current === node.id ? null : node.id));
  const focusNode = (id: string) => {
    setSelected(id);
    viewport.current?.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
  };
  return (
    <section className="sm-graph" aria-labelledby="sm-graph-title">
      <div className="sm-section-head">
        <div>
          <h2 id="sm-graph-title">{t("sharedMemory.graphTitle")}</h2>
          <p className="small muted">{t("sharedMemory.graphHelp")}</p>
        </div>
        <Button size="sm" onClick={() => setList(!list)} icon={list ? "bulb" : "list"}>
          {t(list ? "sharedMemory.graphCanvas" : "sharedMemory.graphList")}
        </Button>
      </div>
      <Toolbar
        search={
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
            clearLabel={t("sharedMemory.clear")}
            aria-label={t("sharedMemory.graphSearch")}
            placeholder={t("sharedMemory.graphSearch")}
          />
        }
      >
        <Select
          size="sm"
          aria-label={t("sharedMemory.graphFilter")}
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "all", label: t("sharedMemory.graphAll") },
            { value: "entry", label: t("sharedMemory.graphEntries") },
            { value: "source", label: t("sharedMemory.graphSources") },
            { value: "workspace", label: t("sharedMemory.graphWorkspaces") },
          ]}
        />
      </Toolbar>
      <div className="sm-graph__bar">
        <span className="small muted" role="status">
          {t("sharedMemory.graphNodes", { nodes: shown.nodes.length, edges: shown.edges.length })}
        </span>
        {!list && (
          <div className="sm-graph__zoom">
            <Button
              size="sm"
              aria-label={t("sharedMemory.zoomOut")}
              disabled={zoom <= 0.4}
              onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
            >
              −
            </Button>
            <span aria-live="polite">{t("sharedMemory.zoom", { percent: Math.round(zoom * 100) })}</span>
            <Button
              size="sm"
              icon="plus"
              aria-label={t("sharedMemory.zoomIn")}
              disabled={zoom >= 1.8}
              onClick={() => setZoom((z) => Math.min(1.8, z + 0.2))}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              aria-label={t("sharedMemory.zoomReset")}
              onClick={() => {
                setZoom(0.8);
                viewport.current?.scrollTo({ top: 0, left: 0 });
              }}
            />
          </div>
        )}
      </div>
      {shown.nodes.length === 0 ? (
        <EmptyState icon="search">{t("sharedMemory.graphEmpty")}</EmptyState>
      ) : (
        <div className="sm-graph__body">
          {list ? (
            <ul className="sm-graph__list">
              {shown.nodes.map((node) => (
                <li key={node.id}>
                  <Button variant="link" onClick={() => choose(node)} aria-pressed={picked?.id === node.id}>
                    <Icon name={icons[node.kind]} />
                    {node.label}
                  </Button>
                  <span className="small muted">{t(`sharedMemory.graphNode.${node.kind}`)}</span>
                  <ul>
                    {shown.edges
                      .filter((edge) => edge.from === node.id)
                      .map((edge) => (
                        <li key={`${edge.to}:${edge.kind}`}>
                          <span>{t(`sharedMemory.graphEdge.${edge.kind}`)}</span>
                          <Button variant="link" onClick={() => setSelected(edge.to)}>
                            {byId.get(edge.to)?.label}
                          </Button>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <div className="sm-graph__viewport" ref={viewport} aria-describedby={helpId}>
              <div style={{ width: layout.width * zoom, height: layout.height * zoom }} className="sm-graph__extent">
                <div
                  className="sm-graph__canvas"
                  style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
                >
                  <svg className="sm-graph__edges" width={layout.width} height={layout.height} aria-hidden="true">
                    {shown.edges.map((edge) => {
                      const from = layout.positions.get(edge.from);
                      const to = layout.positions.get(edge.to);
                      if (!from || !to) return null;
                      const right = to.x > from.x;
                      const x1 = from.x + (right ? from.width : 0);
                      const x2 = to.x + (right ? 0 : to.width);
                      const y1 = from.y + from.height / 2;
                      const y2 = to.y + to.height / 2;
                      const bend = Math.max(64, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
                      return (
                        <path
                          key={`${edge.from}:${edge.to}:${edge.kind}`}
                          d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
                          className={`sm-graph__edge sm-graph__edge--${edge.kind}`}
                          data-selected={
                            picked && (picked.id === edge.from || picked.id === edge.to) ? true : undefined
                          }
                          data-muted={picked && picked.id !== edge.from && picked.id !== edge.to ? true : undefined}
                        />
                      );
                    })}
                  </svg>
                  {shown.nodes.map((node) => {
                    const position = layout.positions.get(node.id);
                    if (!position) return null;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`sm-graph__node sm-graph__node--${node.kind}`}
                        data-node-id={node.id}
                        data-muted={picked && !neighbors.has(node.id) && picked.id !== node.id ? true : undefined}
                        aria-pressed={picked?.id === node.id}
                        onClick={() => choose(node)}
                        style={
                          {
                            left: position.x,
                            top: position.y,
                            width: position.width,
                            minHeight: position.height,
                          } as CSSProperties
                        }
                      >
                        <span className="sm-graph__node-kind">
                          <Icon name={icons[node.kind]} size={16} />
                          {t(`sharedMemory.graphNode.${node.kind}`)}
                        </span>
                        <strong>{node.label}</strong>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <aside className="sm-graph__inspector" aria-live="polite">
            {picked ? (
              <>
                <Chip icon={icons[picked.kind]}>{t(`sharedMemory.graphNode.${picked.kind}`)}</Chip>
                <h3>{picked.label}</h3>
                {inspect(picked)}
                {related.length > 0 && (
                  <>
                    <h4>{t("sharedMemory.graphRelated")}</h4>
                    <ul className="sm-graph__connections">
                      {related.map((edge) => {
                        const other = byId.get(edge.from === picked.id ? edge.to : edge.from);
                        if (!other) return null;
                        return (
                          <li key={`${edge.from}:${edge.to}:${edge.kind}`}>
                            <span className="small muted">{t(`sharedMemory.graphEdge.${edge.kind}`)}</span>
                            <Button variant="link" onClick={() => focusNode(other.id)}>
                              {other.label}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <div className="sm-graph__select">
                <Icon name="bulb" size={20} />
                <p>{t("sharedMemory.graphSelect")}</p>
              </div>
            )}
          </aside>
        </div>
      )}
      <p id={helpId} className="small muted">
        {t("sharedMemory.graphKeyboard")}
      </p>
    </section>
  );
}
