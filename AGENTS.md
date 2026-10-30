# AGENTS.md

面向所有开发者与其 AI 编码助手的项目工作指南,由项目 AI 辅助开发历史归纳而成(2026-09 ~ 2026-10)。

项目 **Auto-NovelAI-Refactor (ANR)**: NovelAI 多 token 批量生图工具。FastAPI + SSE 后端(`server/`、`utils/`、`src/`)+ 零构建原生 JS 前端(`web/`)+ 插件系统(`plugins/`)。Python ≥3.10,运行入口 `main.py`(开发用 `run.bat`)。

## 项目结构速览

- `server/app.py` + `server/routes/` — FastAPI 应用与路由
- `src/generate_images.py` — 生图核心(质量预设拼接、请求体组装、重试)
- `utils/` — 服务层: generator / tokens / usage / plugins / prompt_text / translate / models / naimeta …
- `web/js/views/*.js` — 前端各页面视图; `web/js/components.js` — 图片编辑器等共享组件
- `plugins/<name>/` — 插件,每个含 `__init__.py`(必须实现 `register(plugin)`)+ 可选 `requirements.txt`
- `wildcards/`、`data/`、`outputs/` — 数据与运行时产物

## 1. Git 提交与版本规范

- 提交信息用 **gitmoji + 中文描述**,如 `:sparkles:`(功能)、`:bug:`(修复)、`:zap:`(性能)、`:bento:`(预设/资源)、`:memo:`(文档)、`:art:`(格式)、`:recycle:`(重构)、`:truck:`(移动/改名)、`:lipstick:`(UI 样式)
- 完成用户指定的需求后,自动更新版本号,并询问是否需要提交并推送
- 功能提交与版本号提交**分开**;代码按照功能分别提交;版本号提交单独为 `:bookmark: 版本号 x.y.z`;插件一并提交,要求相同
- 版本号三处必须同步:`VERSION`(打包脚本读取)、`pyproject.toml`、`utils/variable.py`
- 完成一批改动并自验后提交并推送到 `origin/main`
- pre-commit 钩子(ruff/black/isort,用 venv 里的 python)随提交自动运行,不要绕过

## 2. 前后端同步与 emoji 规范

- 提示词处理规则(如 v5 `teXt:` 自然段收拢)**必须前后端镜像修改**: 后端 `utils/prompt_text.py` ↔ 前端 `web/js/views/generate.js`(`applyTextSection`)。前端镜像的意义是把被收拢的内容回写到输入框;请求仍由后端最终处理。改完用同一份语料逐例比对,前后端输出必须逐字节一致
- 例: v5 `teXt:` 段末尾的收尾英文引号是**故意的非配对引号**,不是笔误,不要当 bug 修掉
- 项目有 **emoji 跨系统统一化处理**(保证各设备显示一致、不闪烁): UI 中引入新 emoji 时,必须阅读相关统一化代码,并把缺失的 emoji 资源保存进项目;修复"emoji 闪烁/不显示"类问题时,统一化处理与资源入库都要做
- 涉及提示词规则的前端改动要注意回写边界: 仅当输入框仍是提交时的原文才回写,中途被用户改过不覆盖

## 3. 插件系统开发规范

- 插件 = `plugins/<name>/` 目录,`__init__.py` 中实现 `register(plugin)`;注册零面板的插件会被丢弃;依赖写进插件自己的 `requirements.txt`(启动时自动 pip 安装)
- API 结构:`Plugin`(name/title/description/icon/panels/warmup) → `Panel`(id/title/fields/actions/show_output/inline_actions/reset_defaults) → `Field` 与 `Action`
- `Field` 全部 17 种类型:`text / textarea / number / slider / checkbox / checkbox_group / radio / select / path / image / filearea / color / info / section` + 前端扩展 `toggle / chart / corner_select`;完整属性定义以 `utils/plugins.py` 源码为准
- 插件避免在 import 期做重活(读 config、加载模型);用 `warmup` 机制延迟到启动后台执行
- 面板 UI 约定见 §4

## 4. UI/UX 偏好(历次需求归纳,做 UI 改动时优先遵循)

