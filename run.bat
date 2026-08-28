@echo off
if "%1" == "max" goto begin
start /max "" "%~f0" max & exit

:begin

chcp 65001 >nul
title Auto-NovelAI-WebUI
cd /d "%~dp0"

set "PYTHON="
if exist "Python\python.exe" set "PYTHON=Python\python.exe"
if not defined PYTHON if exist "venv\Scripts\python.exe" set "PYTHON=venv\Scripts\python.exe"

if not defined PYTHON (
    echo [ANR] 正在创建虚拟环境...
    python -m venv venv
    if errorlevel 1 (
        echo [ANR] 错误: 未找到可用的 Python，请安装 Python 后重试。
        pause
        exit /b 1
    )
    set "PYTHON=venv\Scripts\python.exe"
)

echo [ANR] 使用解释器: %PYTHON%
echo [ANR] 正在检查依赖...
"%PYTHON%" -X utf8 -s -m pip install -r requirements.txt -q --disable-pip-version-check
if errorlevel 1 (
    echo [ANR] 警告: 依赖安装失败，尝试继续启动...
)

echo [ANR] 正在启动 Auto-NovelAI-WebUI ...
"%PYTHON%" -X utf8 main.py

echo.
echo [ANR] 进程已结束。

pause
