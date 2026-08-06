"""SmartSaveImage 节点回归测试。"""

import json
from pathlib import Path

import pytest
import torch
from PIL import Image

pytest.importorskip("folder_paths")

from src.SmartSaveImage.nodes import NODE_CLASS_MAPPINGS, SmartSaveImage
from src.SmartSaveImage.nodes.smart_save import (
    EMPTY_VARIABLE_CONFIG,
    apply_variable_overrides,
    build_subfolder,
    expand_template,
    extract_context,
    parse_variable_config,
    resolve_template_context,
)
from src.SmartSaveImage.server_routes import compute_preview


def test_node_is_registered():
    assert NODE_CLASS_MAPPINGS["SmartSaveImage"] is SmartSaveImage
    assert SmartSaveImage.OUTPUT_NODE is True
    assert SmartSaveImage.RETURN_TYPES == ()


def test_template_expansion_and_sanitizing():
    context = {
        "model": "model:name",
        "seed": "42",
        "positive": "portrait / studio",
        "width": "1024",
        "height": "768",
    }

    folder = build_subfolder("%model%/%seed%/%prompt%", context)

    assert Path(folder).parts == ("model_name", "42", "portrait _ studio")


def test_extracts_model_name_from_unet_loader():
    prompt = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "Krea/Krea2_fp8.safetensors"},
        }
    }

    context = extract_context(prompt)

    assert context["model"] == "Krea2_fp8"


def test_extract_context_ignores_links_and_reads_sampler():
    prompt = {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "sdxl/dreamShaperXL.safetensors"}},
        "2": {"class_type": "LoraLoader",
              "inputs": {"lora_name": "add_detail.safetensors", "model": ["1", 0]}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": 999, "steps": 30, "cfg": 6.0,
                         "sampler_name": "euler", "scheduler": "normal", "model": ["2", 0]}},
    }

    ctx = extract_context(prompt)

    assert ctx["model"] == "dreamShaperXL"
    assert ctx["lora"] == "add_detail"
    assert ctx["seed"] == "999"
    assert ctx["sampler"] == "euler"


def test_collision_mode_adds_counter(tmp_path):
    original = tmp_path / "image.png"
    original.write_bytes(b"existing")

    result = SmartSaveImage._unique_path(str(original), overwrite=False, digits=3)

    assert Path(result).name == "image_001.png"
    assert original.read_bytes() == b"existing"


def test_preview_uses_next_available_filename(tmp_path):
    (tmp_path / "image.png").write_bytes(b"existing")

    preview = compute_preview({
        "root_mode": "custom",
        "custom_root": str(tmp_path),
        "folder_template": "",
        "filename_template": "image",
        "file_format": "png",
        "collision_mode": "increment",
        "counter_digits": 3,
    })

    assert preview["example_filenames"] == ["image_001.png"]


def test_batch_token_in_filename():
    ctx = extract_context({})
    assert expand_template("img_%batch%", ctx, 5) == "img_05"


def test_variable_overrides_replace_auto_values_and_add_custom_tokens():
    prompt = {
        "1": {
            "class_type": "KSampler",
            "inputs": {"seed": 999, "steps": 30, "sampler_name": "euler"},
        }
    }
    config = json.dumps({"items": [
        {"id": "seed", "key": "seed", "value": "123"},
        {"id": "project", "key": "project", "value": "client/A"},
    ]})

    ctx = resolve_template_context(prompt, variable_overrides=config)

    assert ctx["seed"] == "123"
    assert ctx["steps"] == "30"
    assert ctx["custom"] == {"project": "client/A"}
    assert expand_template("%project%_%seed%", ctx) == "client_A_123"


def test_loras_override_keeps_first_lora_token_consistent():
    ctx = apply_variable_overrides(
        extract_context({}),
        {"items": [{"key": "loras", "value": "face.safetensors, detail.safetensors"}]},
    )

    assert ctx["lora"] == "face.safetensors"
    assert ctx["loras"] == ["face.safetensors", "detail.safetensors"]
    assert expand_template("%lora%+%loras%", ctx) == "face.safetensors+face.safetensors+detail.safetensors"


def test_variable_configuration_is_per_call_and_does_not_mutate_auto_context():
    automatic = extract_context({"1": {"class_type": "KSampler", "inputs": {"seed": 7}}})
    first = apply_variable_overrides(automatic, {"items": [{"key": "seed", "value": "11"}]})
    second = apply_variable_overrides(automatic, {"items": [{"key": "seed", "value": "22"}]})

    assert automatic["seed"] == "7"
    assert first["seed"] == "11"
    assert second["seed"] == "22"


