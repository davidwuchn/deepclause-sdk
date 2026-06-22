@echo off
REM autojump.bat - Windows wrapper for autojump
REM This script locates and invokes the autojump Python module

setlocal EnableDelayedExpansion

REM Try to find Python
set PYTHON_CMD=
if defined PYTHONDONTWRITEBYTEFILE (
    REM already in a Python-aware environment
)

where python3 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set PYTHON_CMD=python3
) else (
    where python >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        set PYTHON_CMD=python
    ) else (
        echo autojump: error - Python not found. Please install Python 2.6+ or 3.3+.
        exit /b 1
    )
)

REM Locate the autojump module
set AUTOJUMP_DIR=%~dp0

REM Try to find autojump.py in the same directory as this batch file
if exist "%AUTOJUMP_DIR:autojump=%\autojump.py" goto FOUND_PY

REM Try using -m to invoke the module
%PYTHON_CMD% -m bin.autojump %*
exit /b %ERRORLEVEL%

:FOUND_PY
%PYTHON_CMD% "%AUTOJUMP_DIR:autojump=%\autojump.py" %*
exit /b %ERRORLEVEL%
