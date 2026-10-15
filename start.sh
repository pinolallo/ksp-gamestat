#!/bin/bash

echo "=================================="
echo "  KSP GameStats - Mission Control"
echo "=================================="
echo ""

# Verifica Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 non trovato. Installalo prima di continuare."
    exit 1
fi

echo "✓ Python 3 trovato"

# Verifica e installa dipendenze
if [ ! -d "venv" ]; then
    echo "📦 Creazione ambiente virtuale..."
    python3 -m venv venv
    source venv/bin/activate
    echo "📦 Installazione dipendenze..."
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

echo "✓ Dipendenze installate"
echo ""

# Configura path (opzionale)
if [ -z "$KSP_SFS_PATH" ]; then
    echo "💡 Tip: Puoi configurare il path del file .sfs con:"
    echo "   export KSP_SFS_PATH='/path/to/persistent.sfs'"
    echo ""
fi

# Avvia server
echo "🚀 Avvio server..."
echo ""
python app.py
