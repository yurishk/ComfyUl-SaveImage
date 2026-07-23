"""SmartSaveImage 包初始化"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# 注册实时预览路由（在无 server 的测试环境中会静默跳过）
try:
    from .server_routes import register_routes

    register_routes()
except Exception:  # pragma: no cover
    pass

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
