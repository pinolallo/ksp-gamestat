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

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
    res.json({
        sfs_path:   db.getConfig('sfs_path', ''),
        last_hash:  db.getConfig('last_hash', ''),
        last_parse: db.getConfig('last_parse', ''),
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

// ── Summary ───────────────────────────────────────────────────────────────────
app.get('/api/summary', (_req, res) => {
    try { res.json(db.getSummary()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Kerbals ───────────────────────────────────────────────────────────────────
app.get('/api/kerbals', (_req, res) => {
    try { res.json(db.getAllKerbals()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/kerbals/:name', (req, res) => {
    try {
        const k = db.getKerbal(req.params.name);
        if (!k) return res.status(404).json({ error: 'Kerbal not found' });
        res.json(k);
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Tourists ──────────────────────────────────────────────────────────────────
app.get('/api/tourists', (_req, res) => {
    try { res.json(db.getAllTourists()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Contracts ─────────────────────────────────────────────────────────────────
app.get('/api/contracts', (_req, res) => {
    try { res.json(db.getAllContracts()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/contracts/progress', (req, res) => {
    try {
        const type    = req.query.type || null;
        const history = db.getContractHistory(type);
        res.json(history);
    } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── System info ───────────────────────────────────────────────────────────────
app.get('/api/system-info', (_req, res) => {
    try {
        const last = db.getLastParseRecord();
        res.json({
            db_size_bytes: db.getDbSize(),
            db_path:       DB_PATH,
            last_parse:    last || null,
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
