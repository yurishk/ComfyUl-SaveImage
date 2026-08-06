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

const PREVIEW_VALUE_WIDGETS = {
  model: ["ckpt_name", "unet_name", "model_name", "value", "text"],
  unet: ["unet_name", "diffusion_model_name", "model_name", "value", "text"],
  lora: ["lora_name", "value", "text"],
  loras: ["lora_name", "value", "text"],
  vae: ["vae_name", "value", "text"],
  seed: ["value", "seed", "noise_seed"],
  steps: ["value", "steps"],
  cfg: ["value", "cfg"],
  width: ["value", "width"],
  height: ["value", "height"],
  prompt: ["value", "text", "prompt"],
  negative: ["value", "text", "negative"],
};

export function collectConnectedPreviewValues(graph, targetNode, specs) {
  const values = {};
  for (const spec of specs || []) {
    const targetInput = targetNode?.inputs?.find((input) => input.name === spec.inputName);
    const link = getLink(graph, targetInput?.link);
    const source = link ? graph?.getNodeById?.(link.origin_id) : null;
    if (!source) continue;
    const preferred = PREVIEW_VALUE_WIDGETS[spec.key] || ["value", "text"];
    for (const name of preferred) {
      const sourceWidget = source.widgets?.find((widget) => widget.name === name);
      if (!sourceWidget) continue;
      const value = safeWidgetValue(sourceWidget.value);
      if (value === undefined || (value !== null && typeof value === "object")) continue;
      values[spec.inputName] = value;
      break;
    }
  }
  return values;
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
    for (const input of node?.inputs || []) {
      const link = getLink(graph, input?.link);
      if (!input?.name || !link) continue;
      inputs[input.name] = [String(link.origin_id), link.origin_slot ?? 0];
    }
    prompt[String(node.id)] = {
      class_type: node.comfyClass || node.type || "",
      inputs,
    };
  }
  return prompt;
}
