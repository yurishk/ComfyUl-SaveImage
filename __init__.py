"""Smart Save Image custom node package for ComfyUI."""

__author__ = "kj"
__email__ = "2990346238@qq.com"
__version__ = "2.1.0"

from .src.SmartSaveImage import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
