<p align="center">
  <img src="https://socialify.git.ci/zhulinyv/Auto-NovelAI-Refactor/image?custom_description=%E4%B8%80%E6%9E%9A%E6%9B%B4%E5%8F%AF%E7%88%B1%E7%9A%84+NovelAI+%E7%94%9F%E6%88%90%E5%B7%A5%E5%85%B7&custom_language=Python&description=1&font=Inter&forks=1&issues=1&language=1&logo=https%3A%2F%2Favatars.githubusercontent.com%2Fu%2F66541860%3Fv%3D4&name=1&owner=1&pattern=Transparent&pulls=1&stargazers=1&theme=Auto" alt="Auto-NovelAI-Refactor" width="640" height="320" />
</p>

<img decoding="async" align=right src="https://i.postimg.cc/mgC0kGSX/tu-tu-tu-fix.png" width="35%">

## 💬 介绍

- 一款 NovelAI 批量生成工具, 更好的 NovelAI 体验!

- [Semi-Auto-NovelAI-to-Pixiv](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv) (SANP) → [Auto-NovelAI-Refactor](https://github.com/zhulinyv/Auto-NovelAI-Refactor) (ANR-gradio) → [**Auto-NovelAI-Refactor**](https://github.com/zhulinyv/Auto-NovelAI-Refactor) (ANR-webui), 一步比一步更好用

- **使用中遇到问题请加 QQ 群咨询：[704064019](https://qm.qq.com/cgi-bin/qm/qr?k=704064019)**


## ✨ 特性

- 🖼️ **批量生图** — 批量生图, 省去下载保存重复点击生成的麻烦
- 🚦 **生图队列** — N 个 Token 即 N 条并行生图通道, 每通道独立冷却; 任务可排队 / 取消 / 调序 / 单独停止, 队列进度实时可视
- 🃏 **卡片系统** — 分类管理 / 图片封面 / 搜索 / 多选 / 拖拽插入提示词 / 顺序通配 / 内置提示词库
- 🏷️ **提示词库** — Danbooru 中文标签自动补全 / 多源免 Key 在线翻译 / 提示词库收藏常用组合
- 🧩 **插件系统** — 声明式面板, 前端根据清单自动渲染表单, 插件开发更简单; 内置 6 个实用插件; 插件商店在线安装 / 卸载 / 启停 / 更新
- 📜 **实时日志** — 底部日志面板通过 SSE 与终端同步, 级别着色, 异常堆栈可展开, 支持导出; CPU / 内存 / GPU 占用实时显示
- ⚙️ **即时配置** — 配置保存在 settings.json, 除端口外全部实时生效, 无需重启; 首次启动自动从旧版 .env 迁移
- 🚫 **轻量架构** — 后端 FastAPI + SSE 事件流, 前端零构建的模块化原生 JS: 无需 Node / npm, 无需 GPU, 启动快、占用低
- 🎀 **可爱界面** — 马卡龙配色、圆角卡片、飘浮装饰; 深色 / 浅色一键切换; 自定义壁纸 (动漫随机 / Bing 每日 / Picsum / 本地上传) 与外观调色; 一言; 启动 / 完成提示音
- 📧 **细节体验** — SMTP 邮件通知 / 429 限流自动重试 / 一键重启与更新 / 自定义输出路径模板 / 侧边栏与日志面板自由拖拽调整 / 隐藏终端启动 / 顶栏一键退出
- 🔇 **后台运行** — 隐藏终端启动 / WebUI 顶栏按钮一键退出

## 🎞️ 实机演示

<img width="2560" height="1600" alt="image" src="https://github.com/user-attachments/assets/c52f2005-41f5-49b7-adf7-33dabbf921d6" />


## 💿 部署

### 💻 配置需求

- 极低的配置需求, 极致的用户体验!

| 项目 | 说明 |
|:---:|:---:|
| NovelAI 会员 | 为了无限生成图片, 建议 25$/month 会员 |
| 网络代理 | 为了成功发送请求, 确保你可以正常访问相关网站 |
| Python | 3.10 及以上版本 |
| 操作系统 | 跨平台运行; 仅超分降噪引擎需要 Windows |


### 🎉 开始部署

#### 0️⃣ Star 本项目

- 如果你喜欢这个项目，请不妨点个 Star🌟，这是对开发者最大的动力

#### 1️⃣ 安装 Python 与 Git

- 推荐安装 3.10 及以上版本, 安装时注意勾选将 Python 添加到环境变量 [https://www.python.org/downloads/](https://www.python.org/downloads/)
- 推荐安装最新版本 Git [https://git-scm.com/downloads](https://git-scm.com/downloads)

#### 2️⃣ 克隆 ANR-WebUI 分支

- 打开 cmd 或 powershell, 执行 `git clone https://github.com/zhulinyv/Auto-NovelAI-Refactor.git`

#### 3️⃣ 运行与使用

- 双击运行 `run.bat` 即可: 缺少依赖时会自动安装, 克隆完仓库直接运行就能使用
- 启动后浏览器会自动打开 [http://127.0.0.1:11451](http://127.0.0.1:11451)
- **非 Windows 操作系统**请手动启动: 先 `pip install -r requirements.txt`, 再执行 `python -X utf8 main.py`

#### 4️⃣ 整合包下载

- 如果上述操作你觉得难以上手或出现问题, 请加群下载整合包, 解压即用


## ⚙️ 配置

- ⚠️ 1. 启动后进入 **⚙️ 配置设置** 页面填写 NovelAI Token 并保存, **除端口外所有配置修改后立即生效, 无需重启**; 每个配置项旁都有说明提示, 请不要跳过这一步

- ⚠️ 2. **多 Token 并行**: Token 每行填写一个, Token 数量 = 同时执行的生图任务数 (生图队列通道数)

- ⚠️ 3. 配置持久化到 `settings.json`; 如果你用过旧版本, 首次启动会自动从 `.env` 迁移 Token 等配置

⚠️ token 的获取:

- ![jc](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv/assets/66541860/82f657fe-81bc-412b-a63c-11a878fde7d2)



## 🧩 插件

### 插件商店

- **🛒 插件商店** 页面可以在线安装 / 卸载 / 启停 / 更新插件, 插件清单见 [`assets/plugins.json`](assets/plugins.json), 欢迎提交你的插件

- 内置插件 (见功能一览) 随项目发布, 也可通过商店启停或更新

### 插件开发

插件是 `plugins/` 下的一个目录 (或单文件), 在 `__init__.py` 中导出 `register(plugin)`:

```python
from utils.plugins import Action, Field, Panel, Plugin


def register(plugin: Plugin):
    plugin.title = "我的插件"
    plugin.panels.append(
        Panel(
            id="my_panel",
            title="我的面板",
            icon="🌸",
            fields=[Field(id="text", label="输入", type="textarea", autocomplete=True)],
            actions=[Action(id="run", label="执行", inputs=["text"], handler=my_handler)],
        )
    )
```

- **字段类型**: `text / textarea / number / slider / checkbox / checkbox_group / radio / select / path / image / filearea / color / info / toggle / chart` 等, 支持 `show_if` 条件显示、`row_group` 并排、`sync` 联动、提示词自动补全 (`autocomplete`)、左右分栏 (`column`) 等
- **动作路由**: `uses_novelai=True` 的动作进入生图队列 (排队 / 冷却 / 多 Token 并发), 其余走本地多线程立即执行
- **返回值**: 处理函数返回字典 (`{"text": ..., "images": [...], "image": ...}`)、字符串, 或**生成器**


## 🤝 鸣谢

本项目使用 [SmilingWolf/wd-tagger](https://huggingface.co/spaces/SmilingWolf/wd-tagger) 反推提示词

本项目使用 [novelai-image-metadata](https://github.com/NovelAI/novelai-image-metadata) 读取与修改元数据

本项目使用 [realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan) | [Anime4KCPP](https://github.com/TianZerL/Anime4KCPP) | [waifu2x-caffe](https://github.com/lltcggie/waifu2x-caffe) 超分降噪图片

本项目使用 [Semi-Auto-NovelAI-to-Pixiv](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv) 的部分源代码

本项目使用 [Lolicon API](https://docs.api.lolicon.app) | [Hitokoto 一言](https://hitokoto.cn) | [Bing 每日壁纸](https://www.bing.com) | [Picsum](https://picsum.photos) 提供背景和一言服务


## 🔊 声明

免责声明: **本软件仅提供技术服务，开发者不对用户使用本软件可能引发的任何法律责任或损失承担责任, 用户应对其使用本软件及其结果负全部责任**

<p align="center" >
  <a href="https://github.com/zhulinyv/Auto-NovelAI-Refactor/blob/main/CODE_OF_CONDUCT.md"><b>Code of conduct</b></a> | <a href="https://github.com/zhulinyv/Auto-NovelAI-Refactor/blob/main/LICENSE"><b>LICENSE</b></a> | <a href="https://github.com/zhulinyv/Auto-NovelAI-Refactor/blob/main/SECURITY.md"><b>Security</b></a>
</p>

<hr>
<img src="https://count.getloli.com/@zhulinyv?name=zhulinyv&theme=asoul&padding=6&offset=0&align=top&scale=1.5&pixelated=1&darkmode=auto&prefix=769854"></img>