- 说明文字统一放**输出区域下方**(参照"读取元数据"面板的排版);Action 结果区设为**不可编辑**
- 同类功能划分区域(section),字段排版紧凑(如宽高放同一行);功能太多太杂时拆分/精简面板
- 生成结果图片**单击**放大(不是双击)
- 长列表 / 多 token 显示用下拉,避免文本溢出;下拉要足够长以完整显示
- 弹窗不透明(队列弹窗与 wildcards 弹窗风格一致)
- wildcards 提示词库/卡片库: 上方分类 + 分类下内容;**点击即可多选,再点取消**;切换分类不清空其它分类已选项
- 跨页面跳转(发送到图生图/法术解析等)要有明确的 toast 提示,且只弹一次;图片浏览遇大量图片时注意性能(懒加载,勿一次性全量渲染)
- 交互实现拿不准时优先参照官网(见 §6)

## 5. 验证与环境约定(Windows)

- 项目面向 Windows 运行(仓库自带 run.bat): Windows 下运行 Python 脚本统一加 `-X utf8`,避免 GBK 编码问题;脚本中调用 git/其它程序时注意路径空格与引号
- Python 侧验证: `ruff check` + `ruff format`(与 pre-commit 同款)
- JS 侧验证: 前端零构建无打包链,把文件复制成 `.mjs` 后 `node --check`;纯函数模块(cropRect 等)可直接用 node 实测
- 模拟生成验证: 临时把 `src/generate_images.py` 的 `_generate_with_retry` 换成返回占位图,即可拿到真实请求体而不消耗 Anlas;此类**临时脚本放仓库外的临时目录,不入库不提交**
- 测试/探针产生的临时文件(脚本、截图、dump、日志)在验证完成后**立即删除**,不在工作区或仓库内遗留
- 大的性能优化 / 结构调整**确认方案后再动手**;改动完成后列出修改清单,并说明每项如何手动验证
- 输出建议/审计清单时按优先级编号(如 P0/P1、F-01…),便于逐条按编号讨论与应用
- 修一个 bug 后自查其它位置是否存在同类问题
- 排查"页面崩溃/白屏/报错"类回归时,优先检查最近一次改动

## 6. 官网对齐与调试工作流

- NovelAI 行为以官网 **https://novelai.net/image** 为准。以下功能都曾按官网校准过,改动时先对照官网: 蒙版笔刷、局部重绘裁剪自动扩展、角色分区选择(v4/v4.5 网格区域、v5 自由拖动)、官方预设与 Variety+ 取值
- 无订阅账号发送生成请求返回 **402 是预期的**,请求体仍可正常抓取,官方预设与 Variety+ 等取值即由此更新;访问官网需要代理时走系统代理(`utils/translate.py` 有直连失败回退系统代理的现成实现可参考)

## 7. 领域规则: 分辨率与蒙版

- 分辨率对齐: 用户自定义分辨率按 **round64** 对齐(Math.round 到 64 的倍数,下限 64);图生图编辑器画布从图片加载时用 **floor64**(cropToAlign64)。两者语义不同,**不可混用**
- 用户修改生成分辨率时,图生图编辑器的图片/蒙版/涂鸦/裁剪选框要用 `editor.resizeTo()` 同步缩放到对齐后的尺寸;拖拽中的选框/笔迹作废,撤销栈清空
- 局部重绘蒙版: 透明背景 + 重绘区域白色,**不允许半透明**
- 蒙版笔刷遵循官网 8x8 网格体系: 预览为 8px 类圆形多边形(只显示边缘,不显示网格),移动步进 8px;前端绘制所见即所得,后端只需改色(白=重绘/黑=保留),不再做区域扩展
- 笔刷大小数值是 8 的倍数(如 4 → Square 笔刷 32px 边长;非 Square 为挖角的类圆形,大小越大挖角越多,范围 4~50);Square Brush 勾选=方形、取消=硬边圆(非软圆)
- 编辑器坐标换算注意缩放/平移(曾有滚轮缩放后预览漂移、预览区与实际绘制区偏移的 bug)
- 局部重绘裁剪自动扩展: 框选外框四边各 +64px 逐步扩展,使宽高乘积最接近对应上限;一边越出图片边界时只扩另一边(**非对称扩展**);不同形状对应不同上限(方形 1024x1024 / 非方形 1024x960),尽可能接近或相等但不超过;扩展出的蒙版区域为黑色

## 8. 多 token 调度与用量显示

