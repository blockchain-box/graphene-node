@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS, then open Join Graphene again.
  pause
  exit /b 1
)
node scripts/join-network.js
pause
