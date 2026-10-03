"""纯工具函数: 字符串、文件、wildcard、随机等 (不依赖任何 UI)。"""

from __future__ import annotations

import hashlib
import os
import platform
import random
import re
import secrets
import shutil
import smtplib
import string
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from email.mime.text import MIMEText
from pathlib import Path

import numpy as np
import requests
import ujson as json
from PIL import Image
from rich.progress import BarColumn, DownloadColumn, Progress, TextColumn, TransferSpeedColumn

from utils.config import env
from utils.logger import console, logger, loguru_to_rich
from utils.variable import get_proxies

try:
    from git import Repo
except Exception:
    os.environ["PATH"] = os.path.abspath("./Git/cmd")
    from git import Repo


# ---------------------------------------------------------------- 基础工具


def generate_random_str(length: int) -> str:
    base_str = string.ascii_letters + string.digits
    return "".join(random.choice(base_str) for _ in range(length))


def generate_hash_string() -> str:
    return hashlib.sha256(secrets.token_bytes(32)).hexdigest()


def list_to_str(str_list: list[str]) -> str:
    return format_str(",".join(str_list))


def format_str(text: str | None) -> str:
    """格式化提示词: 整理多余空格与逗号 (开关由 env.format_input 控制)。"""
    if not text or not env.format_input:
        return text or ""
    lines = text.splitlines(keepends=True)
    formatted = []
    for line in lines:
        if line.endswith("\n"):
            content = line[:-1]
            formatted.append(_clean_line(content) + "\n" if content else "\n")
        else:
            formatted.append(_clean_line(line))
    return "".join(formatted)


def _clean_line(line: str) -> str:
    result = re.sub(r"[,\s]*,[,\s]*", ", ", line)
    result = re.sub(r" +", " ", result)
    return result.strip()


