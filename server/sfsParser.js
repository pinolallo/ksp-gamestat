'use strict';
const fs       = require('fs');
const readline = require('readline');
const crypto   = require('crypto');

const KSP_YEAR_SECONDS = 9203544;
const KSP_DAY_SECONDS  = 21600;

const BODY_NAMES = {
    0: 'Sun',  1: 'Kerbin', 2: 'Mun',    3: 'Minmus', 4: 'Moho',
    5: 'Eve',  6: 'Duna',   7: 'Ike',    8: 'Jool',   9: 'Laythe',
    10: 'Vall', 11: 'Bop',  12: 'Tylo',  13: 'Gilly', 14: 'Pol',
    15: 'Dres', 16: 'Eeloo',
};

const BODY_ACTIVITY_XP = {
    Sun:    { Flyby: 3.0, Orbit: 6.0 },
    Kerbin: { Flight: 0.5, Suborbit: 0.5, Orbit: 0.5, Flyby: 0.5, Land: 0.5, Splashdown: 0.5, PlantFlag: 0.5, Crash: 0.5 },
    Mun:    { Flyby: 0.5, Orbit: 1.5, Land: 3.0, PlantFlag: 3.0, Crash: 3.0 },
    Minmus: { Flyby: 0.5, Orbit: 1.5, Land: 4.0, PlantFlag: 4.0 },
    Eve:    { Flight: 0.5, Flyby: 1.0, Orbit: 2.5, Land: 7.0, Splashdown: 7.0 },
    Gilly:  { Flyby: 0.5, Orbit: 1.5, Land: 2.5 },
    Duna:   { Flight: 0.5, Suborbit: 1.0, Flyby: 1.0, Orbit: 2.5, Land: 8.0 },
    Ike:    { Flyby: 1.0, Orbit: 2.5, Land: 4.0 },
    Moho:   { Flyby: 1.5, Orbit: 3.5, Land: 9.0 },
    Dres:   { Flyby: 1.5, Orbit: 3.5, Land: 7.0 },
    Jool:   { Flight: 1.0, Flyby: 2.0, Orbit: 4.0 },
    Laythe: { Flight: 1.0, Flyby: 2.0, Orbit: 4.5, Land: 7.0, Splashdown: 7.0 },
    Vall:   { Flyby: 2.0, Orbit: 4.5, Land: 5.0 },
    Tylo:   { Flyby: 2.5, Orbit: 5.0, Land: 10.0 },
    Bop:    { Flyby: 2.0, Orbit: 4.5, Land: 5.0, PlantFlag: 5.0 },
    Pol:    { Flyby: 2.0, Orbit: 4.5, Land: 5.0 },
    Eeloo:  { Flyby: 2.5, Orbit: 5.5, Land: 12.0 },
};
const KSP_LEVELS = [2, 6, 16, 32, 64];

const FLIGHT_EVENTS = new Set([
    'Flight', 'Suborbit', 'Orbit', 'Flyby', 'Escape',
    'Land', 'Splashdown', 'Crash', 'PlantFlag',
]);

function utToKspDate(ut) {
    const year = Math.floor(ut / KSP_YEAR_SECONDS) + 1;
    const day  = Math.floor((ut % KSP_YEAR_SECONDS) / KSP_DAY_SECONDS) + 1;
    return { year, day };
}

function makeKerbal(name) {
    return {
        name, flights: 0, locations: {}, isTourist: false,
        trait: '', state: 'Available', experienceLevel: 0, experience: 0.0,
        courage: 0.0, stupidity: 0.0, gender: 'Male', veteran: false,
        isBadass: false, currentLocation: '', currentVessel: '', currentVesselType: '', hiredUt: 0.0,
        bodyActivities: {}, bodyMissions: {},
    };
}

function makeTourist(name) {
    return {
        name, state: 'Returned', flights: 0,
        courage: 0.0, stupidity: 0.0, gender: 'Male',
        currentLocation: '', currentVessel: '',
        contractUt: 0.0, contractBody: '', contractAgent: '', contractGuid: '',
        locations: {}, bodyMissions: {}, bodyActivities: {}, objectives: [],
    };
}

