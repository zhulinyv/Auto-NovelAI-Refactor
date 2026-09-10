"""共享链接 (外网访问隧道): 通过 cloudflared 快速隧道把本地 WebUI 暴露到公网。

- 开启共享后生成形如 https://xxxx.trycloudflare.com 的公网链接, 无需注册账号/密钥
- 首次使用时自动下载 cloudflared 单文件程序到 bin/ 目录 (支持代理)
- 隧道进程由本模块统一管理: start_tunnel / stop_tunnel / ensure_tunnel
- 重启服务 (os.execl) 时子进程存活, 通过 bin/cloudflared.pid 沿用旧隧道, 链接保持不变
- 可选启动时自动打开浏览器访问共享链接 (open_browser=True, 用于首次启动替代本地链接)
- 隧道只转发到本机 127.0.0.1, 服务本身不额外对局域网开放
"""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import threading
import time
from pathlib import Path

from utils.config import BASE_DIR, env
from utils.logger import logger

_URL_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
_BIN_DIR = BASE_DIR / "bin"
_PID_FILE = _BIN_DIR / "cloudflared.pid"

_lock = threading.Lock()
_process: subprocess.Popen | None = None  # 本进程拉起的隧道
_adopted_pid: int | None = None  # 重启沿用 (非本进程拉起) 的隧道 pid
_tunnel_url: str | None = None
_url_ready = False  # 端到端连通性确认通过, 链接真实可访问
_last_error: str | None = None  # 最近一次建立失败的原因 (展示给前端)
_pending_open = False  # 链接就绪后是否需要自动打开浏览器
_browser_opened = False


def _binary_path() -> Path:
    if platform.system() == "Windows":
        return _BIN_DIR / "cloudflared.exe"
    return _BIN_DIR / "cloudflared"


def _download_binary() -> Path:
    """按平台下载 cloudflared 单文件程序 (复用 helpers.download 的进度条与代理)。"""
    from utils.helpers import download

    system = platform.system()
    if system == "Windows":
        name = "cloudflared-windows-amd64.exe"
    elif system == "Linux":
        name = "cloudflared-linux-amd64"
    elif system == "Darwin":
        name = "cloudflared-darwin-amd64.tgz"
    else:
        raise RuntimeError(f"暂不支持的平台: {system}")
    url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{name}"
    dst = _binary_path()
    _BIN_DIR.mkdir(parents=True, exist_ok=True)
    download(url, str(dst))
    if name.endswith(".tgz"):
        import tarfile

        with tarfile.open(dst) as tar:
            tar.extractall(_BIN_DIR)
        os.remove(dst)
    try:
        os.chmod(dst, 0o755)
    except Exception:
        pass
    return dst


def _write_pidfile(pid: int, url: str | None) -> None:
    try:
        _BIN_DIR.mkdir(parents=True, exist_ok=True)
        _PID_FILE.write_text(json.dumps({"pid": pid, "url": url, "port": env.port}), encoding="utf-8")
    except Exception:
        pass


