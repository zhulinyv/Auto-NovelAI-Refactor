<p align="center" >
  <img src="https://socialify.git.ci/zhulinyv/Auto-NovelAI-Refactor/image?custom_description=%F0%9F%8C%9F%E5%B8%A6%E6%9C%89+WebUI+%E7%9A%84+NovelAI+%E9%87%8F%E4%BA%A7%E5%B7%A5%E5%85%B7%F0%9F%8C%9F&description=1&forks=1&issues=1&language=1&logo=https%3A%2F%2Fi.postimg.cc%2FP5s0p7Cq%2FXYTPZ-317323127057666-00001-12.png&name=1&owner=1&pattern=Circuit+Board&pulls=1&stargazers=1&theme=Auto" alt="Auto-NovelAI-Refactor" width="640" height="320" />
</p>

<img decoding="async" align=right src="https://i.postimg.cc/hvJPjYXg/XYTPZ-317323127057666-00001.png" width="35%">


## 💬 介绍

- 这里是 [Semi-Auto-NovelAI-to-Pixiv](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv) 的重构版本

- 它不仅继承了 SANP 的各个功能, 更提供了方便快捷的使用体验

- **使用中遇到问题请加 QQ 群咨询：[559063963](https://qm.qq.com/cgi-bin/qm/qr?k=I9FqVFb_wn-y5Ejid9CIae57KLLlvDuj&jump_from=webapi&authKey=i+DvSe2nFRBsKNu+D9NK0sFd7Qr1u/vakfRUFDGDCWaceBQOsuiHwkxDa3kRLfup)**

- 目前已实现的功能:

<img src=https://i.postimg.cc/kXNKdjtb/image.png  alt="Auto-NovelAI-Refactor" width="500"/>


## 💿 部署

### 💻 配置需求

- 极低的配置需求, 极致的用户体验!

| 项目 | 说明 |
|:---:|:---:|
| NovelAI 会员 | 为了无限生成图片, 建议 25$/month 会员 |
| 网络代理 | 为了成功发送请求, 确保你可以正常访问相关网站 |
| 操作系统 | 相较于 SANP, ANR 并非只能运行在 Windows 上, 它是跨平台的 |
| 其它 | 相较于 SANP, ANR 不再需要与其同样的内存和显存 |

### 🎉 开始部署

#### 0️⃣ Star 本项目

- 如果你喜欢这个项目，请不妨点个 Star🌟，这是对开发者最大的动力

#### 1️⃣ 安装 Python

- 推荐安装 3.10 及以上版本, 安装时注意勾选将 Python 添加到环境变量 [https://www.python.org/downloads/windows](https://www.python.org/downloads/windows)

#### 2️⃣ 安装 Git

- 推荐安装最新版本, 安装时一路 **Next** 即可 [https://git-scm.com/download/win](https://git-scm.com/download/win)

#### 3️⃣ 克隆仓库

- 打开 cmd 或 powershell, 执行 `git clone -b main --depth=1 https://github.com/zhulinyv/Auto-NovelAI-Refactor.git`

#### 4️⃣ 接下来的路

- 现在你可以直接运行项目根目录下的 `run.bat` 来启动 WebUI, 首次启动会自动创建虚拟环境并安装依赖

- **非 Windows 操作系统**需要手动安装依赖并使用 python 执行 main.py 来启动 WebUI

#### 5️⃣ 整合包下载

- 如果上述操作你觉得难以上手或出现问题, 请立即加群下载整合包, 解压即用


## ⚙️ 配置

- ⚠️ 1.如果你已经启动了 WebUI, 但没有进行 token 配置, 那么请转到配置设置页面进行 token 配置

- ⚠️ 2.请不要跳过这一步, 它非常重要, 确保你已经将所有配置浏览过一遍

- ⚠️ 3.你同样可以直接编辑 `.env` 文件进行配置

⚠️ token 的获取:

- ![jc](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv/assets/66541860/82f657fe-81bc-412b-a63c-11a878fde7d2)


## 🌟 使用

- **运行 `run.bat`, 会自动打开默认浏览器并跳转到 [http://127.0.0.1:11451](http://127.0.0.1:11451)**


## 🤝 鸣谢

本项目使用 [SmilingWolf/wd-tagger](https://huggingface.co/spaces/SmilingWolf/wd-tagger) 反推提示词

本项目使用 [涩涩法典梦神版](https://share.weiyun.com/Xf8NXoNA) 提供的各种动作提示词

本项目使用 [novelai-image-metadata](https://github.com/NovelAI/novelai-image-metadata) 修改元数据

本项目使用 [realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan/) | [Anime4KCPP](https://github.com/TianZerL/Anime4KCPP) | [waifu2x-caffe](https://github.com/lltcggie/waifu2x-caffe) 超分降噪图片



## 🔊 声明

免责声明: **本软件仅提供技术服务，开发者不对用户使用本软件可能引发的任何法律责任或损失承担责任, 用户应对其使用本软件及其结果负全部责任**

<p align="center" >
  <a href="https://github.com/zhulinyv/Auto-NovelAI-Refactor/blob/main/CODE_OF_CONDUCT.md"><b>Code of conduct</b></a> | <a href="https://github.com/zhulinyv/Auto-NovelAI-Refactor/blob/main/SECURITY.md"><b>Security</b></a>
</p>

<hr>
<img src="https://count.getloli.com/@zhulinyv?name=zhulinyv&theme=moebooru-h&padding=6&offset=0&align=top&scale=1.5&pixelated=1&darkmode=auto&prefix=769854"></img>
