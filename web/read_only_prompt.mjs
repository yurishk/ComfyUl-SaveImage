function getLink(graph, linkId) {
  const links = graph?.links;
  if (!links || linkId == null) return null;
  return typeof links.get === "function" ? links.get(linkId) : links[linkId];
}

function collectUpstreamNodes(graph, targetNode) {
  if (!targetNode) return new Set(graph?._nodes || []);

  const found = new Set([targetNode]);
  const pending = [targetNode];
  while (pending.length) {
    const current = pending.pop();
    for (const input of current?.inputs || []) {
      const link = getLink(graph, input?.link);
      if (!link) continue;
      const origin = graph?.getNodeById?.(link.origin_id);
      if (!origin || found.has(origin)) continue;
      found.add(origin);
      pending.push(origin);
    }
  }
  return found;
}

function safeWidgetValue(value) {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    const result = value.map(safeWidgetValue);
    return result.some((item) => item === undefined) ? undefined : result;
  }
  return undefined;
}

/**
 * Build only the metadata subset needed by SmartSave's path preview.
 * Reading widget.value directly is intentional: serializeValue and queue hooks
 * may randomize seeds, upload files, or mutate third-party node state.
 */
export function buildReadOnlyPrompt(graph, targetNode = null) {
  const included = collectUpstreamNodes(graph, targetNode);
  const prompt = {};

  for (const node of graph?._nodes || []) {
    if (!included.has(node)) continue;
    const inputs = {};
    for (const widget of node?.widgets || []) {
      if (!widget?.name || widget?.options?.serialize === false) continue;
      const value = safeWidgetValue(widget.value);
      if (value !== undefined) inputs[widget.name] = value;
    }
    prompt[String(node.id)] = {
      class_type: node.comfyClass || node.type || "",
      inputs,
    };
  }
  return prompt;
}
