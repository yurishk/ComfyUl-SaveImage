import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  buildReadOnlyPrompt,
  collectConnectedPreviewValues,
} from "./read_only_prompt.mjs?v=3";
import {
  KNOWN_VARIABLE_KEYS,
  createVariableItem,
  isCustomVariableKey,
  parseVariableConfig,
  serializeVariableConfig,
  variableInputName,
  variableInputType,
} from "./variable_config.mjs?v=3";

const NODE_NAME = "SmartSaveImage";
const CSS_HREF = new URL("./smart_save.css?v=3", import.meta.url).href;
let variableOptionsPromise = null;

function fetchVariableOptions() {
  if (!variableOptionsPromise) {
    variableOptionsPromise = api.fetchApi("/smartsave/options")
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null);
  }
  return variableOptionsPromise;
}

// 需要隐藏并由自定义面板托管的原生 widget
const MANAGED_WIDGETS = [
  "root_mode",
  "custom_root",
  "folder_template",
  "filename_template",
  "file_format",
  "quality",
  "collision_mode",
  "save_mode",
  "manual_model",
  "embed_workflow",
  "counter_digits",
  "png_compression",
  "variable_overrides",
];

// 占位符说明（分组展示，点击插入到当前聚焦的模板输入框）
function createTranslator() {
  const locale = String(app.ui?.settings?.getSettingValue?.("Comfy.Locale") || navigator.language || "en").toLowerCase();
  const chinese = locale.startsWith("zh");
  return (zh, en) => chinese ? zh : en;
}

function tokenGroups(tr) {
  return [
  { group: tr("时间", "Time"), items: [
    { t: "%date:yyyy-MM-dd%", d: tr("日期（可自定义格式）", "Date with a custom format") },
    { t: "%year%", d: tr("年", "Year") }, { t: "%month%", d: tr("月", "Month") }, { t: "%day%", d: tr("日", "Day") },
    { t: "%hour%", d: tr("时", "Hour") }, { t: "%minute%", d: tr("分", "Minute") }, { t: "%second%", d: tr("秒", "Second") },
  ]},
  { group: tr("模型", "Model"), items: [
    { t: "%model%", d: tr("模型名（无扩展名）", "Model name without extension") },
    { t: "%model_full%", d: tr("模型完整名", "Full model name") },
    { t: "%unet%", d: tr("UNet/扩散模型", "UNet or diffusion model") },
    { t: "%lora%", d: tr("首个 LoRA", "First LoRA") },
    { t: "%loras%", d: tr("全部 LoRA", "All LoRAs") },
    { t: "%vae%", d: "VAE" },
  ]},
  { group: tr("采样", "Sampling"), items: [
    { t: "%seed%", d: tr("种子", "Seed") }, { t: "%steps%", d: tr("步数", "Steps") }, { t: "%cfg%", d: "CFG" },
    { t: "%sampler%", d: tr("采样器", "Sampler") }, { t: "%scheduler%", d: tr("调度器", "Scheduler") },
  ]},
  { group: tr("图片", "Image"), items: [
    { t: "%width%", d: tr("宽", "Width") }, { t: "%height%", d: tr("高", "Height") },
    { t: "%prompt%", d: tr("正向提示词", "Positive prompt") },
    { t: "%negative%", d: tr("负向提示词", "Negative prompt") },
    { t: "%batch%", d: tr("批次序号（仅文件名）", "Batch index, filenames only") },
  ]},
  ];
}

function variableDefinitions(tr) {
  return [
    ["seed", tr("种子", "Seed")],
    ["steps", tr("步数", "Steps")],
    ["cfg", "CFG"],
    ["sampler", tr("采样器", "Sampler")],
    ["scheduler", tr("调度器", "Scheduler")],
    ["unet", tr("UNet / 扩散模型", "UNet / Diffusion Model")],
    ["lora", tr("首个 LoRA", "First LoRA")],
    ["loras", tr("全部 LoRA", "All LoRAs")],
    ["vae", "VAE"],
    ["width", tr("宽度", "Width")],
    ["height", tr("高度", "Height")],
    ["prompt", tr("正向提示词", "Positive Prompt")],
    ["negative", tr("负向提示词", "Negative Prompt")],
  ];
}

