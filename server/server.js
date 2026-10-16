'use strict';
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const { SFSParser } = require('./sfsParser');
const { KSPDatabase } = require('./database');

const PORT    = parseInt(process.env.KSP_PORT || '4999', 10);
const DB_PATH = process.env.KSP_DB_PATH || path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.ksp-gamestat', 'ksp_stats.db'
);
const STATIC_DIR = path.join(__dirname, '..', 'static');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/static', express.static(STATIC_DIR));
app.use(express.static(STATIC_DIR));

let db;
try {
    db = new KSPDatabase(DB_PATH);
    console.log(`Database: ${DB_PATH}`);
} catch (err) {
    console.error('Failed to open database:', err);
    process.exit(1);
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Scan for KSP saves ────────────────────────────────────────────────────────
app.get('/api/scan-saves', (_req, res) => {
    const os   = require('os');
    const home = os.homedir();
    const searchRoots = [
        path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Kerbal Space Program', 'saves'),
        path.join(home, 'Documents', 'Kerbal Space Program', 'saves'),
        path.join(home, 'Documents', 'Gaming'),
        path.join(home, 'Documents'),
        path.join(home, 'Applications', 'Kerbal Space Program', 'saves'),
        '/Applications/Kerbal Space Program/saves',
        path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Kerbal Space Program 2', 'saves'),
    ];
    const configured = db.getConfig('sfs_path', '');
    if (configured) searchRoots.unshift(path.dirname(path.dirname(configured)));

    const found = [];
    const visited = new Set();

    function scan(dir, depth) {
        if (depth > 5 || visited.has(dir)) return;
        visited.add(dir);
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isFile() && e.name === 'persistent.sfs') {
                const parts   = full.split(path.sep);
                const saveName = parts[parts.length - 2] || '';
                const gameIdx  = parts.findIndex(p => /kerbal/i.test(p));
                const gameName = gameIdx >= 0 ? parts[gameIdx] : '';
                found.push({ path: full, saveName, gameName });
            } else if (e.isDirectory() && depth < 5) {
                scan(full, depth + 1);
            }
        }
    }

    for (const root of searchRoots) {
        if (fs.existsSync(root)) scan(root, 0);
    }

    res.json(found);
});

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
    const sfs_path = db.getConfig('sfs_path', '');
    res.json({
        sfs_path,
        last_hash:  db.getConfig('last_hash', ''),
        last_parse: db.getConfig('last_parse', ''),
        configured: !!(sfs_path && fs.existsSync(sfs_path)),
    });
});

app.post('/api/config', (req, res) => {
    const { sfs_path } = req.body || {};
    if (!sfs_path) return res.status(400).json({ error: 'sfs_path required' });
    if (!fs.existsSync(sfs_path)) return res.status(400).json({ error: 'File not found: ' + sfs_path });
    db.setConfig('sfs_path', sfs_path);
    res.json({ ok: true, sfs_path });
});

// ── Parse ─────────────────────────────────────────────────────────────────────
let parsing = false;

