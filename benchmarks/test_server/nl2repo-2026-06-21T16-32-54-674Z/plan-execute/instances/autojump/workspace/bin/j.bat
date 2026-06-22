@echo off
REM j.bat - Jump to directory (Windows)
REM Usage: j <query>

setlocal

set AUTOJUMP_DIR=%~dp0
if not exist "%AUTOJUMP_DIR:autojump=%\autojump.bat" (
    set AUTOJUMP_DIR=%~dp0
)

set AUTOJUMP_CMD=%AUTOJUMP_DIR:autojump=%\autojump.bat

for /f "usebackq tokens=*" %%i in (`%AUTOJUMP_CMD% %*`) do (
    set TARGET=%%i
)

if defined TARGET (
    cd /d "%TARGET%"
) else (
    %AUTOJUMP_CMD% %*
    exit /b %ERRORLEVEL%
)
