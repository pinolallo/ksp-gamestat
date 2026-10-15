"""
KSP GameStats — Flask backend
REST API for KSP save-file statistics
"""

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import os
import sys
from pathlib import Path

from sfs_parser import SFSParser
from database import DatabaseManager

# ── Env-driven configuration ──────────────────────────────────────────────────
DB_PATH = os.environ.get('KSP_DB_PATH', 'ksp_stats.db')
PORT    = int(os.environ.get('KSP_PORT', '4999'))

# ── PyInstaller: static/ lives next to the binary when frozen ─────────────────
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent

app = Flask(__name__, static_folder=str(BASE_DIR / 'static'))
CORS(app)

db = DatabaseManager(DB_PATH)

# persistent.sfs path — env var > last DB record > empty
def _load_sfs_path() -> str:
    env = os.environ.get('KSP_SFS_PATH', '')
    if env:
        return env
    try:
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        row = conn.execute(
            'SELECT filepath FROM file_metadata ORDER BY last_parsed DESC LIMIT 1'
        ).fetchone()
        conn.close()
        return row[0] if row else ''
    except Exception:
        return ''

SFS_FILE_PATH = _load_sfs_path()


@app.route('/')
def index():
    """Serve the main page"""
    return send_from_directory('static', 'index.html')


@app.route('/api/config', methods=['GET'])
def get_config():
    """Return current configuration"""
    return jsonify({
        'sfs_path': SFS_FILE_PATH,
        'db_path': DB_PATH,
        'configured': bool(SFS_FILE_PATH and os.path.exists(SFS_FILE_PATH))
    })


@app.route('/api/config', methods=['POST'])
def set_config():
    """Set the persistent.sfs file path"""
    global SFS_FILE_PATH
    data = request.json
    
    if not data or 'sfs_path' not in data:
        return jsonify({'error': 'Missing sfs_path parameter'}), 400
    
    path = data['sfs_path']
    
    if not os.path.exists(path):
        return jsonify({'error': f'File not found: {path}'}), 404
    
    SFS_FILE_PATH = path
    return jsonify({
        'success': True,
        'sfs_path': SFS_FILE_PATH
    })


@app.route('/api/parse', methods=['POST'])
def parse_file():
    """
    Parse the persistent.sfs file.
    Supports incremental parsing: skips re-parse when the file hash is unchanged.
    """
    if not SFS_FILE_PATH:
        return jsonify({'error': 'SFS file path not configured'}), 400
    
    if not os.path.exists(SFS_FILE_PATH):
        return jsonify({'error': f'File not found: {SFS_FILE_PATH}'}), 404
    
    try:
        parser = SFSParser(SFS_FILE_PATH)
        
        current_hash = parser.calculate_file_hash()
        
        force_parse = request.json.get('force', False) if request.json else False
        
        if not force_parse and not db.needs_update(SFS_FILE_PATH, current_hash):
            return jsonify({
                'success': True,
                'message': 'File already up to date, no parsing needed',
                'cached': True,
                'file_hash': current_hash
            })
        
        print(f"Parsing file: {SFS_FILE_PATH}")
        kerbals, contracts, contract_history, file_hash = parser.parse_all()

        print("Saving to database...")
        db.save_kerbals(kerbals)
        db.save_contracts(contracts)
        db.save_contract_history(contract_history)
        db.update_file_metadata(SFS_FILE_PATH, file_hash)

        stats = {
            'kerbals_parsed': len(kerbals),
            'contracts_parsed': len(contracts),
            'file_hash': file_hash
        }
        
        print(f"Parsing completed: {stats}")
        
        return jsonify({
            'success': True,
            'message': 'File parsed successfully',
            'cached': False,
            'stats': stats
        })
        
    except Exception as e:
        print(f"Error parsing file: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/kerbals', methods=['GET'])
def get_kerbals():
    """Return all kerbals (tourists excluded)"""
    try:
        kerbals = db.get_all_kerbals()
        return jsonify({
            'success': True,
            'kerbals': kerbals,
            'count': len(kerbals)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/kerbals/<name>', methods=['GET'])
def get_kerbal(name):
    """Return details for a single kerbal"""
    try:
        kerbal = db.get_kerbal_by_name(name)
        if kerbal is None:
            return jsonify({'error': 'Kerbal not found'}), 404
        
        return jsonify({
            'success': True,
            'kerbal': kerbal
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/contracts', methods=['GET'])
def get_contracts():
    """Return all contracts aggregated by type"""
    try:
        contracts = db.get_all_contracts()
        return jsonify({
            'success': True,
            'contracts': contracts,
            'count': len(contracts)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/summary', methods=['GET'])
def get_summary():
    """Return top-level summary statistics"""
    try:
        summary = db.get_summary_stats()
        return jsonify({
            'success': True,
            'summary': summary
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'ok',
        'database': 'connected' if db.conn else 'disconnected'
    })


@app.route('/api/contracts/progress', methods=['GET'])
def get_contract_progress():
    """Returns progression data for the contracts dashboard.
    Optional ?type= query param filters to a single contract type.
    """
    try:
        contract_type = request.args.get('type') or None
        return jsonify({'success': True, 'data': db.get_contract_progress(contract_type)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/system-info', methods=['GET'])
def get_system_info():
    """Return system info for the Admin panel"""
    try:
        return jsonify({'success': True, 'info': db.get_system_info()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("=" * 60)
    print("KSP GameStats Server")
    print("=" * 60)
    print(f"Database: {DB_PATH}")
    
    if SFS_FILE_PATH:
        print(f"SFS File: {SFS_FILE_PATH}")
        if os.path.exists(SFS_FILE_PATH):
            print("✓ File found")
        else:
            print("✗ File not found!")
    else:
        print("⚠ SFS File not configured")
        print("  Use the web interface to configure the path")

    print("=" * 60)
    print("\nServer listening on http://localhost:4999")
    print("Press CTRL+C to stop\n")
    
    app.run(debug=not getattr(sys, 'frozen', False), host='127.0.0.1', port=PORT)
