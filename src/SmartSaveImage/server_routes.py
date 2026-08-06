"""为 SmartSaveImage 提供实时目录预览的后端路由。

前端把当前工作流 prompt 和模板发过来，这里用与保存时完全相同的解析逻辑算出：
- 解析到的上下文（model / seed / sampler ...），让用户一眼看清占位符会变成什么；
- 最终目标目录、示例文件名；
- 目录是否已存在、已有多少张图片。

这样用户在保存前就能确认规则，而不是保存完再去猜。
"""

from __future__ import annotations

import os

from .nodes.smart_save import (
    SmartSaveImage,
    build_filename_base,
    build_subfolder,
    resolve_template_context,
    resolve_root,
)

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".gif")


def _count_images(folder: str) -> int:
    try:
        return sum(
            1 for name in os.listdir(folder)
            if name.lower().endswith(_IMAGE_EXTS) and os.path.isfile(os.path.join(folder, name))
        )
    except Exception:
        return 0


def compute_preview(data: dict) -> dict:
    prompt = data.get("prompt") or {}
    root_mode = data.get("root_mode", "output")
    custom_root = data.get("custom_root", "")
    folder_template = data.get("folder_template", "")
    filename_template = data.get("filename_template", "image")
    file_format = data.get("file_format", "png")
    manual_model = data.get("manual_model", "auto")
    variable_overrides = data.get("variable_overrides", "")
    counter_digits = min(max(int(data.get("counter_digits", 3) or 0), 0), 8)
    batch_size = min(max(int(data.get("batch_size", 1) or 1), 1), 1000)
    collision_mode = data.get("collision_mode", SmartSaveImage.COLLISION_INCREMENT)

    ctx = resolve_template_context(
        prompt,
        manual_model=manual_model,
        variable_overrides=variable_overrides,
    )

    root = resolve_root(root_mode, custom_root)
    subfolder = build_subfolder(folder_template, ctx)
    target = os.path.realpath(os.path.join(root, subfolder))

    ext = SmartSaveImage._extension(file_format)
    example_names: list[str] = []
    preview_count = min(max(batch_size, 1), 3)
    for i in range(preview_count):
        base = build_filename_base(filename_template, ctx, i, batch_size, counter_digits)
        desired_path = os.path.join(target, base + ext)
        preview_path = SmartSaveImage._unique_path(
            desired_path,
            collision_mode == SmartSaveImage.COLLISION_OVERWRITE,
            counter_digits,
        )
        example_names.append(os.path.basename(preview_path))

    exists = os.path.isdir(target)
    return {
        "ok": True,
        "root": root,
        "subfolder": subfolder,
        "target": target,
        "exists": exists,
        "existing_count": _count_images(target) if exists else 0,
        "example_filenames": example_names,
        "context": {
            "model": ctx.get("model") or "",
            "model_full": ctx.get("model_full") or "",
            "lora": ctx.get("lora") or "",
            "loras": ctx.get("loras", []),
            "vae": ctx.get("vae") or "",
            "seed": ctx.get("seed") or "",
            "steps": ctx.get("steps") or "",
            "cfg": ctx.get("cfg") or "",
            "sampler": ctx.get("sampler") or "",
            "scheduler": ctx.get("scheduler") or "",
            "width": ctx.get("width") or "",
            "height": ctx.get("height") or "",
            "positive": (ctx.get("positive") or "")[:120],
            "negative": (ctx.get("negative") or "")[:120],
            "custom": ctx.get("custom", {}),
            "overridden": ctx.get("overridden", []),
        },
    }


def register_routes() -> None:
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return

    # 避免重复注册
    if getattr(instance, "_smartsave_routes_registered", False):
        return

    @instance.routes.post("/smartsave/preview")
    async def smartsave_preview(request):  # noqa: ANN001
        try:
            data = await request.json()
        except Exception:
            data = {}
        try:
            result = compute_preview(data or {})
        except Exception as exc:  # 预览失败不影响使用
            result = {"ok": False, "error": str(exc)}
        return web.json_response(result)

    instance._smartsave_routes_registered = True
