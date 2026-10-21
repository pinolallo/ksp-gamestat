// API Base URL
const API_BASE = '/api';

// KSP time constants (seconds)
const KSP_YEAR_S = 9203544;
const KSP_DAY_S  = 21600;

function kspDateStr(ut) {
    const year = Math.floor(ut / KSP_YEAR_S) + 1;
    const day  = Math.floor((ut % KSP_YEAR_S) / KSP_DAY_S) + 1;
    return `Y${year} D${day}`;
}

function kspDurStr(seconds) {
    if (seconds <= 0) return '—';
    const years = Math.floor(seconds / KSP_YEAR_S);
    const days  = Math.floor((seconds % KSP_YEAR_S) / KSP_DAY_S);
    return years > 0 ? `${years}Y ${days}D` : `${days}D`;
}

function starRating(level) {
    const n = Math.max(0, Math.min(5, level || 0));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// State
let currentConfig = null;
let kerbalsData = [];
let contractsData = [];
let touristsData = [];
let gameUt = 0;

// Kerbal roster lookup tables
const TRAIT_BADGE = {
    Pilot:     { cls: 'badge-pilot',     label: 'Pilot' },
    Engineer:  { cls: 'badge-engineer',  label: 'Engineer' },
    Scientist: { cls: 'badge-scientist', label: 'Scientist' },
};
const LEVEL_LABEL = ['TRAINEE', 'CREW', 'VETERAN', 'PROFICIENT', 'SPECIALIST', 'ACE'];
const TRAIT_AVATAR = { Pilot: '🛸', Engineer: '🔧', Scientist: '🔬' };
const STATE_INACTIVE = new Set(['Dead', 'Missing']);
const STATE_BADGE_CLS = {
    Available: 'state-available',
    Assigned:  'state-assigned',
    Dead:      'state-dead',
    Missing:   'state-missing',
};
const STATE_LABEL = {
    Available: 'Available',
    Assigned:  'On Mission',
    Dead:      'Deceased',
    Missing:   'Missing',
};

// Prestige tier per body (shown as +N on location badges)
const BODY_TIER = {
    Sun: 1, Kerbin: 1,
    Mun: 2, Minmus: 3,
    Gilly: 4, Eve: 5,
    Duna: 6, Ike: 4,
    Moho: 7, Dres: 5, Eeloo: 8,
    Jool: 8, Laythe: 7, Tylo: 7, Vall: 6, Bop: 5, Pol: 5,
};
function bodyTier(loc) { return BODY_TIER[loc] || 1; }

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initMissionClock();
    loadConfig();
    const btn = document.getElementById('browseBtn');
    if (btn) btn.style.display = '';
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeKerbalDetail();
            closeContractDetail();
            closeSavePicker();
        }
    });
});

async function browseForSfs() {
    if (window.electronAPI) {
        const selected = await window.electronAPI.selectSfsFile();
        if (!selected) return;
        document.getElementById('sfsPath').value = selected;
        await configurePath();
        return;
    }
    // Browser mode: scan server for KSP saves
    const btn = document.getElementById('browseBtn');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
        const saves = await fetch('/api/scan-saves').then(r => r.json());
        showSavePicker(saves);
    } catch (e) {
        alert('Scan failed: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Browse…';
    }
}

function showSavePicker(saves) {
    document.getElementById('savePickerOverlay').style.display = 'flex';
    const list = document.getElementById('savePickerList');
    if (!saves.length) {
        list.innerHTML = '<div class="save-picker-empty">No persistent.sfs files found.<br>Enter the path manually.</div>';
        return;
    }
    list.innerHTML = saves.map((s, i) =>
        `<div class="save-picker-item" onclick="selectSave(${i})" data-path="${escapeHtml(s.path)}">
            <div class="save-picker-name">${escapeHtml(s.saveName || 'Unknown')}</div>
            <div class="save-picker-game">${escapeHtml(s.gameName || '')}</div>
            <div class="save-picker-path">${escapeHtml(s.path)}</div>
        </div>`
    ).join('');
}

function closeSavePicker() {
    document.getElementById('savePickerOverlay').style.display = 'none';
}

async function selectSave(idx) {
    const items = document.querySelectorAll('.save-picker-item');
    const p = items[idx] && items[idx].dataset.path;
    if (!p) return;
    closeSavePicker();
    document.getElementById('sfsPath').value = p;
    await configurePath();
}

// Mission Clock
function initMissionClock() {
    const startTime = Date.now();
    
    function updateClock() {
        const elapsed = Date.now() - startTime;
        const hours = Math.floor(elapsed / 3600000);
        const minutes = Math.floor((elapsed % 3600000) / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        
        const timeString = [hours, minutes, seconds]
            .map(n => n.toString().padStart(2, '0'))
            .join(':');
        
        document.getElementById('clockTime').textContent = timeString;
    }
    
    updateClock();
    setInterval(updateClock, 1000);
}

// Load configuration
async function loadConfig() {
    try {
        const response = await fetch(`${API_BASE}/config`);
        const data = await response.json();
        
        currentConfig = data;
        
        if (data.configured) {
            document.getElementById('sfsPath').value = data.sfs_path;
            updateConfigStatus(true, `File configured: ${data.sfs_path}`);
            document.getElementById('parseSection').style.display = 'flex';

            // Load existing data
            await loadSummary();
            await loadKerbals();
            await loadTourists();
            await loadContracts();
            await loadVessels();
            await loadAchievements();
        } else {
            // Not configured: show tab nav and route to Admin
            document.getElementById('tabsNav').style.display = 'flex';
            showTab('admin');
        }
    } catch (error) {
        console.error('Error loading config:', error);
        showToast('Error loading configuration', 'error');
    }
}

// Configure path
async function configurePath() {
    let path = document.getElementById('sfsPath').value.trim();

    // In Electron: offer native file dialog when field is empty
    if (!path && window.electronAPI) {
        const selected = await window.electronAPI.selectSfsFile();
        if (!selected) return;
        path = selected;
        document.getElementById('sfsPath').value = path;
    }

    if (!path) {
        showToast('Please enter a valid path', 'warning');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sfs_path: path })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            updateConfigStatus(true, `File configured: ${path}`);
            document.getElementById('parseSection').style.display = 'flex';
            showToast('Configuration saved!', 'success');
            currentConfig = data;
        } else {
            showToast(data.error || 'Configuration error', 'error');
        }
    } catch (error) {
        console.error('Error configuring path:', error);
        showToast('Connection error', 'error');
    }
}

// Update config status UI
function updateConfigStatus(isConfigured, message) {
    const statusDiv = document.getElementById('configStatus');
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    
    if (isConfigured) {
        statusDiv.classList.add('configured');
        indicator.textContent = '✅';
        statusText.textContent = message;
    } else {
        statusDiv.classList.remove('configured');
        indicator.textContent = '⚠️';
        statusText.textContent = message;
    }
}

// Parse file
async function parseFile(force = false) {
    const parseButton = document.getElementById('parseButton');
    const parseProgress = document.getElementById('parseProgress');
    const parseSection = document.getElementById('parseSection');
    
    parseButton.disabled = true;
    parseSection.style.display = 'none';
    parseProgress.style.display = 'flex';
    
    try {
        const response = await fetch(`${API_BASE}/parse`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ force })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            if (data.skipped) {
                showToast('Data already up to date (cached)', 'success');
            } else {
                showToast(`Parsing complete! ${data.kerbals} Kerbals, ${data.tourists} tourists, ${data.contracts} contract types`, 'success');
            }
            
            // Reload data
            await loadSummary();
            await loadKerbals();
            await loadTourists();
            await loadContracts();
            await loadVessels();
            await loadAchievements();

            // Redirect to Kerbals tab after successful parse from Admin
            if (document.getElementById('adminTab').classList.contains('active')) {
                showTab('kerbals');
            }
        } else {
            showToast(data.error || 'Parsing error', 'error');
        }
    } catch (error) {
        console.error('Error parsing file:', error);
        showToast('Connection error during parsing', 'error');
    } finally {
        parseButton.disabled = false;
        parseProgress.style.display = 'none';
        parseSection.style.display = 'flex';
    }
}

