@echo off
echo ==================================
echo   KSP GameStats - Mission Control
echo ==================================
echo.

REM Verifica Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python non trovato. Installalo prima di continuare.
    pause
    exit /b 1
)

echo [OK] Python trovato

REM Verifica e installa dipendenze
if not exist "venv\" (
    echo [INFO] Creazione ambiente virtuale...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo [INFO] Installazione dipendenze...
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate.bat
)

echo [OK] Dipendenze installate
echo.

REM Configura path (opzionale)
if "%KSP_SFS_PATH%"=="" (
    echo [INFO] Tip: Puoi configurare il path del file .sfs con:
    echo    set KSP_SFS_PATH=C:\path\to\persistent.sfs
    echo.
)

REM Avvia server
echo [INFO] Avvio server...
echo.
python app.py

pause
