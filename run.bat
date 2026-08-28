@echo off
if "%1" == "max" goto begin
start /max "" "%~f0" max & exit

:begin

chcp 65001 >nul
title Auto-NovelAI-WebUI 整合包
cd /d "%~dp0"

rem ---- 优先使用整合包自带的 Python ----
set "PYTHON="
if exist "Python\python.exe" set "PYTHON=Python\python.exe"
if not defined PYTHON if exist "venv\Scripts\python.exe" set "PYTHON=venv\Scripts\python.exe"

rem ---- 把内置 Git 加入 PATH, 供 gitpython 使用 ----
if exist "Git\cmd\git.exe" (
    set "PATH=%~dp0Git\cmd;%~dp0Git\bin;%~dp0Git\usr\bin;%PATH%"
    set "GIT_PYTHON_GIT_EXECUTABLE=%~dp0Git\cmd\git.exe"
    rem 便携 Git 证书路径: 指向包内证书, 避免依赖 C:\Program Files\Git
    if exist "%~dp0Git\mingw64\etc\ssl\certs\ca-bundle.crt" set "GIT_SSL_CAINFO=%~dp0Git\mingw64\etc\ssl\certs\ca-bundle.crt"
)

if not defined PYTHON (
    echo [ANR] 错误: 未找到可用的 Python, 请安装 Python 后重试。
    pause
    exit /b 1
)

echo [ANR] 使用解释器: %PYTHON%

rem ---- 首次运行（或依赖更新）时安装依赖 ----
if /i "%PYTHON%"=="Python\python.exe" if exist "Python\.deps_ok" (
    echo [ANR] 依赖已就绪
) else (
    echo [ANR] 正在检查/安装依赖，首次运行可能需要几分钟...
    "%PYTHON%" -X utf8 -s -m pip install -r requirements.txt -q --disable-pip-version-check
    if errorlevel 1 (
        echo [ANR] 警告: 依赖安装失败, 尝试继续启动...
    ) else (
        if /i "%PYTHON%"=="Python\python.exe" echo ok> "Python\.deps_ok"
    )
)

echo [ANR] 正在启动 Auto-NovelAI-WebUI ...
"%PYTHON%" -X utf8 main.py

echo.
echo [ANR] 进程已结束。

pause