// Load summary statistics
async function loadSummary() {
    try {
        const response = await fetch(`${API_BASE}/summary`);
        const data = await response.json();
        
        if (response.ok && data.summary) {
            const summary = data.summary;
            
            document.getElementById('totalKerbals').textContent = summary.total_kerbals;
            document.getElementById('totalFlights').textContent = summary.total_flights;
            document.getElementById('totalContracts').textContent = summary.total_contracts;
            document.getElementById('totalFunds').textContent = formatFunds(summary.total_funds);
            document.getElementById('uniqueLocations').textContent = summary.unique_locations;
            
            if (summary.last_update) {
                document.getElementById('lastUpdate').textContent = formatDate(summary.last_update);
            }
            if (summary.game_ut) gameUt = summary.game_ut;
            if (summary.corps)   renderCorpsSummary(summary.corps);

            document.getElementById('summaryPanel').style.display = 'block';
            document.getElementById('tabsNav').style.display = 'flex';
        }
    } catch (error) {
        console.error('Error loading summary:', error);
    }
}

// Load kerbals
async function loadKerbals() {
    try {
        const response = await fetch(`${API_BASE}/kerbals`);
        const data = await response.json();

        if (response.ok && data.kerbals) {
            kerbalsData = data.kerbals;
            document.getElementById('rosterTotal').textContent = kerbalsData.length;
            applyFilters();
        }
    } catch (error) {
        console.error('Error loading kerbals:', error);
        showToast('Error loading kerbals', 'error');
    }
}

function renderCorpsSummary(corps) {
    const el = document.getElementById('corpsSummary');
    if (!el) return;
    const TRAIT_ICON = { Pilot: '✈️', Engineer: '🔧', Scientist: '🔬' };
    const traits = ['Pilot', 'Engineer', 'Scientist'];
    el.innerHTML = traits.map(trait => {
        const d = corps[trait] || { assigned: 0, available: 0 };
        const total = d.assigned + d.available;
        const icon  = TRAIT_ICON[trait];
        return `<div class="corps-block">
            <div class="corps-trait">${icon} ${trait.toUpperCase()}S</div>
            <div class="corps-stats">
                <span class="corps-assigned">${d.assigned} <span class="corps-label">ASSIGNED</span></span>
                <span class="corps-sep">/</span>
                <span class="corps-available">${d.available} <span class="corps-label">AVAILABLE</span></span>
                <span class="corps-total">(${total})</span>
            </div>
        </div>`;
    }).join('');
}

