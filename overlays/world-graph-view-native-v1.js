import { r as React, j as jsx } from "./index-world-node-native-v1.js";
import { bindNodeInteraction } from "./world-node-native-listener-v1.js";

const groupOrder = ["system", "service", "repository", "deployment", "incident", "workLog"];
const groupLabels = {
  system: "Systems",
  service: "Services",
  repository: "Repositories",
  deployment: "Deployments",
  incident: "Incidents",
  workLog: "Work logs",
};

function NativeGraphNode({ node, position, selectedId, onSelect }) {
  const nodeRef = React.useRef(null);

  React.useEffect(() => {
    const element = nodeRef.current;
    if (!element) return undefined;
    return bindNodeInteraction(element, () => onSelect(node));
  }, [node, onSelect]);

  return jsx.jsxs("g", {
    ref: nodeRef,
    className: `graph-node status-${node.status}${selectedId === node.id ? " is-selected" : ""}`,
    transform: `translate(${position.x}, ${position.y})`,
    role: "button",
    tabIndex: 0,
    "aria-label": `${node.name}, ${node.status}`,
    children: [
      jsx.jsx("rect", { x: "-64", y: "-31", width: "128", height: "62", rx: "8" }),
      jsx.jsx("circle", { cx: "-48", cy: "-15", r: "4" }),
      jsx.jsx("text", {
        className: "node-name",
        x: "0",
        y: "-5",
        textAnchor: "middle",
        children: node.name.length > 17 ? `${node.name.slice(0, 16)}…` : node.name,
      }),
      jsx.jsx("text", {
        className: "node-type",
        x: "0",
        y: "15",
        textAnchor: "middle",
        children: node.type,
      }),
    ],
  });
}

export function GraphView({ nodes, relations, selectedId, onSelect }) {
  const layout = React.useMemo(() => {
    const grouped = groupOrder
      .map((type) => ({ type, nodes: nodes.filter((node) => node.type === type) }))
      .filter((group) => group.nodes.length);
    const width = Math.max(920, grouped.length * 180 + 80);
    const tallestGroup = Math.max(1, ...grouped.map((group) => group.nodes.length));
    const height = Math.max(460, tallestGroup * 108 + 110);
    const positions = new Map();

    grouped.forEach((group, groupIndex) => {
      group.nodes.forEach((node, nodeIndex) => {
        positions.set(node.id, { x: 90 + groupIndex * 180, y: 105 + nodeIndex * 108 });
      });
    });

    return { grouped, width, height, positions };
  }, [nodes]);

  const visibleRelations = relations.filter(
    (relation) => layout.positions.has(relation.source) && layout.positions.has(relation.target),
  );

  if (!nodes.length) {
    return jsx.jsx("div", { className: "empty-state", children: "조건에 맞는 노드가 없습니다." });
  }

  return jsx.jsx("div", {
    className: "graph-scroll",
    "aria-label": "서비스 관계도",
    children: jsx.jsxs("svg", {
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: "img",
      "aria-label": `${nodes.length}개 노드와 ${visibleRelations.length}개 관계`,
      children: [
        jsx.jsx("defs", {
          children: jsx.jsx("marker", {
            id: "arrow",
            viewBox: "0 0 10 10",
            refX: "9",
            refY: "5",
            markerWidth: "5",
            markerHeight: "5",
            orient: "auto-start-reverse",
            children: jsx.jsx("path", { d: "M 0 0 L 10 5 L 0 10 z" }),
          }),
        }),
        layout.grouped.map((group, index) =>
          jsx.jsx(
            "text",
            {
              className: "column-label",
              x: 90 + index * 180,
              y: "46",
              textAnchor: "middle",
              children: groupLabels[group.type],
            },
            group.type,
          ),
        ),
        jsx.jsx("g", {
          className: "relations",
          children: visibleRelations.map((relation) => {
            const source = layout.positions.get(relation.source);
            const target = layout.positions.get(relation.target);
            return jsx.jsx(
              "line",
              {
                x1: source.x + 55,
                y1: source.y,
                x2: target.x - 55,
                y2: target.y,
                markerEnd: "url(#arrow)",
              },
              relation.id,
            );
          }),
        }),
        nodes.map((node) =>
          jsx.jsx(
            NativeGraphNode,
            {
              node,
              position: layout.positions.get(node.id),
              selectedId,
              onSelect,
            },
            node.id,
          ),
        ),
      ],
    }),
  });
}
