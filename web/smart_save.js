import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { buildReadOnlyPrompt } from "./read_only_prompt.mjs";

const NODE_NAME = "SmartSaveImage";
const CSS_HREF = "extensions/SmartSaveImage/smart_save.css";

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
];

// 占位符说明（分组展示，点击插入到当前聚焦的模板输入框）
const TOKENS = [
  { group: "时间", items: [
    { t: "%date:yyyy-MM-dd%", d: "日期(可自定义格式)" },
    { t: "%year%", d: "年" }, { t: "%month%", d: "月" }, { t: "%day%", d: "日" },
    { t: "%hour%", d: "时" }, { t: "%minute%", d: "分" }, { t: "%second%", d: "秒" },
  ]},
  { group: "模型", items: [
    { t: "%model%", d: "模型名(去扩展名)" },
    { t: "%model_full%", d: "模型完整名" },
    { t: "%unet%", d: "UNet/扩散模型" },
    { t: "%lora%", d: "首个 LoRA" },
    { t: "%vae%", d: "VAE" },
  ]},
  { group: "采样", items: [
    { t: "%seed%", d: "种子" }, { t: "%steps%", d: "步数" }, { t: "%cfg%", d: "CFG" },
    { t: "%sampler%", d: "采样器" }, { t: "%scheduler%", d: "调度器" },
  ]},
  { group: "图片", items: [
    { t: "%width%", d: "宽" }, { t: "%height%", d: "高" },
    { t: "%prompt%", d: "正向提示词" }, { t: "%batch%", d: "批次序号(仅文件名)" },
  ]},
];

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

function hideWidget(node, name) {
  const w = getWidget(node, name);
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (!w.options) w.options = {};
  w.options.serialize = true;
}

