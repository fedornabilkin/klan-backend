@echo off
setlocal
cd /d "%~dp0"
call npm.cmd run local:start
exit /b %errorlevel%
