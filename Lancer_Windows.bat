@echo off
setlocal
cd /d "%~dp0"
echo === Table JDR - serveur Windows ===
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 serveur_mac.py
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        python serveur_mac.py
    ) else (
        echo Python 3 est necessaire. Installez-le depuis https://www.python.org/downloads/
        echo Cochez Add Python to PATH pendant l'installation.
    )
)
echo.
pause
