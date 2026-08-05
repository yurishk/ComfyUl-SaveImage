"""SmartSaveImage 节点模块"""

from .smart_save import SmartSaveImage

# 节点 ID 保持为 SmartSaveImage，旧工作流可无缝复用
NODE_CLASS_MAPPINGS = {
    "SmartSaveImage": SmartSaveImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SmartSaveImage": "Smart Save Image",
}

__all__ = [
    "SmartSaveImage",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
