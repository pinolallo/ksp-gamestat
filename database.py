"""
SQLite database manager for KSP GameStats.
Handles persistence and retrieval of kerbal, contract, and parse-history data.
"""

import sqlite3
import json
import threading
from typing import Dict, List, Optional, Tuple
from datetime import datetime
from sfs_parser import KerbalStats, ContractStats, ContractRecord


class DatabaseManager:
    """SQLite database manager for KSP statistics"""

    def __init__(self, db_path: str = 'ksp_stats.db'):
        self.db_path = db_path
        self._local = threading.local()
        self.init_database()

    @property
    def conn(self):
        if not getattr(self._local, 'conn', None):
            self._local.conn = sqlite3.connect(self.db_path)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def connect(self):
        _ = self.conn  # trigger lazy init

    def close(self):
        if getattr(self._local, 'conn', None):
            self._local.conn.close()
            self._local.conn = None
    
    def init_database(self):
        """Inizializza lo schema del database"""
        self.connect()
        cursor = self.conn.cursor()
        
        # Tabella per tracking del file
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS file_metadata (
                id INTEGER PRIMARY KEY,
                filepath TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                last_parsed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                parse_count INTEGER DEFAULT 1
            )
        ''')
        
        # Tabella kerbals
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS kerbals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                flights INTEGER DEFAULT 0,
                is_tourist BOOLEAN DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Tabella locations visitate dai kerbals
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS kerbal_locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kerbal_id INTEGER NOT NULL,
                location TEXT NOT NULL,
                visit_count INTEGER DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (kerbal_id) REFERENCES kerbals(id),
                UNIQUE(kerbal_id, location)
            )
        ''')
        
        # Tabella contratti
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS contracts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contract_type TEXT NOT NULL UNIQUE,
                count INTEGER DEFAULT 0,
                total_funds REAL DEFAULT 0.0,
                passengers INTEGER DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        # Migration: add passengers column if missing
        try:
            cursor.execute('ALTER TABLE contracts ADD COLUMN passengers INTEGER DEFAULT 0')
        except Exception:
            pass

        # Migration: new kerbal fields
        for col, typedef in [
            ('trait',             'TEXT DEFAULT ""'),
            ('state',             'TEXT DEFAULT "Available"'),
            ('experience_level',  'INTEGER DEFAULT 0'),
            ('experience',        'REAL DEFAULT 0.0'),
            ('courage',           'REAL DEFAULT 0.0'),
            ('stupidity',         'REAL DEFAULT 0.0'),
            ('gender',            'TEXT DEFAULT "Male"'),
            ('veteran',           'BOOLEAN DEFAULT 0'),
            ('is_badass',         'BOOLEAN DEFAULT 0'),
            ('current_location',  'TEXT DEFAULT ""'),
            ('current_vessel',    'TEXT DEFAULT ""'),
            ('hired_ut',          'REAL DEFAULT 0'),
        ]:
            try:
                cursor.execute(f'ALTER TABLE kerbals ADD COLUMN {col} {typedef}')
            except Exception:
                pass
        
        # Individual contract records (for progression timeline)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS contracts_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                contract_type TEXT NOT NULL,
                prestige      INTEGER DEFAULT 0,
                body_name     TEXT DEFAULT '',
                funds         REAL DEFAULT 0.0,
                passengers    INTEGER DEFAULT 0,
                date_ut       REAL NOT NULL,
                ksp_year      INTEGER NOT NULL,
                ksp_day       INTEGER NOT NULL
            )
        ''')
        try:
            cursor.execute('ALTER TABLE contracts_history ADD COLUMN passengers INTEGER DEFAULT 0')
        except Exception:
            pass

        # Migration: game_ut on file_metadata
        try:
            cursor.execute('ALTER TABLE file_metadata ADD COLUMN game_ut REAL DEFAULT 0')
        except Exception:
            pass

        # Indici per performance
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_kerbal_name ON kerbals(name)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_kerbal_locations ON kerbal_locations(kerbal_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_contract_type ON contracts(contract_type)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_ch_date ON contracts_history(date_ut)')
        
        self.conn.commit()
    
    def needs_update(self, filepath: str, current_hash: str) -> bool:
        """Return True if the file has changed since the last parse"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT file_hash FROM file_metadata 
            WHERE filepath = ? 
            ORDER BY last_parsed DESC 
            LIMIT 1
        ''', (filepath,))
        
        row = cursor.fetchone()
        if row is None:
            return True
        
        return row[0] != current_hash
    
    def update_file_metadata(self, filepath: str, file_hash: str):
        """Aggiorna i metadata del file parsato"""
        cursor = self.conn.cursor()
        
        # Check if a record already exists for this file
        cursor.execute('SELECT id, parse_count FROM file_metadata WHERE filepath = ?', (filepath,))
        row = cursor.fetchone()
        
        if row:
            cursor.execute('''
                UPDATE file_metadata 
                SET file_hash = ?, last_parsed = CURRENT_TIMESTAMP, parse_count = parse_count + 1
                WHERE filepath = ?
            ''', (file_hash, filepath))
        else:
            cursor.execute('''
                INSERT INTO file_metadata (filepath, file_hash) 
                VALUES (?, ?)
            ''', (filepath, file_hash))
        
        self.conn.commit()
    
    def save_kerbals(self, kerbals: Dict[str, KerbalStats]):
        """Save or update kerbal statistics (full replace on each parse)"""
        cursor = self.conn.cursor()

        # Remove stale entries not in current parse (handles tourist cleanup etc.)
        if kerbals:
            placeholders = ','.join('?' * len(kerbals))
            cursor.execute(
                f'DELETE FROM kerbals WHERE name NOT IN ({placeholders})',
                list(kerbals.keys())
            )

        for name, stats in kerbals.items():
            # Insert or update kerbal
            cursor.execute('''
                INSERT INTO kerbals (
                    name, flights, is_tourist,
                    trait, state, experience_level, experience,
                    courage, stupidity, gender, veteran, is_badass,
                    current_location, current_vessel, hired_ut,
                    last_updated
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(name) DO UPDATE SET
                    flights = excluded.flights,
                    is_tourist = excluded.is_tourist,
                    trait = excluded.trait,
                    state = excluded.state,
                    experience_level = excluded.experience_level,
                    experience = excluded.experience,
                    courage = excluded.courage,
                    stupidity = excluded.stupidity,
                    gender = excluded.gender,
                    veteran = excluded.veteran,
                    is_badass = excluded.is_badass,
                    current_location = excluded.current_location,
                    current_vessel = excluded.current_vessel,
                    hired_ut = excluded.hired_ut,
                    last_updated = CURRENT_TIMESTAMP
            ''', (name, stats.flights, stats.is_tourist,
                  stats.trait, stats.state, stats.experience_level, stats.experience,
                  stats.courage, stats.stupidity, stats.gender,
                  stats.veteran, stats.is_badass,
                  stats.current_location, stats.current_vessel,
                  stats.hired_ut))
            
            # Get the kerbal's row ID
            cursor.execute('SELECT id FROM kerbals WHERE name = ?', (name,))
            kerbal_id = cursor.fetchone()[0]
            
            # Save visit locations
            for location, count in stats.locations.items():
                cursor.execute('''
                    INSERT INTO kerbal_locations (kerbal_id, location, visit_count, last_updated)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(kerbal_id, location) DO UPDATE SET
                        visit_count = excluded.visit_count,
                        last_updated = CURRENT_TIMESTAMP
                ''', (kerbal_id, location, count))
        
        self.conn.commit()
    
    def save_contracts(self, contracts: Dict[str, ContractStats]):
        """Save or update contract statistics"""
        cursor = self.conn.cursor()
        
        for contract_type, stats in contracts.items():
            cursor.execute('''
                INSERT INTO contracts (contract_type, count, total_funds, passengers, last_updated)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(contract_type) DO UPDATE SET
                    count = excluded.count,
                    total_funds = excluded.total_funds,
                    passengers = excluded.passengers,
                    last_updated = CURRENT_TIMESTAMP
            ''', (contract_type, stats.count, stats.total_funds, stats.passengers))
        
        self.conn.commit()
    
    def save_contract_history(self, records: List[ContractRecord]):
        """Full replace of contracts_history on every parse."""
        cursor = self.conn.cursor()
        cursor.execute('DELETE FROM contracts_history')
        cursor.executemany(
            'INSERT INTO contracts_history '
            '(contract_type, prestige, body_name, funds, passengers, date_ut, ksp_year, ksp_day) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [(r.contract_type, r.prestige, r.body_name, r.funds, r.passengers,
              r.date_ut, r.ksp_year, r.ksp_day) for r in records]
        )
        self.conn.commit()

    def get_contract_progress(self, contract_type: str = None) -> dict:
        """Returns aggregated progression data for the dashboard.
        If contract_type is given, filters to that type only.
        TourismContract uses passengers instead of funds as the main metric.
        """
        cursor = self.conn.cursor()

        if contract_type:
            rows = cursor.execute(
                'SELECT contract_type, prestige, body_name, funds, passengers, date_ut, ksp_year, ksp_day '
                'FROM contracts_history WHERE contract_type = ? ORDER BY date_ut ASC',
                (contract_type,)
            ).fetchall()
        else:
            rows = cursor.execute(
                'SELECT contract_type, prestige, body_name, funds, passengers, date_ut, ksp_year, ksp_day '
                'FROM contracts_history ORDER BY date_ut ASC'
            ).fetchall()

        if not rows:
            return {'by_period': [], 'by_prestige': {}, 'by_body': [], 'summary': {}, 'metric': 'funds'}

        is_tourism = (contract_type == 'TourismContract')

        # ── prestige breakdown ──────────────────────────────────────────
        prestige_labels = {0: 'trivial', 1: 'significant', 2: 'exceptional'}
        by_prestige = {'trivial': {'count': 0, 'funds': 0.0},
                       'significant': {'count': 0, 'funds': 0.0},
                       'exceptional': {'count': 0, 'funds': 0.0}}
        for r in rows:
            key = prestige_labels.get(r[1], 'trivial')
            by_prestige[key]['count'] += 1
            by_prestige[key]['funds'] += r[3]

        # ── body breakdown (top 10 by count) ────────────────────────────
        body_counts: dict = {}
        for r in rows:
            b = r[2] or 'Unknown'
            if b not in body_counts:
                body_counts[b] = {'count': 0, 'funds': 0.0}
            body_counts[b]['count'] += 1
            body_counts[b]['funds'] += r[3]
        body_counts.pop('Unknown', None)
        by_body = sorted(body_counts.items(), key=lambda x: -x[1]['count'])[:10]
        by_body = [{'body': b, 'count': v['count'], 'funds': v['funds']} for b, v in by_body]

        # ── time bins (25 KSP days each) ─────────────────────────────────
        BIN_DAYS = 25
        from sfs_parser import KSP_DAY_SECONDS, KSP_YEAR_SECONDS
        ut_min = rows[0][5]
        ut_max = rows[-1][5]
        bin_size_ut = BIN_DAYS * KSP_DAY_SECONDS

        def ut_label(ut):
            year = int(ut / KSP_YEAR_SECONDS) + 1
            day  = int((ut % KSP_YEAR_SECONDS) / KSP_DAY_SECONDS) + 1
            return f'Y{year}D{day}'

        import math
        n_bins = max(2, math.ceil((ut_max - ut_min) / bin_size_ut) + 1)
        bins: list = [{'label': '', 'start': 0, 'count': 0, 'funds': 0.0, 'passengers': 0} for _ in range(n_bins)]
        for i in range(n_bins):
            bins[i]['start'] = ut_min + i * bin_size_ut
            bins[i]['label'] = ut_label(bins[i]['start'])

        for r in rows:
            idx = int((r[5] - ut_min) / bin_size_ut)
            idx = min(idx, n_bins - 1)
            bins[idx]['count']      += 1
            bins[idx]['funds']      += r[3]
            bins[idx]['passengers'] += r[4]

        cum_funds = 0.0
        cum_pax   = 0
        for b in bins:
            cum_funds += b['funds']
            cum_pax   += b['passengers']
            b['cumulative_funds']      = cum_funds
            b['cumulative_passengers'] = cum_pax

        total_funds      = sum(r[3] for r in rows)
        total_passengers = sum(r[4] for r in rows)

        return {
            'by_period':   bins,
            'by_prestige': by_prestige,
            'by_body':     by_body,
            'metric':      'passengers' if is_tourism else 'funds',
            'summary': {
                'total_count':      len(rows),
                'total_funds':      total_funds,
                'total_passengers': total_passengers,
                'start_label':      ut_label(ut_min),
                'end_label':        ut_label(ut_max),
            }
        }

    def get_all_kerbals(self) -> List[Dict]:
        """Recupera tutti i Kerbals con le loro statistiche"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT *
            FROM kerbals
            WHERE is_tourist = 0
            ORDER BY experience DESC, name ASC
        ''')

        kerbals = []
        for row in cursor.fetchall():
            kerbal = {
                'id': row['id'],
                'name': row['name'],
                'flights': row['flights'],
                'is_tourist': bool(row['is_tourist']),
                'trait': row['trait'] or '',
                'state': row['state'] or 'Available',
                'experience_level': row['experience_level'] or 0,
                'experience': row['experience'] or 0.0,
                'courage': row['courage'] or 0.0,
                'stupidity': row['stupidity'] or 0.0,
                'gender': row['gender'] or 'Male',
                'veteran': bool(row['veteran']),
                'is_badass': bool(row['is_badass']),
                'current_location': row['current_location'] or '',
                'current_vessel': row['current_vessel'] or '',
                'hired_ut': row['hired_ut'] or 0.0,
                'last_updated': row['last_updated'],
                'locations': []
            }

            # Fetch visit locations
            cursor.execute('''
                SELECT location, visit_count
                FROM kerbal_locations
                WHERE kerbal_id = ?
                ORDER BY visit_count DESC, location ASC
            ''', (kerbal['id'],))

            kerbal['locations'] = [
                {'location': r[0], 'count': r[1]}
                for r in cursor.fetchall()
            ]

            kerbals.append(kerbal)

        return kerbals
    
    def get_kerbal_by_name(self, name: str) -> Optional[Dict]:
        """Recupera un singolo Kerbal per nome"""
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM kerbals WHERE name = ?', (name,))

        row = cursor.fetchone()
        if not row:
            return None

        kerbal = {
            'id': row['id'],
            'name': row['name'],
            'flights': row['flights'],
            'is_tourist': bool(row['is_tourist']),
            'trait': row['trait'] or '',
            'state': row['state'] or 'Available',
            'experience_level': row['experience_level'] or 0,
            'experience': row['experience'] or 0.0,
            'courage': row['courage'] or 0.0,
            'stupidity': row['stupidity'] or 0.0,
            'gender': row['gender'] or 'Male',
            'veteran': bool(row['veteran']),
            'is_badass': bool(row['is_badass']),
            'current_location': row['current_location'] or '',
            'current_vessel': row['current_vessel'] or '',
            'hired_ut': row['hired_ut'] or 0.0,
            'last_updated': row['last_updated'],
            'locations': []
        }

        cursor.execute('''
            SELECT location, visit_count
            FROM kerbal_locations
            WHERE kerbal_id = ?
            ORDER BY visit_count DESC
        ''', (kerbal['id'],))

        kerbal['locations'] = [
            {'location': r[0], 'count': r[1]}
            for r in cursor.fetchall()
        ]

        return kerbal
    
    def get_all_contracts(self) -> List[Dict]:
        """Recupera tutti i contratti con le loro statistiche"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT contract_type, count, total_funds, passengers, last_updated
            FROM contracts
            ORDER BY total_funds DESC, count DESC
        ''')

        contracts = []
        for row in cursor.fetchall():
            contracts.append({
                'type': row[0],
                'count': row[1],
                'total_funds': row[2],
                'passengers': row[3],
                'last_updated': row[4]
            })
        
        return contracts
    
    def save_game_ut(self, game_ut: float):
        """Store the current game UT on the most recent file_metadata row."""
        cursor = self.conn.cursor()
        cursor.execute(
            'UPDATE file_metadata SET game_ut = ? WHERE id = (SELECT MAX(id) FROM file_metadata)',
            (game_ut,)
        )
        self.conn.commit()

    def get_summary_stats(self) -> Dict:
        """Recupera statistiche riassuntive"""
        cursor = self.conn.cursor()
        
        # Totale Kerbals (non turisti)
        cursor.execute('SELECT COUNT(*) FROM kerbals WHERE is_tourist = 0')
        total_kerbals = cursor.fetchone()[0]
        
        # Totale voli
        cursor.execute('SELECT SUM(flights) FROM kerbals WHERE is_tourist = 0')
        total_flights = cursor.fetchone()[0] or 0
        
        # Totale contratti
        cursor.execute('SELECT SUM(count) FROM contracts')
        total_contracts = cursor.fetchone()[0] or 0
        
        # Totale funds
        cursor.execute('SELECT SUM(total_funds) FROM contracts')
        total_funds = cursor.fetchone()[0] or 0.0
        
        # Locations uniche visitate
        cursor.execute('SELECT COUNT(DISTINCT location) FROM kerbal_locations')
        unique_locations = cursor.fetchone()[0]
        
        # Last update and game time
        cursor.execute('SELECT last_parsed, game_ut FROM file_metadata ORDER BY last_parsed DESC LIMIT 1')
        meta_row = cursor.fetchone()
        last_update = meta_row[0] if meta_row else None
        game_ut     = float(meta_row[1]) if meta_row and meta_row[1] else 0.0

        # Corps breakdown: count per trait × state (Assigned / Available)
        cursor.execute('''
            SELECT trait, state, COUNT(*) as c
            FROM kerbals
            WHERE is_tourist = 0 AND trait != ''  AND state IN ('Assigned', 'Available')
            GROUP BY trait, state
        ''')
        corps = {}
        for row in cursor.fetchall():
            trait, state, count = row['trait'], row['state'], row['c']
            if trait not in corps:
                corps[trait] = {'assigned': 0, 'available': 0}
            corps[trait]['assigned' if state == 'Assigned' else 'available'] = count

        return {
            'total_kerbals': total_kerbals,
            'total_flights': total_flights,
            'total_contracts': total_contracts,
            'total_funds': total_funds,
            'unique_locations': unique_locations,
            'last_update': last_update,
            'game_ut': game_ut,
            'corps': corps,
        }

    def get_system_info(self) -> Dict:
        """Recupera informazioni di sistema per il pannello Admin"""
        cursor = self.conn.cursor()

        cursor.execute(
            'SELECT filepath, file_hash, last_parsed, parse_count FROM file_metadata ORDER BY last_parsed DESC LIMIT 1'
        )
        row = cursor.fetchone()
        metadata = {
            'filepath': row[0] if row else None,
            'file_hash': row[1] if row else None,
            'last_parsed': row[2] if row else None,
            'parse_count': row[3] if row else 0,
        }

        cursor.execute('SELECT COUNT(*) FROM kerbals')
        total_kerbals_db = cursor.fetchone()[0]

        cursor.execute('SELECT COUNT(*) FROM kerbal_locations')
        total_locations_db = cursor.fetchone()[0]

        cursor.execute('SELECT COUNT(*) FROM contracts')
        total_contract_types_db = cursor.fetchone()[0]

        import os as _os
        db_size_bytes = _os.path.getsize(self.db_path) if _os.path.exists(self.db_path) else 0

        return {
            'metadata': metadata,
            'db_rows': {
                'kerbals': total_kerbals_db,
                'kerbal_locations': total_locations_db,
                'contracts': total_contract_types_db,
            },
            'db_size_bytes': db_size_bytes,
            'db_path': self.db_path,
        }


if __name__ == '__main__':
    # Test del database
    db = DatabaseManager('test_ksp_stats.db')
    
    # Test insert kerbals
    from sfs_parser import KerbalStats
    
    test_kerbal = KerbalStats(name="Jebediah Kerman", flights=5)
    test_kerbal.add_location("Mun")
    test_kerbal.add_location("Mun")
    test_kerbal.add_location("Minmus")
    
    db.save_kerbals({"Jebediah Kerman": test_kerbal})
    
    # Test retrieve
    kerbals = db.get_all_kerbals()
    print("Kerbals:", kerbals)
    
    # Test summary
    summary = db.get_summary_stats()
    print("Summary:", summary)
    
    db.close()
