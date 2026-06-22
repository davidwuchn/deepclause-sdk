@echo off
REM jco.bat - Jump to child directory and open in file manager (Windows)
REM Usage: jco <query>

setlocal

set AUTOJUMP_DIR=%~dp0

set AUTOJUMP_CMD=%AUTOJUMP_DIR:autojump=%\autojump.bat

for /f "usebackq tokens=*" %%i in (`%AUTOJUMP_CMD% --children %*`) do (
    set TARGET=%%i
)

if defined TARGET (
    cd /d "%TARGET%"
    start explorer "%TARGET%"
) else (
    %AUTOJUMP_CMD% --children %*
    exit /b %ERRORLEVEL%
)
