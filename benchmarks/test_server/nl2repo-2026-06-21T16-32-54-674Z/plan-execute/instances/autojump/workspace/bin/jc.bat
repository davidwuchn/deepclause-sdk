@echo off
REM jc.bat - Jump to child directory (Windows)
REM Usage: jc <query>

setlocal

set AUTOJUMP_DIR=%~dp0

set AUTOJUMP_CMD=%AUTOJUMP_DIR:autojump=%\autojump.bat

for /f "usebackq tokens=*" %%i in (`%AUTOJUMP_CMD% --children %*`) do (
    set TARGET=%%i
)

if defined TARGET (
    cd /d "%TARGET%"
) else (
    %AUTOJUMP_CMD% --children %*
    exit /b %ERRORLEVEL%
)
