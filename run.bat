@echo off
chcp 65001 >nul

rem ---- 自跳转只走一跳: 首次进入按 hide_terminal 二选一转起 (旧版先最大化再隐藏双跳, 多弹一个窗口 + 固定 ping 等待 1 秒)
if not "%~1"=="" goto begin
cd /d "%~dp0"
set "HIDE="
for /f "tokens=2 delims=:{," %%A in ('findstr /i /c:"hide_terminal" settings.json 2^>nul') do set "HIDE=%%A"
if defined HIDE set "HIDE=%HIDE: =%"
if /i not "%HIDE%"=="true" (
    start /max "" "%~f0" max
    exit
)
echo [ANR] 隐藏终端启动 (hide_terminal): 服务转入后台, 本窗口即将关闭...
powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -ArgumentList 'hidden' -WorkingDirectory '%~dp0' -WindowStyle Hidden -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 (
    echo [ANR] 警告: 隐藏启动失败, 改为普通窗口启动...
    goto begin
)
rem Start-Process 同步返回、后台实例已独立运行, 下面两秒只是让提示语停留片刻方便读完 (按任意键可提前关)
timeout /t 2 >nul || ping -n 3 127.0.0.1 >nul
exit

:begin

title Auto-NovelAI-Refactor
cd /d "%~dp0"

rem ---- 把内置 Git 加入 PATH, 供 gitpython 使用 (整合包) ----
if exist "Git\cmd\git.exe" (
    set "PATH=%~dp0Git\cmd;%~dp0Git\bin;%~dp0Git\usr\bin;%PATH%"
    set "GIT_PYTHON_GIT_EXECUTABLE=%~dp0Git\cmd\git.exe"
    rem 便携 Git 证书路径: 指向包内证书, 避免依赖 C:\Program Files\Git
    if exist "%~dp0Git\mingw64\etc\ssl\certs\ca-bundle.crt" set "GIT_SSL_CAINFO=%~dp0Git\mingw64\etc\ssl\certs\ca-bundle.crt"
)

rem ---- 查找 Python: 目录里有 venv / Python 文件夹就用, 两者都有时优先 venv ----
set "PYTHON="
if exist "venv\Scripts\python.exe" call :try_python "venv\Scripts\python.exe" PYTHON
if not defined PYTHON if exist "Python\python.exe" call :try_python "Python\python.exe" PYTHON
if defined PYTHON goto :got_python

rem ---- 都没有: 用系统安装的 Python (3.10+) 创建虚拟环境 venv ----
set "SYSTEM_PY="
for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined SYSTEM_PY call :try_python "%%P" SYSTEM_PY
)
if not defined SYSTEM_PY (
    echo [ANR] 错误: 目录中没有 venv / Python 文件夹, 也未找到系统安装的 Python 3.10+。
    echo [ANR] 请先安装 Python（勾选 Add to PATH）后重试。
    pause
    exit /b 1
)
echo [ANR] 未找到 venv / Python 文件夹, 正在用系统 Python 创建虚拟环境: %SYSTEM_PY%
"%SYSTEM_PY%" -X utf8 -m venv venv
if not exist "venv\Scripts\python.exe" (
    echo [ANR] 错误: 创建虚拟环境失败, 请检查系统 Python 是否完整。
    pause
    exit /b 1
)
set "PYTHON=venv\Scripts\python.exe"

:got_python
echo [ANR] 使用解释器: %PYTHON%

rem ---- 关键依赖检查 (find_spec 只查包元数据不真正加载, 旧版全量 import 每次白付 0.7~3 秒):
rem      极端情况"半安装"包被误判就绪时, main.py 导入即报错, 再跑一次会触发下面的安装 ----
"%PYTHON%" -X utf8 -c "import importlib.util as u, sys; sys.exit(1 if any(u.find_spec(m) is None for m in ('fastapi','uvicorn','requests','PIL','loguru','ujson','psutil','pystray')) else 0)" >nul 2>nul
if errorlevel 1 (
    echo [ANR] 正在检查/安装依赖, 首次运行可能需要几分钟...
    "%PYTHON%" -X utf8 -s -m pip install -r requirements.txt -q --disable-pip-version-check
    if errorlevel 1 (
        echo [ANR] 警告: 依赖安装失败, 尝试继续启动...
    ) else (
        echo [ANR] 依赖安装完成
    )
) else (
    echo [ANR] 依赖已就绪
)

echo [ANR] 正在启动 Auto-NovelAI-Refactor ...
"%PYTHON%" -X utf8 main.py

echo.
echo [ANR] 进程已结束。
rem hidden instance has nobody to press a key - a plain pause there would hang the cmd forever
if /i "%~1"=="hidden" exit /b 0
pause
exit /b 0

rem ---- 子过程: 验证候选解释器版本 (需 3.10+, 自动排除 Microsoft Store 占位符) ----
:try_python
"%~1" -X utf8 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "%~2=%~1"
exit /b
