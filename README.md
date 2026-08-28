# 🌸 Auto-NovelAI-WebUI

Auto-NovelAI-Refactor (ANR) 的前端重构版: **彻底抛弃 Gradio**, 使用 **FastAPI + 原生 Web 前端**,
拥有可爱清新的界面、深色/浅色主题切换、实时日志面板, 功能与原版完全一致。

## ✨ 特性

- 🚀 **完全抛弃 Gradio** — 后端 FastAPI, 前端零构建的模块化原生 JS
- 🎀 **可爱界面** — 马卡龙配色、圆角卡片、飘浮装饰, 支持 **深色 / 浅色** 一键切换 (也可 `?__theme=dark`)
- 📜 **实时日志** — 前端底部日志面板实时显示, 错误自动附带可读的异常堆栈
- 🧩 **全新插件系统** — 声明式面板, 前端自动渲染表单, 插件开发更简单
- 🖼️ 全部原功能保留: 文生图 / 图生图 / 局部重绘 / 涂鸦重绘 / 角色分区 / 角色参考 / Vibe 迁移 / Enhance
- 🎬 导演工具 / ✨ 超分降噪 / 🔮 法术解析 (读取信息、反推、抹除数据) / 🗂️ 图片筛选
- 🛒 插件商店: 在线安装 / 卸载 / 启停插件

## 💿 部署

1. 安装 [Python 3.10+](https://www.python.org/downloads/)
2. 双击运行 `run.bat` (首次会自动创建虚拟环境并安装依赖)
3. 浏览器自动打开 [http://127.0.0.1:11451](http://127.0.0.1:11451)

手动启动:

```bash
pip install -r requirements.txt
python -X utf8 main.py
```

## ⚙️ 配置

- 启动后进入 **⚙️ 配置** 页面填写 NovelAI Token 并保存
- 配置保存在 `settings.json` 中 (首次启动会自动从旧版 `.env` 迁移 Token)
- **所有配置修改后立即生效, 无需重启** (仅端口与共享链接需要重启重新绑定)

## 📁 项目结构

```
ANR-WebUI/
├── main.py              # 入口: FastAPI 服务
├── server/              # API 路由 (生成 / 工具 / 插件 / 配置 / 事件流)
├── utils/               # 核心逻辑 (生成器 / 模型 / 工具 / 插件系统)
├── src/                 # 生成 / 导演工具 / 超分 业务逻辑
├── web/                 # 前端 (无构建步骤)
│   ├── css/             # 主题变量 + 组件样式
│   └── js/              # 模块化前端 (views/ 下为各页面)
├── plugins/             # 插件 (声明式面板)
├── assets/              # 静态资源
└── wildcards/           # 提示词卡片
```

## 🧩 插件开发

插件是 `plugins/` 下的一个目录, 在 `__init__.py` 中导出 `register(plugin)`:

```python
from utils.plugins import Action, Field, Panel, Plugin

def register(plugin: Plugin):
    plugin.panels.append(Panel(
        id="my_panel",
        title="我的面板",
        fields=[Field(id="text", label="输入", type="text")],
        actions=[Action(id="run", label="执行", inputs=["text"], handler=my_handler)],
    ))
```

支持字段类型: `text / textarea / number / slider / checkbox / checkbox_group / radio / select / path / image / color / info`,
支持 `show_if` 条件显示。动作处理函数返回字符串 / 字典 / 生成器 (生成器每个产出会实时推送到前端)。

## 📜 日志

- 终端: rich 彩色输出, 错误含完整 traceback
- 前端: 底部日志面板, 级别着色, 异常堆栈可点击展开
- 所有错误日志均包含可读的上下文信息

## ⚠️ 声明

本软件仅提供技术服务, 开发者不对用户使用本软件可能引发的任何法律责任或损失承担责任。