app.post('/api/parse', async (req, res) => {
    if (parsing) return res.status(409).json({ error: 'Parse already in progress' });
    const sfsPath = db.getConfig('sfs_path', '');
    if (!sfsPath) return res.status(400).json({ error: 'No sfs_path configured' });
    if (!fs.existsSync(sfsPath)) return res.status(400).json({ error: 'File not found: ' + sfsPath });

    const force = !!(req.body && req.body.force);
    const parser = new SFSParser(sfsPath);

    const fileHash = await parser.calculateFileHash();
    const lastHash = db.getConfig('last_hash', '');
    if (!force && fileHash === lastHash)
        return res.json({ skipped: true, message: 'File unchanged (use force:true to re-parse)' });

    parsing = true;
    const t0 = Date.now();
    try {
        console.log('Parsing', sfsPath, '...');
        const result = await parser.parseAll();
        const { kerbals, allTourists, contracts, contractHistory, gameUt } = result;

        console.log(`Saving ${Object.keys(kerbals).length} kerbals ...`);
        db.saveKerbals(kerbals);
        console.log(`Saving ${Object.keys(allTourists).length} tourists ...`);
        db.saveTourists(allTourists);
        console.log(`Saving ${Object.keys(contracts).length} contract types ...`);
        db.saveContracts(contracts);
        console.log(`Saving ${contractHistory.length} contract history records ...`);
        db.saveContractHistory(contractHistory);

        const durationS = (Date.now() - t0) / 1000;
        db.saveParseRecord(sfsPath, fileHash, durationS, gameUt);
        db.setConfig('last_hash',  fileHash);
        db.setConfig('last_parse', new Date().toISOString());

        parsing = false;
        console.log(`Parse complete in ${durationS.toFixed(1)}s`);
        res.json({
            ok: true,
            duration: durationS,
            kerbals:  Object.keys(kerbals).length,
            tourists: Object.keys(allTourists).length,
            contracts: Object.keys(contracts).length,
            contractHistory: contractHistory.length,
        });
    } catch (err) {
        parsing = false;
        console.error('Parse error:', err);
        res.status(500).json({ error: String(err) });
    }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function locArray(locations, bodyActivities) {
    return Object.entries(locations)
        .map(([loc, count]) => ({ location: loc, count, activities: bodyActivities[loc] || [] }))
        .sort((a, b) => b.count - a.count);
}

// ── Summary ───────────────────────────────────────────────────────────────────
app.get('/api/summary', (_req, res) => {
    try {
        const kerbals     = db.getAllKerbals();
        const corps       = {};
        let   totalFlights = 0;
        const locationSet = new Set();
        for (const k of kerbals) {
            if (!corps[k.trait]) corps[k.trait] = { assigned: 0, available: 0 };
            if (k.state !== 'Available') corps[k.trait].assigned++;
            else corps[k.trait].available++;
            totalFlights += k.flights;
            for (const loc of Object.keys(k.locations)) locationSet.add(loc);
        }
        const hist       = db.getContractHistory();
        const totalFunds = hist.reduce((s, h) => s + (h.funds || 0), 0);
        const last       = db.getLastParseRecord();
        const s          = db.getSummary();
        res.json({
            summary: {
                total_kerbals:    kerbals.length,
                total_flights:    totalFlights,
                total_contracts:  s.contracts,
                total_funds:      totalFunds,
                unique_locations: locationSet.size,
                last_update:      last ? new Date(last.parsed_at * 1000).toISOString() : null,
                game_ut:          last ? last.game_ut : 0,
                corps,
            },
        });
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Kerbals ───────────────────────────────────────────────────────────────────
function fmtKerbal(k) {
    return {
        name:             k.name,
        trait:            k.trait,
        state:            k.state,
        experience_level: k.experienceLevel,
        experience:       k.experience,
        courage:          k.courage,
        stupidity:        k.stupidity,
        gender:           k.gender,
        veteran:          k.veteran,
        is_badass:        k.isBadass,
        flights:          k.flights,
        current_location: k.currentLocation,
        current_vessel:   k.currentVessel,
        hired_ut:         k.hiredUt,
        locations:        locArray(k.locations, k.bodyActivities),
    };
}

app.get('/api/kerbals', (_req, res) => {
    try { res.json({ kerbals: db.getAllKerbals().map(fmtKerbal) }); }
    catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/kerbals/:name', (req, res) => {
    try {
        const k = db.getKerbal(req.params.name);
        if (!k) return res.status(404).json({ error: 'Kerbal not found' });
        res.json(fmtKerbal(k));
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Tourists ──────────────────────────────────────────────────────────────────
app.get('/api/tourists', (_req, res) => {
    try {
        const all = db.getAllTourists().map(t => ({
            name:             t.name,
            state:            t.state,
            flights:          t.flights,
            courage:          t.courage,
            stupidity:        t.stupidity,
            gender:           t.gender,
            current_location: t.currentLocation,
            current_vessel:   t.currentVessel,
            contract_ut:      t.contractUt,
            contract_body:    t.contractBody,
            contract_agent:   t.contractAgent,
            contract_guid:    t.contractGuid,
            objectives:       t.objectives,
            locations:        locArray(t.locations, t.bodyActivities),
        }));
        res.json({ tourists: all, count: all.length, flying: all.filter(t => t.state === 'Flying').length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Contracts ─────────────────────────────────────────────────────────────────
app.get('/api/contracts', (_req, res) => {
    try {
        const contracts = db.getAllContracts().map(c => ({
            type:        c.contractType,
            count:       c.count,
            total_funds: c.totalFunds,
            passengers:  c.passengers,
        }));
        res.json({ contracts });
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

const PRESTIGE_KEY = { 0: 'trivial', 1: 'significant', 2: 'exceptional' };

app.get('/api/contracts/progress', (req, res) => {
    try {
        const type    = req.query.type || null;
        const history = db.getContractHistory(type);
        if (!history.length) {
            return res.json({
                success: true,
                data: {
                    metric: 'funds',
                    summary: { total_count: 0, total_funds: 0, total_passengers: 0, start_label: '—', end_label: '—' },
                    by_prestige: { trivial: {count:0,funds:0}, significant:{count:0,funds:0}, exceptional:{count:0,funds:0} },
                    by_period: [],
                    by_body:   [],
                },
            });
        }

        const isTourism = type === 'TourismContract';
        const metric    = isTourism ? 'passengers' : 'funds';

        const total_funds      = history.reduce((s, h) => s + (h.funds || 0), 0);
        const total_passengers = history.reduce((s, h) => s + (h.passengers || 0), 0);

        const by_prestige = { trivial:{count:0,funds:0}, significant:{count:0,funds:0}, exceptional:{count:0,funds:0} };
        const bodyMap     = {};

        for (const h of history) {
            const pk = PRESTIGE_KEY[h.prestige] || 'trivial';
            by_prestige[pk].count++;
            by_prestige[pk].funds += h.funds || 0;
            if (h.bodyName) bodyMap[h.bodyName] = (bodyMap[h.bodyName] || 0) + 1;
        }

        // Adaptive day-based bins (target ~12-20 bins)
        const KSP_YEAR = 9203544, KSP_DAY = 21600;
        const allUts   = history.map(h => h.dateUt).filter(Boolean);
        const minUt    = allUts.length ? Math.min(...allUts) : 0;
        const maxUt    = allUts.length ? Math.max(...allUts) : 0;
        const spanDays = allUts.length ? Math.max(1, (maxUt - minUt) / KSP_DAY) : 1;
        const binDays  = spanDays <= 100 ? 10 : spanDays <= 400 ? 25 : spanDays <= 1200 ? 50 : 100;

        const byBin = {};
        for (const h of history) {
            if (!h.dateUt) continue;
            const dayNum  = Math.floor(h.dateUt / KSP_DAY);
            const binDay  = Math.floor(dayNum / binDays) * binDays;
            const kspYear = Math.floor(binDay * KSP_DAY / KSP_YEAR) + 1;
            const dayOfYr = binDay - Math.floor((kspYear - 1) * KSP_YEAR / KSP_DAY);
            const key     = binDay;
            const label   = `Y${kspYear}-D${dayOfYr + 1}`;
            if (!byBin[key]) byBin[key] = { label, count: 0, funds: 0, passengers: 0 };
            byBin[key].count++;
            byBin[key].funds      += h.funds      || 0;
            byBin[key].passengers += h.passengers || 0;
        }

        let cumFunds = 0;
        const by_period = Object.keys(byBin).sort((a, b) => a - b).map(k => {
            cumFunds += byBin[k].funds;
            return { label: byBin[k].label, count: byBin[k].count, funds: byBin[k].funds, cumulative_funds: cumFunds, passengers: byBin[k].passengers };
        });

        const by_body = Object.entries(bodyMap).map(([body, count]) => ({ body, count })).sort((a, b) => b.count - a.count);

        res.json({
            success: true,
            data: {
                metric,
                summary: {
                    total_count:      history.length,
                    total_funds,
                    total_passengers,
                    start_label:      by_period.length ? by_period[0].label                    : '—',
                    end_label:        by_period.length ? by_period[by_period.length - 1].label : '—',
                },
                by_prestige,
                by_period,
                by_body,
            },
        });
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── System info ───────────────────────────────────────────────────────────────
app.get('/api/system-info', (_req, res) => {
    try {
        const last       = db.getLastParseRecord();
        const parseCount = db.db.prepare('SELECT COUNT(*) AS c FROM parse_history').get().c;
        const kerbCount  = db.db.prepare('SELECT COUNT(*) AS c FROM kerbals').get().c;
        const ctCount    = db.db.prepare('SELECT COUNT(*) AS c FROM contracts').get().c;
        res.json({
            info: {
                metadata: {
                    last_parsed: last ? new Date(last.parsed_at * 1000).toISOString() : null,
                    parse_count: parseCount,
                    file_hash:   last ? last.file_hash : null,
                    duration_s:  last ? last.duration_s : null,
                    game_ut:     last ? last.game_ut : null,
                },
                db_size_bytes: db.getDbSize(),
                db_path:       DB_PATH,
                db_rows: {
                    kerbals:   kerbCount,
                    contracts: ctCount,
                },
            },
        });
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
    console.log(`KSP GameStats server listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
