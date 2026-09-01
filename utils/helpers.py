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
import zipfile
from email.mime.text import MIMEText
from pathlib import Path

import numpy as np
import requests
import send2trash
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
    """在 [seconds-1, seconds+1] 内随机休眠, 避免请求过快; 检测到停止时立即返回。"""
    sleep_time = round(random.uniform(abs(seconds - 1), seconds + 1), 3)
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


def replace_wildcards(text: str) -> str:
    pattern = r"<([^:]+):([^>]+)>"
    matchers = re.findall(pattern, text)
    matchers_number = 0
    while matchers:
        for wild_card in matchers:
            if wild_card[1] == "随机":
                _path = f"./wildcards/{wild_card[0]}/"
                name = random.choice(os.listdir(_path))
                name = name.replace(".txt", "")
            elif wild_card[1] == "顺序":
                name, tag = _sequential_wildcard(wild_card[0])
            else:
                name = wild_card[1]
                tag = read_txt(f"./wildcards/{wild_card[0]}/{wild_card[1]}.txt")
            if wild_card[1] != "顺序":
                tag = read_txt(f"./wildcards/{wild_card[0]}/{name}.txt")
            matchers_number += 1
            text = text.replace(f"<{wild_card[0]}:{wild_card[1]}>", tag)
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
    names = sorted(os.listdir(f"./wildcards/{category}"))
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
    return names[number].replace(".txt", ""), read_txt(f"./wildcards/{category}/{names[number]}")


def find_and_replace_wildcards_from_dict(data: dict) -> dict:
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
        pass
    try:
        from utils.jobs import jobs as _jobs
        from utils.jobs import write_break_flag

        for jid in _jobs.running_job_ids():
            write_break_flag(True, jid)
    except Exception:
        pass
    os.makedirs("./outputs", exist_ok=True)
    with open("./outputs/temp_break.json", "w") as f:
        json.dump({"break": True}, f)


def check_stop() -> bool:
    """检测当前任务的停止信号 (自动按线程定位任务; 任务线程外读取全局文件)。"""
    try:
        from utils.jobs import break_file_path

        return bool(read_json(break_file_path()).get("break"))
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
    except Exception:
        pass


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
            except Exception:
                pass
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
        repo = Repo(path)
        repo.git.pull()
        repo.close()
        logger.success("更新完成, 重启后生效!")
        return "更新完成, 重启后生效!"
    except Exception as e:
        logger.error(f"更新失败: {e}")
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


def install_requirements(path: str) -> None:
    if env.share:
        logger.warning("共享模式下已跳过插件依赖安装")
        return
    logger.debug(f"正在安装插件依赖: {path}")
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    cmd = [sys.executable, "-X", "utf8", "-m", "pip", "install", "-r", path]
    if not in_venv:
        cmd.append("--user")
    cmd += ["--quiet", "--disable-pip-version-check"]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=600,
    )
    if proc.returncode == 0:
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
    finally:
        if smtp_obj is not None:
            try:
                smtp_obj.quit()
            except smtplib.SMTPException as e:
                logger.error(f"关闭 SMTP 连接失败: {e}")


# ---------------------------------------------------------------- 图片筛选


def _safe_img_paths(input_path: str) -> list[str]:
    return [
        str(Path(input_path) / f)
        for f in os.listdir(input_path)
        if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
    ]


def show_first_img(input_path: str):
    try:
        file_list = _safe_img_paths(input_path)
        if not file_list:
            logger.error("输入的目录中没有图片!")
            return None, None
        img_path = file_list[0]
        np.save("./outputs/temp_selector.npy", np.array(file_list[1:]))
        with Image.open(img_path):
            return [str(img_path)], img_path
    except Exception as e:
        logger.error(f"加载图片目录失败: {e}")
        return None, None


def show_next_img():
    try:
        if not os.path.exists("./outputs/temp_selector.npy"):
            return None, None
        file_list = [str(f) for f in np.load("./outputs/temp_selector.npy")]
        if not file_list:
            return None, None
        img_path = file_list[0]
        np.save("./outputs/temp_selector.npy", np.array(file_list[1:]))
        with Image.open(img_path):
            return [str(img_path)], img_path
    except Exception as e:
        logger.error(f"读取图片列表失败: {e}")
        return None, None


def move_current_img(current_img, output_path):
    try:
        os.makedirs(output_path, exist_ok=True)
        shutil.move(current_img, str(Path(output_path) / Path(current_img).name))
        logger.info(loguru_to_rich(f"已将 <c>{current_img}</c> 移动到 <c>{output_path}</c>"))
        return show_next_img()
    except Exception as e:
        logger.error(f"移动图片失败: {e}")
        return None, None


def copy_current_img(current_img, output_path):
    try:
        os.makedirs(output_path, exist_ok=True)
        shutil.copyfile(current_img, str(Path(output_path) / Path(current_img).name))
        logger.info(loguru_to_rich(f"已将 <c>{current_img}</c> 复制到 <c>{output_path}</c>"))
        return show_next_img()
    except Exception as e:
        logger.error(f"复制图片失败: {e}")
        return None, None


def del_current_img(current_img):
    """把图片移到系统回收站 (send2trash), 返回 (None, 图片列表, 当前图)。"""
    try:
        if current_img:
            send2trash.send2trash(str(Path(current_img)))
            logger.info(loguru_to_rich(f"已将 <c>{current_img}</c> 移到系统回收站"))
            images, nxt = show_next_img()
            return None, images, nxt
        logger.error("当前未选择图片!")
    except Exception as e:
        logger.error(f"删除图片失败: {e}")
    return None, None, None
