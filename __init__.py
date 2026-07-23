"""智能保存图片 - ComfyUI 节点包"""

__author__ = "kj"
__email__ = "2990346238@qq.com"
__version__ = "2.0.0"

from .src.SmartSaveImage import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# 前端资源目录（可视化面板 JS/CSS）
WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
