@echo off
title Manchester Jobs Directory
cd /d "%~dp0"
echo.
echo   Starting Manchester Jobs Directory...
echo   Opening http://localhost:5173 in your browser.
echo.
start "" http://localhost:5173
node server.mjs
echo.
echo   Server stopped. Press any key to close.
pause >nul