// Render kerbals
function renderKerbals(kerbals) {
    const grid = document.getElementById('kerbalsGrid');

    if (!kerbals.length) {
        grid.innerHTML = '<p class="text-center">No kerbals found.</p>';
        return;
    }

    grid.innerHTML = kerbals.map((k, i) => {
        const trait    = TRAIT_BADGE[k.trait] || { cls: 'badge-unknown', label: k.trait || '—' };
        const level    = LEVEL_LABEL[k.experience_level] || 'TRAINEE';
        const avatar   = TRAIT_AVATAR[k.trait] || (k.gender === 'Female' ? '👩‍🚀' : '👨‍🚀');
        const inactive = STATE_INACTIVE.has(k.state) ? ' kerbal-card--inactive' : '';
        const top5     = k.locations.slice(0, 5);
        const more     = k.locations.length - 5;
        const safeName = escapeHtml(k.name).replace(/'/g, "\\'");

        return `
        <div class="kerbal-card${inactive}" style="animation-delay:${i * 0.05}s"
             onclick="openKerbalDetail('${safeName}')">
            <div class="kerbal-header">
                <div class="kerbal-avatar">${avatar}</div>
                <div class="kerbal-info">
                    <h3>${escapeHtml(k.name)}</h3>
                    <div class="kerbal-badges">
                        <span class="trait-badge ${trait.cls}">${trait.label}</span>
                        <span class="star-rating">${starRating(k.experience_level)}</span>
                    </div>
                </div>
            </div>
            <div class="kerbal-stats-row">
                <div class="kerbal-stat">
                    <div class="kerbal-stat-label">RATING</div>
                    <div class="kerbal-stat-value">${k.experience.toFixed(1)}</div>
                </div>
                <div class="kerbal-stat">
                    <div class="kerbal-stat-label">MISSIONS</div>
                    <div class="kerbal-stat-value">${k.flights}</div>
                </div>
                <div class="kerbal-stat">
                    <div class="kerbal-stat-label">LOCATIONS</div>
                    <div class="kerbal-stat-value">${k.locations.length}</div>
                </div>
            </div>
            ${(() => {
                if (k.veteran) {
                    const svc = gameUt > 0 ? kspDurStr(gameUt) : '—';
                    return `<div class="kerbal-stats-row kerbal-service-row">
                        <div class="kerbal-stat"><div class="kerbal-stat-label">JOINED</div><div class="kerbal-stat-value kerbal-stat-sm">VETERAN</div></div>
                        <div class="kerbal-stat"><div class="kerbal-stat-label">SERVICE</div><div class="kerbal-stat-value kerbal-stat-sm">${svc}</div></div>
                    </div>`;
                } else if (k.hired_ut > 0 && gameUt > 0) {
                    return `<div class="kerbal-stats-row kerbal-service-row">
                        <div class="kerbal-stat"><div class="kerbal-stat-label">JOINED</div><div class="kerbal-stat-value kerbal-stat-sm">${kspDateStr(k.hired_ut)}</div></div>
                        <div class="kerbal-stat"><div class="kerbal-stat-label">SERVICE</div><div class="kerbal-stat-value kerbal-stat-sm">${kspDurStr(gameUt - k.hired_ut)}</div></div>
                    </div>`;
                }
                return '';
            })()}
            ${(k.current_location || k.current_vessel) ? `
            <div class="kerbal-current-location">
                <span>📍</span>
                <span class="current-loc-text">${escapeHtml(k.current_location)}</span>
                ${k.current_vessel ? `<span class="current-vessel-sep">•</span><span class="current-vessel-name">🚀 ${escapeHtml(k.current_vessel)}</span>` : ''}
            </div>` : ''}
            ${top5.length ? `
            <div class="kerbal-locations">
                <h4>🌍 TOP DESTINATIONS</h4>
                <div class="location-list">
                    ${top5.map(loc => `
                    <div class="location-item">
                        <span class="location-name">${escapeHtml(loc.location)}</span>
                        <span class="location-right">
                            <span class="location-count">${loc.count}×</span>
                            <span class="location-tier">+${bodyTier(loc.location)}</span>
                        </span>
                    </div>`).join('')}
                    ${more > 0 ? `<div class="location-item location-more">+${more} more...</div>` : ''}
                </div>
            </div>` : `<p class="text-center" style="color:var(--text-secondary);font-size:.875rem;">No destinations recorded</p>`}
        </div>`;
    }).join('');
}

// Apply all filters + sort
function applyFilters() {
    const search    = document.getElementById('kerbalSearch').value.toLowerCase();
    const sortKey   = document.getElementById('kerbalSortSelect').value;
    const locFilter = document.getElementById('locationFilter').value.toLowerCase();

    let filtered = kerbalsData.filter(k => {
        const matchName = !search || k.name.toLowerCase().includes(search);
        const matchLoc  = !locFilter ||
            k.locations.some(l => l.location.toLowerCase().includes(locFilter));
        return matchName && matchLoc;
    });

    const sorts = {
        rating:     (a, b) => b.experience - a.experience,
        rating_asc: (a, b) => a.experience - b.experience,
        flights:    (a, b) => b.flights - a.flights,
        name:       (a, b) => a.name.localeCompare(b.name),
        service:    (a, b) => (a.hired_ut || 0) - (b.hired_ut || 0),  // lower hired_ut = longer service
        joined:     (a, b) => (a.hired_ut || 0) - (b.hired_ut || 0),  // earliest rescue first; veterans (0) sort first
    };
    filtered.sort(sorts[sortKey] || sorts.rating);

    document.getElementById('rosterShowing').textContent = filtered.length;
    renderKerbals(filtered);
}

// ── Tourist roster ──────────────────────────────────────────────────────────

async function loadTourists() {
    try {
        const response = await fetch(`${API_BASE}/tourists`);
        const data = await response.json();
        if (response.ok && data.tourists) {
            touristsData = data.tourists;
            document.getElementById('touristTotal').textContent  = data.count;
            document.getElementById('touristFlying').textContent = data.flying;
            applyTouristFilters();
        }
    } catch (error) {
        console.error('Error loading tourists:', error);
    }
}

function applyTouristFilters() {
    const search      = document.getElementById('touristSearch').value.toLowerCase();
    const sortKey     = document.getElementById('touristSortSelect').value;
    const stateFilter = document.getElementById('touristStateFilter').value;

    let filtered = touristsData.filter(t => {
        const matchName  = !search || t.name.toLowerCase().includes(search);
        const matchState = stateFilter === 'all' || t.state === stateFilter;
        return matchName && matchState;
    });

    const STATE_ORDER = { Flying: 0, Awaiting: 1, Returned: 2 };
    const sorts = {
        date_desc: (a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (b.contract_ut || 0) - (a.contract_ut || 0),
        date_asc:  (a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (a.contract_ut || 0) - (b.contract_ut || 0),
        name:      (a, b) => a.name.localeCompare(b.name),
        status:    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
    };
    filtered.sort(sorts[sortKey] || sorts.date_desc);

    renderTourists(filtered);
}

function renderTourists(tourists) {
    const grid = document.getElementById('touristsGrid');
    if (!tourists.length) {
        const filter = document.getElementById('touristStateFilter').value;
        const hint = filter !== 'all'
            ? `No ${filter.toLowerCase()} tourists. Try <a href="#" onclick="document.getElementById('touristStateFilter').value='all';applyTouristFilters();return false;" style="color:var(--accent-cyan)">All tourists</a>.`
            : 'No tourists found. Try Force Refresh in Admin.';
        grid.innerHTML = `<p class="text-center" style="color:var(--text-secondary);padding:2rem;grid-column:1/-1;">${hint}</p>`;
        return;
    }

    const active    = tourists.filter(t => t.state === 'Flying' || t.state === 'Awaiting');
    const returned  = tourists.filter(t => t.state === 'Returned');

    const STATE_INFO = {
        Flying:   { cls: 'tourist-flying',   label: '✈️ FLYING' },
        Awaiting: { cls: 'tourist-awaiting', label: '📋 AWAITING' },
        Returned: { cls: 'tourist-returned', label: '✅ RETURNED' },
    };

    // ── Active tourists (Flying + Awaiting) ──
    const activeHtml = active.map((t, i) => {
        const si     = STATE_INFO[t.state] || STATE_INFO.Flying;
        const avatar = t.gender === 'Female' ? '👩' : '👨';
        const bodyBadge = t.contract_body
            ? `<span class="tourist-body-badge">${escapeHtml(t.contract_body)}</span>` : '';
        const contractCompleteBadge = t.state === 'Flying' && !(t.objectives || []).length
            ? `<span class="tourist-state-badge tourist-contract-done">🏁 CONTRACT DONE</span>` : '';
        const locStr = t.current_location && t.current_location !== 'Kerbin (KSC)'
            ? t.current_location : (t.current_location || '');
        return `<div class="tourist-card tourist-card--flying" style="animation-delay:${i * 0.04}s">
            <div class="tourist-header">
                <div class="tourist-avatar">${avatar}</div>
                <div class="tourist-info">
                    <h3>${escapeHtml(t.name)}</h3>
                    <div class="tourist-badges">
                        <span class="tourist-state-badge ${si.cls}">${si.label}</span>
                        ${contractCompleteBadge}
                        ${bodyBadge}
                    </div>
                </div>
            </div>
            <div class="tourist-stats-row">
                <div class="tourist-stat"><div class="tourist-stat-label">MISSIONS</div><div class="tourist-stat-value">${t.flights}</div></div>
                <div class="tourist-stat"><div class="tourist-stat-label">LOCATIONS</div><div class="tourist-stat-value">${t.locations.length}</div></div>
                <div class="tourist-stat"><div class="tourist-stat-label">BRAVE</div><div class="tourist-stat-value">${(t.courage * 100).toFixed(0)}%</div></div>
            </div>
            ${locStr ? `
            <div class="kerbal-current-location">
                <span>📍</span>
                <span class="current-loc-text">${escapeHtml(locStr)}</span>
                ${t.current_vessel ? `<span class="current-vessel-sep">•</span><span class="current-vessel-name">🚀 ${escapeHtml(t.current_vessel)}</span>` : ''}
            </div>` : ''}
            ${(() => {
                const objs = t.objectives || [];
                if (objs.length) {
                    // Group contract objectives by body, preserve order
                    const byBody = [];
                    const seen = {};
                    for (const o of objs) {
                        if (!seen[o.body]) { seen[o.body] = []; byBody.push([o.body, seen[o.body]]); }
                        seen[o.body].push(o);
                    }
                    return `<div class="tourist-trip">${byBody.map(([body, os]) =>
                        `<div class="tourist-trip-body">
                            <span class="tourist-loc-tag">${escapeHtml(body)}</span>
                            ${os.map(o => `<span class="tourist-act-tag ${o.complete ? 'act-done' : 'act-pending'}">${o.complete ? '✓' : '○'} ${o.activity}</span>`).join('')}
                        </div>`).join('')}</div>`;
                }
                // Fallback: show flight-log activities if no contract objectives
                return t.locations.length ? `<div class="tourist-trip">${t.locations.map(l =>
                    `<div class="tourist-trip-body">
                        <span class="tourist-loc-tag">${escapeHtml(l.location)}</span>
                        ${l.activities && l.activities.length ? l.activities.map(a => `<span class="tourist-act-tag">${a}</span>`).join('') : ''}
                    </div>`).join('')}</div>` : '';
            })()}
        </div>`;
    }).join('');

    // ── Returned tourists: grouped by contract_guid ──
    const groups = new Map(); // guid → { agent, body, ut, tourists[] }
    for (const t of returned) {
        const key = t.contract_guid || `_${t.contract_ut}_${t.contract_body}`;
        if (!groups.has(key)) {
            groups.set(key, { agent: t.contract_agent, body: t.contract_body, ut: t.contract_ut, tourists: [] });
        }
        groups.get(key).tourists.push({ name: t.name, gender: t.gender });
    }

    const groupsSorted = [...groups.values()].sort((a, b) => (b.ut || 0) - (a.ut || 0));

    const returnedHtml = groupsSorted.length ? `
        <div class="tourist-returned-section">
            <div class="tourist-section-hdr">✅ RETURNED — ${returned.length} tourists in ${groupsSorted.length} missions</div>
            ${groupsSorted.map((g, gi) => `
            <div class="tourist-contract-group" style="animation-delay:${gi * 0.04}s">
                <div class="tcg-header">
                    ${g.body ? `<span class="tourist-body-badge">${escapeHtml(g.body)}</span>` : ''}
                    ${g.ut > 0 ? `<span class="tcg-date">📅 ${kspDateStr(g.ut)}</span>` : ''}
                    ${g.agent ? `<span class="tcg-agent">🏢 ${escapeHtml(g.agent)}</span>` : ''}
                    <span class="tcg-count">${g.tourists.length} tourist${g.tourists.length > 1 ? 's' : ''}</span>
                </div>
                <div class="tcg-names">${g.tourists.map(t =>
                    `<span class="tcg-name">${escapeHtml(t.name)}</span>`).join('')}
                </div>
            </div>`).join('')}
        </div>` : '';

    grid.innerHTML = activeHtml + returnedHtml;
}

// Load contracts
async function loadContracts() {
    try {
        const response = await fetch(`${API_BASE}/contracts`);
        const data = await response.json();

        if (response.ok && data.contracts) {
            contractsData = data.contracts;
            renderContracts(contractsData);
        }
    } catch (error) {
        console.error('Error loading contracts:', error);
        showToast('Error loading contracts', 'error');
    }
    loadContractProgress();
}

// Render contracts
function renderContracts(contracts) {
    const tbody = document.getElementById('contractsTableBody');
    
    if (contracts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center">No contracts found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = contracts.map((contract, index) => {
        const isTourism = contract.type === 'TourismContract';
        const fundsCell = isTourism
            ? `<span title="KSP does not save revenue for completed tourism contracts">🧳 ${contract.passengers} passengers</span>`
            : formatFunds(contract.total_funds);
        const avgCell = isTourism
            ? `<span style="color:var(--text-secondary)">—</span>`
            : formatFunds(contract.total_funds / contract.count);
        return `
        <tr style="animation-delay: ${index * 0.03}s"
            onclick="openContractDetail('${escapeHtml(contract.type).replace(/'/g,"\\'")}')">
            <td class="contract-type">${escapeHtml(contract.type)}</td>
            <td class="contract-count">${contract.count}</td>
            <td class="contract-funds">${fundsCell}</td>
            <td class="contract-avg">${avgCell}</td>
        </tr>`;
    }).join('');
}

// Show tab
function showTab(tabName, triggerEl) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const btn = triggerEl || document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    const panels = { kerbals: 'kerbalsTab', tourists: 'touristsTab', contracts: 'contractsTab', vessels: 'vesselsTab', achievements: 'achievementsTab', admin: 'adminTab' };
    const target = document.getElementById(panels[tabName]);
    if (target) target.classList.add('active');

    if (tabName === 'admin')        loadSystemInfo();
    if (tabName === 'contracts')   loadContractProgress();
    if (tabName === 'vessels')     loadVessels();
    if (tabName === 'achievements') loadAchievements();
}

// Load system info for Admin tab
async function loadSystemInfo() {
    try {
        const response = await fetch(`${API_BASE}/system-info`);
        if (!response.ok) return;
        const data = await response.json();
        const info = data.info;

        const meta = info.metadata;
        document.getElementById('parseHistoryGrid').innerHTML = `
            <div class="admin-info-card">
                <div class="admin-info-label">Last Parse</div>
                <div class="admin-info-value admin-info-mono">${meta.last_parsed ? formatDate(meta.last_parsed) : '—'}</div>
            </div>
            <div class="admin-info-card">
                <div class="admin-info-label">Total Parses</div>
                <div class="admin-info-value">${meta.parse_count}</div>
            </div>
            <div class="admin-info-card">
                <div class="admin-info-label">Hash File</div>
                <div class="admin-info-value admin-info-mono">${meta.file_hash ? meta.file_hash.slice(0, 12) + '…' : '—'}</div>
            </div>
        `;

        const bytes = info.db_size_bytes;
        const sizeStr = bytes > 1024 * 1024
            ? (bytes / (1024 * 1024)).toFixed(2) + ' MB'
            : (bytes / 1024).toFixed(1) + ' KB';
        document.getElementById('dbInfoGrid').innerHTML = `
            <div class="admin-info-card">
                <div class="admin-info-label">Kerbals in DB</div>
                <div class="admin-info-value">${info.db_rows.kerbals}</div>
            </div>
            <div class="admin-info-card">
                <div class="admin-info-label">Contract Types</div>
                <div class="admin-info-value">${info.db_rows.contracts}</div>
            </div>
            <div class="admin-info-card">
                <div class="admin-info-label">DB Size</div>
                <div class="admin-info-value">${sizeStr}</div>
            </div>
            <div class="admin-info-card">
                <div class="admin-info-label">DB Path</div>
                <div class="admin-info-value admin-info-mono">${escapeHtml(info.db_path)}</div>
            </div>
        `;
    } catch (error) {
        console.error('Error loading system info:', error);
    }
}

// Open Kerbal detail modal
async function openKerbalDetail(name) {
    const modal = document.getElementById('kerbalModal');
    modal.classList.add('modal-visible');

    document.getElementById('modalAvatar').textContent = '👨‍🚀';
    document.getElementById('modalName').textContent = name;
    document.getElementById('modalBadges').innerHTML = '';
    document.getElementById('modalAssignment').innerHTML = '';
    document.getElementById('modalStatsGrid').innerHTML = '<span style="color:var(--text-secondary)">Loading...</span>';
    document.getElementById('modalBars').innerHTML = '';
    document.getElementById('modalLocations').innerHTML = '';

    try {
        const res  = await fetch(`${API_BASE}/kerbals/${encodeURIComponent(name)}`);
        const data = await res.json();
        if (!res.ok || !data.kerbal) {
            showToast('Kerbal not found', 'error');
            closeKerbalDetail();
            return;
        }
        populateModal(data.kerbal);
    } catch (err) {
        console.error('Error loading kerbal detail:', err);
        showToast('Error loading kerbal details', 'error');
        closeKerbalDetail();
    }
}

function populateModal(k) {
    const trait      = TRAIT_BADGE[k.trait] || { cls: 'badge-unknown', label: k.trait || '—' };
    const level      = LEVEL_LABEL[k.experience_level] || 'TRAINEE';
    const avatar     = TRAIT_AVATAR[k.trait] || (k.gender === 'Female' ? '👩‍🚀' : '👨‍🚀');
    const stateCls   = STATE_BADGE_CLS[k.state] || 'state-available';
    const stateLabel = STATE_LABEL[k.state] || k.state;

    document.getElementById('modalAvatar').textContent = avatar;
    document.getElementById('modalName').textContent   = k.name;

    const badges = [
        `<span class="trait-badge ${trait.cls}">${trait.label}</span>`,
        `<span class="star-rating">${starRating(k.experience_level)}</span>`,
        `<span class="state-badge ${stateCls}">${stateLabel}</span>`,
    ];
    if (k.veteran)   badges.push('<span class="honor-badge badge-veteran">Veteran</span>');
    if (k.is_badass) badges.push('<span class="honor-badge badge-badass">Badass</span>');
    document.getElementById('modalBadges').innerHTML = badges.join('');

    const assignEl = document.getElementById('modalAssignment');
    if (k.current_location || k.current_vessel) {
        assignEl.innerHTML = `
            <span>📍</span>
            <span class="modal-assignment-loc">${escapeHtml(k.current_location)}</span>
            ${k.current_vessel ? `<span class="current-vessel-sep">•</span>
            <span>🚀</span>
            <span class="modal-assignment-vessel">${escapeHtml(k.current_vessel)}</span>` : ''}`;
    }

    document.getElementById('modalStatsGrid').innerHTML = `
        <div class="modal-stat">
            <div class="modal-stat-label">Rating</div>
            <div class="modal-stat-value">${k.experience.toFixed(1)}</div>
        </div>
        <div class="modal-stat">
            <div class="modal-stat-label">Missions</div>
            <div class="modal-stat-value">${k.flights}</div>
        </div>
        <div class="modal-stat">
            <div class="modal-stat-label">Locations</div>
            <div class="modal-stat-value">${k.locations.length}</div>
        </div>
        <div class="modal-stat">
            <div class="modal-stat-label">Level</div>
            <div class="modal-stat-value modal-stat-stars">${starRating(k.experience_level)}</div>
        </div>
        ${k.veteran ? `
        <div class="modal-stat">
            <div class="modal-stat-label">Joined</div>
            <div class="modal-stat-value">Veteran</div>
        </div>
        <div class="modal-stat">
            <div class="modal-stat-label">Service</div>
            <div class="modal-stat-value">${gameUt > 0 ? kspDurStr(gameUt) : '—'}</div>
        </div>` : k.hired_ut > 0 && gameUt > 0 ? `
        <div class="modal-stat">
            <div class="modal-stat-label">Joined</div>
            <div class="modal-stat-value">${kspDateStr(k.hired_ut)}</div>
        </div>
        <div class="modal-stat">
            <div class="modal-stat-label">Service</div>
            <div class="modal-stat-value">${kspDurStr(gameUt - k.hired_ut)}</div>
        </div>` : ''}
    `;

    document.getElementById('modalBars').innerHTML = `
        <div class="attr-bar-row">
            <span class="attr-label">Courage</span>
            <div class="attr-bar-track">
                <div class="attr-bar-fill attr-bar-courage" style="width:${(k.courage * 100).toFixed(0)}%"></div>
            </div>
            <span class="attr-pct">${(k.courage * 100).toFixed(0)}%</span>
        </div>
        <div class="attr-bar-row">
            <span class="attr-label">Stupidity</span>
            <div class="attr-bar-track">
                <div class="attr-bar-fill attr-bar-stupidity" style="width:${(k.stupidity * 100).toFixed(0)}%"></div>
            </div>
            <span class="attr-pct">${(k.stupidity * 100).toFixed(0)}%</span>
        </div>
    `;

    if (k.locations.length > 0) {
        document.getElementById('modalLocations').innerHTML = `
            <h4 class="modal-section-title">🌍 All Destinations (${k.locations.length})</h4>
            <div class="location-list">
                ${k.locations.map(loc => `
                <div class="location-item">
                    <span class="location-name">${escapeHtml(loc.location)}</span>
                    <span class="location-right">
                        <span class="location-count">${loc.count}×</span>
                        <span class="location-tier">+${bodyTier(loc.location)}</span>
                    </span>
                </div>`).join('')}
            </div>
        `;
    }
}

function closeKerbalDetail(event) {
    if (event && event.target !== document.getElementById('kerbalModal')) return;
    document.getElementById('kerbalModal').classList.remove('modal-visible');
}

// Show toast notification
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    
    const iconMap = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${iconMap[type] || iconMap.info}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s ease-out reverse';
        setTimeout(() => {
            container.removeChild(toast);
        }, 300);
    }, 5000);
}

