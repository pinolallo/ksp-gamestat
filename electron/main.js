const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const { spawn }   = require('child_process');
const net    = require('net');
const http   = require('http');
const fs     = require('fs');

let mainWindow     = null;
let backendProcess = null;
let backendPort    = null;

// ── Free port ─────────────────────────────────────────────────────────────────
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

// ── Backend binary path ───────────────────────────────────────────────────────
function getBackendPath() {
    const exe = process.platform === 'win32'
        ? 'ksp-gamestat-server.exe'
        : 'ksp-gamestat-server';

    if (!app.isPackaged) {
        return path.join(__dirname, '..', 'dist_pyinstaller', 'ksp-gamestat-server', exe);
    }
    return path.join(process.resourcesPath, 'backend', exe);
}

// ── Health poll ───────────────────────────────────────────────────────────────
function waitForBackend(port, maxAttempts = 40, intervalMs = 250) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        function attempt() {
            attempts++;
            const req = http.get(
                { hostname: '127.0.0.1', port, path: '/api/health', timeout: 200 },
                (res) => {
                    if (res.statusCode === 200) return resolve();
                    res.resume();
                    scheduleRetry();
                }
            );
            req.on('error', scheduleRetry);
            req.on('timeout', () => { req.destroy(); scheduleRetry(); });
        }
        function scheduleRetry() {
            if (attempts >= maxAttempts)
                return reject(new Error(`Backend did not start after ${maxAttempts} attempts`));
            setTimeout(attempt, intervalMs);
        }
        attempt();
    });
}

// ── Spawn backend ─────────────────────────────────────────────────────────────
async function startBackend() {
    backendPort = await findFreePort();

    const dbDir  = app.getPath('userData');
    const dbPath = path.join(dbDir, 'ksp_stats.db');
    const binary = getBackendPath();

    if (!fs.existsSync(binary)) {
        throw new Error(
            `Backend binary not found:\n${binary}\n\nRun: npm run build:backend`
        );
    }

    const env = Object.assign({}, process.env, {
        KSP_PORT:    String(backendPort),
        KSP_DB_PATH: dbPath,
        FLASK_ENV:   'production',
        FLASK_DEBUG: '0',
    });

    backendProcess = spawn(binary, [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    backendProcess.stdout.on('data', d => console.log('[backend]', d.toString().trimEnd()));
    backendProcess.stderr.on('data', d => console.error('[backend:err]', d.toString().trimEnd()));

    backendProcess.on('exit', (code, signal) => {
        console.log(`Backend exited: code=${code} signal=${signal}`);
        backendProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.executeJavaScript(
                `document.body.innerHTML='<div style="font-family:monospace;color:#ff6b35;padding:2rem;background:#0a0a1a;min-height:100vh">` +
                `<h2>Backend crashed</h2><pre>Exit code: ${code}\\nSignal: ${signal}</pre>` +
                `<p>Restart the application.</p></div>';`
            );
        }
    });

    backendProcess.on('error', err => {
        console.error('Failed to spawn backend:', err);
    });

    await waitForBackend(backendPort);
    console.log(`Backend ready on port ${backendPort}`);
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:     1280,
        height:    900,
        minWidth:  900,
        minHeight: 600,
        title:     'KSP GameStats',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
    });

    mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
    mainWindow.on('closed', () => { mainWindow = null; });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('select-sfs-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title:      'Select persistent.sfs',
        filters:    [{ name: 'KSP Save File', extensions: ['sfs'] }],
        properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    try {
        await startBackend();
        createWindow();
    } catch (err) {
        console.error('Startup error:', err);
        const errWin = new BrowserWindow({ width: 680, height: 340 });
        errWin.loadURL(
            `data:text/html,<body style="font-family:monospace;background:%230a0a1a;color:%23ff6b35;padding:2rem">` +
            `<h2>Startup Error</h2><pre>${String(err).replace(/</g,'&lt;')}</pre></body>`
        );
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendPort) createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function killBackend() {
    if (!backendProcess) return;
    try {
        backendProcess.kill('SIGTERM');
        if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            try { execSync(`taskkill /pid ${backendProcess.pid} /T /F`); } catch (_) {}
        }
    } catch (_) {}
    backendProcess = null;
}

app.on('before-quit', killBackend);
process.on('exit',   killBackend);
process.on('SIGINT',  () => { killBackend(); process.exit(0); });
process.on('SIGTERM', () => { killBackend(); process.exit(0); });
