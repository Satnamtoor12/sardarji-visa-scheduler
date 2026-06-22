@echo off
setlocal
echo ============================================
echo  SardarJi Native Host - Windows Installer
echo ============================================
echo.
echo The extension uses a fixed ID, so no copy-paste is needed.
echo This just registers the native host with Chrome/Edge.
echo.

set "MANIFEST=%~dp0com.sardarji.visa_helper.json"

echo Registering native host...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sardarji.visa_helper" /ve /t REG_SZ /d "%MANIFEST%" /f
if errorlevel 1 (
  echo.
  echo ERROR: Registry write failed.
  pause
  exit /b 1
)

rem Also register for Microsoft Edge (harmless if Edge isn't installed)
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sardarji.visa_helper" /ve /t REG_SZ /d "%MANIFEST%" /f >nul 2>&1

echo.
echo ============================================
echo  Done! Native host registered.
echo ============================================
echo.
echo Last steps:
echo   1. Make sure Python 3 is installed:  python --version
echo   2. Go to chrome://extensions and click RELOAD on the extension.
echo.
pause
endlocal