- token 选用按**配置顺序**: 多个空闲通道可用时优先分配编号最小的通道(即优先第一个 Token,依次类推),不要随机选用
- "用量为空时跳过 nai5 任务"(`env.skip_nai5_no_usage`,默认关闭): `nai-diffusion-5` 系列任务遇到剩余用量**恰为 0** 的 token 通道不可领取(即使空闲),按序交给第一个有剩余用量的通道(该通道忙碌时任务在队列中等待);全部 token 均无用量时不入队、直接跳过并提示;查询失败哨兵值 -1 不参与判断
- 剩余点数/用量徽标: 启动时 `inquire_all_anlas()` 查询**全部** token;生成后经 `anlas:update` 事件只更新用到的 token;多 token 用下拉显示避免溢出
- 每 token 显示"下次恢复 1%": `body["usage"]["timeUntilNextPercent"] / 3600` 小时(保留两位小数);左侧 ✓/✗ emoji 对应 `body["active"]`(走统一化处理,见 §2)
- "剩余用量提醒%"(`env.anlas_remind_percent`,默认 1,**负值关闭**): 剩余用量 ≤ 阈值时提醒一次(配置 `smtp_mail`/`smtp_token` 发邮件,否则 webui 右上角通知);自然恢复超过阈值后重置提醒状态,再次跌破才再发,不重复轰炸

## 9. 数据存储位置约定

- 项目根只保留 `settings.json`(用户配置)与 `last.json`(上次生成参数),其余状态一律不进根目录
- `data/` 是状态/缓存/临时文件统一入口:`data/state/`(用户可恢复状态: 收藏/提示词库/背景/插件表单值)、`data/caches/`(可再生存缓存)、`data/temp/`(短命中间文件)、`data/browser-profile/`;**`outputs/` 只放用户生成的图片**
- 状态 JSON 的读-改-写必须走 `utils/jsonstore.py`(原子写 + 全局锁 + 损坏备份),**禁止裸 read_text/write_text** —— 历史上半截 JSON 曾导致"收藏/提示词库突然全没了"
- 临时文件必须用 `utils/paths.py` 的 `job_temp_path()`(按任务隔离)/`shared_temp_path()`(跨任务共享);固定路径的 temp 文件会被并行 token 通道互相覆盖(表现为偶发、无法复现的错图)
- 新增状态文件/目录归口 `utils/paths.py` 定义,不要在业务代码里手写字面量路径

## 10. 性能陷阱与已知坑(历次审计沉淀)

- **async 路由里不做同步阻塞 IO**(网络请求/子进程/批量图片处理)——会卡死事件循环;需要阻塞操作时路由用 `def`(FastAPI 自动进线程池),仓库已有先例
- **新模块命名避开标准库同名**: `server/routes/queue.py`(遮蔽 queue)、`utils/http.py`(遮蔽 http 导致开始菜单快捷方式启动失败)都已踩过并改名
- 写新功能前先找共享 helper,**不要复制既有实现**: 输入收集/重试/字体加载等都曾多份复制后语义分叉,现已抽到共享模块
- 图像批量处理用 numpy 向量化,不要逐像素 Python 双循环;同一图片避免多次完整解码(共享解码结果,参考 naimeta 复用已解码像素的修复)
- 插件 import 期不做重活(见 §3);SSE/轮询类实现注意事件滞后与频率,新增事件推送时确认前端有订阅者

## 11. 禁改与谨慎清单

- `utils/models/` 模型参数文件**禁止修改**(原因写在该目录 `__init__.py`;需要模型特性变更时先阅读说明再与用户讨论)
- gitignore 的本地文件(`settings.json`/`last.json`/`test.*` 等)在各机器内容不同:**不提交、不清理、不擅自删除或移动**
- `venv/`、`outputs/`、`.webui-browser/` 等运行时目录不作为改动/阅读对象;调试脚本不入库
- 前端保持零构建原生 JS: **不引入构建工具与 npm 依赖**
- 改名 `server/routes/` 下模块前注意路由注册顺序的影响(有注释说明依赖关系)
- 拿不准的内容询问用户,用户享有最高决策权,即使和本文件冲突
- 未经允许, 禁止修改本文件

## 12. 项目打包与发布

