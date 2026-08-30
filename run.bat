@echo off
if "%~1" == "max" goto begin
if "%~1" == "hidden" goto begin
start /max "" "%~f0" max & exit

:begin

chcp 65001 >nul
title Auto-NovelAI-Refactor
cd /d "%~dp0"

rem ---- 读取配置: hide_terminal (通过 run.bat 启动时隐藏终端窗口, 兼容 Windows Terminal) ----
set "HIDE="
for /f "tokens=2 delims=:{," %%A in ('findstr /i /c:"hide_terminal" settings.json 2^>nul') do set "HIDE=%%A"
if defined HIDE set "HIDE=%HIDE: =%"
if /i "%HIDE%"=="true" if /i not "%~1"=="hidden" (
    echo [ANR] 检测到隐藏终端启动: 服务转入后台运行, 当前窗口即将关闭, 请耐心等待...
    powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -ArgumentList 'hidden' -WorkingDirectory '%~dp0' -WindowStyle Hidden -ErrorAction Stop } catch { exit 1 }"
    if errorlevel 1 (
        echo [ANR] 警告: 隐藏启动失败, 改为普通窗口启动...
    ) else (
        ping -n 2 127.0.0.1 >nul
        rem 用 exit (不带 /b) 直接结束宿主 cmd, 终端窗口随之关闭
        exit
    )
)

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
    echo [ANR] 请先安装 Python (勾选 Add to PATH) 后重试。
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

rem ---- 缺少关键依赖时自动安装: 克隆仓库后直接运行 run.bat 即可 ----
"%PYTHON%" -X utf8 -c "import fastapi, uvicorn, requests, PIL, loguru, ujson, psutil" >nul 2>nul
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
pause
exit /b 0

rem ---- 子过程: 验证候选解释器版本 (需 3.10+, 自动排除 Microsoft Store 占位符) ----
:try_python
"%~1" -X utf8 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "%~2=%~1"
exit /b
