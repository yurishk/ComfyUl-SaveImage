"""SmartSaveImage —— 规则可视化、目录可预览、模型读取健壮的图片保存节点。

设计目标（对应用户诉求）：
1. 所见即所得：保存规则（目录 / 文件名模板）在节点里清晰展示，配合前端实时预览，
   不需要保存完再去猜文件去哪了。
2. 目录规则强大：支持根目录选择、多级目录模板、丰富的占位符（日期 / 模型 / lora /
   采样器 / 尺寸 / 提示词 / 计数器等），并做安全清洗。
3. 模型读取健壮：从工作流 prompt 中广度扫描各种加载器、各种输入键、其它插件的自定义
   节点，尽最大努力拿到 checkpoint / unet / lora / vae 名称，且支持手动覆盖。

本文件不依赖任何旧的 core/utils 模块，方便独立维护。
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths
import nodes as comfy_nodes

try:
    from comfy.cli_args import args
except Exception:  # pragma: no cover - 测试环境可能没有
    args = None


# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #

_INVALID_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_DATE_TOKEN = re.compile(r"%date(?::([^%]+))?%", re.IGNORECASE)
_CUSTOM_TOKEN_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_VARIABLE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".sft", ".bin", ".gguf", ".onnx")

# 各类模型输入键（尽量覆盖官方 + 常见第三方节点）
_CKPT_KEYS = ("ckpt_name", "checkpoint", "ckpt", "base_ckpt_name", "model_path")
_UNET_KEYS = ("unet_name", "diffusion_model_name", "model_name")
_LORA_KEYS = ("lora_name", "lora", "lora_name_1", "lora_1", "lora_0")
_VAE_KEYS = ("vae_name", "vae")

_SAMPLER_SEED_KEYS = ("seed", "noise_seed")

VARIABLE_CONFIG_VERSION = 1
EMPTY_VARIABLE_CONFIG = json.dumps(
    {"version": VARIABLE_CONFIG_VERSION, "items": []},
    ensure_ascii=False,
    separators=(",", ":"),
)
VARIABLE_ALIASES = {
    "unet": "unet",
    "lora": "lora",
    "loras": "loras",
    "vae": "vae",
    "seed": "seed",
    "steps": "steps",
    "cfg": "cfg",
    "sampler": "sampler",
    "scheduler": "scheduler",
    "width": "width",
    "height": "height",
    "prompt": "positive",
    "negative": "negative",
}
_RESERVED_CUSTOM_KEYS = {
    "date", "year", "month", "day", "hour", "minute", "second", "batch",
    "model", "model_full", *VARIABLE_ALIASES,
}
_EXTERNAL_INPUT_KEYS = {
    "unet", "lora", "loras", "vae", "seed", "steps", "cfg",
    "width", "height", "prompt", "negative",
}


class AnyType(str):
    def __ne__(self, other):
        return False


ANY = AnyType("*")
MISSING = object()


class FlexibleOptionalInputType(dict):
    """Accept frontend-defined override sockets while preserving known input specs."""

    def __init__(self, dynamic_spec, data=None):
        super().__init__(data or {})
        self.dynamic_spec = dynamic_spec

    def __getitem__(self, key):
        return super().__getitem__(key) if dict.__contains__(self, key) else self.dynamic_spec

    def __contains__(self, key):
        return True


def variable_input_name(item_id: Any) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(item_id or ""))
    return f"variable_{safe_id}"


# --------------------------------------------------------------------------- #
# 上下文提取（模型 / 种子 / 提示词 / 采样参数）
# --------------------------------------------------------------------------- #

def _is_link(value: Any) -> bool:
    """ComfyUI 中，连线输入会表现为 [node_id, output_index]。"""
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int))


def _looks_like_model(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower().endswith(MODEL_EXTS)


def _iter_prompt_nodes(prompt: Any):
    """遍历 prompt（{node_id: {class_type, inputs}}）里的每个节点。"""
    if not isinstance(prompt, dict):
        return
    for node_data in prompt.values():
        if isinstance(node_data, dict) and "class_type" in node_data:
            inputs = node_data.get("inputs")
            yield str(node_data.get("class_type", "")), inputs if isinstance(inputs, dict) else {}


def extract_context(prompt: Any, width: int = 0, height: int = 0) -> dict[str, Any]:
    """从工作流 prompt 中健壮地提取用于命名的上下文信息。

    返回值一定包含所有键，缺失时给出合理的占位值，绝不抛异常。
    """
    ctx: dict[str, Any] = {
        "model": "",
        "model_full": "",
        "unet": "",
        "lora": "",
        "loras": [],
        "vae": "",
        "seed": "",
        "steps": "",
        "cfg": "",
        "sampler": "",
        "scheduler": "",
        "positive": "",
        "negative": "",
        "width": str(int(width)) if width else "",
        "height": str(int(height)) if height else "",
    }

    checkpoint = ""
    unet = ""
    vae = ""
    loras: list[str] = []
    text_candidates: list[str] = []

    for class_type, inputs in _iter_prompt_nodes(prompt):
        cls_lower = class_type.lower()

        # ---- 模型：checkpoint / unet ----
        for key, value in inputs.items():
            if _is_link(value):
                continue
            key_l = key.lower()
            if not checkpoint and (key_l in _CKPT_KEYS or (_looks_like_model(value) and "ckpt" in key_l)):
                if isinstance(value, str) and value.strip():
                    checkpoint = value.strip()
            if not unet and key_l in _UNET_KEYS and isinstance(value, str) and value.strip():
                unet = value.strip()
            if not vae and key_l in _VAE_KEYS and isinstance(value, str) and value.strip() and value != "taesd":
                vae = value.strip()
            # lora 可能有多个键（lora_name / lora_1 / lora_02 ...）
            if isinstance(value, str) and value.strip() and ("lora" in key_l) and _looks_like_model(value):
                loras.append(value.strip())

        # 兜底：某些加载器把模型放在不常见的键里，但类名里带 Checkpoint/Loader
        if not checkpoint and ("checkpoint" in cls_lower or "ckpt" in cls_lower):
            for value in inputs.values():
                if not _is_link(value) and _looks_like_model(value):
                    checkpoint = value.strip()
                    break

        # ---- 采样参数 ----
        if "sampler" in cls_lower or "ksampler" in cls_lower:
            for k in _SAMPLER_SEED_KEYS:
                v = inputs.get(k)
                if not ctx["seed"] and isinstance(v, (int, float, str)) and not _is_link(v):
                    ctx["seed"] = str(int(v)) if isinstance(v, float) else str(v)
            for field in ("steps", "cfg", "sampler_name", "scheduler"):
                v = inputs.get(field)
                if _is_link(v):
                    continue
                target = {"steps": "steps", "cfg": "cfg",
                          "sampler_name": "sampler", "scheduler": "scheduler"}[field]
                if not ctx[target] and isinstance(v, (int, float, str)) and str(v) != "":
                    ctx[target] = str(v)

        # ---- 提示词文本 ----
        if "textencode" in cls_lower or "cliptextencode" in cls_lower or "text" in cls_lower:
            for tkey in ("text", "text_g", "text_l", "prompt", "positive"):
                v = inputs.get(tkey)
                if isinstance(v, str) and v.strip() and not _is_link(v):
                    text_candidates.append(v.strip())

        # ---- 尺寸兜底（预览时没有真实图片，从 EmptyLatentImage 等读取）----
        if not ctx["width"]:
            w = inputs.get("width")
            if isinstance(w, (int, float)) and not _is_link(w):
                ctx["width"] = str(int(w))
        if not ctx["height"]:
            h = inputs.get("height")
            if isinstance(h, (int, float)) and not _is_link(h):
                ctx["height"] = str(int(h))

    # 模型主名：优先 checkpoint，其次 unet
    model_full = checkpoint or unet
    ctx["model_full"] = model_full
    ctx["model"] = Path(model_full).stem if model_full else ""
    ctx["unet"] = Path(unet).stem if unet else ""
    ctx["vae"] = Path(vae).stem if vae else ""
    # 去重保序
    seen = set()
    uniq_loras = []
    for l in loras:
        stem = Path(l).stem
        if stem not in seen:
            seen.add(stem)
            uniq_loras.append(stem)
    ctx["loras"] = uniq_loras
    ctx["lora"] = uniq_loras[0] if uniq_loras else ""

    if text_candidates:
        ctx["positive"] = text_candidates[0]
        if len(text_candidates) > 1:
            ctx["negative"] = text_candidates[1]

    return ctx


def _prompt_node(prompt: Any, node_id: Any) -> dict[str, Any] | None:
    if not isinstance(prompt, dict):
        return None
    node = prompt.get(str(node_id), prompt.get(node_id))
    return node if isinstance(node, dict) else None


def _connected_source(prompt: Any, unique_id: Any, input_name: str) -> tuple[Any, int] | None:
    current = _prompt_node(prompt, unique_id)
    candidates = [current] if current else []
    if not candidates and isinstance(prompt, dict):
        candidates = [
            node for node in prompt.values()
            if isinstance(node, dict) and node.get("class_type") == "SmartSaveImage"
        ]
    for node in candidates:
        value = (node.get("inputs") or {}).get(input_name)
        if _is_link(value):
            return value[0], int(value[1])
    return None


def _upstream_prompt(prompt: Any, source_id: Any) -> dict[str, Any]:
    subset: dict[str, Any] = {}
    pending = [source_id]
    while pending:
        node_id = pending.pop()
        key = str(node_id)
        if key in subset:
            continue
        node = _prompt_node(prompt, node_id)
        if not node:
            continue
        subset[key] = node
        for value in (node.get("inputs") or {}).values():
            if _is_link(value):
                pending.append(value[0])
    return subset


def _linked_variable_value(prompt: Any, unique_id: Any, input_name: str, key: str) -> str | None:
    source = _connected_source(prompt, unique_id, input_name)
    if not source:
        return None
    source_id, _ = source
    subset = _upstream_prompt(prompt, source_id)
    linked_ctx = extract_context(subset)
    context_key = {
        "model": "model_full",
        "unet": "unet",
        "lora": "lora",
        "vae": "vae",
    }.get(key)
    if context_key and linked_ctx.get(context_key):
        return str(linked_ctx[context_key])
    if key == "loras" and linked_ctx.get("loras"):
        return ",".join(linked_ctx["loras"])

    source_node = _prompt_node(prompt, source_id) or {}
    source_inputs = source_node.get("inputs") or {}
    preferred = {
        "seed": ("seed", "noise_seed", "value"),
        "steps": ("steps", "value"),
        "cfg": ("cfg", "value"),
        "width": ("width", "value"),
        "height": ("height", "value"),
        "prompt": ("text", "prompt", "value"),
        "negative": ("text", "negative", "value"),
    }.get(key, ("value", "text"))
    for candidate in preferred:
        value = source_inputs.get(candidate)
        if isinstance(value, (str, int, float, bool)) and not _is_link(value):
            return str(value)
    return None


def _runtime_variable_value(value: Any) -> str | None:
    if value is MISSING:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, (list, tuple)) and all(isinstance(item, (str, int, float, bool)) for item in value):
        return ",".join(str(item) for item in value)
    return None


def _normalise_named_value(key: str, value: str) -> str:
    if key in {"unet", "lora", "vae"}:
        return Path(value).stem
    if key == "loras":
        return ",".join(
            Path(part.strip()).stem
            for part in re.split(r"[,;\n]+", value)
            if part.strip()
        )
    return value


def parse_variable_config(value: Any) -> list[dict[str, str]]:
    """Parse per-node overrides without allowing malformed workflow data to fail a save."""
    source = value
    if isinstance(value, str):
        try:
            source = json.loads(value)
        except (TypeError, ValueError):
            return []
    if isinstance(source, dict):
        raw_items = source.get("items", [])
    elif isinstance(source, list):
        raw_items = source
    else:
        return []

    items: list[dict[str, str]] = []
    for raw in raw_items if isinstance(raw_items, list) else []:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key", "")).strip().lower()
        if not _CUSTOM_TOKEN_KEY.fullmatch(key):
            continue
        item_id = str(raw.get("id", "")).strip()
        items.append({
            "id": item_id if _VARIABLE_ID.fullmatch(item_id) else "",
            "key": key,
            "value": str(raw.get("value", "")),
        })
    return items


def apply_variable_overrides(
    ctx: dict[str, Any],
    config: Any,
    external_values: dict[str, Any] | None = None,
    prompt: Any = None,
    unique_id: Any = None,
    connected_inputs: set[str] | None = None,
    preview_mode: bool = False,
) -> dict[str, Any]:
    """Return a copied context with known-field and custom-token overrides applied."""
    result = dict(ctx)
    result["loras"] = list(ctx.get("loras") or [])
    result["custom"] = dict(ctx.get("custom") or {})
    overridden: list[str] = []
    override_sources: dict[str, str] = {}
    external_values = external_values or {}
    connected_inputs = connected_inputs or set()

    for item in parse_variable_config(config):
        key = item["key"]
        value = item["value"]
        source = "manual"
        input_name = variable_input_name(item["id"])
        if item["id"] and (key in _EXTERNAL_INPUT_KEYS or key not in VARIABLE_ALIASES):
            runtime_value = _runtime_variable_value(external_values.get(input_name, MISSING))
            linked_value = _linked_variable_value(prompt, unique_id, input_name, key)
            if runtime_value is not None or linked_value is not None:
                value = runtime_value if runtime_value is not None else linked_value
                source = "input"
            elif preview_mode and (
                input_name in connected_inputs or _connected_source(prompt, unique_id, input_name)
            ):
                value = "runtime"
                source = "input"
        value = _normalise_named_value(key, value)
        target = VARIABLE_ALIASES.get(key)
        if target:
            # An unfinished/cleared known override falls back to workflow detection.
            if value == "":
                continue
            if target == "loras":
                result[target] = [part.strip() for part in re.split(r"[,;\n]+", value) if part.strip()]
                result["lora"] = result[target][0] if result[target] else ""
            else:
                result[target] = value
            if key == "lora":
                result["loras"] = [value] if value else []
            overridden.append(key)
            override_sources[key] = source
        elif key not in _RESERVED_CUSTOM_KEYS:
            result["custom"][key] = value
            overridden.append(key)
            override_sources[key] = source

    result["overridden"] = list(dict.fromkeys(overridden))
    result["override_sources"] = override_sources
    return result


def resolve_template_context(
    prompt: Any,
    width: int = 0,
    height: int = 0,
    manual_model: str = "auto",
    variable_overrides: Any = EMPTY_VARIABLE_CONFIG,
    *,
    external_values: dict[str, Any] | None = None,
    unique_id: Any = None,
    model_input: Any = MISSING,
    connected_inputs: set[str] | None = None,
    preview_mode: bool = False,
) -> dict[str, Any]:
    """Build the final per-save-node context used by both preview and execution."""
    ctx = extract_context(prompt, width, height)
    if manual_model and manual_model != "auto":
        ctx["model_full"] = manual_model
        ctx["model"] = Path(manual_model).stem
    model_source = None
    model_value = _runtime_variable_value(model_input)
    if model_value is None:
        model_value = _linked_variable_value(prompt, unique_id, "model_input", "model")
    if model_value:
        ctx["model_full"] = model_value
        ctx["model"] = Path(model_value).stem
        model_source = "input"
    elif preview_mode and (
        "model_input" in (connected_inputs or set())
        or _connected_source(prompt, unique_id, "model_input")
    ):
        ctx["model_full"] = "runtime_model"
        ctx["model"] = "runtime_model"
        model_source = "input"
    result = apply_variable_overrides(
        ctx,
        variable_overrides,
        external_values=external_values,
        prompt=prompt,
        unique_id=unique_id,
        connected_inputs=connected_inputs,
        preview_mode=preview_mode,
    )
    if model_source:
        result["override_sources"]["model"] = model_source
    return result


# --------------------------------------------------------------------------- #
# 模板引擎
# --------------------------------------------------------------------------- #

def _strftime_format(value: str) -> str:
    result = value
    for token, repl in (
        ("yyyy", "%Y"), ("yy", "%y"), ("MM", "%m"), ("dd", "%d"),
        ("HH", "%H"), ("hh", "%H"), ("mm", "%M"), ("ss", "%S"),
    ):
        result = result.replace(token, repl)
    return result


def sanitize_segment(value: str, fallback: str = "", max_length: int = 80) -> str:
    value = _INVALID_NAME_CHARS.sub("_", str(value)).strip().strip(".")
    value = re.sub(r"\s+", " ", value)
    if value.upper() in _WINDOWS_RESERVED:
        value = f"_{value}"
    value = value[:max_length].rstrip()
    return value or fallback


def expand_template(template: str, ctx: dict[str, Any], batch_index: int = 0,
                    prompt_max_len: int = 60) -> str:
    """把模板字符串中的占位符替换为真实值（不做路径分段清洗）。"""
    now = datetime.now()

    def replace_date(match: re.Match[str]) -> str:
        fmt = match.group(1) or "yyyy-MM-dd"
        try:
            return now.strftime(_strftime_format(fmt))
        except ValueError:
            return now.strftime("%Y-%m-%d")

    value = _DATE_TOKEN.sub(replace_date, template or "")

    positive = re.sub(r"\s+", " ", ctx.get("positive", "")).strip()[:prompt_max_len]

    # Only literal separators typed in the template may create directories.
    # Values coming from models/prompts often contain slashes and must stay in one segment.
    model = sanitize_segment(ctx.get("model") or "unknown_model", "unknown_model", 100)
    model_full = sanitize_segment(ctx.get("model_full") or "unknown_model", "unknown_model", 140)
    unet = sanitize_segment(ctx.get("unet") or "", "", 100)
    lora = sanitize_segment(ctx.get("lora") or "no_lora", "no_lora", 100)
    loras = sanitize_segment("+".join(ctx.get("loras") or []), "no_lora", 160)
    vae = sanitize_segment(ctx.get("vae") or "", "", 100)
    prompt_text = sanitize_segment(positive or "untitled", "untitled", prompt_max_len)
    negative = re.sub(r"\s+", " ", ctx.get("negative", "")).strip()[:prompt_max_len]
    negative_text = sanitize_segment(negative or "", "", prompt_max_len)

    tokens = {
        "%year%": now.strftime("%Y"),
        "%month%": now.strftime("%m"),
        "%day%": now.strftime("%d"),
        "%hour%": now.strftime("%H"),
        "%minute%": now.strftime("%M"),
        "%second%": now.strftime("%S"),
        "%model%": model,
        "%model_full%": model_full,
        "%unet%": unet,
        "%lora%": lora,
        "%loras%": loras,
        "%vae%": vae,
        "%seed%": str(ctx.get("seed") or "0"),
        "%steps%": str(ctx.get("steps") or ""),
        "%cfg%": str(ctx.get("cfg") or ""),
        "%sampler%": ctx.get("sampler") or "",
        "%scheduler%": ctx.get("scheduler") or "",
        "%width%": str(ctx.get("width") or "0"),
        "%height%": str(ctx.get("height") or "0"),
        "%prompt%": prompt_text,
        "%negative%": negative_text,
        "%batch%": f"{batch_index:02d}",
    }
    for token, repl in tokens.items():
        value = value.replace(token, str(repl))
    for key, custom_value in (ctx.get("custom") or {}).items():
        if _CUSTOM_TOKEN_KEY.fullmatch(str(key)) and key not in _RESERVED_CUSTOM_KEYS:
            value = value.replace(
                f"%{key}%",
                sanitize_segment(str(custom_value), "", 160),
            )
    return value


def build_subfolder(template: str, ctx: dict[str, Any], prompt_max_len: int = 60) -> str:
    """把目录模板展开成安全的相对子目录（保留多级）。"""
    expanded = expand_template(template, ctx, 0, prompt_max_len)
    parts = re.split(r"[\\/]+", expanded)
    safe = [sanitize_segment(p) for p in parts if p.strip() not in {"", ".", ".."}]
    safe = [p for p in safe if p]
    return os.path.join(*safe) if safe else ""


def build_filename_base(template: str, ctx: dict[str, Any], batch_index: int,
                        batch_size: int, counter_digits: int) -> str:
    """Build one safe filename stem using the same rules for preview and saving."""
    expanded = expand_template(template or "image", ctx, batch_index)
    base = sanitize_segment(expanded, fallback="image", max_length=160)
    if batch_size > 1 and "%batch%" not in (template or ""):
        width = max(int(counter_digits), 1)
        base = f"{base}_{batch_index:0{width}d}"
    return base


# --------------------------------------------------------------------------- #
# 根目录解析
# --------------------------------------------------------------------------- #

def _known_roots() -> dict[str, str]:
    roots = {
        "output": folder_paths.get_output_directory(),
        "input": folder_paths.get_input_directory(),
        "temp": folder_paths.get_temp_directory(),
    }
    return {k: os.path.realpath(v) for k, v in roots.items()}


def resolve_root(root_mode: str, custom_root: str) -> str:
    roots = _known_roots()
    if root_mode in roots:
        return roots[root_mode]
    # custom
    output_root = roots["output"]
    if not custom_root or not custom_root.strip():
        return output_root
    requested = os.path.expandvars(os.path.expanduser(custom_root.strip()))
    if not os.path.isabs(requested):
        requested = os.path.join(output_root, requested)
    return os.path.realpath(requested)


def resolve_target(root_mode: str, custom_root: str, folder_template: str,
                   ctx: dict[str, Any], prompt_max_len: int = 60) -> tuple[str, str]:
    """返回 (根目录, 完整目标目录)。"""
    root = resolve_root(root_mode, custom_root)
    subfolder = build_subfolder(folder_template, ctx, prompt_max_len)
    target = os.path.realpath(os.path.join(root, subfolder))
    return root, target


# --------------------------------------------------------------------------- #
# 节点主体
# --------------------------------------------------------------------------- #

class SmartSaveImage:
    """规则可视化的智能图片保存节点。"""

    CATEGORY = "image/save"
    DESCRIPTION = "所见即所得的图片保存：目录/文件名规则清晰可见，支持实时目录预览与健壮的模型读取。"
    SEARCH_ALIASES = ["save image", "smart save", "保存图片", "智能保存"]
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    FUNCTION = "save_images"

    ROOT_MODES = ["output", "custom", "input", "temp"]
    FORMATS = ["png", "jpeg", "webp"]
    COLLISION_INCREMENT = "increment"
    COLLISION_OVERWRITE = "overwrite"
    MODE_SAVE_PREVIEW = "save_and_preview"
    MODE_SAVE_ONLY = "save_only"
    MODE_PREVIEW_ONLY = "preview_only"

    @classmethod
    def INPUT_TYPES(cls):
        try:
            ckpts = folder_paths.get_filename_list("checkpoints")
        except Exception:
            ckpts = []
        model_choices = ["auto"] + ckpts

        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "需要保存的图片或图片批次。"}),
                "root_mode": (cls.ROOT_MODES, {
                    "default": "output",
                    "tooltip": "根目录：output=ComfyUI 输出目录；custom=自定义绝对/相对路径；input/temp 为内置目录。",
                }),
                "custom_root": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "仅当 root_mode=custom 生效；可用绝对路径，留空回退到 output。",
                }),
                "folder_template": ("STRING", {
                    "default": "%date:yyyy-MM-dd%/%model%",
                    "multiline": False,
                    "tooltip": "子目录模板，支持多级与占位符，如 %date%/%model%/%sampler%。",
                }),
                "filename_template": ("STRING", {
                    "default": "%model%_%seed%",
                    "multiline": False,
                    "tooltip": "文件名模板（不含扩展名）。批量时自动追加序号，或用 %batch% 自定义位置。",
                }),
                "file_format": (cls.FORMATS, {"default": "png"}),
                "quality": ("INT", {
                    "default": 95, "min": 1, "max": 100, "step": 1,
                    "tooltip": "旧工作流兼容字段，不在新版界面中显示。",
                }),
                "collision_mode": ([cls.COLLISION_INCREMENT, cls.COLLISION_OVERWRITE], {
                    "default": cls.COLLISION_INCREMENT,
                    "tooltip": "increment=自动编号避免覆盖；overwrite=覆盖同名文件。",
                }),
                "save_mode": ([cls.MODE_SAVE_PREVIEW, cls.MODE_SAVE_ONLY, cls.MODE_PREVIEW_ONLY], {
                    "default": cls.MODE_SAVE_PREVIEW,
                }),
            },
            "optional": FlexibleOptionalInputType((ANY, {
                "forceInput": True,
                "tooltip": "由变量覆盖面板创建的外部输入。",
            }), {
                "manual_model": (model_choices, {
                    "default": "auto",
                    "tooltip": "手动指定模型名以覆盖自动读取（auto=自动从工作流读取）。",
                }),
                "embed_workflow": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "PNG 写入 ComfyUI 工作流元数据；JPEG/WebP 写入 EXIF。",
                }),
                "counter_digits": ("INT", {
                    "default": 3, "min": 0, "max": 8,
                    "tooltip": "批量/防冲突序号位数，0 表示尽量不加序号。",
                }),
                "png_compression": ("INT", {
                    "default": 4, "min": 0, "max": 9, "step": 1,
                    "tooltip": "PNG 无损压缩等级；4 与 ComfyUI 自带保存节点一致。",
                }),
                "variable_overrides": ("STRING", {
                    "default": EMPTY_VARIABLE_CONFIG,
                    "multiline": True,
                    "tooltip": "当前保存节点独立使用的模板变量覆盖与自定义变量。",
                }),
                "model_input": (ANY, {
                    "forceInput": True,
                    "tooltip": "可连接模型对象或模型名称；连接后优先于手动模型来源。",
                }),
            }),
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    # --------------------------- 元数据 --------------------------- #

    @staticmethod
    def _safe_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)

    @staticmethod
    def _metadata_disabled() -> bool:
        return args is not None and getattr(args, "disable_metadata", False)

    @classmethod
    def _png_metadata(cls, prompt, extra_pnginfo, ctx, enabled: bool) -> PngInfo | None:
        if not enabled or cls._metadata_disabled():
            return None
        meta = PngInfo()
        # A1111 风格 parameters，方便第三方查看器识别
        params = cls._build_parameters_text(ctx)
        if params:
            meta.add_text("parameters", params)
        if prompt is not None:
            meta.add_text("prompt", cls._safe_json(prompt))
        if isinstance(extra_pnginfo, dict):
            for key, value in extra_pnginfo.items():
                meta.add_text(str(key), cls._safe_json(value))
        return meta

    @classmethod
    def _exif_metadata(cls, image: Image.Image, prompt, extra_pnginfo, enabled: bool):
        if not enabled or cls._metadata_disabled():
            return None
        payload = {"prompt": prompt, "extra_pnginfo": extra_pnginfo}
        exif = image.getexif()
        exif[0x9286] = cls._safe_json(payload)  # UserComment
        return exif

    @staticmethod
    def _build_parameters_text(ctx: dict[str, Any]) -> str:
        parts: list[str] = []
        if ctx.get("positive"):
            parts.append(ctx["positive"])
        if ctx.get("negative"):
            parts.append(f"Negative prompt: {ctx['negative']}")
        extra = []
        if ctx.get("steps"):
            extra.append(f"Steps: {ctx['steps']}")
        if ctx.get("sampler"):
            sch = ctx.get("scheduler")
            extra.append(f"Sampler: {ctx['sampler']}" + (f" {sch}" if sch and sch != "normal" else ""))
        if ctx.get("cfg"):
            extra.append(f"CFG scale: {ctx['cfg']}")
        if ctx.get("seed"):
            extra.append(f"Seed: {ctx['seed']}")
        if ctx.get("width") and ctx.get("height"):
            extra.append(f"Size: {ctx['width']}x{ctx['height']}")
        if ctx.get("model"):
            extra.append(f"Model: {ctx['model']}")
        if extra:
            parts.append(", ".join(extra))
        return "\n".join(parts)

    # --------------------------- 图片写盘 --------------------------- #

    @staticmethod
    def _extension(file_format: str) -> str:
        return {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}.get(file_format, ".png")

    @staticmethod
    def _tensor_to_image(image) -> Image.Image:
        array = image.detach().cpu().numpy() if hasattr(image, "detach") else np.asarray(image)
        array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
        return Image.fromarray(array)

    @classmethod
    def _save_one(cls, image, path, file_format, quality, png_compression,
                  prompt, extra_pnginfo, ctx, embed):
        pil = cls._tensor_to_image(image)
        pil_format = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}.get(file_format, "PNG")
        kwargs: dict[str, Any] = {}
        if file_format == "png":
            kwargs["pnginfo"] = cls._png_metadata(prompt, extra_pnginfo, ctx, embed)
            kwargs["compress_level"] = max(0, min(int(png_compression), 9))
        else:
            if pil.mode not in {"RGB", "L"}:
                pil = pil.convert("RGB")
            kwargs["exif"] = cls._exif_metadata(pil, prompt, extra_pnginfo, embed)
            if file_format == "webp":
                kwargs["lossless"] = True
            else:
                kwargs["quality"] = max(1, min(int(quality), 100))
                kwargs["subsampling"] = 0

        os.makedirs(os.path.dirname(path), exist_ok=True)
        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile(prefix=".smartsave-", suffix=cls._extension(file_format),
                                             dir=os.path.dirname(path), delete=False) as handle:
                temp_path = handle.name
            pil.save(temp_path, format=pil_format,
                     **{k: v for k, v in kwargs.items() if v is not None})
            os.replace(temp_path, path)
            temp_path = ""
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)

    @staticmethod
    def _unique_path(path: str, overwrite: bool, digits: int) -> str:
        if overwrite or not os.path.exists(path):
            return path
        root, ext = os.path.splitext(path)
        width = max(digits, 1)
        counter = 1
        while counter <= 9_999_999:
            candidate = f"{root}_{counter:0{width}d}{ext}"
            if not os.path.exists(candidate):
                return candidate
            counter += 1
        raise RuntimeError(f"无法为文件生成可用编号: {path}")

    @staticmethod
    def _is_inside(path: str, root: str) -> bool:
        try:
            return os.path.commonpath([os.path.realpath(path), os.path.realpath(root)]) == os.path.realpath(root)
        except ValueError:
            return False

    @classmethod
    def _ui_image(cls, path: str) -> dict[str, str] | None:
        roots = (
            ("output", folder_paths.get_output_directory()),
            ("input", folder_paths.get_input_directory()),
            ("temp", folder_paths.get_temp_directory()),
        )
        for image_type, root in roots:
            if not cls._is_inside(path, root):
                continue
            subfolder = os.path.relpath(os.path.dirname(path), root)
            return {
                "filename": os.path.basename(path),
                "subfolder": "" if subfolder == "." else subfolder.replace("\\", "/"),
                "type": image_type,
            }
        return None

    # --------------------------- 主函数 --------------------------- #

    def save_images(self, images, root_mode, custom_root, folder_template, filename_template,
                    file_format, quality, collision_mode, save_mode,
                    manual_model="auto", embed_workflow=True, counter_digits=3, png_compression=4,
                    variable_overrides=EMPTY_VARIABLE_CONFIG, model_input=MISSING,
                    prompt=None, extra_pnginfo=None, unique_id=None, **dynamic_inputs):

        if save_mode == self.MODE_PREVIEW_ONLY:
            return comfy_nodes.PreviewImage().save_images(
                images, filename_prefix="SmartSavePreview",
                prompt=prompt, extra_pnginfo=extra_pnginfo)

        height = int(images[0].shape[0]) if len(images) else 0
        width = int(images[0].shape[1]) if len(images) else 0
        ctx = resolve_template_context(
            prompt,
            width,
            height,
            manual_model,
            variable_overrides,
            external_values=dynamic_inputs,
            unique_id=unique_id,
            model_input=model_input,
        )

        root, target_folder = resolve_target(root_mode, custom_root, folder_template, ctx)
        os.makedirs(target_folder, exist_ok=True)

        overwrite = collision_mode == self.COLLISION_OVERWRITE
        saved_ui: list[dict[str, str]] = []

        for batch_index, image in enumerate(images):
            base = build_filename_base(
                filename_template, ctx, batch_index, len(images), counter_digits)
            filename = base + self._extension(file_format)
            path = self._unique_path(os.path.join(target_folder, filename), overwrite, counter_digits)

            self._save_one(
                image, path, file_format, quality, png_compression,
                prompt, extra_pnginfo, ctx, embed_workflow)

            ui_image = self._ui_image(path)
            if ui_image:
                saved_ui.append(ui_image)

        if save_mode == self.MODE_SAVE_ONLY:
            return {"ui": {}}
        if saved_ui:
            return {"ui": {"images": saved_ui}}
        # 保存到 output 之外时无法通过 /view 直接预览，用临时预览兜底
        return comfy_nodes.PreviewImage().save_images(
            images, filename_prefix="SmartSavePreview",
            prompt=prompt, extra_pnginfo=extra_pnginfo)