def test_malformed_variable_configuration_falls_back_to_automatic_values():
    automatic = extract_context({"1": {"class_type": "KSampler", "inputs": {"seed": 42}}})

    assert parse_variable_config("not-json") == []
    assert apply_variable_overrides(automatic, "not-json")["seed"] == "42"
    assert SmartSaveImage.INPUT_TYPES()["optional"]["variable_overrides"][1]["default"] == EMPTY_VARIABLE_CONFIG


def test_blank_known_override_keeps_the_automatically_detected_value():
    automatic = extract_context({"1": {"class_type": "KSampler", "inputs": {"seed": 42}}})
    result = apply_variable_overrides(automatic, {"items": [{"key": "seed", "value": ""}]})

    assert result["seed"] == "42"
    assert result["overridden"] == []


def test_preview_uses_the_same_override_context_as_saving(tmp_path):
    config = json.dumps({"items": [
        {"key": "seed", "value": "321"},
        {"key": "project", "value": "example"},
    ]})
    preview = compute_preview({
        "root_mode": "custom",
        "custom_root": str(tmp_path),
        "folder_template": "%project%",
        "filename_template": "image_%seed%",
        "file_format": "png",
        "variable_overrides": config,
    })

    assert Path(preview["target"]).name == "example"
    assert preview["example_filenames"] == ["image_321.png"]
    assert preview["context"]["custom"] == {"project": "example"}
    assert preview["context"]["overridden"] == ["seed", "project"]


@pytest.mark.parametrize("file_format,pil_format", [
    ("png", "PNG"),
    ("jpeg", "JPEG"),
    ("webp", "WEBP"),
])
def test_saves_real_image_batches(tmp_path, file_format, pil_format):
    images = torch.rand((2, 16, 20, 3))
    node = SmartSaveImage()

    node.save_images(
        images=images,
        root_mode="custom",
        custom_root=str(tmp_path),
        folder_template="case_%model%",
        filename_template="sample_%batch%",
        file_format=file_format,
        quality=91,
        collision_mode=SmartSaveImage.COLLISION_INCREMENT,
        save_mode=SmartSaveImage.MODE_SAVE_ONLY,
        manual_model="auto",
        embed_workflow=True,
        counter_digits=3,
        prompt={
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "models/demo.safetensors"},
            }
        },
        extra_pnginfo={"workflow": {"nodes": []}},
    )

    ext = SmartSaveImage._extension(file_format).lstrip(".")
    saved = sorted(tmp_path.rglob(f"*.{ext}"))
    assert [path.stem for path in saved] == ["sample_00", "sample_01"]
    assert {Image.open(path).format for path in saved} == {pil_format}


def test_overwrite_batch_with_zero_digits_keeps_every_image(tmp_path):
    images = torch.rand((2, 8, 8, 3))

    SmartSaveImage().save_images(
        images=images,
        root_mode="custom",
        custom_root=str(tmp_path),
        folder_template="",
        filename_template="image",
        file_format="png",
        quality=95,
        collision_mode=SmartSaveImage.COLLISION_OVERWRITE,
        save_mode=SmartSaveImage.MODE_SAVE_ONLY,
        manual_model="auto",
        embed_workflow=False,
        counter_digits=0,
    )

    assert sorted(path.name for path in tmp_path.glob("*.png")) == ["image_0.png", "image_1.png"]


def test_png_compression_defaults_to_comfyui_save_image_level():
    config = SmartSaveImage.INPUT_TYPES()["optional"]["png_compression"][1]

    assert config["default"] == 4
    assert config["min"] == 0
    assert config["max"] == 9


def test_png_compression_changes_size_without_changing_pixels(tmp_path):
    image = torch.zeros((1, 64, 64, 3))
    node = SmartSaveImage()
    common = {
        "images": image,
        "root_mode": "custom",
        "custom_root": str(tmp_path),
        "folder_template": "",
        "file_format": "png",
        "quality": 95,
        "collision_mode": SmartSaveImage.COLLISION_OVERWRITE,
        "save_mode": SmartSaveImage.MODE_SAVE_ONLY,
        "embed_workflow": False,
    }

    node.save_images(filename_template="level_0", png_compression=0, **common)
    node.save_images(filename_template="level_4", png_compression=4, **common)

    level_0 = tmp_path / "level_0.png"
    level_4 = tmp_path / "level_4.png"
    with Image.open(level_0) as first, Image.open(level_4) as second:
        assert first.tobytes() == second.tobytes()
    assert level_4.stat().st_size < level_0.stat().st_size