打包脚本位于仓库外的 `E:\pack.bat`,产物是一个自解压 exe(7z SFX):双击解压出 `Auto-NovelAI-Refactor\` 后自动调用 `run.bat`。仓库里没有打包脚本,也没有打包/发布 CI(`.github/workflows/` 只有格式检查)。

### 12.1 固定路径与前提(换机要逐项改)

- 脚本 `E:\pack.bat`(v5)。文件必须是 **ANSI/GBK + CRLF**:不要转成 UTF-8、不要加 `chcp 65001`,那是 v4 就修掉的"乱码 + 命令不识别"
- 打包源 `E:\Auto-NovelAI-Refactor`:发布专用的**独立 clone**,不是开发克隆(本机开发克隆为 `D:\GitClone\Auto-NovelAI-Refactor`)。xcopy 拷的是这份副本的**文件快照**(未跟踪、被忽略但实际存在的文件都会进包),不是 git 归档
- 构建目录 `E:\_build`,脚本只前置校验前两项:
  - `portable_python313\python.exe` — 包内 Python 的来源(包内**不含 venv**)
  - `tools\PortableGit\cmd\git.exe` — 拉取插件用
  - `tools\ResHacker\ResourceHacker.exe` — 改写 SFX 的清单与图标(**缺失不报错**,见 §12.7)
  - `make_manifest.py` — 生成 asInvoker 清单
- 7-Zip 固定在 `D:\Softwares\7-Zip`(`7z.exe` 与 `7z.sfx`);图标源固定在 `D:\Pictures\头像\ttt_fix.png`(个人路径,换机必改)
- 缓存缺失时脚本 `pause & exit /b 1` 并提示"请先运行一次完整打包";实际处理是手工把便携 Python / Git 放回上述路径

### 12.2 准备与七个阶段(每步的硬约束)

0. **同步源码 + 读版本号**:`fetch --prune origin` → 有未提交改动先 `stash -u` → `reset --hard origin/<分支>`;再从 `VERSION` 读版本号,并用 `findstr /x` 校验 `pyproject.toml` 与 `utils/variable.py`。任一步失败都 `exit /b 1`,不会带着旧代码或错版本号继续打包
1. **清理**:只删 `E:\_build\package` 与 `E:\_build\plugins`,其余缓存(便携 Python / Git / 7z 模块)保留
2. **更新插件**:读 `assets/plugins.json` 每个条目的 `url`,目录名取仓库名;不存在则 `git clone --depth 1`,已存在则 `git pull --ff-only`(第 1 步已把插件目录整个删掉,所以实际上**每次都是重新浅克隆**,`git pull` 分支基本走不到)。`plugins/` 被 gitignore 整目录忽略,**新增插件不写进 `assets/plugins.json` 就不会进包**
3. **装依赖**:便携 Python 装 `requirements.txt` + 每个插件 `requirements.txt`,再补 torch(CPU 轮子)、ultralytics、segment-anything、nudenet、scipy、opencv-python
4. **组装**(四次 `xcopy /E /I /Y /Q /H /K`):项目本体 → `%DST%`,插件缓存 → `plugins\`,便携 Python → `Python\`,便携 Git → `Git\`
   - **`/H` 不能删**:Windows 上 git 给 `.git` 打 Hidden 属性,xcopy 默认跳过隐藏项,缺 `/H` 会**静默丢掉整个 `.git`**
   - **`/K`**:保留只读属性,使 `.git\objects`、`.git\index` 与原仓库一致
   - 便携 Python **故意不含 `python313._pth`**:保留 user site,因为非 venv 下插件依赖走 `pip install --user`(`utils/helpers.py` 的 `install_requirements`)
   - 便携 Python 自带 VC++ 运行库(msvcp140.dll 等),随 xcopy 一并进包,保证 torch 在没装 VC++ 的机器上也能加载
   - **4.5 自检**:`%DST%\.git\HEAD` 与每个 `%DST%\plugins\<name>\.git\HEAD` 必须存在,缺一个就 `pause & exit /b 1`
5. **图标**:PIL 从源图生成 256/128/64/48/32/16 多尺寸 `sfx.ico`;失败只告警,退回 7-Zip 默认图标
6. **压缩**:`7z a -t7z ... -mx=9 -m0=LZMA2 -mmt=on` 到 `E:\_build\Auto-NovelAI-Refactor.7z`(极限压缩,几分钟属正常)
7. **自解压**:`7z.sfx` 经 ResHacker 打上 asInvoker 清单(不加会每次启动弹 UAC)与自定义图标,追加 UTF-8 的 `sfx_cfg.txt`(`Title` / `BeginPrompt` / `RunProgram="Auto-NovelAI-Refactor\run.bat"`)与 7z 数据,`copy /b` 拼成 `E:\Auto-NovelAI-Refactor-<version>.exe`

### 12.3 为什么包内必须带 `.git`(一条完整因果链)

- 启动时 `utils/helpers.py` 的 `check_update` 用 GitPython 比较本地 HEAD 与 `origin/<branch>`,结果经 `/api/state` 的 `update` 字段给设置页展示(`env.check_update`,默认开)
- WebUI 的更新动作 → `POST /api/settings/update-repo` → `update_repo` 执行 `git pull`(带 300s 超时;Windows 上 GitPython 的 `kill_after_timeout` 不可用,所以改用 subprocess)
- 插件商店的更新复用同一个 `update_repo`,因此**每个插件目录也必须带 `.git`**
- 结论:`.git` 缺失不是"少个历史",而是**检查更新报错 + 主程序与插件更新全部失效**;这就是 §12.2 里 `/H` 与 4.5 自检存在的唯一理由

### 12.4 版本号与发布命名

- 版本号文件 `VERSION`(仓库根,**无扩展名**,单行)是**打包读取的唯一来源**;`pyproject.toml` 与 `utils/variable.py` 仍要与它一致(§1),准备阶段会整行校验,不一致直接中止
- 产物名自动带版本号:`E:\Auto-NovelAI-Refactor-<version>.exe`(如 `Auto-NovelAI-Refactor-2.3.0-alpha.3.exe`),**不再手工改名**;SFX 的标题与解压提示也会显示版本号
- 发版顺序:改三处版本号 → 提交并**推送** → 跑 `pack.bat`(它会自己 fetch + reset 到 origin)→ 产物名即最终发布名
- 版本号沿用 PEP 440 预发布格式(`2.3.0-alpha.3`);文件名里只用数字、字母、`.`、`-`,不要出现空格或中文

### 12.5 打包前检查(缺一项就别按开始)

- [ ] 目标版本已提交并**推送**到 origin:脚本会自动同步,但**没推送的提交永远不会进包**(2026-10-29 的教训:发布副本停在 `2.3.0-alpha.2`,包里就是旧版)
- [ ] 打包源里若有想保留的本地改动,先自己提交或另存;脚本会把它们 `git stash` 掉再 reset(打包后 `git stash pop` 可取回)
- [ ] `VERSION`、`pyproject.toml`、`utils/variable.py` 三处版本号一致(§1,脚本也会校验)
- [ ] 打包源里**没有** `settings.json` / `last.json`,也**没有**想私藏的 `data/` 内容(自建 Vibe、提示词库会原样进包);`venv/`、`outputs/`、`test.*` 等本地散件同理会被 xcopy 照拷
- [ ] 新增/移除插件已同步 `assets/plugins.json`
- [ ] `D:\Softwares\7-Zip`、`E:\_build\tools\ResHacker`、`E:\_build\make_manifest.py`、图标源文件都在(脚本不校验后三项)

### 12.6 打包后验证

- 提醒作者(用户)手动去虚拟机验证

### 12.7 已知缺口与纪律

- **ResHacker 失败是静默降级**:该步没有 errorlevel 检查,缺文件时产物没有 asInvoker 清单与自定义图标,表现为"图标是 7-Zip 的 / 双击弹 UAC"。只能靠 §12.6 事后看住
- **脚本头部的 `[pack.bat v5 OK]` 是诊断用的**:同一 cmd 窗口跑过旧版后才冒出来的"不是内部或外部命令"乱码来自旧跑的残留,关窗重开即可
- **改脚本**:保持 GBK/CRLF 与 `setlocal enabledelayedexpansion`(循环内用 `!VAR!`);路径一律加引号(便携目录可能含空格);新增外部工具必须补 `if not exist ... pause & exit /b 1`,别再制造一个静默降级
- **改脚本后必须真跑一次全流程**并做 §12.6 检查:没打过包的脚本改动等于没改
- **脚本不在仓库里**:改动只活在这台机器的 `E:\pack.bat`;要迁移或多人使用需另行备份/入库(入库前先与用户确认,见 §11 末条)
- **插件克隆失败不会立即中断**:`git clone` 的输出被重定向到 nul,失败由 4.5 自检兜住。看到"以下插件仓库缺少 .git"时,先查网络/代理,再确认该插件在 `assets/plugins.json` 里的 `url`
- 仓库**没有**打包/发布 CI;整合包的分发渠道见 README「整合包下载」
