@echo off
REM agent-thinking-live launcher - runs main.py with the shared env E:\Project\.venv.
REM Usage:  start.bat            start the observation deck
REM         start.bat test       self-check (db fields + static assets + port)

setlocal
cd /d "%~dp0"
set "PYTHONPATH="

if not defined GLOBAL_PY set "GLOBAL_PY=E:\Project\.venv\Scripts\python.exe"
if defined ATL_PYTHON set "GLOBAL_PY=%ATL_PYTHON%"
if not exist "%GLOBAL_PY%" (
  echo [agent-thinking-live] shared env not found: %GLOBAL_PY%
  echo.
  echo Create it once:
  echo   cd /d E:\Project
  echo   uv venv .venv -p 3.12
  exit /b 2
)

"%GLOBAL_PY%" main.py %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
