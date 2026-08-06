export const VARIABLE_CONFIG_VERSION = 1;

export const KNOWN_VARIABLE_KEYS = [
  "unet",
  "lora",
  "loras",
  "vae",
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "width",
  "height",
  "prompt",
  "negative",
];

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
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

  return rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const key = normalizeVariableKey(raw.key);
    if (!key) return [];
    const rawId = String(raw.id ?? "");
    return [{
      id: /^[A-Za-z0-9_-]+$/.test(rawId) ? rawId : makeId(),
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