// Utility functions
function formatFunds(amount) {
    if (typeof amount !== 'number') return '0';
    
    return amount.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }) + ' ₭';
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Contracts Progress Dashboard ──────────────────────────────────────

async function loadContractProgress() {
    try {
        const res  = await fetch(`${API_BASE}/contracts/progress`);
        const data = await res.json();
        if (data.success && data.data && data.data.summary.total_count > 0) {
            renderProgressDashboard(data.data);
            document.getElementById('contractProgress').style.display = 'flex';
        }
    } catch (err) {
        console.error('Error loading contract progress:', err);
    }
}

function renderProgressDashboard(data) {
    renderPrestigeTiles(data.by_prestige, data.summary);
    renderAreaChart(data.by_period, 'earningsChart', 'cumulative_funds');
    renderBarChart(data.by_period, 'earningsPerPeriodChart', 'funds', formatFunds);
    renderBarChart(data.by_period, 'activityChart', 'count');
    renderBodyBreakdown(data.by_body);
}

// ── Prestige tiles ────────────────────────────────────────────────────

function renderPrestigeTiles(p, summary) {
    const tiles = [
        { key: 'trivial',     icon: '🟢', label: 'Trivial',     cls: 'progress-tile-trivial' },
        { key: 'significant', icon: '🔵', label: 'Significant', cls: 'progress-tile-significant' },
        { key: 'exceptional', icon: '🟠', label: 'Exceptional', cls: 'progress-tile-exceptional' },
    ];
    document.getElementById('prestigeTiles').innerHTML = tiles.map(t => {
        const d = p[t.key] || { count: 0, funds: 0 };
        const pct = summary.total_count > 0
            ? ((d.count / summary.total_count) * 100).toFixed(0) : 0;
        return `
        <div class="progress-tile ${t.cls}">
            <div class="progress-tile-icon">${t.icon}</div>
            <div class="progress-tile-body">
                <div class="progress-tile-label">${t.label} — ${pct}% of contracts</div>
                <div class="progress-tile-count">${d.count}</div>
                <div class="progress-tile-funds">${formatFunds(d.funds)}</div>
            </div>
        </div>`;
    }).join('');
}