def return_x64(num: int) -> int:
    """把尺寸向上/向下取整到 64 的倍数 (至少 64)。"""
    if num <= 64:
        return 64
    if num % 64 == 0:
        return num
    if num / 64 % 1 >= 0.5:
        return (num // 64 + 1) * 64
    return (num // 64) * 64


def return_max_size(width: int, height: int, max_width: int = 1536, max_height: int = 2048) -> tuple[int, int]:
    """保持纵横比缩放 (width, height), 使宽高乘积不超过 max_width * max_height, 返回均为 64 倍数的尺寸。

    以 64 为最小网格换算: 面积上限 = (max_width // 64) * (max_height // 64) 格。
    先按面积比开方得到理想放大倍数, 再整体等比缩小直到取整后的格子面积不超上限
    (整体缩放而不是单边收缩, 这样纵横比最贴近原图, 且面积尽量顶到上限)。
    """
    budget = max(1, (max_width // 64) * (max_height // 64))
    base_w = max(1, return_x64(width) // 64)
    base_h = max(1, return_x64(height) // 64)
    scale = (budget / (base_w * base_h)) ** 0.5
    for _ in range(256):
        grid_w, grid_h = max(1, round(base_w * scale)), max(1, round(base_h * scale))
        if grid_w * grid_h <= budget:
            return grid_w * 64, grid_h * 64
        scale *= (budget / (grid_w * grid_h)) ** 0.5
    # 兜底 (理论上不可达): 直接收缩较大的一边直到不超上限
    while grid_w * grid_h > budget and max(grid_w, grid_h) > 1:
        if grid_w >= grid_h:
            grid_w -= 1
        else:
            grid_h -= 1
    return grid_w * 64, grid_h * 64


def read_txt(path) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def read_json(path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def return_last_value(_dict: dict):
    return list(_dict.values())[-1]


class StopGeneration(Exception):
    """生成过程中检测到停止信号 (用于中断重试/等待流程)。"""


def sleep_interruptible(seconds: float) -> None:
    """分段休眠, 期间检测停止信号, 一旦请求停止立即返回 (不再等待剩余时间)。"""
    deadline = time.time() + max(0.0, seconds)
    while time.time() < deadline:
        if check_stop():
            return
        time.sleep(min(0.2, max(0.0, deadline - time.time())))


def sleep_for_cool(seconds: int | float) -> None:
    """在 [seconds-1, seconds+1] 内随机休眠, 避免请求过快; 检测到停止时立即返回。

    下界用 max(0, seconds - 1): 原先写 abs(seconds - 1), 当 seconds < 1 时下界反而
    大于 seconds (如 seconds=0.5 得到 [0.5, 1.5], 比要求还久; seconds=0 得到 [1, 1])。
    """
    low = max(0.0, float(seconds) - 1)
    high = max(low, float(seconds) + 1)
    sleep_time = round(random.uniform(low, high), 3)
    logger.debug(f"等待 {sleep_time} 秒后继续...")
    sleep_interruptible(sleep_time)


# ---------------------------------------------------------------- 坐标


def position_to_float(position: str):
    offset = 0.1
    letter_dict = {chr(65 + i): i * 0.2 + offset for i in range(5)}
    number_dict = {str(i + 1): i * 0.2 + offset for i in range(5)}
    letter, number = position
    return round(letter_dict[letter], 1), round(number_dict[number], 1)


def float_to_position(letter_float: float, number_float: float) -> str:
    offset = 0.1
    letter_dict = {chr(65 + i): i * 0.2 + offset for i in range(5)}
    number_dict = {str(i + 1): i * 0.2 + offset for i in range(5)}
    letter = min(letter_dict, key=lambda x: abs(letter_dict[x] - letter_float))
    number = min(number_dict, key=lambda x: abs(number_dict[x] - number_float))
    return letter + number


# ---------------------------------------------------------------- wildcard


# wildcard 解析期间的文件系统缓存: 一次请求里同一个分类/同一张卡片会被反复查找
# (原实现对每个匹配项都重新 listdir + 读文件), 且替换过程中外层还在反复 findall。
# 缓存只在这一轮替换内有效 (调用方在入口清空), 保证用户改完 wildcard 立刻生效。
_WC_DIR_CACHE: dict[str, list[str]] = {}
_WC_FILE_CACHE: dict[str, str] = {}


def _reset_wildcard_cache() -> None:
    _WC_DIR_CACHE.clear()
    _WC_FILE_CACHE.clear()


def _list_wildcard_txt(category: str) -> list[str]:
    """列出 wildcard 目录下的 .txt 文件名 (过滤图片等非文本文件, 避免 UnicodeDecodeError)。"""
    cached = _WC_DIR_CACHE.get(category)
    if cached is not None:
        return cached
    path = f"./wildcards/{category}"
    if not os.path.isdir(path):
        names: list[str] = []
    else:
        names = sorted(f for f in os.listdir(path) if f.lower().endswith(".txt"))
    _WC_DIR_CACHE[category] = names
    return names


def _read_wildcard_file(category: str, name: str) -> str:
    """读取一张 wildcard 卡片的内容 (同一轮替换内带缓存)。"""
    key = f"{category}/{name}"
    cached = _WC_FILE_CACHE.get(key)
    if cached is not None:
        return cached
    content = read_txt(f"./wildcards/{category}/{name}.txt")
    _WC_FILE_CACHE[key] = content
    return content


# 替换轮数上限: 卡片内容本身可以再引用别的 wildcard, 正常情况下几轮就收敛;
# 但若某个卡片解析失败/自引用, 原实现会在 while matchers 里无限循环 (每次都对整段文本
# 重新 findall)。这里显式设上限并把无法解析的标记留在原地, 保证一定有退出路径。
_WILDCARD_MAX_ROUNDS = 50
# 匹配失败 (分类为空 / 文件缺失) 时把该标记记下来, 后续轮次直接跳过
_WILDCARD_SKIP: set[str] = set()


def replace_wildcards(text: str) -> str:
    pattern = r"<([^:]+):([^>]+)>"
    matchers = re.findall(pattern, text)
    matchers_number = 0
    rounds = 0
    unresolved: set[str] = set()
    while matchers:
        rounds += 1
        if rounds > _WILDCARD_MAX_ROUNDS:
            logger.warning(
                f"wildcard 替换超过 {_WILDCARD_MAX_ROUNDS} 轮仍未收敛, 已停止; "
                f"未替换的标记: {sorted(unresolved)[:5]}"
            )
            break
        for wild_card in matchers:
            token = f"<{wild_card[0]}:{wild_card[1]}>"
            if token in unresolved:
                continue  # 已知解析不了: 不再重复尝试 (否则会无限循环)
            try:
                if wild_card[1] == "随机":
                    names = _list_wildcard_txt(wild_card[0])
                    if not names:
                        raise FileNotFoundError(f"分类为空或不存在: {wild_card[0]}")
                    name = random.choice(names).replace(".txt", "")
                    tag = _read_wildcard_file(wild_card[0], name)
                elif wild_card[1] == "顺序":
                    name, tag = _sequential_wildcard(wild_card[0])
                    if not name:
                        raise FileNotFoundError(f"分类为空或不存在: {wild_card[0]}")
                else:
                    name = wild_card[1]
                    tag = _read_wildcard_file(wild_card[0], name)
            except Exception as e:
                # 卡片缺失/分类为空: 保留原标记并跳过 (原来是直接抛错中断整次生成)
                logger.warning(f"wildcard 解析失败, 已保留原样: {token} ({e})")
                unresolved.add(token)
                continue
            matchers_number += 1
            text = text.replace(token, tag)
            logger.debug(
                loguru_to_rich(
                    r'已将 <c><{}:{}></c> 替换为 <c>{}</c>: "<c>{}</c>"'.format(
                        wild_card[0], wild_card[1], name, tag.replace("<", r"\<")
                    )
                )
            )
        matchers = re.findall(pattern, text)
    if matchers_number:
        logger.info(f"共发现 {matchers_number} 个 wildcard, 已完成替换!")
    return format_str(text)


def _sequential_wildcard(category: str):
    """顺序 wildcard: 按文件名的字母顺序依次使用。"""
    state_path = "./outputs/temp_wildcards.json"
    names = _list_wildcard_txt(category)
    if not names:
        return "", ""
    if os.path.exists(state_path):
        data = read_json(state_path)
    else:
        data = {}
    number = data.get(category, -1) + 1
    if number > len(names) - 1:
        number = 0
    data[category] = number
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    chosen = names[number]
    return chosen.replace(".txt", ""), _read_wildcard_file(category, chosen.replace(".txt", ""))


def find_and_replace_wildcards_from_dict(data: dict) -> dict:
    # 每次请求开始清空 wildcard 文件缓存: 保证这一轮内重复引用只读一次盘,
    # 又能让用户在两次请求之间修改 wildcard 后立即生效。
    _reset_wildcard_cache()
    data["input"] = replace_wildcards(data["input"])
    data["parameters"]["negative_prompt"] = replace_wildcards(data["parameters"]["negative_prompt"])

    if data["model"] not in [
        "nai-diffusion-3",
        "nai-diffusion-furry-3",
        "nai-diffusion-3-inpainting",
        "nai-diffusion-furry-3-inpainting",
    ]:
        data["parameters"]["v4_prompt"]["caption"]["base_caption"] = data["input"]
        data["parameters"]["v4_negative_prompt"]["caption"]["base_caption"] = data["parameters"]["negative_prompt"]
        for i in range(len(data["parameters"]["v4_prompt"]["caption"]["char_captions"])):
            char_pos = replace_wildcards(data["parameters"]["v4_prompt"]["caption"]["char_captions"][i]["char_caption"])
            char_neg = replace_wildcards(
                data["parameters"]["v4_negative_prompt"]["caption"]["char_captions"][i]["char_caption"]
            )
            data["parameters"]["v4_prompt"]["caption"]["char_captions"][i]["char_caption"] = char_pos
            data["parameters"]["v4_negative_prompt"]["caption"]["char_captions"][i]["char_caption"] = char_neg
            data["parameters"]["characterPrompts"][i]["prompt"] = char_pos
            data["parameters"]["characterPrompts"][i]["uc"] = char_neg
    return data


# ---------------------------------------------------------------- 任务控制
# 停止信号为"每任务独立文件" (./outputs/temp_break_<任务id>.json):
# 生图队列多通道并行时, 停止某个任务不会误伤其它通道上正在运行的任务。


def reset_stop() -> None:
    """任务开始时重置当前任务的停止信号 (替代旧的全局 temp_break.json 写入)。"""
    from utils.jobs import write_break_flag

    write_break_flag(False)
    clear_stop_cache()  # 新任务开始: 丢掉上一轮的"无信号"负缓存


def stop_generate(job_id: str | None = None) -> None:
    """请求停止生成。

    - 指定 job_id: 只停止该任务
    - 未指定: 停止生图队列全部运行中任务 + 所有后台任务 (全局停止, 兼容旧行为)
    """
    logger.warning("正在停止生成...")
    if job_id:
        from utils.jobs import write_break_flag

        write_break_flag(True, job_id)
        return
    try:
        from utils.gen_queue import gen_queue

        gen_queue.stop_all_running()
    except Exception:
        logger.opt(exception=True).debug("停止生成队列失败堆栈:")
    try:
        from utils.jobs import jobs as _jobs
        from utils.jobs import write_break_flag

        for jid in _jobs.running_job_ids():
            write_break_flag(True, jid)
    except Exception:
        logger.opt(exception=True).debug("写入停止信号失败堆栈:")
    os.makedirs("./outputs", exist_ok=True)
    with open("./outputs/temp_break.json", "w") as f:
        json.dump({"break": True}, f)


# check_stop 的负结果缓存: 它在逐图循环与重试循环里被高频调用, 而每次调用都要
# 打开并 JSON 解析一个信号文件。文件不存在 (最常见) 时记下"该任务无信号", 之后直接返回。
# 只缓存否定结果: 一旦读到 break=true 立刻清缓存并返回 True, 停止指令永远即时生效,
# 且 clean_stop_cache() 会在任务开始时调用, 避免跨任务/跨轮次误判。
_STOP_CACHE: set[str] = set()


def clear_stop_cache() -> None:
    """清空停止信号负缓存 (任务开始时调用, 防止沿用上一轮/别的任务的判定)。"""
    _STOP_CACHE.clear()


def check_stop() -> bool:
    """检测当前任务的停止信号 (自动按线程定位任务; 任务线程外读取全局文件)。

    负结果按信号文件路径缓存 (见 _STOP_CACHE), 避免逐图/逐次重试都去打开文件。
    """
    try:
        from utils.jobs import break_file_path

        path = break_file_path()
        if path in _STOP_CACHE:
            return False
        breaking = bool(read_json(path).get("break"))
        if breaking:
            _STOP_CACHE.discard(path)
            return True
        _STOP_CACHE.add(path)
        return False
    except FileNotFoundError:
        return False
    except Exception:
        return False


# ---------------------------------------------------------------- 提示音


def playsound(file_path: str) -> None:
    try:
        from playsound import playsound as _playsound

        if file_path == "./assets/llss.mp3" and not env.start_sound:
            return
        if file_path == "./assets/finish.mp3" and not env.finish_sound:
            return
        _playsound(file_path)
    except Exception as e:
        logger.warning(f"playsound 播放失败: {e}")
        logger.opt(exception=True).debug("playsound 播放失败堆栈:")


# ---------------------------------------------------------------- 系统


def restart() -> None:
    logger.warning("开始重启...")
    # 标记为重启: 重启后不再自动打开浏览器窗口
    os.environ["ANR_SKIP_BROWSER"] = "1"
    p = sys.executable
    os.execl(p, p, *sys.argv)


def apply_console_visibility() -> None:
    """按当前配置隐藏 / 显示终端窗口 (仅 Windows; 无控制台或非 Windows 时忽略)。"""
    if platform.system() != "Windows":
        return
    try:
        import ctypes

        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            # SW_HIDE=0 / SW_SHOW=5
            ctypes.windll.user32.ShowWindow(hwnd, 0 if env.hide_terminal else 5)
    except Exception as e:
        logger.debug(f"设置控制台显隐失败: {e}")


def shutdown_app() -> None:
    """退出程序: 结束后端进程树; 由 run.bat 启动时连同控制台宿主 (cmd) 一起结束。"""

    def _kill():
        if platform.system() == "Windows":
            target = os.getpid()
            try:
                import psutil

                parent = psutil.Process(os.getpid()).parent()
                # 由 run.bat 启动时父进程是 cmd.exe: 连同终端一起结束, 避免残留黑窗口
                if parent and (parent.name() or "").lower() == "cmd.exe":
                    target = parent.pid
            except Exception as e:
                logger.debug(f"获取父进程信息失败: {e}")
            try:
                subprocess.Popen(
                    ["taskkill", "/F", "/T", "/PID", str(target)],
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                # 兜底: taskkill 未生效时也要确保退出
                threading.Timer(2.0, lambda: os._exit(0)).start()
            except Exception:
                os._exit(0)
        else:
            os._exit(0)

    logger.warning("收到退出请求, 进程即将结束...")
    # 延迟执行: 先让 HTTP 响应返回前端再结束进程
    threading.Timer(0.5, _kill).start()


# 更新检查结果缓存 (启动时由 check_update 写入, /api/state 读取展示)
UPDATE_AVAILABLE: bool = False
UPDATE_MESSAGE: str = ""


def check_update(repo_path: str):
    global UPDATE_AVAILABLE, UPDATE_MESSAGE
    try:
        if env.check_update:
            repo = Repo(repo_path)
            current_branch = repo.active_branch
            remote_ref = f"origin/{current_branch.name}"
            if remote_ref not in repo.references:
                UPDATE_AVAILABLE, UPDATE_MESSAGE = False, "远程分支不存在"
                return False, UPDATE_MESSAGE
            local_commit = current_branch.commit.hexsha
            remote_commit = repo.references[remote_ref].commit.hexsha
            repo.close()
            UPDATE_AVAILABLE = local_commit != remote_commit
            UPDATE_MESSAGE = "已是最新版本" if not UPDATE_AVAILABLE else "检测到新版本, 请更新"
            return not UPDATE_AVAILABLE, UPDATE_MESSAGE
        UPDATE_AVAILABLE, UPDATE_MESSAGE = False, "更新检查已关闭"
        return False, UPDATE_MESSAGE
    except Exception as e:
        UPDATE_AVAILABLE, UPDATE_MESSAGE = False, str(e)
        return False, str(e)


def get_update_status() -> dict:
    """返回启动时的更新检查结果 (供 /api/state 与 WebUI 展示)。"""
    return {"available": UPDATE_AVAILABLE, "message": UPDATE_MESSAGE}


def update_repo(path: str) -> str:
    logger.info("正在尝试更新...")
    try:
        Repo(path).close()  # 仅校验是 git 仓库 (非仓库路径抛错, 与原行为一致)
        # 用 subprocess 自带超时执行 pull: GitPython 的 kill_after_timeout 不支持 Windows,
        # 裸 repo.git.pull() 无超时, 网络挂起会把线程池工作线程永久占住
        # (同 plugins_store._check_update_online 的处理方式)
        proc = subprocess.run(
            ["git", "pull"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=300,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "").strip() or f"git pull 退出码 {proc.returncode}")
        logger.success("更新完成, 重启后生效!")
        return "更新完成, 重启后生效!"
    except Exception as e:
        logger.error(f"更新失败: {e}")
        logger.opt(exception=True).debug("更新失败堆栈:")
        return f"更新失败: {e}"


def download(url: str, saved_path: str) -> None:
    """下载文件: 终端显示单行进度条 (大小 + 百分比 + 速度), 完成时记录日志。"""
    rep = requests.get(url, proxies=get_proxies(), stream=True, timeout=60)
    rep.raise_for_status()
    total = int(rep.headers.get("Content-Length") or 0)
    total_mb = total / 1024 / 1024
    os.makedirs(Path(saved_path).parent, exist_ok=True)
    if total:
        logger.info(f"正在下载: {url} ({total_mb:.1f} MB)")
    else:
        logger.info(f"正在下载: {url}")

    downloaded = 0
    if total:
        # 终端: 单行进度条 (与 loguru 共用同一 console, 避免串扰)
        with Progress(
            TextColumn("[bold blue]{task.description}"),
            BarColumn(bar_width=30),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            DownloadColumn(),
            TransferSpeedColumn(),
            console=console,
            transient=True,
        ) as progress:
            task = progress.add_task("下载中", total=total)
            with open(saved_path, "wb") as f:
                for chunk in rep.iter_content(chunk_size=256 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    downloaded += len(chunk)
                    progress.update(task, completed=downloaded)
    else:
        with open(saved_path, "wb") as f:
            for chunk in rep.iter_content(chunk_size=256 * 1024):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)

    logger.success(f"下载完成: {saved_path} ({downloaded / 1024 / 1024:.1f} MB)")


def extract(file_path: str, otp_path: str) -> None:
    with zipfile.ZipFile(file_path) as zip:
        zip.extractall(otp_path)
    os.remove(file_path)


def _deps_fingerprint(path: str) -> str:
    """requirements.txt 内容 + 解释器指纹 (换 venv / 换 Python / 改依赖清单即失效)。"""
    h = hashlib.sha1()
    h.update(Path(path).read_bytes())
    h.update(f"|{sys.version}|{sys.prefix}".encode("utf-8"))
    return h.hexdigest()


def install_requirements(path: str) -> None:
    if env.share:
        logger.warning("共享模式下已跳过插件依赖安装")
        return
    # 指纹守卫: 依赖清单没变则跳过 pip (装 6 个插件时省掉每次启动 6 次 pip 解析, 方案 C-F1)
    stamp = Path(str(path) + ".installed")
    try:
        fp = _deps_fingerprint(path)
    except OSError as e:
        logger.warning(f"读取依赖清单失败, 仍尝试安装: {path} ({e})")
        logger.opt(exception=True).debug("读取依赖清单失败堆栈:")
        fp = None
    if fp:
        try:
            if stamp.read_text(encoding="utf-8").strip() == fp:
                logger.debug(f"插件依赖指纹未变, 跳过安装: {path}")
                return
        except OSError as e:
            logger.debug(f"读取插件依赖指纹失败, 将重新安装: {e}")
    logger.debug(f"正在安装插件依赖: {path}")
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    cmd = [sys.executable, "-X", "utf8", "-m", "pip", "install", "-r", path]
    if not in_venv:
        cmd.append("--user")
    cmd += ["--quiet", "--disable-pip-version-check"]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=600,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        # 装不上依赖不该拖垮整个插件加载: 记一行错误, 下次启动会自然重试
        logger.error(f"插件依赖安装超时 ({Path(path).name}): 超过 600 秒仍未结束, 本次已跳过")
        return
    except OSError as e:
        logger.error(f"插件依赖安装中断 ({Path(path).name}): {e}")
        logger.opt(exception=True).debug("插件依赖安装中断堆栈:")
        return
    if proc.returncode == 0:
        if fp:
            try:
                stamp.write_text(fp, encoding="utf-8")  # 只在安装成功后落指纹; 失败不写, 下次启动自动重试
            except OSError as e:
                logger.debug(f"写入插件依赖指纹失败: {e}")
        logger.success(f"插件依赖安装完成: {Path(path).name}")
    else:
        tail = (proc.stdout or b"").decode("utf-8", errors="ignore").strip().splitlines()[-5:]
        logger.error(f"插件依赖安装失败 ({Path(path).name}):\n" + "\n".join(tail))


def send_mail() -> None:
    if env.smtp_num == 0:
        return
    if not env.smtp_mail or not env.smtp_token:
        logger.warning("未配置邮箱账号或授权码, 已跳过邮件提醒")
        return
    mail_host = "smtp.qq.com"
    message = MIMEText("Auto-NovelAI-Refactor 生成结束", "plain", "utf-8")
    message["From"] = env.smtp_mail
    message["To"] = env.smtp_mail
    message["Subject"] = "ANR 完成提醒"
    smtp_obj = None
    try:
        smtp_obj = smtplib.SMTP_SSL(mail_host, smtplib.SMTP_SSL_PORT)
        smtp_obj.login(env.smtp_mail, env.smtp_token)
        smtp_obj.sendmail(env.smtp_mail, env.smtp_mail, message.as_string())
        logger.success("发送邮件成功!")
    except smtplib.SMTPException as e:
        logger.error(f"发送失败: {e}")
        logger.opt(exception=True).debug("发送失败堆栈:")
    finally:
        if smtp_obj is not None:
            try:
                smtp_obj.quit()
            except smtplib.SMTPException as e:
                logger.error(f"关闭 SMTP 连接失败: {e}")
                logger.opt(exception=True).debug("关闭 SMTP 连接失败堆栈:")


def send_anlas_remind_mail(masked: str, remains: float, threshold: int) -> None:
    """剩余用量低于阈值提醒邮件 (复用 SMTP 配置)。"""
    if not env.smtp_mail or not env.smtp_token:
        logger.warning("未配置邮箱账号或授权码, 已跳过用量提醒邮件")
        return
    mail_host = "smtp.qq.com"
    text = f"Token {masked} 的剩余用量仅剩 {remains}% (低于设定阈值 {threshold}%), 请及时关注。"
    message = MIMEText(text, "plain", "utf-8")
    message["From"] = env.smtp_mail
    message["To"] = env.smtp_mail
    message["Subject"] = "ANR 用量提醒"
    smtp_obj = None
    try:
        smtp_obj = smtplib.SMTP_SSL(mail_host, smtplib.SMTP_SSL_PORT)
        smtp_obj.login(env.smtp_mail, env.smtp_token)
        smtp_obj.sendmail(env.smtp_mail, env.smtp_mail, message.as_string())
        logger.success(f"用量提醒邮件已发送: Token {masked} 剩余用量 {remains}%")
    except smtplib.SMTPException as e:
        logger.error(f"用量提醒邮件发送失败: {e}")
        logger.opt(exception=True).debug("用量提醒邮件发送失败堆栈:")
    finally:
        if smtp_obj is not None:
            try:
                smtp_obj.quit()
            except smtplib.SMTPException as e:
                logger.error(f"关闭 SMTP 连接失败: {e}")
                logger.opt(exception=True).debug("关闭 SMTP 连接失败堆栈:")


# ---------------------------------------------------------------- 图片筛选


def _safe_img_paths(input_path: str) -> list[str]:
    return [
        str(Path(input_path) / f)
        for f in os.listdir(input_path)
        if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
    ]


def _save_selector_queue(file_list: list[str]) -> None:
    np.save("./outputs/temp_selector.npy", np.array(file_list))


def _load_selector_queue() -> list[str]:
    if not os.path.exists("./outputs/temp_selector.npy"):
        return []
    return [str(f) for f in np.load("./outputs/temp_selector.npy")]


def show_first_img(input_path: str):
    """加载目录并显示第一张可读图片 (损坏/读不了的文件自动跳过)。"""
    try:
        file_list = _safe_img_paths(input_path)
    except Exception as e:
        logger.error(f"加载图片目录失败: {e}")
        logger.opt(exception=True).debug("加载图片目录失败堆栈:")
        return None, None
    if not file_list:
        logger.error("输入的目录中没有图片!")
        return None, None
    _save_selector_queue(file_list)
    return show_next_img()


def show_next_img():
    """从队列取下一张图片; 单张文件损坏或已被移走时自动跳过, 队列清空才算浏览完。

    (撤销恢复的历史队列快照里可能含有已被删除的文件, 若不跳过读不到的条目,
     会把"读取失败"当成"队列已空", 明明还有图片却提示已浏览完所有图片。)
    """
    try:
        file_list = _load_selector_queue()
    except Exception as e:
        logger.error(f"读取图片列表失败: {e}")
        logger.opt(exception=True).debug("读取图片列表失败堆栈:")
        return None, None
    while file_list:
        img_path, file_list = file_list[0], file_list[1:]
        _save_selector_queue(file_list)
        try:
            with Image.open(img_path):
                return [str(img_path)], img_path
        except Exception:
            logger.warning(f"图片不存在或无法读取, 已跳过: {img_path}")
            logger.opt(exception=True).debug("读取图片失败堆栈:")
    return None, None


def move_current_img(current_img, output_path):
    """移动图片并显示下一张, 返回 (图片列表, 当前图, 错误信息)。失败时队列不动。"""
    try:
        os.makedirs(output_path, exist_ok=True)
        shutil.move(current_img, str(Path(output_path) / Path(current_img).name))
        logger.info(loguru_to_rich(f"已将 <c>{current_img}</c> 移动到 <c>{output_path}</c>"))
        images, nxt = show_next_img()
        return images, nxt, None
    except Exception as e:
        logger.error(f"移动图片失败: {e}")
        logger.opt(exception=True).debug("移动图片失败堆栈:")
        return None, None, f"移动失败: {e}"


def copy_current_img(current_img, output_path):
    """复制图片并显示下一张, 返回 (图片列表, 当前图, 错误信息)。失败时队列不动。"""
    try:
        os.makedirs(output_path, exist_ok=True)
        shutil.copyfile(current_img, str(Path(output_path) / Path(current_img).name))
        logger.info(loguru_to_rich(f"已将 <c>{current_img}</c> 复制到 <c>{output_path}</c>"))
        images, nxt = show_next_img()
        return images, nxt, None
    except Exception as e:
        logger.error(f"复制图片失败: {e}")
        logger.opt(exception=True).debug("复制图片失败堆栈:")
        return None, None, f"复制失败: {e}"


# 筛选删除使用可撤销的本地回收站: send2trash 无法找回文件路径, 撤销删除会失效
_SELECTOR_TRASH = Path("./outputs/selector_trash")


def clear_selector_trash():
    """清空可撤销回收站 (加载新目录时调用, 与清空历史保持一致)。"""
    try:
        if _SELECTOR_TRASH.exists():
            for f in _SELECTOR_TRASH.iterdir():
                if f.is_file():
                    f.unlink(missing_ok=True)
    except Exception as e:
        logger.error(f"清理回收站失败: {e}")
        logger.opt(exception=True).debug("清理回收站失败堆栈:")


def del_current_img(current_img):
    """把图片移入可撤销的临时回收站, 返回 (回收站路径, 图片列表, 当前图)。"""
    try:
        if current_img:
            _SELECTOR_TRASH.mkdir(parents=True, exist_ok=True)
            trash = _SELECTOR_TRASH / f"{uuid.uuid4().hex[:8]}_{Path(current_img).name}"
            shutil.move(current_img, str(trash))
            logger.info(loguru_to_rich(f"已将 <c>{current_img}</c> 移入回收站"))
            images, nxt = show_next_img()
            return str(trash), images, nxt
        logger.error("当前未选择图片!")
    except Exception as e:
        logger.error(f"删除图片失败: {e}")
        logger.opt(exception=True).debug("删除图片失败堆栈:")
    return None, None, None
