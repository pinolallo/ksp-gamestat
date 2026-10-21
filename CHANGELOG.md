# Changelog

All notable changes to KSP GameStats are documented here.

---

## [Unreleased]

---

## [1.3.0] — 2026-10-21

### Added

#### Crewed Vessels Tab
- New **Vessels** tab listing all currently crewed vessels parsed from the active save file
- Vessel **type** read directly from the `.sfs` VESSEL block (`Ship`, `Station`, `Base`, `Rover`, `SpacePlane`, `Lander`, `Relay`…) and stored per-kerbal in the DB
- Human-readable **location labels**: "Landed on Duna", "Orbiting Kerbin", "Splashed on Eve", "Sub-orbital over Kerbin", "Escaping Jool SOI", "At Kerbin Space Centre" — no emoji in description text
- Per-vessel card shows: type tag, location badge (colour-coded by situation), best Pilot/Engineer/Scientist level aboard, and full crew roster
- Card **icon** adapts to vessel type (🛸 Station, 🏗 Base, 🚀 Spacecraft, ✈ Spaceplane, 🚗 Rover, etc.)
- **Search** by vessel name or crew member name; **sort** by name, crew size, or best trait level; **filter** by location type (orbiting / landed / splashed / sub-orbital / escaping)
- `current_vessel_type` column added to the `kerbals` table with auto-migration

#### Achievements Tab
- New **Achievements** tab parsing the `ProgressTracking` SCENARIO block
- **Programme Milestones** section: first launch, first orbit, first Mun landing, first flag planted, first crew recovery — each showing KSP in-game date, crew name, and vessel name
- **Body Achievement Grid**: for every celestial body in the Kerbol system, shows which of reached / landed / flag planted have been accomplished, with manned/unmanned distinction and tooltips

#### Cross-navigation
- **Vessel crew pills → Kerbal card**: clicking any crew member pill in the Vessels tab opens their kerbal detail modal
- **Kerbal card → Vessel**: the vessel name shown at the bottom of each kerbal card (and in the kerbal detail modal) is a clickable link; clicking it switches to the Vessels tab, filters to that vessel, and highlights it with a cyan pulse animation
- **Tourist cards → Vessel**: same vessel link in the tourist roster

#### macOS LaunchAgent Deploy Script (`deploy-mac.sh`)
- Single script managing the full service lifecycle: `install | uninstall | start | stop | restart | status | logs | open`
- Installs a `~/Library/LaunchAgents/com.sdipietro.ksp-gamestat.plist` with `KeepAlive=true` and `RunAtLoad=true` (auto-restart on crash, auto-start at login)
- Logs to `~/Library/Logs/ksp-gamestat/`
- `start` command kills any stale process holding the configured port before loading the agent — prevents `EADDRINUSE` on restart

#### Other
- `npm run serve` script added to `package.json` for quick browser-mode launch without Electron
- `GET /api/vessels` endpoint — groups assigned kerbals by vessel, aggregates best trait levels
- `GET /api/achievements` endpoint — returns stored JSON from config table

### Fixed
- **Level 4 XP threshold**: was 32, corrected to 24. Kerbals with 24–31 XP (e.g., those who have fully explored Kerbin, Mun, Minmus, and begun Duna/Ike missions) were showing 3 stars instead of 4. Root cause: `KSP_LEVELS` constant had an incorrect threshold; `experienceLevel` is not stored in the `.sfs` file (KSP 1.12) and must be computed.
- **Cross-navigation onclick broken**: vessel name links and crew pills used `JSON.stringify()` to embed strings in `onclick=""` attributes, which produced double-quoted strings that broke the HTML attribute. Fixed by using single-quoted escaped strings in all four occurrences.
- **Stale process on port at service start**: `deploy-mac.sh start` now kills any process holding the port with `lsof -ti:<PORT> | xargs kill -9` before calling `launchctl load`, preventing the new instance from failing to bind.

---

## [1.2.0] — 2026-10 (earlier sessions)

### Added
- **`GET /api/vessels`** — initial vessels endpoint grouping assigned kerbals by current vessel
- **Vessels tab** (initial version) — grid of vessel cards with crew pills, location badge, capability strip
- **`GET /api/achievements`** — achievements endpoint backed by config table JSON
- **Achievements tab** (initial version) — milestones and body grid
- **`deploy-mac.sh`** (initial version) — LaunchAgent install/manage script
- **`npm run serve`** script

---

## [1.1.0] — 2026-10

### Changed
- Backend rewritten from **Python / Flask / PyInstaller** to **Node.js / Express / better-sqlite3** — eliminates the need for a separate Python runtime; runs directly with `node server/server.js`

### Added
- **`GET /api/scan-saves`** — auto-detects `persistent.sfs` files under the KSP installation directory
- **`GET /api/kerbals/:name`** — single kerbal detail endpoint (previously missing, causing the detail modal to always fail)
- **`GET /api/system-info`** — DB size and parse history
- Save file browser modal in the Admin tab
- `start.sh` updated for Node.js

### Fixed
- `/api/config` was not returning the `configured` flag, causing the UI to always show the unconfigured state
- Contract progress endpoint used 30-day bins regardless of career length; switched to day-based adaptive binning

---

## [1.0.0] — 2026-09 (initial public release)

### Features at launch
- **Kerbal Roster** — star rating, trait badges, mission count, location history, join date, service duration, corps breakdown bar
- **Tourist Roster** — flying tourists with per-body contract objectives and completion status; returned tourists grouped by mission with KSP date and agency
- **Contracts Dashboard** — summary tiles, cumulative earnings curve, per-period bars, prestige breakdown
- **Contract Drill-down** — click any contract type for its own filtered charts
- **Kerbal Detail Modal** — courage/stupidity bars, full destination list with visit counts and XP tier
- **Incremental parsing** — MD5 hash check skips unchanged saves; force-refresh option
- **Schema auto-migration** — `ALTER TABLE … ADD COLUMN` migrations run on startup, allowing DB to survive app upgrades without manual intervention
- **Accurate visit deduplication** — multiple events in the same mission (Flyby + Orbit + Land) count as one visit
- **Space-themed UI** — Orbitron / IBM Plex Mono, animated starfield, cyan-orange palette
- **MIT License**

---

[Unreleased]: https://github.com/pinolallo/ksp-gamestat/compare/HEAD...HEAD
[1.3.0]: https://github.com/pinolallo/ksp-gamestat/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/pinolallo/ksp-gamestat/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pinolallo/ksp-gamestat/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/pinolallo/ksp-gamestat/releases/tag/v1.0.0