// ── SVG area chart (cumulative earnings) ─────────────────────────────

function renderAreaChart(bins, containerId, valueKey, formatFn = formatFunds) {
    const W = 800, H = 160, PAD = { top: 12, right: 16, bottom: 28, left: 58 };
    const iW = W - PAD.left - PAD.right;
    const iH = H - PAD.top  - PAD.bottom;

    const vals  = bins.map(b => b[valueKey]);
    const maxV  = Math.max(...vals) || 1;
    const n     = bins.length;

    const xS = i  => PAD.left + (i / (n - 1)) * iW;
    const yS = v  => PAD.top  + (1 - v / maxV) * iH;

    // area path
    const pts = bins.map((b, i) => `${xS(i).toFixed(1)},${yS(vals[i]).toFixed(1)}`).join(' ');
    const areaPath =
        `M${xS(0).toFixed(1)},${(PAD.top + iH).toFixed(1)} ` +
        bins.map((b, i) => `L${xS(i).toFixed(1)},${yS(vals[i]).toFixed(1)}`).join(' ') +
        ` L${xS(n - 1).toFixed(1)},${(PAD.top + iH).toFixed(1)} Z`;

    // x-axis labels — every 8 bins or so
    const step = Math.max(1, Math.floor(n / 6));
    const xLabels = bins
        .map((b, i) => i % step === 0
            ? `<text class="chart-axis-label" x="${xS(i).toFixed(1)}" y="${(PAD.top + iH + 14).toFixed(1)}" text-anchor="middle">${b.label}</text>`
            : '')
        .join('');

    // y-axis labels
    const yLabels = [0, 0.5, 1].map(f => {
        const v = f * maxV;
        const y = yS(v).toFixed(1);
        return `
        <line x1="${PAD.left}" y1="${y}" x2="${(PAD.left + iW).toFixed(1)}" y2="${y}"
              stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
        <text class="chart-value-label" x="${(PAD.left - 6).toFixed(1)}" y="${(+y + 3).toFixed(1)}"
              text-anchor="end">${formatFn(v)}</text>`;
    }).join('');

    const svgId = `svg_${containerId}`;
    const gradId = `grad_${containerId}`;

    const svg = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" id="${svgId}" preserveAspectRatio="none">
        <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stop-color="var(--accent-cyan)" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="var(--accent-cyan)" stop-opacity="0.03"/>
            </linearGradient>
        </defs>
        ${yLabels}
        <path d="${areaPath}" fill="url(#${gradId})"/>
        <polyline points="${pts}" fill="none" stroke="var(--accent-cyan)" stroke-width="2" stroke-linejoin="round"/>
        ${xLabels}
    </svg>`;

    document.getElementById(containerId).innerHTML = svg;
    attachAreaTooltip(svgId, bins, valueKey, xS, yS, PAD, iW, iH, formatFn);
}

function attachAreaTooltip(svgId, bins, valueKey, xS, yS, PAD, iW, iH, formatFn = formatFunds) {
    let tip = document.querySelector('.chart-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tooltip';
        document.body.appendChild(tip);
    }

    const svgEl = document.getElementById(svgId);
    if (!svgEl) return;

    svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const scaleX = 800 / rect.width;
        const svgX = (e.clientX - rect.left) * scaleX;
        const relX = svgX - PAD.left;
        const n = bins.length;
        const idx = Math.round((relX / iW) * (n - 1));
        if (idx < 0 || idx >= n) { tip.classList.remove('visible'); return; }
        const b = bins[idx];
        tip.textContent = `${b.label}  ${formatFn(b[valueKey])}`;
        tip.classList.add('visible');
        tip.style.left = `${e.clientX + 12}px`;
        tip.style.top  = `${e.clientY - 24}px`;
    });
    svgEl.addEventListener('mouseleave', () => tip.classList.remove('visible'));
}

// ── SVG bar chart (contracts per period) ─────────────────────────────

function renderBarChart(bins, containerId, valueKey, formatFn = null) {
    const W = 800, H = 140, PAD = { top: 12, right: 16, bottom: 28, left: 34 };
    const iW = W - PAD.left - PAD.right;
    const iH = H - PAD.top  - PAD.bottom;

    const vals  = bins.map(b => b[valueKey]);
    const maxV  = Math.max(...vals) || 1;
    const n     = bins.length;
    const barW  = Math.max(1, (iW / n) - 2);
    const xS    = i => PAD.left + (i / n) * iW + (iW / n - barW) / 2;

    const bars = bins.map((b, i) => {
        const bh = (vals[i] / maxV) * iH;
        const isMax = vals[i] === maxV;
        const color = isMax ? 'var(--accent-orange)' : 'var(--accent-cyan)';
        return `<rect x="${xS(i).toFixed(1)}" y="${(PAD.top + iH - bh).toFixed(1)}"
                      width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"
                      fill="${color}" opacity="0.75" rx="2"/>`;
    }).join('');

    // x-axis labels
    const step = Math.max(1, Math.floor(n / 6));
    const xLabels = bins.map((b, i) => i % step === 0
        ? `<text class="chart-axis-label" x="${(xS(i) + barW / 2).toFixed(1)}" y="${(PAD.top + iH + 14).toFixed(1)}" text-anchor="middle">${b.label}</text>`
        : '').join('');

    // y-axis max label — use formatter if provided, otherwise raw integer
    const fmtMax = formatFn ? formatFn(maxV) : String(maxV);
    const yLabel = `<text class="chart-axis-label" x="${PAD.left - 4}" y="${(PAD.top + 4).toFixed(1)}" text-anchor="end">${fmtMax}</text>`;

    const svgId = `svg_${containerId}`;

    const svg = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" id="${svgId}" preserveAspectRatio="none">
        <line x1="${PAD.left}" y1="${PAD.top + iH}" x2="${PAD.left + iW}" y2="${PAD.top + iH}"
              stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
        ${yLabel}
        ${bars}
        ${xLabels}
    </svg>`;

    document.getElementById(containerId).innerHTML = svg;
    attachBarTooltip(svgId, bins, valueKey, xS, barW, PAD, iW, iH, formatFn);
}

