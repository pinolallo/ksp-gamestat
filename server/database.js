'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

class KSPDatabase {
    constructor(dbPath) {
        this.dbPath = dbPath;
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this._initSchema();
    }

    // ── Schema ─────────────────────────────────────────────────────────────────
    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS parse_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                sfs_path   TEXT    NOT NULL,
                file_hash  TEXT    NOT NULL,
                parsed_at  REAL    NOT NULL,
                duration_s REAL    DEFAULT 0.0,
                game_ut    REAL    DEFAULT 0.0
            );

            CREATE TABLE IF NOT EXISTS kerbals (
                name             TEXT PRIMARY KEY,
                trait            TEXT DEFAULT '',
                state            TEXT DEFAULT 'Available',
                experience_level INTEGER DEFAULT 0,
                experience       REAL DEFAULT 0.0,
                courage          REAL DEFAULT 0.0,
                stupidity        REAL DEFAULT 0.0,
                gender           TEXT DEFAULT 'Male',
                veteran          INTEGER DEFAULT 0,
                is_badass        INTEGER DEFAULT 0,
                flights          INTEGER DEFAULT 0,
                current_location TEXT DEFAULT '',
                current_vessel   TEXT DEFAULT '',
                hired_ut         REAL DEFAULT 0.0
            );

            CREATE TABLE IF NOT EXISTS kerbal_locations (
                kerbal_name TEXT NOT NULL,
                body        TEXT NOT NULL,
                visit_count INTEGER DEFAULT 1,
                activities  TEXT DEFAULT '',
                PRIMARY KEY (kerbal_name, body),
                FOREIGN KEY (kerbal_name) REFERENCES kerbals(name) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tourists (
                name             TEXT PRIMARY KEY,
                state            TEXT DEFAULT 'Returned',
                flights          INTEGER DEFAULT 0,
                courage          REAL DEFAULT 0.0,
                stupidity        REAL DEFAULT 0.0,
                gender           TEXT DEFAULT 'Male',
                current_location TEXT DEFAULT '',
                current_vessel   TEXT DEFAULT '',
                contract_ut      REAL DEFAULT 0.0,
                contract_body    TEXT DEFAULT '',
                contract_agent   TEXT DEFAULT '',
                contract_guid    TEXT DEFAULT '',
                objectives       TEXT DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS tourist_locations (
                tourist_name TEXT NOT NULL,
                body         TEXT NOT NULL,
                visit_count  INTEGER DEFAULT 1,
                activities   TEXT DEFAULT '',
                PRIMARY KEY (tourist_name, body),
                FOREIGN KEY (tourist_name) REFERENCES tourists(name) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS contracts (
                contract_type TEXT PRIMARY KEY,
                count         INTEGER DEFAULT 0,
                total_funds   REAL DEFAULT 0.0,
                passengers    INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS contract_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                contract_type TEXT NOT NULL,
                prestige      INTEGER DEFAULT 0,
                body_name     TEXT DEFAULT '',
                funds         REAL DEFAULT 0.0,
                passengers    INTEGER DEFAULT 0,
                date_ut       REAL DEFAULT 0.0,
                ksp_year      INTEGER DEFAULT 0,
                ksp_day       INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        this._migrate();
    }

    _migrate() {
        // Add any new columns not present in older schemas
        const safeAdd = (table, col, def) => {
            try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (_) {}
        };
        safeAdd('tourists',       'objectives TEXT',       "DEFAULT '[]'");
        safeAdd('kerbal_locations', 'activities TEXT',     "DEFAULT ''");
        safeAdd('tourist_locations','activities TEXT',     "DEFAULT ''");
        safeAdd('parse_history',  'game_ut REAL',          'DEFAULT 0.0');
    }

    // ── Config ─────────────────────────────────────────────────────────────────
    getConfig(key, defaultValue = null) {
        const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key);
        return row ? row.value : defaultValue;
    }

    setConfig(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
    }

    // ── Kerbals ────────────────────────────────────────────────────────────────
    saveKerbals(kerbals) {
        const upsertKerbal = this.db.prepare(`
            INSERT INTO kerbals
                (name, trait, state, experience_level, experience, courage, stupidity,
                 gender, veteran, is_badass, flights, current_location, current_vessel, hired_ut)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                trait=excluded.trait, state=excluded.state,
                experience_level=excluded.experience_level, experience=excluded.experience,
                courage=excluded.courage, stupidity=excluded.stupidity,
                gender=excluded.gender, veteran=excluded.veteran, is_badass=excluded.is_badass,
                flights=excluded.flights, current_location=excluded.current_location,
                current_vessel=excluded.current_vessel, hired_ut=excluded.hired_ut
        `);

        const upsertLoc = this.db.prepare(`
            INSERT INTO kerbal_locations (kerbal_name, body, visit_count, activities)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(kerbal_name, body) DO UPDATE SET
                visit_count=excluded.visit_count, activities=excluded.activities
        `);

        const txn = this.db.transaction((kerbals) => {
            for (const k of Object.values(kerbals)) {
                upsertKerbal.run(
                    k.name, k.trait, k.state, k.experienceLevel, k.experience,
                    k.courage, k.stupidity, k.gender, k.veteran ? 1 : 0, k.isBadass ? 1 : 0,
                    k.flights, k.currentLocation, k.currentVessel, k.hiredUt
                );
                for (const [body, count] of Object.entries(k.locations || {})) {
                    const actsSet = k.bodyActivities[body];
                    const acts = actsSet ? [...(actsSet instanceof Set ? actsSet : new Set(actsSet))].sort().join('|') : '';
                    upsertLoc.run(k.name, body, count, acts);
                }
            }
        });
        txn(kerbals);
    }

    getAllKerbals() {
        const kerbals = this.db.prepare(`
            SELECT k.*,
                GROUP_CONCAT(kl.body || ':' || kl.visit_count || ':' || kl.activities, '||') AS loc_data
            FROM kerbals k
            LEFT JOIN kerbal_locations kl ON kl.kerbal_name = k.name
            GROUP BY k.name
            ORDER BY k.experience_level DESC, k.experience DESC, k.name ASC
        `).all();

        return kerbals.map(row => {
            const locations = {};
            const bodyActivities = {};
            if (row.loc_data) {
                for (const chunk of row.loc_data.split('||')) {
                    const [body, countStr, actsStr] = chunk.split(':');
                    if (body) {
                        locations[body]     = parseInt(countStr) || 1;
                        bodyActivities[body] = actsStr ? actsStr.split('|').filter(Boolean) : [];
                    }
                }
            }
            return {
                name:            row.name,
                trait:           row.trait,
                state:           row.state,
                experienceLevel: row.experience_level,
                experience:      row.experience,
                courage:         row.courage,
                stupidity:       row.stupidity,
                gender:          row.gender,
                veteran:         row.veteran === 1,
                isBadass:        row.is_badass === 1,
                flights:         row.flights,
                currentLocation: row.current_location,
                currentVessel:   row.current_vessel,
                hiredUt:         row.hired_ut,
                locations,
                bodyActivities,
            };
        });
    }

    getKerbal(name) {
        const row = this.db.prepare('SELECT * FROM kerbals WHERE name = ?').get(name);
        if (!row) return null;
        const locs = this.db.prepare('SELECT body, visit_count, activities FROM kerbal_locations WHERE kerbal_name = ?').all(name);
        const locations = {}, bodyActivities = {};
        for (const l of locs) {
            locations[l.body]      = l.visit_count;
            bodyActivities[l.body] = l.activities ? l.activities.split('|').filter(Boolean) : [];
        }
        return {
            name:            row.name, trait: row.trait, state: row.state,
            experienceLevel: row.experience_level, experience: row.experience,
            courage:         row.courage, stupidity: row.stupidity, gender: row.gender,
            veteran:         row.veteran === 1, isBadass: row.is_badass === 1,
            flights:         row.flights, currentLocation: row.current_location,
            currentVessel:   row.current_vessel, hiredUt: row.hired_ut,
            locations, bodyActivities,
        };
    }

    // ── Tourists ───────────────────────────────────────────────────────────────
    saveTourists(tourists) {
        const upsert = this.db.prepare(`
            INSERT INTO tourists
                (name, state, flights, courage, stupidity, gender,
                 current_location, current_vessel,
                 contract_ut, contract_body, contract_agent, contract_guid, objectives)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                state=excluded.state, flights=excluded.flights,
                courage=excluded.courage, stupidity=excluded.stupidity, gender=excluded.gender,
                current_location=excluded.current_location, current_vessel=excluded.current_vessel,
                contract_ut=excluded.contract_ut, contract_body=excluded.contract_body,
                contract_agent=excluded.contract_agent, contract_guid=excluded.contract_guid,
                objectives=excluded.objectives
        `);

        const upsertLoc = this.db.prepare(`
            INSERT INTO tourist_locations (tourist_name, body, visit_count, activities)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(tourist_name, body) DO UPDATE SET
                visit_count=excluded.visit_count, activities=excluded.activities
        `);

        const txn = this.db.transaction((tourists) => {
            for (const t of Object.values(tourists)) {
                upsert.run(
                    t.name, t.state, t.flights, t.courage, t.stupidity, t.gender,
                    t.currentLocation, t.currentVessel,
                    t.contractUt, t.contractBody, t.contractAgent, t.contractGuid,
                    JSON.stringify(t.objectives || [])
                );
                for (const [body, count] of Object.entries(t.locations || {})) {
                    const actsSet = t.bodyActivities[body];
                    const acts = actsSet ? [...(actsSet instanceof Set ? actsSet : new Set(actsSet))].sort().join('|') : '';
                    upsertLoc.run(t.name, body, count, acts);
                }
            }
        });
        txn(tourists);
    }

    getAllTourists() {
        const rows = this.db.prepare(`
            SELECT t.*,
                GROUP_CONCAT(tl.body || ':' || tl.visit_count || ':' || tl.activities, '||') AS loc_data
            FROM tourists t
            LEFT JOIN tourist_locations tl ON tl.tourist_name = t.name
            GROUP BY t.name
            ORDER BY t.contract_ut DESC, t.name ASC
        `).all();

        return rows.map(row => {
            const locations = {}, bodyActivities = {};
            if (row.loc_data) {
                for (const chunk of row.loc_data.split('||')) {
                    const [body, countStr, actsStr] = chunk.split(':');
                    if (body) {
                        locations[body]      = parseInt(countStr) || 1;
                        bodyActivities[body] = actsStr ? actsStr.split('|').filter(Boolean) : [];
                    }
                }
            }
            return {
                name:            row.name, state: row.state, flights: row.flights,
                courage:         row.courage, stupidity: row.stupidity, gender: row.gender,
                currentLocation: row.current_location, currentVessel: row.current_vessel,
                contractUt:      row.contract_ut, contractBody: row.contract_body,
                contractAgent:   row.contract_agent, contractGuid: row.contract_guid,
                objectives:      JSON.parse(row.objectives || '[]'),
                locations, bodyActivities,
            };
        });
    }

    // ── Contracts ──────────────────────────────────────────────────────────────
    saveContracts(contracts) {
        const upsert = this.db.prepare(`
            INSERT INTO contracts (contract_type, count, total_funds, passengers)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(contract_type) DO UPDATE SET
                count=excluded.count, total_funds=excluded.total_funds, passengers=excluded.passengers
        `);
        const txn = this.db.transaction((contracts) => {
            for (const c of Object.values(contracts))
                upsert.run(c.contractType, c.count, c.totalFunds, c.passengers);
        });
        txn(contracts);
    }

    getAllContracts() {
        return this.db.prepare('SELECT * FROM contracts ORDER BY count DESC').all().map(row => ({
            contractType: row.contract_type,
            count:        row.count,
            totalFunds:   row.total_funds,
            passengers:   row.passengers,
        }));
    }

    saveContractHistory(history) {
        this.db.exec('DELETE FROM contract_history');
        const ins = this.db.prepare(`
            INSERT INTO contract_history
                (contract_type, prestige, body_name, funds, passengers, date_ut, ksp_year, ksp_day)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const txn = this.db.transaction((history) => {
            for (const h of history)
                ins.run(h.contractType, h.prestige, h.bodyName, h.funds, h.passengers, h.dateUt, h.kspYear, h.kspDay);
        });
        txn(history);
    }

    getContractHistory(contractType = null) {
        const sql = contractType
            ? 'SELECT * FROM contract_history WHERE contract_type = ? ORDER BY date_ut ASC'
            : 'SELECT * FROM contract_history ORDER BY date_ut ASC';
        const rows = contractType
            ? this.db.prepare(sql).all(contractType)
            : this.db.prepare(sql).all();
        return rows.map(row => ({
            contractType: row.contract_type, prestige: row.prestige, bodyName: row.body_name,
            funds:        row.funds, passengers: row.passengers, dateUt: row.date_ut,
            kspYear:      row.ksp_year, kspDay: row.ksp_day,
        }));
    }

    // ── Parse History ──────────────────────────────────────────────────────────
    saveParseRecord(sfsPath, fileHash, durationS, gameUt) {
        this.db.prepare(`
            INSERT INTO parse_history (sfs_path, file_hash, parsed_at, duration_s, game_ut)
            VALUES (?, ?, ?, ?, ?)
        `).run(sfsPath, fileHash, Date.now() / 1000, durationS, gameUt);
    }

    getLastParseRecord() {
        return this.db.prepare('SELECT * FROM parse_history ORDER BY parsed_at DESC LIMIT 1').get();
    }

    getSummary() {
        const kerbals   = this.db.prepare('SELECT COUNT(*) AS c FROM kerbals').get().c;
        const assigned  = this.db.prepare("SELECT COUNT(*) AS c FROM kerbals WHERE state != 'Available'").get().c;
        const tourists  = this.db.prepare('SELECT COUNT(*) AS c FROM tourists').get().c;
        const flying    = this.db.prepare("SELECT COUNT(*) AS c FROM tourists WHERE state = 'Flying'").get().c;
        const cRow      = this.db.prepare('SELECT SUM(count) AS cnt, SUM(total_funds) AS funds FROM contracts').get();
        const flightsR  = this.db.prepare('SELECT SUM(flights) AS f FROM kerbals').get();
        return {
            kerbals, assignedKerbals: assigned, tourists, flyingTourists: flying,
            contracts:    cRow.cnt   || 0,
            totalFunds:   cRow.funds || 0,
            totalFlights: flightsR.f || 0,
        };
    }

    // ── Achievements ───────────────────────────────────────────────────────────
    saveAchievements(data) {
        this.setConfig('achievements_json', JSON.stringify(data));
    }

    getAchievements() {
        const json = this.getConfig('achievements_json', null);
        if (!json) return null;
        try { return JSON.parse(json); } catch (_) { return null; }
    }

    getDbSize() {
        try { return fs.statSync(this.dbPath).size; } catch (_) { return 0; }
    }

    close() { this.db.close(); }
}

module.exports = { KSPDatabase };
