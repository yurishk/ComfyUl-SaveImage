export const VARIABLE_CONFIG_VERSION = 1;

export const KNOWN_VARIABLE_KEYS = [
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "unet",
  "lora",
  "loras",
  "vae",
  "width",
  "height",
  "prompt",
  "negative",
];

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_CUSTOM_KEYS = new Set([
  ...KNOWN_VARIABLE_KEYS,
  "date", "year", "month", "day", "hour", "minute", "second", "batch",
  "model", "model_full",
]);
const INPUT_TYPES = {
  unet: "*",
  lora: "*",
  loras: "STRING",
  vae: "*",
  seed: "INT",
  steps: "INT",
  cfg: "FLOAT",
  width: "INT",
  height: "INT",
  prompt: "STRING",
  negative: "STRING",
};
let nextId = 0;

function makeId() {
  nextId += 1;
  return `variable-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

export function normalizeVariableKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return KEY_PATTERN.test(key) ? key : "";
}

export function createVariableItem(key = "seed", value = "") {
  return {
    id: makeId(),
    key: normalizeVariableKey(key) || "seed",
    value: String(value ?? ""),
  };
}

export function variableInputName(id) {
  const safeId = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `variable_${safeId}`;
}

export function variableInputType(key) {
  const normalized = normalizeVariableKey(key);
  if (Object.hasOwn(INPUT_TYPES, normalized)) return INPUT_TYPES[normalized];
  if (normalized && !RESERVED_CUSTOM_KEYS.has(normalized)) return "STRING";
  return null;
}

export function isCustomVariableKey(key) {
  const normalized = normalizeVariableKey(key);
  return Boolean(normalized && !RESERVED_CUSTOM_KEYS.has(normalized));
}

export function parseVariableConfig(value) {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return [];
    }
  }

  const rawItems = Array.isArray(source) ? source : source?.items;
  if (!Array.isArray(rawItems)) return [];

  const usedIds = new Set();
  return rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const key = normalizeVariableKey(raw.key);
    if (!key) return [];
    const rawId = String(raw.id ?? "");
    let id = /^[A-Za-z0-9_-]+$/.test(rawId) ? rawId : makeId();
    if (usedIds.has(id)) id = makeId();
    usedIds.add(id);
    return [{
      id,
      key,
      value: String(raw.value ?? ""),
    }];
  });
}

export function serializeVariableConfig(items) {
  return JSON.stringify({
    version: VARIABLE_CONFIG_VERSION,
    items: parseVariableConfig(items),
  });
}