function attachBarTooltip(svgId, bins, valueKey, xS, barW, PAD, iW, iH, formatFn = null) {
    let tip = document.querySelector('.chart-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tooltip';
        document.body.appendChild(tip);
    }

    const svgEl = document.getElementById(svgId);
    if (!svgEl) return;

    svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const scaleX = 800 / rect.width;
        const svgX = (e.clientX - rect.left) * scaleX;
        const n = bins.length;
        const idx = Math.floor(((svgX - PAD.left) / iW) * n);
        if (idx < 0 || idx >= n) { tip.classList.remove('visible'); return; }
        const b = bins[idx];
        const val = formatFn ? formatFn(b[valueKey]) : `${b[valueKey]}`;
        tip.textContent = `${b.label}  ${val}`;
        tip.classList.add('visible');
        tip.style.left = `${e.clientX + 12}px`;
        tip.style.top  = `${e.clientY - 24}px`;
    });
    svgEl.addEventListener('mouseleave', () => tip.classList.remove('visible'));
}

// ── Body breakdown horizontal bars ───────────────────────────────────

function renderBodyBreakdown(bodies, containerId = 'bodyBreakdown') {
    if (!bodies.length) {
        document.getElementById(containerId).innerHTML =
            '<p style="color:var(--text-secondary);font-size:.8rem;">No destination data</p>';
        return;
    }
    const maxCount = bodies[0].count;
    document.getElementById(containerId).innerHTML = bodies.map(b => `
        <div class="body-bar-row">
            <span class="body-bar-name" title="${escapeHtml(b.body)}">${escapeHtml(b.body)}</span>
            <div class="body-bar-track">
                <div class="body-bar-fill" style="width:${((b.count / maxCount) * 100).toFixed(1)}%"></div>
            </div>
            <span class="body-bar-count">${b.count}</span>
        </div>`).join('');
}

// ── Contract Detail Modal ─────────────────────────────────────────────

const CONTRACT_ICONS = {
    ISRUContract:                '⛏️',
    RecoverAsset:                '🪂',
    RoverConstructionContract:   '🚗',
    SurveyContract:              '🗺️',
    VesselRepairContract:        '🔧',
    BaseContract:                '🏠',
    CollectScience:              '🔬',
    SatelliteContract:           '📡',
    StationContract:             '🛸',
    OrbitalConstructionContract: '🏗️',
    ExplorationContract:         '🌍',
    ARMContract:                 '☄️',
    PlantFlag:                   '🚩',
    PartTest:                    '🧪',
    TourismContract:             '🧳',
};

async function openContractDetail(contractType) {
    const modal = document.getElementById('contractModal');
    modal.classList.add('modal-visible');

    const icon = CONTRACT_ICONS[contractType] || '📋';
    document.getElementById('contractModalIcon').textContent = icon;
    document.getElementById('contractModalTitle').textContent = contractType;
    document.getElementById('contractModalBadges').innerHTML = '';
    document.getElementById('contractModalTiles').innerHTML =
        '<span style="color:var(--text-secondary);font-size:.85rem;">Loading...</span>';
    document.getElementById('contractModalEarningsChart').innerHTML = '';
    document.getElementById('contractModalActivityChart').innerHTML = '';
    document.getElementById('contractModalBodies').innerHTML = '';

    try {
        const res  = await fetch(`${API_BASE}/contracts/progress?type=${encodeURIComponent(contractType)}`);
        const data = await res.json();
        if (!res.ok || !data.success) { showToast('Error loading contract data', 'error'); return; }
        populateContractModal(contractType, data.data);
    } catch (err) {
        console.error('Contract detail error:', err);
        showToast('Error loading contract data', 'error');
    }
}

function populateContractModal(contractType, data) {
    const isTourism = data.metric === 'passengers';
    const s = data.summary;

    // summary tiles
    const tile1Val   = isTourism ? s.total_passengers : formatFunds(s.total_funds);
    const tile1Label = isTourism ? 'Total Passengers' : 'Total Earnings';
    const tile1Icon  = isTourism ? '🧳' : '💰';

    document.getElementById('contractModalTiles').innerHTML = `
        <div class="progress-tile" style="border-left:3px solid var(--accent-cyan);">
            <div class="progress-tile-icon">${tile1Icon}</div>
            <div class="progress-tile-body">
                <div class="progress-tile-label">${tile1Label}</div>
                <div class="progress-tile-count" style="color:var(--accent-cyan);">${tile1Val}</div>
            </div>
        </div>
        <div class="progress-tile" style="border-left:3px solid var(--accent-green);">
            <div class="progress-tile-icon">📋</div>
            <div class="progress-tile-body">
                <div class="progress-tile-label">Completed</div>
                <div class="progress-tile-count" style="color:var(--accent-green);">${s.total_count}</div>
            </div>
        </div>
        <div class="progress-tile" style="border-left:3px solid var(--accent-orange);">
            <div class="progress-tile-icon">📅</div>
            <div class="progress-tile-body">
                <div class="progress-tile-label">Period</div>
                <div class="progress-tile-count" style="font-size:1rem;color:var(--accent-orange);">${s.start_label} → ${s.end_label}</div>
            </div>
        </div>`;

    // chart title + cumulative key
    const cumKey   = isTourism ? 'cumulative_passengers' : 'cumulative_funds';
    const chartLbl = isTourism ? '🧳 Cumulative Passengers' : '💰 Cumulative Earnings';
    document.getElementById('contractModalChartTitle').textContent = chartLbl;

    const numFmt          = isTourism ? (v => String(Math.round(v))) : formatFunds;
    const perPeriodKey    = isTourism ? 'passengers' : 'funds';
    const perPeriodTitle  = isTourism ? '🧳 Passengers per Period' : '💰 Earnings per Period';
    document.getElementById('contractModalPerPeriodTitle').textContent = perPeriodTitle;
    renderAreaChart(data.by_period, 'contractModalEarningsChart',          cumKey,        numFmt);
    renderBarChart( data.by_period, 'contractModalEarningsPerPeriodChart', perPeriodKey,  numFmt);
    renderBarChart( data.by_period, 'contractModalActivityChart',        'count');
    renderBodyBreakdown(data.by_body, 'contractModalBodies');
}