async function* readLines(filepath) {
    const rl = readline.createInterface({
        input: fs.createReadStream(filepath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) yield line;
}

function val(s) { return s.split('=', 2)[1].trim(); }

class SFSParser {
    constructor(filepath) { this.filepath = filepath; }

    calculateFileHash() {
        const hash = crypto.createHash('md5');
        return new Promise((resolve, reject) => {
            const stream = fs.createReadStream(this.filepath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end',  () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    // ── Kerbal Roster ─────────────────────────────────────────────────────────
    async parseKerbalRoster() {
        const kerbals = {};
        let inRoster = false, inKerbal = false, indent = 0;
        let name = null, type = null, trait = '', state = 'Available';
        let expLevel = 0, exp = 0.0, courage = 0.0, stupidity = 0.0;
        let gender = 'Male', veteran = false, isBadass = false;

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if (inKerbal && indent === 1) {
                    const isTourist   = type === 'Tourist' || trait === 'Tourist';
                    const isApplicant = type === 'Applicant';
                    if (name && !isTourist && !isApplicant && !kerbals[name]) {
                        const k = makeKerbal(name);
                        Object.assign(k, { trait, state, experienceLevel: expLevel, experience: exp, courage, stupidity, gender, veteran, isBadass });
                        kerbals[name] = k;
                    }
                    name = null; type = null; inKerbal = false;
                } else if (inRoster && indent === 0) { inRoster = false; }
            }
            if (s === 'ROSTER') { inRoster = true; indent = 0; }
            else if (inRoster && s === 'KERBAL') {
                inKerbal = true; indent = 1;
                name = null; type = null; trait = ''; state = 'Available';
                expLevel = 0; exp = 0.0; courage = 0.0; stupidity = 0.0;
                gender = 'Male'; veteran = false; isBadass = false;
            } else if (inKerbal && indent === 2) {
                if      (s.startsWith('name ='))              name      = val(s);
                else if (s.startsWith('type ='))              type      = val(s);
                else if (s.startsWith('trait ='))             trait     = val(s);
                else if (s.startsWith('state ='))             state     = val(s);
                else if (s.startsWith('brave ='))             courage   = parseFloat(val(s)) || 0;
                else if (s.startsWith('dumb ='))              stupidity = parseFloat(val(s)) || 0;
                else if (s.startsWith('experienceLevel ='))   expLevel  = parseInt(val(s))   || 0;
                else if (s.startsWith('experience ='))        exp       = parseFloat(val(s)) || 0;
                else if (s.startsWith('gender ='))            gender    = val(s);
                else if (s.startsWith('veteran ='))           veteran   = val(s).toLowerCase() === 'true';
                else if (s.startsWith('badS ='))              isBadass  = val(s).toLowerCase() === 'true';
            }
            if (s.startsWith('{')) indent++;
        }
        return kerbals;
    }

    // ── Flight Logs (CAREER_LOG + FLIGHT_LOG) ────────────────────────────────
    async parseFlightLogs(kerbals) {
        let inRoster = false, inKerbal = false;
        let inCareerLog = false, inFlightLog = false;
        let currentName = null, indent = 0;

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if      (inFlightLog  && indent === 2) inFlightLog  = false;
                else if (inCareerLog  && indent === 2) inCareerLog  = false;
                else if (inKerbal     && indent === 1) { inKerbal = false; currentName = null; }
                else if (inRoster     && indent === 0) inRoster = false;
            }
            if      (s === 'ROSTER') { inRoster = true; indent = 0; }
            else if (inRoster && s === 'KERBAL') { inKerbal = true; indent = 1; currentName = null; }
            else if (inKerbal && !inFlightLog && !inCareerLog && indent === 2) {
                if      (s.startsWith('name =')) currentName = val(s);
                else if (s === 'FLIGHT_LOG')     inFlightLog = true;
                else if (s === 'CAREER_LOG')     inCareerLog = true;
            } else if ((inFlightLog || inCareerLog) && currentName && kerbals[currentName]) {
                if (s.startsWith('flight =')) {
                    const count = parseInt(val(s)) || 0;
                    kerbals[currentName].flights = Math.max(kerbals[currentName].flights, count);
                } else if (s.includes('=') && s.includes(',')) {
                    const eqIdx = s.indexOf('=');
                    const key   = s.slice(0, eqIdx).trim();
                    if (/^\d+$/.test(key)) {
                        const rest      = s.slice(eqIdx + 1).trim();
                        const commaIdx  = rest.indexOf(',');
                        const eventType = rest.slice(0, commaIdx).trim();
                        const location  = rest.slice(commaIdx + 1).trim();
                        const mIdx = parseInt(key);
                        if (location && (inFlightLog || FLIGHT_EVENTS.has(eventType))) {
                            const k = kerbals[currentName];
                            if (!k.bodyMissions[location])   k.bodyMissions[location]   = new Set();
                            if (!k.bodyActivities[location]) k.bodyActivities[location] = new Set();
                            k.bodyMissions[location].add(mIdx);
                            k.bodyActivities[location].add(eventType);
                        }
                    }
                }
            }
            if (s.startsWith('{')) indent++;
        }
        return kerbals;
    }

    // ── Tourist Roster ────────────────────────────────────────────────────────
    async parseTouristRoster() {
        const tourists = {};
        let inRoster = false, inKerbal = false, indent = 0;
        let name = null, type = null, trait = '', kspState = 'Available';
        let courage = 0.0, stupidity = 0.0, gender = 'Male';

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if (inKerbal && indent === 1) {
                    if (name && (type === 'Tourist' || trait === 'Tourist')) {
                        const t = makeTourist(name);
                        t.state     = kspState === 'Assigned' ? 'Flying' : 'Awaiting';
                        t.courage   = courage;
                        t.stupidity = stupidity;
                        t.gender    = gender;
                        tourists[name] = t;
                    }
                    name = null; type = null; inKerbal = false;
                } else if (inRoster && indent === 0) { inRoster = false; }
            }
            if      (s === 'ROSTER') { inRoster = true; indent = 0; }
            else if (inRoster && s === 'KERBAL') {
                inKerbal = true; indent = 1;
                name = null; type = null; trait = ''; kspState = 'Available';
                courage = 0.0; stupidity = 0.0; gender = 'Male';
            } else if (inKerbal && indent === 2) {
                if      (s.startsWith('name ='))   name      = val(s);
                else if (s.startsWith('type ='))   type      = val(s);
                else if (s.startsWith('trait ='))  trait     = val(s);
                else if (s.startsWith('state ='))  kspState  = val(s);
                else if (s.startsWith('brave ='))  courage   = parseFloat(val(s)) || 0;
                else if (s.startsWith('dumb ='))   stupidity = parseFloat(val(s)) || 0;
                else if (s.startsWith('gender =')) gender    = val(s);
            }
            if (s.startsWith('{')) indent++;
        }
        return tourists;
    }

    // ── Tourist Contract History ──────────────────────────────────────────────
    async parseTouristContracts() {
        const tourists = {};
        let inContracts = false, inContract = false, indent = 0;
        let cType = null, cBody = '', cAgent = '', cGuid = '', cUt = 0.0, cNames = [];

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if (inContract && indent === 1) {
                    if (cType === 'TourismContract' && cNames.length && cUt > 0) {
                        for (const n of cNames) {
                            if (n) {
                                const t = makeTourist(n);
                                Object.assign(t, { state: 'Returned', contractUt: cUt, contractBody: cBody, contractAgent: cAgent, contractGuid: cGuid });
                                tourists[n] = t;
                            }
                        }
                    }
                    cType = null; cBody = ''; cAgent = ''; cGuid = ''; cUt = 0.0; cNames = [];
                    inContract = false;
                } else if (inContracts && indent === 0) { inContracts = false; }
            }
            if      (s === 'CONTRACTS')                              { inContracts = true; indent = 0; }
            else if (inContracts && s === 'CONTRACT_FINISHED')       { inContract  = true; indent = 1; }
            else if (inContract  && indent === 2) {
                if      (s.startsWith('type ='))       cType  = val(s);
                else if (s.startsWith('agent ='))      cAgent = val(s);
                else if (s.startsWith('guid ='))       cGuid  = val(s);
                else if (s.startsWith('bodyName ='))   cBody  = val(s);
                else if (s.startsWith('targetBody =') && !cBody) { const r = parseInt(val(s)); cBody = BODY_NAMES[r] || ''; }
                else if (s.startsWith('tourists ='))   cNames = val(s).split('|').map(n => n.trim()).filter(Boolean);
                else if (s.startsWith('values ='))   { const v = val(s).split(',').map(Number); cUt = v.length > 8 ? v[8] : 0; }
            }
            if (s.startsWith('{')) indent++;
        }
        return tourists;
    }

    // ── Active Tourism Contract Objectives ────────────────────────────────────
    async parseActiveTourismContracts() {
        const result = {};
        let inContracts = false, inContract = false, contractIsTour = false;
        let indent = 0, currentTourist = null;
        let destBodyIdx = null, destType = '', destState = 'Incomplete';

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if (inContract) {
                    if (indent === 3) {
                        if (contractIsTour && currentTourist && destType && destBodyIdx !== null) {
                            const bodyName = BODY_NAMES[destBodyIdx] || '';
                            if (bodyName) {
                                if (!result[currentTourist]) result[currentTourist] = [];
                                result[currentTourist].push({ body: bodyName, activity: destType, complete: destState === 'Complete' });
                            }
                        }
                        destBodyIdx = null; destType = ''; destState = 'Incomplete';
                    } else if (indent === 2) { currentTourist = null; }
                    else if (indent === 1)   { inContract = false; contractIsTour = false; }
                } else if (inContracts && indent === 0) { inContracts = false; }
            } else if (s === 'CONTRACTS') { inContracts = true; indent = 0; }
            else if (inContracts && !inContract && s === 'CONTRACT') { inContract = true; }
            else if (inContract) {
                if      (indent === 2 && s.startsWith('type =') && val(s) === 'TourismContract') contractIsTour = true;
                else if (indent === 3 && contractIsTour && s.startsWith('kerbalName =')) currentTourist = val(s);
                else if (indent === 4 && contractIsTour) {
                    if      (s.startsWith('targetBody =')) { const r = parseInt(val(s)); destBodyIdx = isNaN(r) ? null : r; }
                    else if (s.startsWith('targetType =')) destType  = val(s);
                    else if (s.startsWith('state ='))      destState = val(s);
                }
            }
            if (s.startsWith('{')) indent++;
        }
        return result;
    }

    // ── Vessel Assignments ────────────────────────────────────────────────────
    async parseVesselAssignments(crew) {
        const locationMap = {}, vesselMap = {}, vesselTypeMap = {};
        let inVessel = false, absIndent = 0, baseDepth = 0, inOrbit = false;
        let vName = null, vType = null, vSit = null, vLandedAt = null, vOrbitRef = null;
        let crewNames = new Set();

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                absIndent--;
                if (inOrbit  && absIndent === baseDepth)     inOrbit = false;
                if (inVessel && absIndent === baseDepth - 1) {
                    if (crewNames.size > 0) {
                        const sit     = vSit || '';
                        const refBody = vOrbitRef !== null ? (BODY_NAMES[vOrbitRef] || 'Unknown') : 'Unknown';
                        const body    = vLandedAt || refBody;
                        let loc;
                        if      (sit === 'LANDED' || sit === 'PRELAUNCH') loc = `${body} (landed)`;
                        else if (sit === 'SPLASHED')                      loc = `${body} (splashed)`;
                        else if (sit === 'ORBITING')                      loc = `Orbiting ${refBody}`;
                        else if (sit === 'SUB_ORBITAL')                   loc = `Sub-orbital (${refBody})`;
                        else if (sit === 'ESCAPING')                      loc = `Escaping ${refBody}`;
                        else                                              loc = sit || 'Unknown';
                        for (const cn of crewNames) { locationMap[cn] = loc; vesselMap[cn] = vName || ''; vesselTypeMap[cn] = vType || ''; }
                    }
                    inVessel = false; inOrbit = false;
                    vName = vType = vSit = vLandedAt = vOrbitRef = null; crewNames = new Set();
                }
            }
            if (!inVessel && s === 'VESSEL') {
                inVessel = true; baseDepth = absIndent + 1;
                vName = vType = vSit = vLandedAt = vOrbitRef = null; inOrbit = false; crewNames = new Set();
            }
            if (inVessel) {
                if (absIndent === baseDepth) {
                    if      (s.startsWith('name =') && vName === null) vName    = val(s);
                    else if (s.startsWith('type =') && vType === null) vType    = val(s);
                    else if (s.startsWith('sit ='))                    vSit     = val(s);
                    else if (s.startsWith('landedAt ='))               { const v = val(s); if (v) vLandedAt = v; }
                    else if (s === 'ORBIT' && !inOrbit)                inOrbit  = true;
                }
                if (inOrbit && absIndent === baseDepth + 1 && s.startsWith('REF =')) {
                    const r = parseInt(val(s)); if (!isNaN(r)) vOrbitRef = r;
                }
                if (absIndent > baseDepth && s.startsWith('crew =')) {
                    const c = val(s); if (crew[c]) crewNames.add(c);
                }
            }
            if (s.startsWith('{')) absIndent++;
        }
        for (const [name, kerbal] of Object.entries(crew)) {
            const st = kerbal.state || '';
            if      (st === 'Available' || st === 'Awaiting') { kerbal.currentLocation = 'Kerbin (KSC)'; kerbal.currentVessel = ''; kerbal.currentVesselType = ''; }
            else if (st === 'Assigned'  || st === 'Flying')   { kerbal.currentLocation = locationMap[name] || 'Unknown'; kerbal.currentVessel = vesselMap[name] || ''; kerbal.currentVesselType = vesselTypeMap[name] || ''; }
            else if (st === 'Dead')                            { kerbal.currentLocation = 'N/A'; kerbal.currentVessel = ''; kerbal.currentVesselType = ''; }
            else                                               { kerbal.currentLocation = 'Unknown'; kerbal.currentVessel = ''; kerbal.currentVesselType = ''; }
        }
    }

    // ── Contracts (aggregated) ────────────────────────────────────────────────
    async parseContracts() {
        const contracts = {};
        let inContracts = false, inContract = false, indent = 0;
        let cType = null, cFunds = 0.0, cState = null, cTourists = 0;

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if (inContract && indent === 1) {
                    if (cType && cState === 'Completed') {
                        if (!contracts[cType]) contracts[cType] = { contractType: cType, count: 0, totalFunds: 0.0, passengers: 0 };
                        contracts[cType].count++;
                        contracts[cType].totalFunds  += cFunds;
                        contracts[cType].passengers  += cTourists;
                    }
                    cType = null; cFunds = 0.0; cState = null; cTourists = 0; inContract = false;
                } else if (inContracts && indent === 0) { inContracts = false; }
            }
            if      (s === 'CONTRACTS')                              { inContracts = true; indent = 0; }
            else if (inContracts && s === 'CONTRACT_FINISHED')       { inContract  = true; indent = 1; cTourists = 0; }
            else if (inContract  && indent === 2) {
                if      (s.startsWith('type ='))    cType     = val(s);
                else if (s.startsWith('state ='))   cState    = val(s);
                else if (s.startsWith('values =')) { const v = val(s).split(',').map(Number); cFunds = v.length > 4 ? v[4] : 0; }
                else if (s.startsWith('tourists =')) cTourists = val(s).split('|').filter(Boolean).length;
            }
            if (s.startsWith('{')) indent++;
        }
        return contracts;
    }

    // ── Contract History (timeline) ───────────────────────────────────────────
    async parseContractHistory() {
        const records = [];
        let inContracts = false, inContract = false, indent = 0;
        let cType = null, cPrestige = 0, cBody = '', cFunds = 0.0;
        let cPassengers = 0, cDateUt = 0.0, cState = null;

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                indent--;
                if (inContract && indent === 1) {
                    if (cType && cState === 'Completed' && cDateUt > 0) {
                        const { year, day } = utToKspDate(cDateUt);
                        records.push({ contractType: cType, prestige: cPrestige, bodyName: cBody, funds: cFunds, passengers: cPassengers, dateUt: cDateUt, kspYear: year, kspDay: day });
                    }
                    cType = null; cPrestige = 0; cBody = ''; cFunds = 0.0; cPassengers = 0; cDateUt = 0.0; cState = null; inContract = false;
                } else if (inContracts && indent === 0) { inContracts = false; }
            }
            if      (s === 'CONTRACTS')                              { inContracts = true; indent = 0; }
            else if (inContracts && s === 'CONTRACT_FINISHED')       { inContract  = true; indent = 1; }
            else if (inContract  && indent === 2) {
                if      (s.startsWith('type ='))      cType      = val(s);
                else if (s.startsWith('state ='))     cState     = val(s);
                else if (s.startsWith('prestige ='))  cPrestige  = parseInt(val(s)) || 0;
                else if (s.startsWith('bodyName ='))  cBody      = val(s);
                else if (s.startsWith('targetBody =') && !cBody) { const r = parseInt(val(s)); cBody = BODY_NAMES[r] || ''; }
                else if (s.startsWith('values ='))   { const v = val(s).split(',').map(Number); cFunds = v.length > 4 ? v[4] : 0; cDateUt = v.length > 8 ? v[8] : 0; }
                else if (s.startsWith('tourists ='))  cPassengers = val(s).split('|').filter(Boolean).length;
            }
            if (s.startsWith('{')) indent++;
        }
        return records;
    }

    // ── Rescue Dates + Game UT ────────────────────────────────────────────────
    async parseRescueDates(kerbals) {
        let currentUt = 0.0;
        let inFt = false, ftLvl = 0;
        let inCts = false, ctsLvl = 0, inCt = false;
        let ctType = null, ctName = null, ctUt = 0.0;

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (s.startsWith('}')) {
                if (inFt)  { ftLvl--;  if (ftLvl < 0)  inFt  = false; }
                if (inCt)  {
                    ctsLvl--;
                    if (ctsLvl === 1) {
                        if (ctType === 'RecoverAsset' && ctName && ctUt > 0 && kerbals[ctName] && !kerbals[ctName].veteran) {
                            kerbals[ctName].hiredUt = ctUt;
                        }
                        ctType = null; ctName = null; ctUt = 0.0; inCt = false;
                    }
                } else if (inCts) { ctsLvl--; if (ctsLvl <= 0) inCts = false; }
            }
            if      (!inFt  && s === 'FLIGHTSTATE')        { inFt  = true;  ftLvl  = 0; }
            else if (!inCts && s === 'CONTRACTS')           { inCts = true;  ctsLvl = 0; }
            else if (inCts && !inCt && s === 'CONTRACT_FINISHED') { inCt = true; ctsLvl = 1; }

            if (inFt && ftLvl === 1 && s.startsWith('UT =')) {
                const v = parseFloat(val(s));
                if (!isNaN(v)) { currentUt = v; inFt = false; }
            }
            if (inCt && ctsLvl === 2) {
                if      (s.startsWith('type ='))       ctType = val(s);
                else if (s.startsWith('kerbalName =')) ctName = val(s);
                else if (s.startsWith('values ='))   { const v = val(s).split(',').map(Number); ctUt = v.length > 8 ? v[8] : 0; }
            }
            if (s.startsWith('{')) { if (inFt) ftLvl++; if (inCts) ctsLvl++; }
        }
        return currentUt;
    }

    // ── World Achievements (ProgressTracking scenario) ────────────────────────
    async parseAchievements() {
        const BODY_SET = new Set(['Sun','Kerbin','Mun','Minmus','Eve','Gilly','Duna','Ike',
                                   'Moho','Dres','Jool','Laythe','Vall','Bop','Tylo','Pol','Eeloo']);
        let depth = 0;
        let inPT = false, ptDepth = null;
        let inProgress = false, progressDepth = null;
        let pendingName = null;
        let bodyName = null, bodyContentDepth = null;
        let achName  = null, achContentDepth  = null;
        let mileName = null, mileContentDepth = null;
        let subBlock = null, subContentDepth  = null;
        let curAch = null, curVessel = null, curCrew = null;
        const global = {}, bodies = {};

        for await (const line of readLines(this.filepath)) {
            const s = line.trim();
            if (!s) continue;

            if (s.startsWith('}')) {
                depth--;
                if (subContentDepth !== null && depth < subContentDepth) {
                    if (subBlock === 'vessel' && curAch) curAch.vessel = curVessel || null;
                    if (subBlock === 'crew'   && curAch) curAch.crew   = curCrew   || [];
                    subBlock = null; subContentDepth = null; curVessel = null; curCrew = null;
                } else if (achContentDepth !== null && depth < achContentDepth) {
                    if (achName && curAch && bodyName) {
                        if (!bodies[bodyName]) bodies[bodyName] = { reached: null, achievements: {} };
                        bodies[bodyName].achievements[achName] = curAch;
                    }
                    achName = null; achContentDepth = null; curAch = null;
                } else if (bodyContentDepth !== null && depth < bodyContentDepth) {
                    bodyName = null; bodyContentDepth = null;
                } else if (mileContentDepth !== null && depth < mileContentDepth) {
                    if (mileName && curAch) global[mileName] = curAch;
                    mileName = null; mileContentDepth = null; curAch = null;
                } else if (progressDepth !== null && depth < progressDepth) {
                    inProgress = false; progressDepth = null;
                    return { global, bodies };
                } else if (ptDepth !== null && depth < ptDepth) {
                    inPT = false; ptDepth = null;
                }
            } else if (s.startsWith('{')) {
                depth++;
                if (pendingName !== null) {
                    const pn = pendingName; pendingName = null;
                    if (inPT && !inProgress && pn === 'Progress') {
                        inProgress = true; progressDepth = depth;
                    } else if (inProgress) {
                        if (bodyName === null && mileName === null && achName === null) {
                            if (BODY_SET.has(pn)) {
                                bodyName = pn; bodyContentDepth = depth;
                                if (!bodies[bodyName]) bodies[bodyName] = { reached: null, achievements: {} };
                            } else {
                                mileName = pn; mileContentDepth = depth;
                                curAch = { ut: null, manned: null, crew: [], vessel: null };
                            }
                        } else if (bodyName !== null && achName === null && subBlock === null) {
                            achName = pn; achContentDepth = depth;
                            curAch = { ut: null, manned: null, crew: [], vessel: null };
                        } else if ((achName !== null || mileName !== null) && subBlock === null) {
                            if (['vessel','crew','base','station'].includes(pn)) {
                                subBlock = pn; subContentDepth = depth;
                                curVessel = {}; curCrew = [];
                            }
                        }
                    }
                }
            } else if (s.includes('=')) {
                const eqIdx = s.indexOf('=');
                const key = s.slice(0, eqIdx).trim();
                const v   = s.slice(eqIdx + 1).trim();

                if (!inPT && key === 'name' && v === 'ProgressTracking') {
                    inPT = true; ptDepth = depth;
                }

                if (inProgress) {
                    if (subBlock === 'vessel') {
                        if (!curVessel) curVessel = {};
                        if      (key === 'name') curVessel.name = v;
                        else if (key === 'flag') curVessel.flag = v;
                    } else if (subBlock === 'crew') {
                        if (key === 'crews') curCrew = v.split(',').map(c => c.trim()).filter(Boolean);
                    } else if (achName !== null && curAch) {
                        const ut = parseFloat(v);
                        if      (key === 'completed')             { curAch.ut = ut; curAch.manned = true; }
                        else if (key === 'completedUnmanned')     { curAch.ut = ut; curAch.manned = false; }
                        else if (key === 'completedManned' || key === 'completedMannedCrew') { curAch.ut = ut; curAch.manned = true; }
                        else if (key === 'reached')               { curAch.ut = ut; curAch.manned = null; }
                        else if (key === 'record')                curAch.record = parseFloat(v);
                    } else if (bodyName !== null && achName === null && key === 'reached') {
                        if (!bodies[bodyName]) bodies[bodyName] = { reached: null, achievements: {} };
                        bodies[bodyName].reached = parseFloat(v) || null;
                    } else if (mileName !== null && curAch) {
                        const ut = parseFloat(v);
                        if      (key === 'completed') { curAch.ut = ut; curAch.manned = true; }
                        else if (key === 'reached')   { curAch.ut = ut; curAch.manned = null; }
                        else if (key === 'record')    curAch.record = parseFloat(v);
                    }
                }
            } else {
                pendingName = s;
            }
        }
        return { global, bodies };
    }

    // ── Full Parse ────────────────────────────────────────────────────────────
    async parseAll() {
        const fileHash = await this.calculateFileHash();

        console.log('Parsing Kerbal roster...');
        let kerbals = await this.parseKerbalRoster();

        console.log(`Parsing flight logs for ${Object.keys(kerbals).length} kerbals...`);
        kerbals = await this.parseFlightLogs(kerbals);
        for (const k of Object.values(kerbals)) {
            k.locations = {};
            for (const [body, missions] of Object.entries(k.bodyMissions)) k.locations[body] = missions.size;
        }

        console.log('Parsing tourist roster...');
        const activeTourists = await this.parseTouristRoster();
        await this.parseFlightLogs(activeTourists);
        for (const t of Object.values(activeTourists)) {
            t.locations = {};
            for (const [body, missions] of Object.entries(t.bodyMissions)) t.locations[body] = missions.size;
        }

        console.log('Parsing tourist contract history...');
        const historicalTourists = await this.parseTouristContracts();
        console.log(`Active: ${Object.keys(activeTourists).length}, historical: ${Object.keys(historicalTourists).length}`);
        const allTourists = { ...historicalTourists, ...activeTourists };

        console.log('Parsing vessel assignments...');
        await this.parseVesselAssignments({ ...kerbals, ...activeTourists });

        console.log('Parsing active tourism contract objectives...');
        const objectives = await this.parseActiveTourismContracts();
        for (const [name, objs] of Object.entries(objectives)) {
            if (activeTourists[name]) activeTourists[name].objectives = objs;
        }

        console.log('Parsing rescue dates...');
        const gameUt = await this.parseRescueDates(kerbals);
        console.log(`Game UT: ${gameUt.toFixed(0)}s`);

        // XP computation
        for (const k of Object.values(kerbals)) {
            if (k.experience === 0.0 && Object.keys(k.bodyActivities).length > 0) {
                let xp = 0;
                for (const [body, acts] of Object.entries(k.bodyActivities))
                    for (const act of acts) xp += (BODY_ACTIVITY_XP[body] || {})[act] || 0;
                k.experience = Math.round(xp * 100) / 100;
            }
            k.experienceLevel = KSP_LEVELS.filter(t => k.experience >= t).length;
        }

        console.log('Parsing contracts...');
        const contracts = await this.parseContracts();
        console.log('Parsing contract history...');
        const contractHistory = await this.parseContractHistory();
        console.log(`Contract history: ${contractHistory.length} records`);

        console.log('Parsing world achievements...');
        const achievements = await this.parseAchievements();
        console.log(`Achievements: ${Object.keys(achievements.bodies).length} bodies, ${Object.keys(achievements.global).length} milestones`);

        for (const name of Object.keys(kerbals)) {
            if (kerbals[name].isTourist) delete kerbals[name];
        }

        return { kerbals, allTourists, contracts, contractHistory, fileHash, gameUt, achievements };
    }
}

module.exports = { SFSParser, utToKspDate };
