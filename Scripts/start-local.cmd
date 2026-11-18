@echo off
setlocal
node "%~dp0prepare-local.mjs"
if errorlevel 1 exit /b %errorlevel%
cd /d "%~dp0..\Project"
if not exist "node_modules\tsx\package.json" (
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
call npm.cmd run local:start
exit /b %errorlevel%
