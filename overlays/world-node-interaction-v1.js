/* Versioned compatibility bridge for the legacy read-only /world/ artifact. */
(() => {
  const nodeSelector = 'svg g.graph-node[role="button"]';
  const detailSelector = 'aside[aria-label="노드 상세 정보"].is-open';
  const reactPropsPrefix = "__reactProps$";

  function findNode(target) {
    return target instanceof Element ? target.closest(nodeSelector) : null;
  }

  function getReactProps(node) {
    const propsKey = Object.getOwnPropertyNames(node).find((key) =>
      key.startsWith(reactPropsPrefix),
    );
    return propsKey ? node[propsKey] : null;
  }

  function isSelectionOpen(node) {
    return node.classList.contains("is-selected") && Boolean(document.querySelector(detailSelector));
  }

  function recoverDispatch(node, event, handlerName) {
    const handler = getReactProps(node)?.[handlerName];
    if (typeof handler !== "function") return;

    window.setTimeout(() => {
      if (!node.isConnected || isSelectionOpen(node)) return;
      handler(event);
    }, 0);
  }

  document.addEventListener(
    "click",
    (event) => {
      const node = findNode(event.target);
      if (node) recoverDispatch(node, event, "onClick");
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const node = findNode(event.target);
      if (!node) return;
      if (event.key === " ") event.preventDefault();
      recoverDispatch(node, event, "onKeyDown");
    },
    true,
  );
})();