function ensureStyles() {
  const id = "smart-save-image-css";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  document.head.append(link);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function widgetValue(node, name, fallback) {
  const w = getWidget(node, name);
  return w ? w.value : fallback;
}

function setWidget(node, name, value) {
  const w = getWidget(node, name);
  if (!w) return;
  w.value = value;
  w.callback?.(value);
}

function getInput(node, name) {
  return node.inputs?.find((input) => input.name === name);
}

function inputConnected(input) {
  return input?.link !== null && input?.link !== undefined;
}

function removeInput(node, name) {
  const index = node.inputs?.findIndex((input) => input.name === name) ?? -1;
  if (index >= 0) node.removeInput(index);
}

function hideWidget(node, name) {
  const w = getWidget(node, name);
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (!w.options) w.options = {};
  w.options.serialize = true;
}

function buildPanel(node) {
  if (node.__ssiPanelBuilt) return;
  node.__ssiPanelBuilt = true;
  const tr = createTranslator();
  const tokens = tokenGroups(tr);
  const variableDefs = variableDefinitions(tr);
  const knownVariableKeys = new Set(KNOWN_VARIABLE_KEYS);
  let debounceTimer = null;
  let previewRequest = 0;
  let variableItems = parseVariableConfig(widgetValue(node, "variable_overrides", ""));
  let variableOptions = { unet: [], lora: [], vae: [], sampler: [], scheduler: [] };
  let panelWidget = null;
  let rowElements = new Map();
  let syncingInputs = false;

  // Reserve one native row for images; variable sockets are positioned beside DOM rows.
  node.widgets_start_y = (globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20) + 4;
  node.serialize_widgets = true;
  for (const name of MANAGED_WIDGETS) hideWidget(node, name);

  const modelWidget = getWidget(node, "manual_model");
  const modelOptions = modelWidget?.options?.values || ["auto"];

  const root = el("div", "ssi-panel");

  // ---- 根目录 ----
  const rootRow = el("div", "ssi-field ssi-location");
  rootRow.append(el("label", "ssi-label", tr("保存位置", "Save Location")));
  const rootSeg = el("div", "ssi-seg");
  const ROOTS = [
    { v: "output", label: tr("输出目录", "Output") },
    { v: "custom", label: tr("自定义", "Custom") },
    { v: "input", label: tr("输入", "Input") },
    { v: "temp", label: tr("临时", "Temp") },
  ];
  const rootButtons = {};
  for (const r of ROOTS) {
    const b = el("button", "ssi-seg-btn", r.label);
    b.type = "button";
    b.onclick = () => { setWidget(node, "root_mode", r.v); syncRoot(); schedulePreview(); };
    rootButtons[r.v] = b;
    rootSeg.append(b);
  }
  rootRow.append(rootSeg);

  const customRoot = el("input", "ssi-input");
  customRoot.placeholder = tr("例如 D:\\AI\\output（留空使用输出目录）", "For example D:\\AI\\output (blank uses Output)");
  customRoot.value = widgetValue(node, "custom_root", "");
  customRoot.oninput = () => { setWidget(node, "custom_root", customRoot.value); schedulePreview(); };
  const customRootWrap = el("div", "ssi-field ssi-custom-root");
  customRootWrap.append(el("label", "ssi-cell-label", tr("自定义路径", "Custom Path")), customRoot);

  // ---- 目录模板 ----
  const folderRow = el("div", "ssi-field");
  folderRow.append(el("label", "ssi-label", tr("子目录规则", "Subfolder Rule")));
  const folderInput = el("input", "ssi-input ssi-mono");
  folderInput.placeholder = tr("例如 %date:yyyy-MM-dd%/%model%", "For example %date:yyyy-MM-dd%/%model%");
  folderInput.value = widgetValue(node, "folder_template", "");
  folderInput.oninput = () => { setWidget(node, "folder_template", folderInput.value); schedulePreview(); };
  folderInput.onfocus = () => { activeField = folderInput; };
  folderRow.append(folderInput);

  // ---- 文件名模板 ----
  const nameRow = el("div", "ssi-field");
  nameRow.append(el("label", "ssi-label", tr("文件名规则", "Filename Rule")));
  const nameInput = el("input", "ssi-input ssi-mono");
  nameInput.placeholder = tr("例如 %model%_%seed%", "For example %model%_%seed%");
  nameInput.value = widgetValue(node, "filename_template", "");
  nameInput.oninput = () => { setWidget(node, "filename_template", nameInput.value); schedulePreview(); };
  nameInput.onfocus = () => { activeField = nameInput; };
  nameRow.append(nameInput);

  let activeField = folderInput;

  // ---- 占位符调色板 ----
  const palette = el("details", "ssi-palette");
  palette.append(el("summary", "ssi-palette-summary", tr("模板变量", "Template Tokens")));
  palette.append(el("div", "ssi-hint", tr("先选中目录或文件名输入框，再点击变量插入。", "Focus a folder or filename field, then click a token to insert it.")));
  for (const grp of tokens) {
    const gwrap = el("div", "ssi-token-group");
    gwrap.append(el("span", "ssi-group-name", grp.group));
    for (const it of grp.items) {
      const chip = el("button", "ssi-chip", it.t.replace(/%/g, ""));
      chip.type = "button";
      chip.title = `${it.t} — ${it.d}`;
      chip.onclick = () => insertToken(it.t);
      gwrap.append(chip);
    }
    palette.append(gwrap);
  }

  function insertToken(token) {
    const field = activeField || folderInput;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.value = field.value.slice(0, start) + token + field.value.slice(end);
    const pos = start + token.length;
    field.setSelectionRange(pos, pos);
    field.focus();
    field.dispatchEvent(new Event("input"));
  }

  // ---- 当前保存节点独立的变量覆盖 ----
  const overrides = el("details", "ssi-overrides");
  const overrideSummary = el("summary", "ssi-overrides-summary");
  const overrideTitle = el("span", null, tr("变量覆盖", "Variable Overrides"));
  const overrideCount = el("span", "ssi-count", "0");
  overrideSummary.append(overrideTitle, overrideCount);
  const overrideHint = el(
    "div",
    "ssi-hint",
    tr(
      "未添加覆盖项或预设变量值为空时自动读取。设置只属于当前保存节点；自定义名称会生成同名模板变量。",
      "No override, or a blank known value, means auto-detect. Settings belong only to this Save node; a custom name creates a matching token.",
    ),
  );
  const overrideList = el("div", "ssi-override-list");
  const addOverride = el("button", "ssi-add-override", tr("＋ 添加变量覆盖", "+ Add Override"));
  addOverride.type = "button";
  overrides.append(overrideSummary, overrideHint, overrideList, addOverride);

  function nextCustomKey() {
    const used = new Set(variableItems.map((item) => item.key));
    if (!used.has("custom")) return "custom";
    let index = 2;
    while (used.has(`custom_${index}`)) index += 1;
    return `custom_${index}`;
  }

  function persistVariableItems() {
    setWidget(node, "variable_overrides", serializeVariableConfig(variableItems));
    overrideCount.textContent = String(variableItems.length);
    schedulePreview();
  }

  function syncVariableInputs() {
    syncingInputs = true;
    try {
      const desired = variableItems.flatMap((item) => {
        const type = variableInputType(item.key);
        return type ? [{ name: variableInputName(item.id), type }] : [];
      });
      const desiredNames = new Set(desired.map((item) => item.name));
      const obsolete = (node.inputs || [])
        .filter((input) => input.name.startsWith("variable_") && !desiredNames.has(input.name))
        .map((input) => input.name);
      for (const name of obsolete) removeInput(node, name);
      for (const item of desired) {
        let input = getInput(node, item.name);
        if (!input) input = node.addInput(item.name, item.type);
        input.type = item.type;
        input.label = " ";
        input.localized_name = " ";
      }
      const modelInput = getInput(node, "model_input");
      if (modelInput) {
        modelInput.label = " ";
        modelInput.localized_name = " ";
      }
    } finally {
      syncingInputs = false;
    }
  }

  function makeOverrideValueControl(item, connected) {
    const choices = variableOptions[item.key] || [];
    let control;
    if (choices.length > 0) {
      control = el("select", "ssi-select ssi-override-value");
      const automatic = el("option", null, tr("自动读取", "Auto Detect"));
      automatic.value = "";
      control.append(automatic);
      if (item.value && !choices.includes(item.value)) {
        const missing = el("option", null, `${item.value}${tr("（当前不可用）", " (currently unavailable)")}`);
        missing.value = item.value;
        control.append(missing);
      }
      for (const choice of choices) {
        const option = el("option", null, choice);
        option.value = choice;
        control.append(option);
      }
      control.value = item.value;
      control.onchange = () => {
        item.value = control.value;
        persistVariableItems();
      };
    } else {
      control = el("input", "ssi-input ssi-override-value");
      if (["seed", "steps", "width", "height", "cfg"].includes(item.key)) {
        control.type = "number";
        control.step = item.key === "cfg" ? "0.01" : "1";
      }
      control.value = item.value;
      control.placeholder = knownVariableKeys.has(item.key)
        ? tr("留空自动读取", "Blank uses auto-detect")
        : tr("自定义值", "Custom value");
      control.title = item.value;
      control.oninput = () => {
        item.value = control.value;
        control.title = item.value;
        persistVariableItems();
      };
    }
    control.disabled = connected;
    if (connected) control.title = tr("已连接外部输入，运行时值优先", "External input connected; runtime value has priority");
    return control;
  }

  function renderVariableItems() {
    syncVariableInputs();
    overrideList.replaceChildren();
    rowElements = new Map();
    overrideCount.textContent = String(variableItems.length);
    overrideCount.classList.toggle("ssi-count-active", variableItems.length > 0);

    const keyCounts = variableItems.reduce((counts, item) => {
      counts.set(item.key, (counts.get(item.key) || 0) + 1);
      return counts;
    }, new Map());

    for (const item of variableItems) {
      const row = el("div", "ssi-override-row");
      const inputName = variableInputName(item.id);
      const supportsInput = variableInputType(item.key) !== null;
      const connected = supportsInput && inputConnected(getInput(node, inputName));
      if (connected) {
        row.classList.add("ssi-override-connected");
        row.title = tr("外部输入已连接，运行时值优先", "External input connected; runtime value has priority");
      }
      if (keyCounts.get(item.key) > 1) {
        row.classList.add("ssi-override-duplicate");
        row.title = tr("同名变量重复，最后一项生效", "Duplicate variable: the last value wins");
      }

      const typeSelect = el("select", "ssi-select ssi-override-type");
      for (const [key, label] of variableDefs) {
        const option = el("option", null, label);
        option.value = key;
        typeSelect.append(option);
      }
      const customOption = el("option", null, tr("自定义…", "Custom..."));
      customOption.value = "__custom__";
      typeSelect.append(customOption);
      typeSelect.value = knownVariableKeys.has(item.key) ? item.key : "__custom__";

      const valueWrap = el("div", "ssi-override-value-wrap");
      if (!knownVariableKeys.has(item.key)) {
        const customKey = el("input", "ssi-input ssi-custom-key");
        customKey.value = item.key;
        customKey.placeholder = tr("变量名", "Token name");
        customKey.title = tr(
          "仅限英文字母、数字和下划线，必须以字母开头，且不能与内置变量重名",
          "Letters, numbers, and underscores; start with a letter and do not reuse a built-in token",
        );
        customKey.onchange = () => {
          const normalized = customKey.value.trim().toLowerCase();
          if (!isCustomVariableKey(normalized)) {
            customKey.value = item.key;
            customKey.classList.add("ssi-input-invalid");
            return;
          }
          customKey.classList.remove("ssi-input-invalid");
          item.key = normalized;
          persistVariableItems();
          renderVariableItems();
        };
        valueWrap.append(customKey);
      }

      const valueInput = makeOverrideValueControl(item, connected);
      valueWrap.append(valueInput);

      const tokenButton = el("button", "ssi-variable-token", `%${item.key}%`);
      tokenButton.type = "button";
      tokenButton.title = tr("插入到当前规则", "Insert into the active rule");
      tokenButton.onclick = () => insertToken(`%${item.key}%`);

      const removeButton = el("button", "ssi-icon-btn", "×");
      removeButton.type = "button";
      removeButton.title = tr("删除变量覆盖", "Remove override");
      removeButton.setAttribute("aria-label", removeButton.title);
      removeButton.onclick = () => {
        variableItems = variableItems.filter((candidate) => candidate.id !== item.id);
        persistVariableItems();
        renderVariableItems();
      };

      typeSelect.onchange = () => {
        item.key = typeSelect.value === "__custom__" ? nextCustomKey() : typeSelect.value;
        persistVariableItems();
        renderVariableItems();
      };

      row.append(typeSelect, valueWrap, tokenButton, removeButton);
      overrideList.append(row);
      if (supportsInput) rowElements.set(inputName, row);
    }
    rowElements.set("model_input", modelRow);
    syncModelInputState();
    requestAnimationFrame(updateInputPositions);
    requestAnimationFrame(fitNodeToPanel);
  }

  addOverride.onclick = () => {
    const used = new Set(variableItems.map((item) => item.key));
    const available = KNOWN_VARIABLE_KEYS.find((key) => !used.has(key));
    variableItems.push(createVariableItem(available || nextCustomKey()));
    overrides.open = true;
    persistVariableItems();
    renderVariableItems();
  };

  // ---- 模型来源 ----
  const modelRow = el("div", "ssi-row");
  modelRow.append(el("label", "ssi-label", tr("模型来源", "Model Source")));
  const modelSelect = el("select", "ssi-select");
  for (const opt of modelOptions) {
    const o = el("option", null, opt === "auto" ? tr("自动读取工作流", "Detect from Workflow") : opt);
    o.value = opt;
    modelSelect.append(o);
  }
  modelSelect.value = widgetValue(node, "manual_model", "auto");
  modelSelect.onchange = () => { setWidget(node, "manual_model", modelSelect.value); schedulePreview(); };
  const modelConnection = el("span", "ssi-input-state");
  modelRow.append(modelSelect, modelConnection);

  function syncModelInputState() {
    const connected = inputConnected(getInput(node, "model_input"));
    modelSelect.disabled = connected;
    modelConnection.textContent = connected ? tr("外部输入", "External") : tr("手动 / 自动", "Manual / Auto");
    modelConnection.classList.toggle("ssi-input-state-connected", connected);
    modelRow.classList.toggle("ssi-model-connected", connected);
  }

  // ---- 格式 / 压缩 / 冲突 / 模式 ----
  const optGrid = el("div", "ssi-grid");

  const fmtSelect = makeSelect(["png", "jpeg", "webp"], widgetValue(node, "file_format", "png"),
    (v) => { setWidget(node, "file_format", v); syncFormat(); schedulePreview(); });
  optGrid.append(labeled(tr("格式", "Format"), fmtSelect));

  const compressionInput = el("input", "ssi-input");
  compressionInput.type = "number";
  compressionInput.min = "0"; compressionInput.max = "9";
  compressionInput.value = widgetValue(node, "png_compression", 4);
  compressionInput.title = tr("0 最快且文件最大，9 最慢；所有等级均为无损", "0 is fastest and largest; 9 is slowest. Every level is lossless.");
  compressionInput.oninput = () => {
    const value = Math.max(0, Math.min(parseInt(compressionInput.value || "0", 10), 9));
    setWidget(node, "png_compression", value);
  };
  const compressionWrap = labeled(tr("PNG 压缩", "PNG Compression"), compressionInput);
  optGrid.append(compressionWrap);

  const collisionSelect = makeSelect(
    [["increment", tr("自动编号", "Auto Number")], ["overwrite", tr("覆盖", "Overwrite")]],
    widgetValue(node, "collision_mode", "increment"),
    (v) => { setWidget(node, "collision_mode", v); schedulePreview(); });
  optGrid.append(labeled(tr("同名冲突", "Name Collision"), collisionSelect));

  const modeSelect = makeSelect(
    [["save_and_preview", tr("保存并预览", "Save and Preview")], ["save_only", tr("仅保存", "Save Only")], ["preview_only", tr("仅预览", "Preview Only")]],
    widgetValue(node, "save_mode", "save_and_preview"),
    (v) => setWidget(node, "save_mode", v));
  optGrid.append(labeled(tr("保存模式", "Save Mode"), modeSelect));

  const digitsInput = el("input", "ssi-input");
  digitsInput.type = "number";
  digitsInput.min = "0"; digitsInput.max = "8";
  digitsInput.value = widgetValue(node, "counter_digits", 3);
  digitsInput.oninput = () => { setWidget(node, "counter_digits", parseInt(digitsInput.value || "0", 10)); schedulePreview(); };
  optGrid.append(labeled(tr("序号位数", "Counter Digits"), digitsInput));

  const embedLabel = el("label", "ssi-check");
  const embedBox = el("input");
  embedBox.type = "checkbox";
  embedBox.checked = widgetValue(node, "embed_workflow", true) !== false;
  embedBox.onchange = () => setWidget(node, "embed_workflow", embedBox.checked);
  embedLabel.append(embedBox, document.createTextNode(tr(" 嵌入工作流", " Embed Workflow")));
  optGrid.append(embedLabel);

  // ---- 预览区 ----
  const previewBox = el("div", "ssi-preview");
  const previewHead = el("div", "ssi-preview-head");
  const previewTitle = el("span", "ssi-preview-title", tr("保存结果预览", "Save Result Preview"));
  const refreshBtn = el("button", "ssi-refresh", tr("刷新", "Refresh"));
  refreshBtn.type = "button";
  refreshBtn.onclick = () => runPreview();
  previewHead.append(previewTitle, refreshBtn);
  const pathLine = el("div", "ssi-path", "—");
  const fileLine = el("div", "ssi-file", "");
  const ctxLine = el("div", "ssi-context", "");
  const statusLine = el("div", "ssi-status", "");
  previewBox.append(previewHead, pathLine, fileLine, ctxLine, statusLine);

  root.append(rootRow, customRootWrap, folderRow, nameRow, previewBox, palette, overrides, modelRow, optGrid);

  function syncFormat() {
    compressionWrap.style.display = fmtSelect.value === "png" ? "flex" : "none";
  }

  function syncRoot() {
    const mode = widgetValue(node, "root_mode", "output");
    for (const [v, b] of Object.entries(rootButtons)) {
      b.classList.toggle("ssi-seg-active", v === mode);
    }
    customRootWrap.style.display = mode === "custom" ? "flex" : "none";
  }

  function syncFromWidgets() {
    customRoot.value = widgetValue(node, "custom_root", "");
    folderInput.value = widgetValue(node, "folder_template", "");
    nameInput.value = widgetValue(node, "filename_template", "");
    const modelValue = widgetValue(node, "manual_model", "auto");
    if (![...modelSelect.options].some((option) => option.value === modelValue)) {
      const missingModel = el("option", null, `${modelValue}${tr("（当前不可用）", " (currently unavailable)")}`);
      missingModel.value = modelValue;
      modelSelect.append(missingModel);
    }
    modelSelect.value = modelValue;
    fmtSelect.value = widgetValue(node, "file_format", "png");
    compressionInput.value = widgetValue(node, "png_compression", 4);
    collisionSelect.value = widgetValue(node, "collision_mode", "increment");
    modeSelect.value = widgetValue(node, "save_mode", "save_and_preview");
    digitsInput.value = widgetValue(node, "counter_digits", 3);
    embedBox.checked = widgetValue(node, "embed_workflow", true) !== false;
    variableItems = parseVariableConfig(widgetValue(node, "variable_overrides", ""));
    if (variableItems.some((item) => variableInputType(item.key) !== null)) overrides.open = true;
    renderVariableItems();
    syncFormat();
    syncRoot();
  }

  // ---- 调用后端计算预览 ----
  async function runPreview() {
    const requestId = ++previewRequest;
    statusLine.textContent = tr("正在计算…", "Calculating...");
    statusLine.className = "ssi-status";
    try {
      const previewInputSpecs = [
        { inputName: "model_input", key: "model" },
        ...variableItems.flatMap((item) => variableInputType(item.key)
          ? [{ inputName: variableInputName(item.id), key: item.key }]
          : []),
      ];
      const payload = {
        prompt: buildReadOnlyPrompt(app.graph, node),
        external_values: collectConnectedPreviewValues(app.graph, node, previewInputSpecs),
        connected_inputs: previewInputSpecs
          .filter((spec) => inputConnected(getInput(node, spec.inputName)))
          .map((spec) => spec.inputName),
        root_mode: widgetValue(node, "root_mode", "output"),
        custom_root: widgetValue(node, "custom_root", ""),
        folder_template: widgetValue(node, "folder_template", ""),
        filename_template: widgetValue(node, "filename_template", "image"),
        file_format: widgetValue(node, "file_format", "png"),
        manual_model: widgetValue(node, "manual_model", "auto"),
        variable_overrides: widgetValue(node, "variable_overrides", ""),
        unique_id: String(node.id),
        counter_digits: widgetValue(node, "counter_digits", 3),
        collision_mode: widgetValue(node, "collision_mode", "increment"),
        batch_size: 1,
      };
      const resp = await api.fetchApi("/smartsave/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (requestId !== previewRequest) return;
      if (!data.ok) {
        statusLine.textContent = tr("预览失败：", "Preview failed: ") + (data.error || tr("未知错误", "Unknown error"));
        statusLine.className = "ssi-status ssi-status-warn";
        return;
      }
      pathLine.textContent = data.target;
      pathLine.title = data.target;
      const examples = (data.example_filenames || []).join(tr("  、  ", ", "));
      fileLine.textContent = tr("示例文件：", "Example file: ") + examples;
      const c = data.context || {};
      const overridden = new Set(c.overridden || []);
      const overrideSources = c.override_sources || {};
      ctxLine.innerHTML = "";
      const chips = [
        [tr("模型", "Model"), c.model, "model"], ["LoRA", c.lora, "lora"], [tr("种子", "Seed"), c.seed, "seed"],
        [tr("采样器", "Sampler"), c.sampler, "sampler"], [tr("尺寸", "Size"), c.width && c.height ? `${c.width}x${c.height}` : "", "width"],
      ];
      for (const [k, v, key] of chips) {
        if (!v) continue;
        const tag = el("span", "ssi-ctx-tag");
        if (overridden.has(key) || (key === "width" && overridden.has("height"))) tag.classList.add("ssi-ctx-overridden");
        if (overrideSources[key] === "input") tag.title = tr("来自外部输入", "From external input");
        tag.append(el("b", null, k + tr("：", ": ")), document.createTextNode(v));
        ctxLine.append(tag);
      }
      for (const [key, value] of Object.entries(c.custom || {})) {
        const tag = el("span", "ssi-ctx-tag ssi-ctx-overridden");
        if (overrideSources[key] === "input") tag.title = tr("来自外部输入", "From external input");
        tag.append(el("b", null, `%${key}%` + tr("：", ": ")), document.createTextNode(value));
        ctxLine.append(tag);
      }
      if (data.exists) {
        statusLine.textContent = tr(`目录已存在，已有 ${data.existing_count} 张图片`, `Folder exists with ${data.existing_count} image(s)`);
        statusLine.className = "ssi-status ssi-status-ok";
      } else {
        statusLine.textContent = tr("目录尚不存在，保存时将自动创建", "Folder does not exist yet and will be created when saving");
        statusLine.className = "ssi-status";
      }
    } catch (err) {
      if (requestId !== previewRequest) return;
      statusLine.textContent = tr("预览异常：", "Preview error: ") + err;
      statusLine.className = "ssi-status ssi-status-warn";
    }
  }

  function schedulePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPreview, 350);
  }

  node.__ssi_refresh = () => {
    syncFromWidgets();
    runPreview();
  };

  function panelContentHeight() {
    const style = getComputedStyle(root);
    const visibleChildren = [...root.children].filter((child) => child.offsetHeight > 0);
    const gap = parseFloat(style.rowGap || style.gap || "0") || 0;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const childrenHeight = visibleChildren.reduce((sum, child) => sum + child.offsetHeight, 0);
    return Math.ceil(padding + childrenHeight + gap * Math.max(visibleChildren.length - 1, 0));
  }

  panelWidget = node.addDOMWidget("smart_save_panel", "smart-save", root, {
    serialize: false,
    getMinHeight() { return Math.max(360, panelContentHeight() + 8); },
    getMaxHeight() { return Math.max(360, panelContentHeight() + 8); },
  });
  panelWidget.serialize = false;

  function updateInputPositions() {
    if (!panelWidget || !root.isConnected) return;
    const rootRect = root.getBoundingClientRect();
    const scale = root.offsetHeight > 0 ? rootRect.height / root.offsetHeight : 1;
    for (const [inputName, row] of rowElements) {
      const input = getInput(node, inputName);
      if (!input || !row?.isConnected) continue;
      const rowRect = row.getBoundingClientRect();
      const offset = (rowRect.top - rootRect.top + rowRect.height / 2) / (scale || 1);
      input.pos = [0, panelWidget.y + offset + (panelWidget.margin || 0)];
    }
    app.graph?.setDirtyCanvas(true, false);
  }

  function fitNodeToPanel() {
    const host = root.parentElement;
    if (!host) return;
    const desiredHeight = Math.ceil(panelContentHeight() + 50);
    const desiredWidth = Math.max(node.size[0], 420);
    if (Math.abs(node.size[1] - desiredHeight) > 2 || node.size[0] < 420) {
      node.setSize([desiredWidth, desiredHeight]);
      app.graph.setDirtyCanvas(true, true);
    }
    updateInputPositions();
  }

  const panelObserver = new ResizeObserver(() => requestAnimationFrame(fitNodeToPanel));
  panelObserver.observe(root);
  palette.addEventListener("toggle", () => requestAnimationFrame(fitNodeToPanel));
  overrides.addEventListener("toggle", () => {
    if (!overrides.open && variableItems.some((item) => variableInputType(item.key) !== null)) {
      requestAnimationFrame(() => { overrides.open = true; });
      return;
    }
    requestAnimationFrame(fitNodeToPanel);
  });

  const onConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = onConnectionsChange?.apply(this, arguments);
    if (!syncingInputs) {
      requestAnimationFrame(() => {
        syncFromWidgets();
        schedulePreview();
      });
    }
    return result;
  };

  const onSerialize = node.onSerialize;
  node.onSerialize = function () {
    persistVariableItems();
    return onSerialize?.apply(this, arguments);
  };

  const onDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function () {
    const result = onDrawForeground?.apply(this, arguments);
    if (!this.flags?.collapsed) updateInputPositions();
    return result;
  };

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    clearTimeout(debounceTimer);
    panelObserver.disconnect();
    onRemoved?.apply(this, arguments);
  };

  syncFromWidgets();
  fetchVariableOptions().then((options) => {
    if (!options) return;
    variableOptions = { ...variableOptions, ...options };
    renderVariableItems();
  });
  requestAnimationFrame(() => {
    node.setSize([Math.max(node.size[0], 420), Math.max(node.size[1], 500)]);
    requestAnimationFrame(fitNodeToPanel);
    runPreview();
  });
}

// 辅助：带标签的字段
function labeled(text, control) {
  const wrap = el("div", "ssi-cell");
  wrap.append(el("label", "ssi-cell-label", text), control);
  return wrap;
}

// 辅助：下拉框（支持 [value, label] 或纯字符串）
function makeSelect(options, value, onChange) {
  const sel = el("select", "ssi-select");
  for (const opt of options) {
    const [v, label] = Array.isArray(opt) ? opt : [opt, opt];
    const o = el("option", null, label);
    o.value = v;
    sel.append(o);
  }
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
  return sel;
}

app.registerExtension({
  name: "Comfy.SmartSaveImage",
  init() {
    ensureStyles();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      buildPanel(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => this.__ssi_refresh?.());
    };

    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      const result = configure?.apply(this, arguments);
      requestAnimationFrame(() => this.__ssi_refresh?.());
      return result;
    };
  },
  loadedGraphNode(node) {
    if ((node.comfyClass || node.type) !== NODE_NAME) return;
    requestAnimationFrame(() => node.__ssi_refresh?.());
  },
});