function closeContractDetail(event) {
    if (event && event.target !== document.getElementById('contractModal')) return;
    document.getElementById('contractModal').classList.remove('modal-visible');
}

// ── Vessels Tab ───────────────────────────────────────────────────────

let vesselsData = [];

async function loadVessels() {
    try {
        const res  = await fetch(`${API_BASE}/vessels`);
        const data = await res.json();
        if (data.vessels) {
            vesselsData = data.vessels;
            document.getElementById('vesselTotal').textContent = data.count;
            applyVesselFilters();
        }
    } catch (err) { console.error('Error loading vessels:', err); }
}

function vesselLocType(loc) {
    if (!loc) return 'unknown';
    if (loc.includes('(landed)') || loc.includes('LANDED') || loc.includes('PRELAUNCH')) return 'landed';
    if (loc.includes('(splashed)')) return 'splashed';
    if (loc.startsWith('Orbiting '))  return 'orbit';
    if (loc.startsWith('Sub-orbital')) return 'suborbit';
    if (loc.startsWith('Escaping'))   return 'escape';
    return 'unknown';
}

function vesselLocLabel(loc) {
    if (!loc) return '?';
    if (loc.includes('(landed)'))     return '🛬 ' + loc.replace(' (landed)', '');
    if (loc.includes('(splashed)'))   return '🌊 ' + loc.replace(' (splashed)', '');
    if (loc.startsWith('Orbiting '))  return '🔄 ' + loc.replace('Orbiting ', '');
    if (loc.startsWith('Sub-orbital'))return '↗ ' + loc;
    if (loc.startsWith('Escaping'))   return '🚀 ' + loc;
    return '📍 ' + loc;
}

const VESSEL_LOC_CLS = {
    orbit:    'vloc-orbit',
    landed:   'vloc-landed',
    splashed: 'vloc-splashed',
    suborbit: 'vloc-suborbit',
    escape:   'vloc-escape',
    unknown:  'vloc-unknown',
};

function applyVesselFilters() {
    const search    = (document.getElementById('vesselSearch').value || '').toLowerCase();
    const sortKey   = document.getElementById('vesselSortSelect').value;
    const locFilter = document.getElementById('vesselLocFilter').value;

    let filtered = vesselsData.filter(v => {
        if (locFilter !== 'all' && vesselLocType(v.location) !== locFilter) return false;
        if (!search) return true;
        return v.name.toLowerCase().includes(search) ||
               v.location.toLowerCase().includes(search) ||
               v.crew.some(c => c.name.toLowerCase().includes(search));
    });

    const sorts = {
        name:      (a, b) => a.name.localeCompare(b.name),
        crew:      (a, b) => b.crew_count - a.crew_count,
        pilot:     (a, b) => b.best_pilot     - a.best_pilot     || a.name.localeCompare(b.name),
        engineer:  (a, b) => b.best_engineer  - a.best_engineer  || a.name.localeCompare(b.name),
        scientist: (a, b) => b.best_scientist - a.best_scientist || a.name.localeCompare(b.name),
    };
    filtered.sort(sorts[sortKey] || sorts.name);

    document.getElementById('vesselShowing').textContent = filtered.length;
    renderVessels(filtered);
}

function renderVessels(vessels) {
    const grid = document.getElementById('vesselsGrid');
    if (!vessels.length) {
        grid.innerHTML = '<p class="text-center" style="color:var(--text-secondary);padding:2rem;grid-column:1/-1;">No vessels match the current filters.</p>';
        return;
    }

    grid.innerHTML = vessels.map((v, i) => {
        const locType  = vesselLocType(v.location);
        const locLabel = vesselLocLabel(v.location);
        const locCls   = VESSEL_LOC_CLS[locType] || 'vloc-unknown';

        const byTrait = { Pilot: [], Engineer: [], Scientist: [] };
        for (const c of v.crew) if (byTrait[c.trait]) byTrait[c.trait].push(c);
        Object.values(byTrait).forEach(arr => arr.sort((a, b) => b.experience_level - a.experience_level));

        const capsule = ['Pilot','Engineer','Scientist'].map(trait => {
            const arr  = byTrait[trait];
            const best = arr[0];
            if (!best) return `<div class="vessel-cap vessel-cap--empty"><span class="vessel-cap-icon">${TRAIT_AVATAR[trait]}</span><span class="vessel-cap-none">—</span></div>`;
            const extras = arr.length > 1 ? `<span class="vessel-cap-extra">+${arr.length - 1}</span>` : '';
            return `<div class="vessel-cap">
                <span class="vessel-cap-icon">${TRAIT_AVATAR[trait]}</span>
                <span class="vessel-cap-stars">${starRating(best.experience_level)}</span>
                <span class="vessel-cap-name">${escapeHtml(best.name.replace(' Kerman', ''))}</span>
                ${extras}
            </div>`;
        }).join('');

        const crewPills = v.crew.map(c => {
            const avatar = TRAIT_AVATAR[c.trait] || (c.gender === 'Female' ? '👩‍🚀' : '👨‍🚀');
            const badges = [];
            if (c.veteran)   badges.push('V');
            if (c.is_badass) badges.push('B');
            const suffix = badges.length ? ` <span class="vessel-crew-badge">${badges.join('')}</span>` : '';
            const traitCls = c.trait ? `vcrew-${c.trait.toLowerCase()}` : '';
            return `<span class="vessel-crew-pill ${traitCls}" title="${escapeHtml(c.name)} · ${c.trait} ${starRating(c.experience_level)} · ${c.flights} flights">
                ${avatar} ${escapeHtml(c.name.replace(' Kerman', ''))}${suffix} <span class="vessel-crew-stars">${'★'.repeat(c.experience_level)}</span>
            </span>`;
        }).join('');

        return `<div class="vessel-card" style="animation-delay:${i * 0.04}s">
            <div class="vessel-header">
                <div class="vessel-name-row">
                    <span class="vessel-icon">🚀</span>
                    <h3 class="vessel-name">${escapeHtml(v.name)}</h3>
                    <span class="vessel-crew-count">${v.crew_count} crew</span>
                </div>
                <div class="vessel-loc ${locCls}">${locLabel}</div>
            </div>
            <div class="vessel-caps">${capsule}</div>
            <div class="vessel-crew-list">${crewPills}</div>
        </div>`;
    }).join('');
}

// ── Achievements Tab ──────────────────────────────────────────────────

async function loadAchievements() {
    try {
        const res  = await fetch(`${API_BASE}/achievements`);
        const data = await res.json();
        renderAchievements(data);
    } catch (err) {
        console.error('Error loading achievements:', err);
    }
}

const BODY_ORDER = [
    { name: 'Kerbin',  emoji: '🌍', color: '#3ddc84' },
    { name: 'Mun',     emoji: '🌑', color: '#8fa3c7' },
    { name: 'Minmus',  emoji: '🟢', color: '#5ecfa3' },
    { name: 'Eve',     emoji: '🟣', color: '#b468d8' },
    { name: 'Gilly',   emoji: '🪨', color: '#8b7355' },
    { name: 'Duna',    emoji: '🔴', color: '#ff6b35' },
    { name: 'Ike',     emoji: '⚫', color: '#7a8a9c' },
    { name: 'Moho',    emoji: '🟤', color: '#c47c4a' },
    { name: 'Dres',    emoji: '💠', color: '#5ba3cc' },
    { name: 'Jool',    emoji: '🟩', color: '#4aaa5e' },
    { name: 'Laythe',  emoji: '🌊', color: '#00d9ff' },
    { name: 'Vall',    emoji: '❄️',  color: '#a8d8ea' },
    { name: 'Tylo',    emoji: '🔵', color: '#5ba3f5' },
    { name: 'Bop',     emoji: '🟤', color: '#8b6914' },
    { name: 'Pol',     emoji: '💛', color: '#c9a832' },
    { name: 'Eeloo',   emoji: '⚪', color: '#b0b8c8' },
    { name: 'Sun',     emoji: '☀️',  color: '#ffd93d' },
];

