@echo off
cd /d "%~dp0"
node participant/server.js --sentry
pause
