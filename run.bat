@echo off

if exist "Python" (
    set PYTHON=Python\python.exe
) else (
    python -m venv venv
    set PYTHON=venv\Scripts\python.exe
)

%PYTHON% -s -m pip install -r requirements.txt

%PYTHON% .\main.py

pause
