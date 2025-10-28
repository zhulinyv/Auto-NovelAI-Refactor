@echo off

if exist "Git" (
    .\Git\cmd\git.exe config --global --add safe.directory '*'
    .\Git\cmd\git.exe pull
) else (
    git config --global --add safe.directory '*'
    git pull
)

pause