function buildPanel(node) {
  let debounceTimer = null;
  let previewRequest = 0;

  node.serialize_widgets = true;
  for (const name of MANAGED_WIDGETS) hideWidget(node, name);

  const modelWidget = getWidget(node, "manual_model");
  const modelOptions = modelWidget?.options?.values || ["auto"];

  const root = el("div", "ssi-panel");

  // ---- 根目录 ----
  const rootRow = el("div", "ssi-field ssi-location");
  rootRow.append(el("label", "ssi-label", "保存位置"));
  const rootSeg = el("div", "ssi-seg");
  const ROOTS = [
    { v: "output", label: "输出目录" },
    { v: "custom", label: "自定义" },
    { v: "input", label: "输入" },
    { v: "temp", label: "临时" },
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
  customRoot.placeholder = "例如 D:\\AI\\output（留空使用输出目录）";
  customRoot.value = widgetValue(node, "custom_root", "");
  customRoot.oninput = () => { setWidget(node, "custom_root", customRoot.value); schedulePreview(); };
  const customRootWrap = el("div", "ssi-field ssi-custom-root");
  customRootWrap.append(el("label", "ssi-cell-label", "自定义路径"), customRoot);

  // ---- 目录模板 ----
  const folderRow = el("div", "ssi-field");
  folderRow.append(el("label", "ssi-label", "子目录规则"));
  const folderInput = el("input", "ssi-input ssi-mono");
  folderInput.placeholder = "例如 %date:yyyy-MM-dd%/%model%";
  folderInput.value = widgetValue(node, "folder_template", "");
  folderInput.oninput = () => { setWidget(node, "folder_template", folderInput.value); schedulePreview(); };
  folderInput.onfocus = () => { activeField = folderInput; };
  folderRow.append(folderInput);

  // ---- 文件名模板 ----
  const nameRow = el("div", "ssi-field");
  nameRow.append(el("label", "ssi-label", "文件名规则"));
  const nameInput = el("input", "ssi-input ssi-mono");
  nameInput.placeholder = "例如 %model%_%seed%";
  nameInput.value = widgetValue(node, "filename_template", "");
  nameInput.oninput = () => { setWidget(node, "filename_template", nameInput.value); schedulePreview(); };
  nameInput.onfocus = () => { activeField = nameInput; };
  nameRow.append(nameInput);

  let activeField = folderInput;

  // ---- 占位符调色板 ----
  const palette = el("details", "ssi-palette");
  palette.append(el("summary", "ssi-palette-summary", "模板变量"));
  palette.append(el("div", "ssi-hint", "先选中目录或文件名输入框，再点击变量插入。"));
  for (const grp of TOKENS) {
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

  // ---- 模型来源 ----
  const modelRow = el("div", "ssi-row");
  modelRow.append(el("label", "ssi-label", "模型来源"));
  const modelSelect = el("select", "ssi-select");
  for (const opt of modelOptions) {
    const o = el("option", null, opt === "auto" ? "自动读取工作流" : opt);
    o.value = opt;
    modelSelect.append(o);
  }
  modelSelect.value = widgetValue(node, "manual_model", "auto");
  modelSelect.onchange = () => { setWidget(node, "manual_model", modelSelect.value); schedulePreview(); };
  modelRow.append(modelSelect);

  // ---- 格式 / 压缩 / 冲突 / 模式 ----
  const optGrid = el("div", "ssi-grid");

  const fmtSelect = makeSelect(["png", "jpeg", "webp"], widgetValue(node, "file_format", "png"),
    (v) => { setWidget(node, "file_format", v); syncFormat(); schedulePreview(); });
  optGrid.append(labeled("格式", fmtSelect));

  const compressionInput = el("input", "ssi-input");
  compressionInput.type = "number";
  compressionInput.min = "0"; compressionInput.max = "9";
  compressionInput.value = widgetValue(node, "png_compression", 4);
  compressionInput.title = "0 最快且文件最大，9 最慢；所有等级均为无损";
  compressionInput.oninput = () => {
    const value = Math.max(0, Math.min(parseInt(compressionInput.value || "0", 10), 9));
    setWidget(node, "png_compression", value);
  };
  const compressionWrap = labeled("PNG 压缩", compressionInput);
  optGrid.append(compressionWrap);

  const collisionSelect = makeSelect(
    [["increment", "自动编号"], ["overwrite", "覆盖"]],
    widgetValue(node, "collision_mode", "increment"),
    (v) => { setWidget(node, "collision_mode", v); schedulePreview(); });
  optGrid.append(labeled("同名冲突", collisionSelect));

  const modeSelect = makeSelect(
    [["save_and_preview", "保存并预览"], ["save_only", "仅保存"], ["preview_only", "仅预览"]],
    widgetValue(node, "save_mode", "save_and_preview"),
    (v) => setWidget(node, "save_mode", v));
  optGrid.append(labeled("保存模式", modeSelect));

  const digitsInput = el("input", "ssi-input");
  digitsInput.type = "number";
  digitsInput.min = "0"; digitsInput.max = "8";
  digitsInput.value = widgetValue(node, "counter_digits", 3);
  digitsInput.oninput = () => { setWidget(node, "counter_digits", parseInt(digitsInput.value || "0", 10)); schedulePreview(); };
  optGrid.append(labeled("序号位数", digitsInput));

  const embedLabel = el("label", "ssi-check");
  const embedBox = el("input");
  embedBox.type = "checkbox";
  embedBox.checked = widgetValue(node, "embed_workflow", true) !== false;
  embedBox.onchange = () => setWidget(node, "embed_workflow", embedBox.checked);
  embedLabel.append(embedBox, document.createTextNode(" 嵌入工作流"));
  optGrid.append(embedLabel);

  // ---- 预览区 ----
  const previewBox = el("div", "ssi-preview");
  const previewHead = el("div", "ssi-preview-head");
  const previewTitle = el("span", "ssi-preview-title", "保存结果预览");
  const refreshBtn = el("button", "ssi-refresh", "刷新");
  refreshBtn.type = "button";
  refreshBtn.onclick = () => runPreview();
  previewHead.append(previewTitle, refreshBtn);
  const pathLine = el("div", "ssi-path", "—");
  const fileLine = el("div", "ssi-file", "");
  const ctxLine = el("div", "ssi-context", "");
  const statusLine = el("div", "ssi-status", "");
  previewBox.append(previewHead, pathLine, fileLine, ctxLine, statusLine);

  root.append(rootRow, customRootWrap, folderRow, nameRow, previewBox, palette, modelRow, optGrid);

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
      const missingModel = el("option", null, `${modelValue}（当前不可用）`);
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
    syncFormat();
    syncRoot();
  }

  // ---- 调用后端计算预览 ----
  async function runPreview() {
    const requestId = ++previewRequest;
    statusLine.textContent = "正在计算…";
    statusLine.className = "ssi-status";
    try {
      const payload = {
        prompt: buildReadOnlyPrompt(app.graph, node),
        root_mode: widgetValue(node, "root_mode", "output"),
        custom_root: widgetValue(node, "custom_root", ""),
        folder_template: widgetValue(node, "folder_template", ""),
        filename_template: widgetValue(node, "filename_template", "image"),
        file_format: widgetValue(node, "file_format", "png"),
        manual_model: widgetValue(node, "manual_model", "auto"),
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
        statusLine.textContent = "预览失败：" + (data.error || "未知错误");
        statusLine.className = "ssi-status ssi-status-warn";
        return;
      }
      pathLine.textContent = data.target;
      pathLine.title = data.target;
      const examples = (data.example_filenames || []).join("  、  ");
      fileLine.textContent = "示例文件：" + examples;
      const c = data.context || {};
      ctxLine.innerHTML = "";
      const chips = [
        ["模型", c.model], ["LoRA", c.lora], ["种子", c.seed],
        ["采样器", c.sampler], ["尺寸", c.width && c.height ? `${c.width}x${c.height}` : ""],
      ];
      for (const [k, v] of chips) {
        if (!v) continue;
        const tag = el("span", "ssi-ctx-tag");
        tag.append(el("b", null, k + "："), document.createTextNode(v));
        ctxLine.append(tag);
      }
      if (data.exists) {
        statusLine.textContent = `目录已存在，已有 ${data.existing_count} 张图片`;
        statusLine.className = "ssi-status ssi-status-ok";
      } else {
        statusLine.textContent = "目录尚不存在，保存时将自动创建";
        statusLine.className = "ssi-status";
      }
    } catch (err) {
      if (requestId !== previewRequest) return;
      statusLine.textContent = "预览异常：" + err;
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

  const widget = node.addDOMWidget("smart_save_panel", "smart-save", root, {
    serialize: false,
    getMinHeight() { return Math.max(360, panelContentHeight() + 8); },
    getMaxHeight() { return 900; },
  });
  widget.serialize = false;

  function fitNodeToPanel() {
    const host = root.parentElement;
    if (!host) return;
    const desiredHeight = Math.ceil(panelContentHeight() + 50);
    const desiredWidth = Math.max(node.size[0], 420);
    if (Math.abs(node.size[1] - desiredHeight) > 2 || node.size[0] < 420) {
      node.setSize([desiredWidth, desiredHeight]);
      app.graph.setDirtyCanvas(true, true);
    }
  }

  const panelObserver = new ResizeObserver(() => requestAnimationFrame(fitNodeToPanel));
  panelObserver.observe(root);
  palette.addEventListener("toggle", () => requestAnimationFrame(fitNodeToPanel));

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    clearTimeout(debounceTimer);
    panelObserver.disconnect();
    onRemoved?.apply(this, arguments);
  };

  syncFromWidgets();
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
  },
});