const ACH_DISPLAY = [
    { key: 'Flyby',               label: 'Flyby' },
    { key: 'Orbit',               label: 'Orbit' },
    { key: 'Suborbit',            label: 'Suborbit' },
    { key: 'Escape',              label: 'Escape' },
    { key: 'Flight',              label: 'Flight' },
    { key: 'Landing',             label: 'Landing' },
    { key: 'Splashdown',          label: 'Splashdown' },
    { key: 'SurfaceEVA',          label: 'EVA' },
    { key: 'Spacewalk',           label: 'Spacewalk' },
    { key: 'FlagPlant',           label: 'Flag' },
    { key: 'Science',             label: 'Science' },
    { key: 'Rendezvous',          label: 'Rendezvous' },
    { key: 'Docking',             label: 'Docking' },
    { key: 'BaseConstruction',    label: 'Base' },
    { key: 'StationConstruction', label: 'Station' },
    { key: 'ReturnFromOrbit',     label: 'Rtn↑Orbit' },
    { key: 'ReturnFromSurface',   label: 'Rtn↓Surface' },
];

const MILESTONE_CONFIG = [
    { key: 'FirstLaunch',        label: 'First Launch',        icon: '🚀' },
    { key: 'ReachedSpace',       label: 'Reached Space',       icon: '⭐' },
    { key: 'FirstCrewToSurvive', label: 'First Crew Survived', icon: '🦺' },
    { key: 'KSCLanding',         label: 'KSC Landing',         icon: '🏁' },
    { key: 'RunwayLanding',      label: 'Runway Landing',      icon: '✈️' },
    { key: 'RecordsAltitude',    label: 'Altitude Record',     icon: '📏' },
    { key: 'RecordsSpeed',       label: 'Speed Record',        icon: '⚡' },
    { key: 'RecordsDistance',    label: 'Distance Record',     icon: '📐' },
    { key: 'RecordsDepth',       label: 'Depth Record',        icon: '🌊' },
];

function renderAchievements(data) {
    const el = document.getElementById('achievementsContent');
    if (!data || (Object.keys(data.global || {}).length === 0 && Object.keys(data.bodies || {}).length === 0)) {
        el.innerHTML = '<p class="text-center" style="color:var(--text-secondary);padding:3rem;">Parse the save file to load achievements.</p>';
        return;
    }

    const globalHtml  = renderMilestones(data.global || {});
    const bodiesHtml  = renderBodyGrid(data.bodies || {});
    el.innerHTML = globalHtml + bodiesHtml;
}

function renderMilestones(global) {
    const known = MILESTONE_CONFIG.filter(m => global[m.key]);
    const pois  = Object.entries(global)
        .filter(([k]) => k.startsWith('POI') && global[k].ut)
        .sort(([,a],[,b]) => (a.ut || 0) - (b.ut || 0));

    if (!known.length && !pois.length) return '';

    const cards = known.map(m => {
        const ach = global[m.key];
        const date = ach.ut ? kspDateStr(ach.ut) : '—';
        const crew = ach.crew && ach.crew.length ? ach.crew.slice(0, 2).join(', ') + (ach.crew.length > 2 ? ` +${ach.crew.length - 2}` : '') : '';
        const vessel = ach.vessel ? ach.vessel.name : '';
        return `<div class="milestone-card milestone-card--done">
            <div class="milestone-icon">${m.icon}</div>
            <div class="milestone-body">
                <div class="milestone-label">${m.label}</div>
                <div class="milestone-date">${date}</div>
                ${vessel ? `<div class="milestone-detail">🚀 ${escapeHtml(vessel)}</div>` : ''}
                ${crew ? `<div class="milestone-detail">👨‍🚀 ${escapeHtml(crew)}</div>` : ''}
            </div>
        </div>`;
    }).join('');

    const poiCards = pois.map(([key, ach]) => {
        const label = key.replace(/^POI/, '').replace(/([A-Z])/g, ' $1').trim();
        const date  = ach.ut ? kspDateStr(ach.ut) : '—';
        const vessel = ach.vessel ? ach.vessel.name : '';
        return `<div class="milestone-card milestone-card--poi">
            <div class="milestone-icon">📍</div>
            <div class="milestone-body">
                <div class="milestone-label">${escapeHtml(label)}</div>
                <div class="milestone-date">${date}</div>
                ${vessel ? `<div class="milestone-detail">🚀 ${escapeHtml(vessel)}</div>` : ''}
            </div>
        </div>`;
    }).join('');

    return `
    <div class="ach-section">
        <div class="panel-header"><h2>🏆 Programme Milestones</h2></div>
        <div class="milestone-grid">${cards}</div>
        ${pois.length ? `<div class="panel-header" style="margin-top:1.5rem;"><h3 class="ach-subsection-title">📍 Points of Interest (${pois.length})</h3></div><div class="milestone-grid milestone-grid--poi">${poiCards}</div>` : ''}
    </div>`;
}

function renderBodyGrid(bodies) {
    const cards = BODY_ORDER.map(b => {
        const bd = bodies[b.name];
        if (!bd) {
            return `<div class="body-ach-card body-ach-card--locked">
                <div class="body-ach-header" style="--body-color:${b.color}">
                    <span class="body-emoji">${b.emoji}</span>
                    <span class="body-name">${b.name}</span>
                    <span class="body-reached body-reached--never">not reached</span>
                </div>
                <div class="body-ach-badges body-ach-badges--locked">
                    <span class="ach-lock">🔒 Unexplored</span>
                </div>
            </div>`;
        }

        const reached = bd.reached ? kspDateStr(bd.reached) : '?';
        const achs    = bd.achievements || {};
        const total   = ACH_DISPLAY.filter(a => achs[a.key]).length;

        const badges = ACH_DISPLAY.map(a => {
            const ach = achs[a.key];
            if (!ach) {
                return `<span class="ach-badge ach-badge--locked" title="${a.label}: not achieved">${a.label}</span>`;
            }
            const cls   = ach.manned === false ? 'ach-badge--unmanned' : 'ach-badge--manned';
            const title = buildAchTooltip(a.label, ach);
            return `<span class="ach-badge ${cls}" title="${escapeHtml(title)}">${a.label}</span>`;
        }).join('');

        return `<div class="body-ach-card">
            <div class="body-ach-header" style="--body-color:${b.color}">
                <span class="body-emoji">${b.emoji}</span>
                <span class="body-name">${b.name}</span>
                <span class="body-reached">reached ${reached}</span>
                <span class="body-ach-count">${total}/${ACH_DISPLAY.length}</span>
            </div>
            <div class="body-ach-badges">${badges}</div>
        </div>`;
    }).join('');

    return `
    <div class="ach-section" style="margin-top:2rem;">
        <div class="panel-header"><h2>🌍 Solar System Progress</h2></div>
        <div class="body-ach-grid">${cards}</div>
    </div>`;
}

function buildAchTooltip(label, ach) {
    const parts = [label];
    if (ach.ut)    parts.push(kspDateStr(ach.ut));
    if (ach.manned === false) parts.push('unmanned');
    if (ach.vessel && ach.vessel.name) parts.push('🚀 ' + ach.vessel.name);
    if (ach.crew  && ach.crew.length)  parts.push('👨‍🚀 ' + ach.crew.slice(0, 3).join(', '));
    return parts.join(' · ');
}
