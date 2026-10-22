@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   NEFERDIDI - TWO YEARS TOGETHER
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 18 or newer first.
  echo https://nodejs.org/
  pause
  exit /b 1
)
if "%ADMIN_PASSWORD%"=="" (
  set /p ADMIN_PASSWORD=Create a password for the admin dashboard: 
)
if "%ADMIN_PASSWORD%"=="" (
  echo An admin password is required.
  pause
  exit /b 1
)
set PORT=3000
echo.
echo Site: http://localhost:3000
echo Admin dashboard: http://localhost:3000/admin
echo Keep this window open while testing the website.
echo.
start "" http://localhost:3000
node server.js
pause