def _read_pidfile() -> dict | None:
    try:
        return json.loads(_PID_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def _pid_alive(pid: int) -> bool:
    try:
        import psutil

        proc = psutil.Process(pid)
        return proc.is_running() and "cloudflared" in (proc.name() or "").lower()
    except Exception:
        return False


def _cleanup_stale() -> dict | None:
    """处理上次残留的隧道: 端口一致且链接已知且进程存活则沿用 (返回信息), 否则清理。"""
    info = _read_pidfile()
    try:
        _PID_FILE.unlink()
    except Exception:
        pass
    if not info:
        return None
    pid, url, port = int(info.get("pid") or 0), info.get("url"), int(info.get("port") or 0)
    if pid > 0 and url and port == env.port and _pid_alive(pid):
        return {"pid": pid, "url": url}
    # 端口不一致 / 链接未知 / 进程已死: 直接清理 (进程还活着就杀掉)
    if pid > 0 and _pid_alive(pid):
        try:
            import psutil

            psutil.Process(pid).kill()
            logger.info(f"已清理不兼容的残留隧道进程 (pid={pid})")
        except Exception:
            pass
    return None


def _maybe_open_browser(url: str | None) -> None:
    """隧道就绪后按需自动打开共享链接 (仅一次, 替代启动时的本地链接)。"""
    global _browser_opened
    if not _pending_open or _browser_opened or not url:
        return
    _browser_opened = True
    try:
        import webbrowser

        webbrowser.open(url)
        logger.info(f"已打开共享链接: {url}")
    except Exception as e:
        logger.warning(f"自动打开共享链接失败: {e}")


def _publish() -> None:
    try:
        from utils.events import broker

        broker.publish("share:update", {"url": get_tunnel_url(), "running": is_running()})
    except Exception:
        pass


def start_tunnel(open_browser: bool = False) -> bool:
    """启动共享隧道; 返回是否成功拉起 (公网链接稍后在后台解析)。

    open_browser: 链接就绪后自动用系统浏览器打开 (首次启动替代本地链接)。
    """
    global _process, _tunnel_url, _adopted_pid, _pending_open, _browser_opened, _url_ready, _last_error
    with _lock:
        _last_error = None
        # 已在运行 (本进程拉起或沿用): 只按需补一次打开浏览器的动作
        if (_process is not None and _process.poll() is None) or _adopted_pid is not None:
            _pending_open = _pending_open or open_browser
            _maybe_open_browser(_tunnel_url)
            return True
    adopted = _cleanup_stale()
    if adopted:
        with _lock:
            _adopted_pid = adopted["pid"]
            _tunnel_url = adopted["url"]
            _url_ready = True  # 沿用的旧隧道早已注册完成, 直接视为就绪
            _pending_open = open_browser
        logger.info(f"共享链接: 沿用上次未关闭的隧道 {_tunnel_url}")
        _write_pidfile(_adopted_pid, _tunnel_url)
        _maybe_open_browser(_tunnel_url)
        _publish()
        return True
    binary = _binary_path()
    if not binary.exists():
        try:
            logger.info("共享链接: 首次使用, 正在下载 cloudflared (约 17MB, 请耐心等待)...")
            _download_binary()
        except Exception as e:
            logger.error(f"共享链接: cloudflared 下载失败, 无法生成外网链接: {e}")
            return False
    cmd = [
        str(binary),
        "tunnel",
        "--url",
        f"http://127.0.0.1:{env.port}",
        "--no-autoupdate",
    ]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if platform.system() == "Windows" else 0
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
    except Exception as e:
        logger.error(f"共享链接: 启动 cloudflared 失败: {e}")
        return False
    with _lock:
        _process = proc
        _tunnel_url = None
        _url_ready = False
        _pending_open = open_browser
    _write_pidfile(proc.pid, None)
    logger.info("共享链接: 隧道进程已启动, 正在生成公网链接...")
    threading.Thread(target=_watch, args=(proc,), daemon=True).start()
    return True


def _verify_reachable(url: str) -> bool:
    """端到端确认公网链接真实可访问 (直连, 不走任何代理, 模拟普通访客)。"""
    try:
        import requests

        sess = requests.Session()
        sess.trust_env = False
        r = sess.get(url + "/api/share", timeout=15)
        return r.status_code == 200
    except Exception:
        return False


def _confirm_ready(proc: subprocess.Popen, url: str) -> None:
    """循环实测公网链接, 确认可访问后才对外提供; 长时间不可达则停掉并报错。

    cloudflared 打印链接到边缘线路全球生效有传播窗口, 仅凭日志判断"就绪"
    可能早于真实可访问, 导致前端跳转到打不开的链接。
    """
    global _url_ready, _last_error
    intervals = (0, 5, 10, 15, 25, 35, 50, 70, 90, 120)  # 恰好十次
    ok = False
    for i, delay in enumerate(intervals):
        if delay:
            time.sleep(delay)
        if proc.poll() is not None:
            break
        if _verify_reachable(url):
            ok = True
            break
        logger.info(f"共享链接连通性确认第 {i + 1}/{len(intervals)} 次未通过, 继续等待...")
    with _lock:
        if ok and _tunnel_url == url:
            _url_ready = True
            logger.success(f"共享链接已确认可访问: {url}")
        else:
            _url_ready = False
    if ok:
        _maybe_open_browser(url)
        _publish()
        return
    # 长时间不可达: 停掉隧道并记录原因, 让前端明确显示失败
    stop_tunnel()
    with _lock:
        _last_error = "公网链接 10 次连通性确认均未通过, 请检查本机网络后重新保存开启"
    logger.error(f"共享链接连通性确认失败, 已停止隧道: {url}")
    _publish()


def _watch(proc: subprocess.Popen) -> None:
    """读取隧道输出, 解析公网链接; 进程退出时清理状态。

    注意: 解析到链接后必须继续持续读取并丢弃输出 -- 一旦停止读取,
    管道缓冲区写满会把 cloudflared 整个卡死 (隧道假死无法访问)。
    """
    global _process, _tunnel_url
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            m = _URL_RE.search(line)
            if m and not _tunnel_url:
                with _lock:
                    _tunnel_url = m.group(0)
                _write_pidfile(proc.pid, _tunnel_url)
                logger.success(f"共享链接已生成: {_tunnel_url}, 正在做端到端连通性确认...")
                threading.Thread(target=_confirm_ready, args=(proc, _tunnel_url), daemon=True).start()
    except Exception:
        pass
    finally:
        code = proc.wait()
        with _lock:
            if _process is proc:
                _process = None
                _tunnel_url = None
                _url_ready = False
        # 仅当 pidfile 仍属于本进程时才清理, 避免误删新隧道的 pidfile
        try:
            info = _read_pidfile()
            if info and info.get("pid") == proc.pid:
                _PID_FILE.unlink()
        except Exception:
            pass
        logger.warning(f"共享链接隧道已退出 (exit code={code})")
        _publish()


def stop_tunnel() -> None:
    """停止共享链接并清理状态 (含沿用模式的按 pid 结束)。"""
    global _process, _tunnel_url, _adopted_pid, _url_ready, _last_error
    with _lock:
        proc = _process
        adopted = _adopted_pid
        _last_error = None
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    if adopted is not None and _pid_alive(adopted):
        try:
            import psutil

            psutil.Process(adopted).kill()
        except Exception:
            pass
    with _lock:
        _process = None
        _adopted_pid = None
        _tunnel_url = None
        _url_ready = False
    try:
        _PID_FILE.unlink()
    except Exception:
        pass
    logger.info("共享链接已关闭")
    _publish()


def ensure_tunnel() -> None:
    """按 env.share 配置保证隧道状态一致 (保存配置 / 启动后调用)。"""
    if bool(env.share):
        start_tunnel()
    else:
        stop_tunnel()


def get_tunnel_url() -> str | None:
    with _lock:
        return _tunnel_url


def get_share_info() -> dict:
    """对外展示用的统一状态: 链接仅在端到端连通性确认后才提供。"""
    with _lock:
        ready = bool(_url_ready and _tunnel_url)
        running = (_process is not None and _process.poll() is None) or _adopted_pid is not None
        error = _last_error
    info = {"url": _tunnel_url if ready else None, "running": running, "ready": ready}
    if error:
        info["error"] = error
    return info


def is_running() -> bool:
    with _lock:
        if _process is not None and _process.poll() is None:
            return True
        adopted = _adopted_pid
    return adopted is not None and _pid_alive(adopted)
