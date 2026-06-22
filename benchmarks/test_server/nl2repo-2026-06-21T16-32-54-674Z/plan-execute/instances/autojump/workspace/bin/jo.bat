@echo off
REM jo.bat - Open directory in file manager (Windows)
REM Usage: jo <query>

setlocal

set AUTOJUMP_DIR=%~dp0

set AUTOJUMP_CMD=%AUTOJUMP_DIR:autojump=%\autojump.bat

for /f "usebackq tokens=*" %%i in (`%AUTOJUMP_CMD% %*`) do (
    set TARGET=%%i
)

if defined TARGET (
    start explorer "%TARGET%"
) else (
    %AUTOJUMP_CMD% %*
    exit /b %ERRORLEVEL%
)
