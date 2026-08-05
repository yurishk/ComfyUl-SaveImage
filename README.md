# Smart Save Image

**English** | [简体中文](#简体中文)

## English

A visual, template-driven image saver for ComfyUI. It previews the final destination before execution and keeps folder and filename rules in one compact node.

![Smart Save Image](https://sywb.top/Staticfiles/pic/SmartSaveImage.png)

## Features

- Live destination folder and example filename preview.
- Output, input, temp, relative, and absolute destination roots.
- Reusable date, model, sampler, prompt, size, and batch tokens.
- PNG, JPEG, and WebP output.
- Collision-safe automatic numbering or overwrite mode.
- Optional workflow metadata embedding.
- English and Simplified Chinese UI.

## Usage

1. Add **Smart Save Image** and connect `images`.
2. Choose a save location. A custom path may be absolute or relative to ComfyUI's output directory.
3. Enter the subfolder and filename rules.
4. Check **Save Result Preview** before queuing the workflow.

The template token panel is collapsed by default. Focus either rule field, then click a token to insert it.

## Template Tokens

- Time: `%date:yyyy-MM-dd%`, `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`
- Model: `%model%`, `%model_full%`, `%unet%`, `%lora%`, `%vae%`
- Sampling: `%seed%`, `%steps%`, `%cfg%`, `%sampler%`, `%scheduler%`
- Image: `%width%`, `%height%`, `%prompt%`, `%batch%`

Example for numbered images under a model folder:

```text
Subfolder rule: krea/%model%
Filename rule: image
Name collision: Auto Number
```

PNG compression defaults to level 4, matching ComfyUI's built-in save node. PNG compression is always lossless. WebP is also saved losslessly.

## Installation

Install `smart-save-image` from ComfyUI Manager, or clone this repository into `ComfyUI/custom_nodes` and restart ComfyUI.

---

## 简体中文

[English](#english) | **简体中文**

一个带实时路径预览的 ComfyUI 图片保存节点。节点菜单中搜索 **智能保存图片**。

### 使用方式

1. 连接 `images`。
2. 选择保存位置；自定义模式可填写绝对路径或相对 `output` 的路径。
3. 填写子目录规则和文件名规则。
4. 在“保存结果预览”中确认最终目录与示例文件名。

模板变量默认折叠，展开后点击变量即可插入当前规则输入框。

### 保存行为

- 支持 PNG、JPEG、WebP；PNG 默认压缩等级为 4，与 ComfyUI 自带保存节点一致，且始终无损；WebP 使用无损保存。
- 自动编号不会覆盖已有文件；覆盖模式也会保证批量图片互不覆盖。
- PNG 使用 ComfyUI 原生元数据字段；关闭“嵌入工作流”后不写入生成信息。
- 保存到 `output`、`input`、`temp` 时直接使用对应预览类型；其他绝对目录使用临时预览。
- 模型名自动从工作流读取，也可在“模型来源”中手动指定。

插件只依赖 ComfyUI 已包含的 Pillow 与 NumPy。
