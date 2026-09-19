"""系统托盘: 右键菜单 打开 / 重启 / 关闭。

- 图标与浏览器标签页 favicon 同源 (assets/logo.ico)。
- "打开"优先使用默认浏览器 (Chromium 系) 的 --app 独立窗口: 独立 profile + PID 落盘,
  可前置激活、可被"关闭"强杀; 默认浏览器非 Chromium 系时退回 webbrowser 普通标签页
  (浏览器安全模型限制, 普通标签页无法从后端强杀, "关闭"此时只结束后端)。
- "重启"等价于 WebUI 内重启 (os.execl 原地替换, 共享隧道沿用), 并由独立助手进程
  等后端端口就绪后重新打开 webui 窗口。
- 托管浏览器窗口 PID 经 .webui-browser/pid 跨进程保留: 无论从托盘还是 WebUI 重启,
  新进程都能重新接管旧窗口 ("打开"置前 / "关闭"强杀依然有效)。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.request import urlopen

from utils.config import env
from utils.logger import logger
from utils.variable import VERSION

BASE_DIR = Path(__file__).resolve().parents[1]
ICON_PATH = BASE_DIR / "assets" / "logo.ico"
PROFILE_DIR = BASE_DIR / ".webui-browser"
PID_FILE = PROFILE_DIR / "pid"

# 支持 --app 无地址栏窗口的 Chromium 系浏览器 (未命中则退回普通标签页)
_CHROMIUM_EXES = {
    "msedge.exe",
    "chrome.exe",
    "chromium.exe",
    "chromium-browser.exe",
    "vivaldi.exe",
    "brave.exe",
    "opera.exe",
}
_WINDOW_MARK = "--anr-webui"  # 自有标记: 供 _managed_pid 校验窗口归属, Chromium 忽略未知开关
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def webui_url() -> str:
    return f"http://127.0.0.1:{env.port}"


# ---------------------------------------------------------------- 默认浏览器探测


def _default_browser_exe() -> str | None:
    """读注册表取 HTTP 默认浏览器的可执行文件路径 (仅 Chromium 系返回)。"""
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
        ) as k:
            prog_id, _ = winreg.QueryValueEx(k, "ProgId")
        cmd = None
        for root, sub in (
            (winreg.HKEY_CLASSES_ROOT, prog_id + r"\shell\open\command"),
            (winreg.HKEY_CURRENT_USER, "Software\\Classes\\" + prog_id + "\\shell\\open\\command"),
        ):
            try:
                with winreg.OpenKey(root, sub) as k2:
                    cmd, _ = winreg.QueryValueEx(k2, None)
                break
            except OSError:
                continue
        if not cmd:
            return None
        cmd = winreg.ExpandEnvironmentStrings(cmd)
        exe = cmd.split('"')[1] if cmd.startswith('"') else cmd.split(" ")[0]
        exe = exe.strip()
        if os.path.basename(exe).lower() in _CHROMIUM_EXES and os.path.isfile(exe):
            return exe
    except OSError as e:
        logger.debug(f"读取注册表浏览器命令失败: {e}")
    return None


# ---------------------------------------------------------------- 托管窗口状态


def _read_pid() -> int | None:
    try:
        return int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None


def _write_pid(pid: int) -> None:
    try:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(pid))
    except OSError:
        logger.opt(exception=True).debug("写入托盘 PID 文件失败堆栈:")


def _clear_pid() -> None:
    try:
        PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _managed_pid() -> int | None:
    """当前存活的托管浏览器主进程 PID; 失效时清除记录并返回 None。"""
    pid = _read_pid()
    if not pid:
        return None
    try:
        import psutil

        p = psutil.Process(pid)
        if p.is_running() and p.status() != psutil.STATUS_ZOMBIE and any(_WINDOW_MARK in str(a) for a in p.cmdline()):
            return pid
    except Exception as e:
        logger.debug(f"扫描托管窗口进程失败: {e}")
    _clear_pid()
    return None


def _activate_windows(pid: int) -> int:
    """把该进程的可见顶层窗口还原并置前, 返回置前数量。"""
    if sys.platform != "win32":
        return 0
    try:
        import ctypes
        from ctypes.wintypes import BOOL, DWORD, HWND, LPARAM

        user32 = ctypes.windll.user32
        found: list[int] = []

        @ctypes.WINFUNCTYPE(BOOL, HWND, LPARAM)
        def _cb(hwnd, _lparam):
            pid_out = DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_out))
            if pid_out.value == pid and user32.IsWindowVisible(hwnd):
                found.append(int(hwnd))
            return True

        user32.EnumWindows(_cb, 0)
        for hwnd in found:
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
        return len(found)
    except Exception:
        return 0


# ---------------------------------------------------------------- 打开 / 强杀

# ---------------------------------------------------------------- AUMID 快捷方式注册 (Win11 任务栏强制 ANR 图标)

# 托管窗口专属 AppUserModelID。Win11 任务栏按钮按 AUMID 注册快捷方式绘制图标 (无视窗口自身
# 图标); 在开始菜单放一个带 logo 图标 + 该 AUMID 属性的快捷方式后, 按钮图标/悬停名都归 ANR。
# Win10 与「注册失败」时退路是 --app-icon/favicon 的窗口图标; 浏览器 exe 或参数变化自动重建。
WEBUI_AUMID = "AutoNovelAI.WebUI"
WAKE_SCRIPT = BASE_DIR / "utils" / "wake.py"  # 唤醒快捷方式的脚本目标 (pythonw 直跑, 无控制台)


def _start_menu_shortcut_path() -> Path | None:
    """开始菜单里 AUMID 快捷方式的路径 (无 APPDATA 时 None)。"""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    return (
        Path(appdata)
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Auto-NovelAI-Refactor"
        / "Auto-NovelAI-Refactor WebUI.lnk"
    )


def _wake_shortcut_path() -> Path | None:
    """开始菜单里可见的唤醒入口 (点它保证到界面; 后端没跑时由 wake.py 自动拉起)。"""
    base = _start_menu_shortcut_path()
    if base is None:
        return None
    return base.with_name("Auto-NovelAI-Refactor.lnk")


def _scan_managed_pid(timeout_s: float = 8.0) -> int | None:
    """轮询找带窗口标记的浏览器主进程 (排除 --type= 子进程)。

    explorer 通道是异步拉起, Popen 返回的 pid 不可用; .pid 丢失但托管浏览器仍活着
    (handoff 复用) 时这里也能把它认领回来。
    """
    try:
        import psutil
    except ImportError:
        return None
    deadline = time.monotonic() + timeout_s
    while True:
        for p in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                name = (p.info["name"] or "").lower()
                cl = " ".join(p.info["cmdline"] or [])
                if name in ("msedge.exe", "chrome.exe") and _WINDOW_MARK in cl and "--type=" not in cl:
                    return int(p.info["pid"])
            except Exception as e:  # noqa: BLE001 - 进程枚举竞争窗口, 下个周期再来
                logger.debug(f"扫描托管窗口进程失败: {e}")
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.4)


def _lnk_args_str(args: list[str]) -> str:
    """Popen 参数列表 -> 快捷方式 Arguments 字符串 (含空格的值加引号, 供手动从开始菜单打开时同样生效)。"""
    out = []
    for a in args:
        if " " not in a:
            out.append(a)
        elif "=" in a:
            k, _, v = a.partition("=")
            out.append(f'{k}"{v}"')
        else:
            out.append(f'"{a}"')
    return " ".join(out)


def _psq(s: object) -> str:
    """PowerShell 单引号字符串转义 (双单引号)。"""
    return str(s).replace("'", "''")


def _ensure_aumid_shortcut(exe: str, args_str: str) -> None:
    """确保开始菜单存在带 ANR 图标与 AUMID 属性的 WebUI 快捷方式; 一切失败只降级不抛错。"""
    lnk = _start_menu_shortcut_path()
    if lnk is None:
        return
    stamp = PROFILE_DIR / "aumid-shortcut.stamp"
    pythonw = next(
        (
            c
            for c in (BASE_DIR / "venv" / "Scripts" / "pythonw.exe", BASE_DIR / "Python" / "pythonw.exe")
            if c.is_file()
        ),
        None,
    )
    wake_lnk = _wake_shortcut_path()
    wake_fp = f"{pythonw or ''}|{wake_lnk or ''}"
    fingerprint = f"{exe}|{args_str}|{ICON_PATH}|{wake_fp}"
    try:
        if lnk.is_file() and stamp.read_text(encoding="utf-8") == fingerprint:
            return  # 已是最新: 不反复动开始菜单
    except OSError as e:
        logger.debug(f"读取快捷方式指纹失败: {e}")
    # '@ 结束符必须独占行首 (曾被字符串隐式拼接并进 Add-Type 一行, 教训), CRLF 双保险
    ps = "\r\n".join(
        [
            "$ErrorActionPreference = 'Stop'",
            f"$lnkObj = (New-Object -ComObject WScript.Shell).CreateShortcut('{_psq(lnk)}')",
            f"$lnkObj.TargetPath = '{_psq(exe)}'",
            f"$lnkObj.Arguments = '{_psq(args_str)}'",
            f"$lnkObj.WorkingDirectory = '{_psq(BASE_DIR)}'",
            f"$lnkObj.IconLocation = '{_psq(ICON_PATH)},0'",
            "$lnkObj.Description = 'Auto-NovelAI-Refactor WebUI'",
            "$lnkObj.Save()",
            # WScript.Shell 不支持 AUMID; Shell.Application 的 ExtendedProperty 在 PowerShell
            # 延迟绑定下只能读不能 put (实测报无二参方法) -> 经 shell32 IPropertyStore 直写快捷方式属性存储
            "$code = @'",
            "using System;",
            "using System.Runtime.InteropServices;",
            "public static class ShortcutAumid {",
            "  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }",
            "  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; }",
            '  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            "  interface IPropertyStore { int GetCount(out int c); int GetAt(int i, out PropertyKey k); int GetValue(ref PropertyKey k, out PropVariant v); int SetValue(ref PropertyKey k, ref PropVariant v); int Commit(); }",
            '  [ComImport, Guid("0000010c-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            "  interface IPersistFile { int GetClassID(out Guid c); [PreserveSig] int IsDirty(); int Load([MarshalAs(UnmanagedType.LPWStr)] string f, int m); int Save(string a, bool b); int SaveCompleted(string a); int GetCurFile(out string a); }",
            "  public static int Set(string lnkPath, string aumid) {",
            '    object link = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));',
            "    int hr = ((IPersistFile)link).Load(lnkPath, 2); if (hr != 0) return hr;",
            "    IPropertyStore store = (IPropertyStore)link;  // CShellLink 原生实现 IPropertyStore",
            '    PropertyKey key = new PropertyKey(); key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); key.pid = 5;',
            "    PropVariant v = new PropVariant(); v.vt = 31; v.p = Marshal.StringToHGlobalUni(aumid);",
            "    hr = store.SetValue(ref key, ref v); if (hr == 0) hr = store.Commit(); Marshal.FreeHGlobal(v.p);",
            "    if (hr != 0) return hr;",
            "    // 属性存储只是内存态, Commit 不落盘: 必须再 IPersistFile::Save 才写进 .lnk 文件",
            "    return ((IPersistFile)link).Save(lnkPath, true);",
            "  }",
            "}",
            "'@",
            "Add-Type -TypeDefinition $code",
            f"$hr = [ShortcutAumid]::Set('{_psq(lnk)}', '{_psq(WEBUI_AUMID)}')",
            'if ($hr -ne 0) { throw ("AUMID 写入失败 hr=0x{0:X8}" -f $hr) }',
        ]
    )
    wake_lines = []
    if pythonw is not None and wake_lnk is not None:
        # 可见唤醒条目: pythonw 跑 wake.py (带引号防路径空格); 图标同源 logo
        wake_lines = [
            f"$wake = (New-Object -ComObject WScript.Shell).CreateShortcut('{_psq(wake_lnk)}')",
            f"$wake.TargetPath = '{_psq(pythonw)}'",
            f"$wake.Arguments = '\"{_psq(WAKE_SCRIPT)}\"'",
            f"$wake.WorkingDirectory = '{_psq(BASE_DIR)}'",
            f"$wake.IconLocation = '{_psq(ICON_PATH)},0'",
            "$wake.Description = 'Auto-NovelAI-Refactor (未运行时自动拉起后端)'",
            "$wake.Save()",
        ]
        ps += "\r\n" + "\r\n".join(wake_lines)
    try:
        lnk.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            timeout=60,
            creationflags=_NO_WINDOW,
        )
        if r.returncode == 0:
            if wake_lines:
                # 唤醒入口就位后, 身份载体快捷方式设为隐藏 (hidden 不影响任务栏 AUMID 图标解析,
                # Electron 同款做法); 开始菜单里只留唤醒条目, 不再出现两个入口
                try:
                    import ctypes

                    ctypes.windll.kernel32.SetFileAttributesW(str(lnk), 0x00000002)  # FILE_ATTRIBUTE_HIDDEN
                except Exception as e:
                    logger.debug(f"设置快捷方式属性失败: {e}")
            stamp.write_text(fingerprint, encoding="utf-8")  # 成功才落指纹, 失败下次拉起自愈重试
        else:
            logger.debug(f"AUMID 快捷方式注册失败 (退回窗口图标): {r.stderr.decode('utf-8', 'ignore').strip()[:200]}")
    except Exception as e:
        logger.debug(f"AUMID 快捷方式注册异常 (退回窗口图标): {e}")
        logger.opt(exception=True).debug("AUMID 快捷方式注册失败堆栈:")


def open_webui() -> bool:
    """在默认浏览器中打开 webui; 优先激活/拉起可托管的 --app 窗口。

    返回 True 表示托管窗口路径 (可被"关闭"强杀), False 表示退回普通标签页。
    """
    exe = _default_browser_exe()
    if not exe:
        webbrowser.open(webui_url())
        return False
    pid = _managed_pid()
    if pid:
        _activate_windows(pid)
        return True
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    launch_args = [
        f"--app={webui_url()}",
        f"--app-icon={ICON_PATH}",  # 窗口自身图标 (标题栏/Win10 任务栏/Win11 注册失败时的退路), 与 favicon/托盘同源
        f"--app-user-model-id={WEBUI_AUMID}",  # 脱离 Edge 分组; 配合下方快捷方式注册出独立 ANR 图标
        _WINDOW_MARK,
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",  # 托管窗口默认最大化启动
    ]
    _ensure_aumid_shortcut(exe, _lnk_args_str(launch_args))
    lnk = _start_menu_shortcut_path()
    if lnk is not None and lnk.is_file():
        # 主通道: explorer 拉起带 AUMID 的快捷方式。Win11 任务栏身份只在「shell 启动带
        # System.AppUserModel.ID 的快捷方式」时继承; python 直接 Popen 的进程不带身份,
        # --app-user-model-id 开关对 Edge 的 --app 窗口被忽略 (实测), 图标停留在 Edge。
        # explorer 同步返回、真 pid 拿不到, 用 _WINDOW_MARK 反查浏览器主进程再落 .pid。
        try:
            subprocess.Popen(
                ["explorer.exe", str(lnk)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
            pid = _scan_managed_pid()
            if pid:
                _write_pid(pid)
                return True
        except OSError as e:
            logger.debug(f"启动托管窗口失败: {e}")
    # 兜底: 直启浏览器 (窗口照常; 仅 Win11 任务栏图标退回浏览器默认)
    try:
        p = subprocess.Popen(
            [exe, *launch_args],
            cwd=str(BASE_DIR),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
        )
        _write_pid(p.pid)
        return True
    except OSError:
        webbrowser.open(webui_url())
        return False


def _kill_window() -> None:
    """强杀托管浏览器窗口进程树并清除 PID 记录 (用户手开的普通标签页不在范围)。"""
    pid = _managed_pid()
    _clear_pid()
    if not pid:
        return
    if sys.platform == "win32":
        subprocess.Popen(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
        )
        time.sleep(0.3)  # 给 taskkill 一点时间, 避免随后的后端退出竞争
    else:
        try:
            import psutil

            proc = psutil.Process(pid)
            for child in proc.children(recursive=True):
                child.kill()
            proc.kill()
        except Exception:
            pass


# ---------------------------------------------------------------- 托盘动作


def _on_open(_icon=None, _item=None) -> None:
    open_webui()


def _spawn_wait_open() -> None:
    """独立助手进程: 等后端端口就绪后重新打开 webui 窗口 (本进程 exec/退出后仍存活)。"""
    subprocess.Popen(
        [sys.executable, "-m", "utils.tray", "--wait-open"],
        cwd=str(BASE_DIR),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


def _on_restart(icon=None, _item=None) -> None:
    from utils.helpers import restart

    logger.info("托盘: 重启服务...")
    _kill_window()
    _spawn_wait_open()
    if icon:
        try:
            icon.stop()
        except Exception:
            pass
    restart()  # os.execl 原地替换新进程, ANR_SKIP_BROWSER 由其设置, 窗口交给助手进程重开


def _on_close(icon=None, _item=None) -> None:
    from utils.helpers import shutdown_app

    logger.info("托盘: 关闭程序...")
    _kill_window()
    if icon:
        try:
            icon.stop()
        except Exception:
            pass
    shutdown_app()


# ---------------------------------------------------------------- 托盘启动


def start_tray() -> None:
    """创建托盘图标 (pystray)。依赖缺失或平台不支持时静默降级, 不影响服务启动。"""
    try:
        import pystray
        from PIL import Image
    except ImportError:
        logger.debug("未安装 pystray, 跳过系统托盘")
        return
    try:
        img = Image.open(ICON_PATH)
        img.load()
        img = img.convert("RGBA")
        img.thumbnail((32, 32))
        menu = pystray.Menu(
            pystray.MenuItem("打开", _on_open, default=True),  # 双击托盘图标 = 打开
            pystray.MenuItem("重启", _on_restart),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("关闭", _on_close),
        )
        icon = pystray.Icon("Auto-NovelAI-Refactor", img, f"Auto-NovelAI-Refactor v{VERSION}", menu, visible=True)
        icon.run_detached()
        logger.info("系统托盘已启动 (打开 / 重启 / 关闭)")
    except Exception as e:
        logger.warning(f"系统托盘启动失败: {e}")
        logger.opt(exception=True).debug("系统托盘启动失败堆栈:")


def _wait_open_main() -> None:
    """--wait-open 入口: 轮询直至后端可访问, 再打开 webui 窗口 (最长约 60s)。"""
    url = webui_url()
    for _ in range(120):
        time.sleep(0.5)
        try:
            with urlopen(url, timeout=2):
                break
        except Exception:
            continue
    open_webui()


if __name__ == "__main__":  # python -m utils.tray --wait-open
    if "--wait-open" in sys.argv:
        _wait_open_main()
