"""
Incremental parser for Kerbal Space Program .sfs save files.
Handles large files (98 MB+) efficiently with MD5-based change detection.
"""

import re
import hashlib
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime


KSP_YEAR_SECONDS = 9203544   # Kerbin orbital period (s)
KSP_DAY_SECONDS  = 21600     # 6 h/day

def ut_to_ksp_date(ut: float):
    year = int(ut / KSP_YEAR_SECONDS) + 1
    day  = int((ut % KSP_YEAR_SECONDS) / KSP_DAY_SECONDS) + 1
    return year, day


BODY_NAMES = {
    0: 'Sun', 1: 'Kerbin', 2: 'Mun', 3: 'Minmus', 4: 'Moho',
    5: 'Eve', 6: 'Duna', 7: 'Ike', 8: 'Jool', 9: 'Laythe',
    10: 'Vall', 11: 'Bop', 12: 'Tylo', 13: 'Gilly',
    14: 'Pol', 15: 'Dres', 16: 'Eeloo',
}


@dataclass
class KerbalStats:
    """Statistiche per un singolo Kerbal"""
    name: str
    flights: int = 0
    locations: Dict[str, int] = field(default_factory=dict)  # location -> count
    is_tourist: bool = False
    trait: str = ''
    state: str = 'Available'
    experience_level: int = 0
    experience: float = 0.0
    courage: float = 0.0
    stupidity: float = 0.0
    gender: str = 'Male'
    veteran: bool = False
    is_badass: bool = False
    current_location: str = ''
    current_vessel: str = ''

    hired_ut: float = 0.0  # UT (seconds) when rescued; 0.0 = veteran / unknown
    body_activities: Dict[str, set] = field(default_factory=dict)   # body -> set of activity types
    body_missions: Dict[str, set] = field(default_factory=dict)     # body -> set of mission indices


@dataclass
class TouristRecord:
    """Statistiche per un singolo turista (attivo o storico)"""
    name: str
    state: str = 'Returned'      # 'Flying' = ancora in roster; 'Returned' = da contratto storico
    flights: int = 0
    courage: float = 0.0
    stupidity: float = 0.0
    gender: str = 'Male'
    current_location: str = ''
    current_vessel: str = ''
    contract_ut: float = 0.0     # UT completamento contratto (0 = non noto)
    contract_body: str = ''      # corpo di destinazione dal contratto
    locations: Dict[str, int] = field(default_factory=dict)
    body_missions: Dict[str, set] = field(default_factory=dict)
    body_activities: Dict[str, set] = field(default_factory=dict)


@dataclass
class ContractRecord:
    """Single completed contract with timestamp, for progression charting"""
    contract_type: str
    prestige: int = 0       # 0=Trivial 1=Significant 2=Exceptional
    body_name: str = ''
    funds: float = 0.0
    passengers: int = 0
    date_ut: float = 0.0
    ksp_year: int = 1
    ksp_day: int = 1


@dataclass
class ContractStats:
    """Statistiche per i contratti"""
    contract_type: str
    count: int = 0
    total_funds: float = 0.0
    passengers: int = 0

    def add_contract(self, funds: float, tourists: int = 0):
        self.count += 1
        self.total_funds += funds
        self.passengers += tourists


class SFSParser:
    """Parser per file .sfs con supporto per parsing incrementale"""
    
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.file_hash: Optional[str] = None
        
    def calculate_file_hash(self) -> str:
        """Compute MD5 hash of the file to detect changes"""
        hasher = hashlib.md5()
        with open(self.filepath, 'rb') as f:
            # Leggi in chunks per file grandi
            for chunk in iter(lambda: f.read(8192), b''):
                hasher.update(chunk)
        return hasher.hexdigest()
    
    def parse_kerbal_roster(self) -> Dict[str, KerbalStats]:
        """Estrae informazioni sui Kerbal dal roster"""
        kerbals = {}

        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_roster = False
            in_kerbal = False
            current_name = None
            current_type = None
            current_trait = ''
            current_state = 'Available'
            current_experience_level = 0
            current_experience = 0.0
            current_courage = 0.0
            current_stupidity = 0.0
            current_gender = 'Male'
            current_veteran = False
            current_is_badass = False
            indent_level = 0

            for line in f:
                stripped = line.strip()

                if stripped.startswith('}'):
                    indent_level -= 1
                    if in_kerbal and indent_level == 1:
                        is_tourist   = (current_type == 'Tourist' or current_trait == 'Tourist')
                        is_applicant = (current_type == 'Applicant')
                        if current_name and not is_tourist and not is_applicant:
                            if current_name not in kerbals:
                                kerbals[current_name] = KerbalStats(
                                    name=current_name,
                                    is_tourist=False,
                                    trait=current_trait,
                                    state=current_state,
                                    experience_level=current_experience_level,
                                    experience=current_experience,
                                    courage=current_courage,
                                    stupidity=current_stupidity,
                                    gender=current_gender,
                                    veteran=current_veteran,
                                    is_badass=current_is_badass,
                                )
                        current_name = None
                        current_type = None
                        in_kerbal = False
                    elif in_roster and indent_level == 0:
                        in_roster = False

                if stripped == 'ROSTER':
                    in_roster = True
                    indent_level = 0
                elif in_roster and stripped == 'KERBAL':
                    in_kerbal = True
                    indent_level = 1
                    current_name = None
                    current_type = None
                    current_trait = ''
                    current_state = 'Available'
                    current_experience_level = 0
                    current_experience = 0.0
                    current_courage = 0.0
                    current_stupidity = 0.0
                    current_gender = 'Male'
                    current_veteran = False
                    current_is_badass = False
                elif in_kerbal and indent_level == 2:
                    # Only read direct children of the KERBAL block
                    if stripped.startswith('name ='):
                        current_name = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('type ='):
                        current_type = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('trait ='):
                        current_trait = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('state ='):
                        current_state = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('brave ='):
                        try:
                            current_courage = float(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('dumb ='):
                        try:
                            current_stupidity = float(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('experienceLevel ='):
                        try:
                            current_experience_level = int(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('experience ='):
                        try:
                            current_experience = float(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('gender ='):
                        current_gender = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('veteran ='):
                        current_veteran = stripped.split('=', 1)[1].strip().lower() == 'true'
                    elif stripped.startswith('badS ='):
                        current_is_badass = stripped.split('=', 1)[1].strip().lower() == 'true'

                if stripped.startswith('{'):
                    indent_level += 1

        return kerbals
    
    def parse_flight_logs(self, kerbals: Dict[str, KerbalStats]) -> Dict[str, KerbalStats]:
        """Parse CAREER_LOG and FLIGHT_LOG blocks to count missions and build destination history."""
        # Only count meaningful flight milestones from CAREER_LOG; skip crew-ops like ExitVessel/BoardVessel
        FLIGHT_EVENTS = {
            'Flight', 'Suborbit', 'Orbit', 'Flyby', 'Escape',
            'Land', 'Splashdown', 'Crash', 'PlantFlag',
        }
        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_roster = False
            in_kerbal = False
            in_career_log = False
            in_flight_log = False
            current_kerbal_name = None
            indent_level = 0

            for line in f:
                stripped = line.strip()

                if stripped.startswith('}'):
                    indent_level -= 1
                    if in_flight_log and indent_level == 2:
                        in_flight_log = False
                    elif in_career_log and indent_level == 2:
                        in_career_log = False
                    elif in_kerbal and indent_level == 1:
                        in_kerbal = False
                        current_kerbal_name = None
                    elif in_roster and indent_level == 0:
                        in_roster = False

                if stripped == 'ROSTER':
                    in_roster = True
                    indent_level = 0
                elif in_roster and stripped == 'KERBAL':
                    in_kerbal = True
                    indent_level = 1
                    current_kerbal_name = None
                elif in_kerbal and not in_flight_log and not in_career_log and indent_level == 2:
                    if stripped.startswith('name ='):
                        current_kerbal_name = stripped.split('=', 1)[1].strip()
                    elif stripped == 'FLIGHT_LOG':
                        in_flight_log = True
                    elif stripped == 'CAREER_LOG':
                        in_career_log = True
                elif in_flight_log or in_career_log:
                    if stripped.startswith('flight ='):
                        try:
                            count = int(stripped.split('=', 1)[1].strip())
                            if current_kerbal_name and current_kerbal_name in kerbals:
                                kerbals[current_kerbal_name].flights = max(
                                    kerbals[current_kerbal_name].flights, count
                                )
                        except ValueError:
                            pass
                    elif '=' in stripped:
                        key, _, value = stripped.partition('=')
                        key_s = key.strip()
                        if key_s.isdigit() and ',' in value:
                            mission_idx = int(key_s)
                            event_type, _, body = value.strip().partition(',')
                            location = body.strip()
                            event_type = event_type.strip()
                            if location and current_kerbal_name and current_kerbal_name in kerbals:
                                if in_flight_log or event_type in FLIGHT_EVENTS:
                                    k = kerbals[current_kerbal_name]
                                    k.body_missions.setdefault(location, set()).add(mission_idx)
                                    k.body_activities.setdefault(location, set()).add(event_type)

                if stripped.startswith('{'):
                    indent_level += 1

        return kerbals
    
    def parse_tourist_roster(self) -> Dict[str, 'TouristRecord']:
        """Parse ROSTER section for type=Tourist kerbals (currently flying)."""
        tourists: Dict[str, TouristRecord] = {}
        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_roster = False
            in_kerbal = False
            current_name = None
            current_type = None
            current_trait = ''
            current_courage = 0.0
            current_stupidity = 0.0
            current_gender = 'Male'
            indent_level = 0

            for line in f:
                stripped = line.strip()
                if stripped.startswith('}'):
                    indent_level -= 1
                    if in_kerbal and indent_level == 1:
                        is_tourist = (current_type == 'Tourist' or current_trait == 'Tourist')
                        if current_name and is_tourist:
                            tourists[current_name] = TouristRecord(
                                name=current_name,
                                state='Flying',
                                courage=current_courage,
                                stupidity=current_stupidity,
                                gender=current_gender,
                            )
                        current_name = None
                        current_type = None
                        in_kerbal = False
                    elif in_roster and indent_level == 0:
                        in_roster = False

                if stripped == 'ROSTER':
                    in_roster = True
                    indent_level = 0
                elif in_roster and stripped == 'KERBAL':
                    in_kerbal = True
                    indent_level = 1
                    current_name = None
                    current_type = None
                    current_trait = ''
                    current_courage = 0.0
                    current_stupidity = 0.0
                    current_gender = 'Male'
                elif in_kerbal and indent_level == 2:
                    if stripped.startswith('name ='):
                        current_name = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('type ='):
                        current_type = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('trait ='):
                        current_trait = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('brave ='):
                        try:
                            current_courage = float(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('dumb ='):
                        try:
                            current_stupidity = float(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('gender ='):
                        current_gender = stripped.split('=', 1)[1].strip()

                if stripped.startswith('{'):
                    indent_level += 1
        return tourists

    def parse_tourist_contracts(self) -> Dict[str, 'TouristRecord']:
        """Extract historical tourists from completed TourismContract records.
        Uses the 'tourists = name1|name2|...' field present in each record.
        Overwrites earlier entries so the most recent contract per tourist wins.
        """
        tourists: Dict[str, TouristRecord] = {}
        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_contracts = False
            in_contract = False
            current_type = None
            current_body = ''
            current_ut = 0.0
            current_names: list = []
            indent_level = 0

            for line in f:
                stripped = line.strip()
                if stripped.startswith('}'):
                    indent_level -= 1
                    if in_contract and indent_level == 1:
                        if current_type == 'TourismContract' and current_names and current_ut > 0:
                            for name in current_names:
                                if name:
                                    tourists[name] = TouristRecord(
                                        name=name,
                                        state='Returned',
                                        contract_ut=current_ut,
                                        contract_body=current_body,
                                    )
                        current_type = None
                        current_body = ''
                        current_ut = 0.0
                        current_names = []
                        in_contract = False
                    elif in_contracts and indent_level == 0:
                        in_contracts = False

                if stripped == 'CONTRACTS':
                    in_contracts = True
                    indent_level = 0
                elif in_contracts and stripped == 'CONTRACT_FINISHED':
                    in_contract = True
                    indent_level = 1
                elif in_contract and indent_level == 2:
                    if stripped.startswith('type ='):
                        current_type = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('bodyName ='):
                        current_body = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('targetBody =') and not current_body:
                        try:
                            ref = int(stripped.split('=', 1)[1].strip())
                            current_body = BODY_NAMES.get(ref, '')
                        except ValueError:
                            pass
                    elif stripped.startswith('tourists ='):
                        names_str = stripped.split('=', 1)[1].strip()
                        current_names = [n.strip() for n in names_str.split('|') if n.strip()]
                    elif stripped.startswith('values ='):
                        try:
                            vals = [float(v) for v in stripped.split('=', 1)[1].strip().split(',')]
                            current_ut = vals[8] if len(vals) > 8 else 0.0
                        except (ValueError, IndexError):
                            pass

                if stripped.startswith('{'):
                    indent_level += 1
        return tourists

    def parse_vessel_assignments(self, crew: dict) -> None:
        """Determines current location and vessel for each assigned crew member (kerbals or tourists)."""
        location_map: Dict[str, str] = {}
        vessel_map: Dict[str, str] = {}

        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_vessel = False
            vessel_base_depth = 0
            abs_indent = 0
            in_orbit = False
            v_name = None
            v_sit = None
            v_landed_at = None
            v_orbit_ref = None
            crew_names: set = set()

            for line in f:
                stripped = line.strip()

                if stripped.startswith('}'):
                    abs_indent -= 1

                    if in_orbit and abs_indent == vessel_base_depth:
                        in_orbit = False

                    if in_vessel and abs_indent == vessel_base_depth - 1:
                        if crew_names:
                            sit = v_sit or ''
                            ref_body = BODY_NAMES.get(v_orbit_ref, 'Unknown') if v_orbit_ref is not None else 'Unknown'
                            if sit in ('LANDED', 'PRELAUNCH'):
                                body_name = v_landed_at if v_landed_at else ref_body
                                loc = f"{body_name} (landed)"
                            elif sit == 'SPLASHED':
                                body_name = v_landed_at if v_landed_at else ref_body
                                loc = f"{body_name} (splashed)"
                            elif sit == 'ORBITING':
                                loc = f"Orbiting {ref_body}"
                            elif sit == 'SUB_ORBITAL':
                                loc = f"Sub-orbital ({ref_body})"
                            elif sit == 'ESCAPING':
                                loc = f"Escaping {ref_body}"
                            else:
                                loc = sit or 'Unknown'
                            for cname in crew_names:
                                location_map[cname] = loc
                                vessel_map[cname] = v_name or ''
                        in_vessel = False
                        in_orbit = False
                        v_name = v_sit = v_landed_at = v_orbit_ref = None
                        crew_names = set()

                if not in_vessel and stripped == 'VESSEL':
                    in_vessel = True
                    vessel_base_depth = abs_indent + 1
                    v_name = v_sit = v_landed_at = v_orbit_ref = None
                    in_orbit = False
                    crew_names = set()

                if in_vessel:
                    if abs_indent == vessel_base_depth:
                        if stripped.startswith('name =') and v_name is None:
                            v_name = stripped.split('=', 1)[1].strip()
                        elif stripped.startswith('sit ='):
                            v_sit = stripped.split('=', 1)[1].strip()
                        elif stripped.startswith('landedAt ='):
                            val = stripped.split('=', 1)[1].strip()
                            if val:
                                v_landed_at = val
                        elif stripped == 'ORBIT' and not in_orbit:
                            in_orbit = True

                    if in_orbit and abs_indent == vessel_base_depth + 1:
                        if stripped.startswith('REF ='):
                            try:
                                v_orbit_ref = int(stripped.split('=', 1)[1].strip())
                            except ValueError:
                                pass

                    if abs_indent > vessel_base_depth and stripped.startswith('crew ='):
                        candidate = stripped.split('=', 1)[1].strip()
                        if candidate in crew:
                            crew_names.add(candidate)

                if stripped.startswith('{'):
                    abs_indent += 1

        for kerbal_name, kerbal in crew.items():
            if getattr(kerbal, 'state', '') == 'Available':
                kerbal.current_location = 'Kerbin (KSC)'
                kerbal.current_vessel = ''
            elif getattr(kerbal, 'state', '') == 'Assigned':
                kerbal.current_location = location_map.get(kerbal_name, 'Unknown')
                kerbal.current_vessel = vessel_map.get(kerbal_name, '')
            elif kerbal.state == 'Dead':
                kerbal.current_location = 'N/A'
                kerbal.current_vessel = ''
            else:
                kerbal.current_location = 'Unknown'
                kerbal.current_vessel = ''

    def parse_contracts(self) -> Dict[str, ContractStats]:
        """Estrae statistiche sui contratti completati"""
        contracts = {}

        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_contracts = False
            in_contract = False
            current_type = None
            current_funds = 0.0
            current_state = None
            current_tourists = 0
            indent_level = 0

            for line in f:
                stripped = line.strip()

                if stripped.startswith('}'):
                    indent_level -= 1
                    if in_contract and indent_level == 1:
                        if current_type and current_state == 'Completed':
                            if current_type not in contracts:
                                contracts[current_type] = ContractStats(contract_type=current_type)
                            contracts[current_type].add_contract(current_funds, current_tourists)
                        current_type = None
                        current_funds = 0.0
                        current_state = None
                        current_tourists = 0
                        in_contract = False
                    elif in_contracts and indent_level == 0:
                        in_contracts = False

                if stripped == 'CONTRACTS':
                    in_contracts = True
                    indent_level = 0
                elif in_contracts and stripped == 'CONTRACT_FINISHED':
                    in_contract = True
                    indent_level = 1
                    current_tourists = 0
                elif in_contract and indent_level == 2:
                    # Only read direct children of CONTRACT_FINISHED
                    if stripped.startswith('type ='):
                        current_type = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('state ='):
                        current_state = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('values ='):
                        try:
                            vals = [float(v) for v in stripped.split('=', 1)[1].strip().split(',')]
                            current_funds = vals[4] if len(vals) > 4 else 0.0
                        except (ValueError, IndexError):
                            current_funds = 0.0
                    elif stripped.startswith('tourists ='):
                        names = stripped.split('=', 1)[1].strip()
                        current_tourists = len([n for n in names.split('|') if n.strip()])

                if stripped.startswith('{'):
                    indent_level += 1

        return contracts
    
    def parse_contract_history(self) -> List['ContractRecord']:
        """Returns one ContractRecord per completed contract (for timeline/progression)."""
        records: List[ContractRecord] = []

        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            in_contracts = False
            in_contract  = False
            current_type = None
            current_prestige = 0
            current_body = ''
            current_funds = 0.0
            current_passengers = 0
            current_date_ut = 0.0
            current_state = None
            indent_level = 0

            for line in f:
                stripped = line.strip()

                if stripped.startswith('}'):
                    indent_level -= 1
                    if in_contract and indent_level == 1:
                        if current_type and current_state == 'Completed' and current_date_ut > 0:
                            year, day = ut_to_ksp_date(current_date_ut)
                            records.append(ContractRecord(
                                contract_type=current_type,
                                prestige=current_prestige,
                                body_name=current_body,
                                funds=current_funds,
                                passengers=current_passengers,
                                date_ut=current_date_ut,
                                ksp_year=year,
                                ksp_day=day,
                            ))
                        current_type = None
                        current_prestige = 0
                        current_body = ''
                        current_funds = 0.0
                        current_passengers = 0
                        current_date_ut = 0.0
                        current_state = None
                        in_contract = False
                    elif in_contracts and indent_level == 0:
                        in_contracts = False

                if stripped == 'CONTRACTS':
                    in_contracts = True
                    indent_level = 0
                elif in_contracts and stripped == 'CONTRACT_FINISHED':
                    in_contract = True
                    indent_level = 1
                elif in_contract and indent_level == 2:
                    if stripped.startswith('type ='):
                        current_type = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('state ='):
                        current_state = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('prestige ='):
                        try:
                            current_prestige = int(stripped.split('=', 1)[1].strip())
                        except ValueError:
                            pass
                    elif stripped.startswith('bodyName ='):
                        current_body = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('targetBody ='):
                        if not current_body:
                            try:
                                ref = int(stripped.split('=', 1)[1].strip())
                                current_body = BODY_NAMES.get(ref, '')
                            except ValueError:
                                pass
                    elif stripped.startswith('values ='):
                        try:
                            vals = [float(v) for v in stripped.split('=', 1)[1].strip().split(',')]
                            current_funds   = vals[4] if len(vals) > 4 else 0.0
                            current_date_ut = vals[8] if len(vals) > 8 else 0.0
                        except (ValueError, IndexError):
                            pass
                    elif stripped.startswith('tourists ='):
                        names = stripped.split('=', 1)[1].strip()
                        current_passengers = len([n for n in names.split('|') if n.strip()])

                if stripped.startswith('{'):
                    indent_level += 1

        return records

    def parse_rescue_dates(self, kerbals: Dict[str, KerbalStats]) -> float:
        """
        Single-pass scan that reads:
          - FLIGHTSTATE.UT  → current game time (seconds)
          - CONTRACT_FINISHED blocks of type RecoverAsset → rescue date per kerbal
        Sets kerbals[name].hired_ut for each rescued non-veteran kerbal.
        Returns the current game UT (0.0 if not found).
        """
        current_ut = 0.0

        # FLIGHTSTATE tracking (local indent, reset when block found)
        in_ft  = False
        ft_lvl = 0

        # CONTRACTS tracking
        in_cts  = False
        cts_lvl = 0
        in_ct   = False
        ct_type = ct_name = None
        ct_ut   = 0.0

        with open(self.filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                stripped = line.strip()

                # ── Decrement ─────────────────────────────────────────────
                if stripped.startswith('}'):
                    if in_ft:
                        ft_lvl -= 1
                        if ft_lvl < 0:
                            in_ft = False
                    if in_ct:
                        cts_lvl -= 1
                        if cts_lvl == 1:        # CONTRACT_FINISHED block closed
                            if ct_type == 'RecoverAsset' and ct_name and ct_ut > 0:
                                if ct_name in kerbals and not kerbals[ct_name].veteran:
                                    kerbals[ct_name].hired_ut = ct_ut
                            ct_type = ct_name = None
                            ct_ut = 0.0
                            in_ct = False
                    elif in_cts:
                        cts_lvl -= 1
                        if cts_lvl <= 0:
                            in_cts = False

                # ── Block detection ───────────────────────────────────────
                if not in_ft and stripped == 'FLIGHTSTATE':
                    in_ft = True;  ft_lvl = 0
                elif not in_cts and stripped == 'CONTRACTS':
                    in_cts = True; cts_lvl = 0
                elif in_cts and not in_ct and stripped == 'CONTRACT_FINISHED':
                    in_ct = True;  cts_lvl = 1

                # ── Content reading ───────────────────────────────────────
                if in_ft and ft_lvl == 1 and stripped.startswith('UT ='):
                    try:
                        current_ut = float(stripped.split('=', 1)[1].strip())
                        in_ft = False           # found what we need
                    except ValueError:
                        pass

                if in_ct and cts_lvl == 2:
                    if stripped.startswith('type ='):
                        ct_type = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('kerbalName ='):
                        ct_name = stripped.split('=', 1)[1].strip()
                    elif stripped.startswith('values ='):
                        try:
                            vals = [float(v) for v in stripped.split('=', 1)[1].strip().split(',')]
                            ct_ut = vals[8] if len(vals) > 8 else 0.0
                        except (ValueError, IndexError):
                            pass

                # ── Increment ─────────────────────────────────────────────
                if stripped.startswith('{'):
                    if in_ft:
                        ft_lvl  += 1
                    if in_cts:
                        cts_lvl += 1

        return current_ut

    def parse_all(self):
        """
        Full parse of the save file.
        Returns: (kerbals_dict, tourists_dict, contracts_dict, contract_history, file_hash, game_ut)
        """
        file_hash = self.calculate_file_hash()

        # Parse kerbals
        print("Parsing Kerbal roster...")
        kerbals = self.parse_kerbal_roster()

        # Parse flight logs (CAREER_LOG + FLIGHT_LOG)
        print(f"Parsing flight logs for {len(kerbals)} kerbals...")
        kerbals = self.parse_flight_logs(kerbals)

        # Derive visit counts: one per distinct mission index, not per event
        for kerbal in kerbals.values():
            kerbal.locations = {body: len(missions) for body, missions in kerbal.body_missions.items()}

        # Parse tourists — active (ROSTER) + historical (TourismContract records)
        print("Parsing tourist roster...")
        active_tourists = self.parse_tourist_roster()
        self.parse_flight_logs(active_tourists)  # reuse: duck-typed, same fields
        for t in active_tourists.values():
            t.locations = {body: len(missions) for body, missions in t.body_missions.items()}

        print("Parsing tourist contract history...")
        historical_tourists = self.parse_tourist_contracts()
        print(f"Active tourists: {len(active_tourists)}, historical: {len(historical_tourists)}")

        # Merge: active (Flying) takes priority over historical for same name
        all_tourists = {**historical_tourists, **active_tourists}

        # Vessel assignments for both kerbals and active tourists
        print("Parsing vessel assignments...")
        self.parse_vessel_assignments({**kerbals, **active_tourists})

        # Parse rescue dates and current game time
        print("Parsing rescue dates...")
        game_ut = self.parse_rescue_dates(kerbals)
        print(f"Game UT: {game_ut:.0f}s")

        # Compute KSP experience: each unique (body, activity) pair gives XP independently.
        # Flyby + Orbit + Land at Mun = 0.5 + 1.5 + 3.0 = 5.0 XP (not just the best).
        BODY_ACTIVITY_XP = {
            'Sun':    {'Flyby': 3.0, 'Orbit': 6.0},
            'Kerbin': {'Flight': 0.5, 'Suborbit': 0.5, 'Orbit': 0.5, 'Flyby': 0.5, 'Land': 0.5, 'Splashdown': 0.5, 'PlantFlag': 0.5, 'Crash': 0.5},
            'Mun':    {'Flyby': 0.5, 'Orbit': 1.5, 'Land': 3.0, 'PlantFlag': 3.0, 'Crash': 3.0},
            'Minmus': {'Flyby': 0.5, 'Orbit': 1.5, 'Land': 4.0, 'PlantFlag': 4.0},
            'Eve':    {'Flight': 0.5, 'Flyby': 1.0, 'Orbit': 2.5, 'Land': 7.0, 'Splashdown': 7.0},
            'Gilly':  {'Flyby': 0.5, 'Orbit': 1.5, 'Land': 2.5},
            'Duna':   {'Flight': 0.5, 'Suborbit': 1.0, 'Flyby': 1.0, 'Orbit': 2.5, 'Land': 8.0},
            'Ike':    {'Flyby': 1.0, 'Orbit': 2.5, 'Land': 4.0},
            'Moho':   {'Flyby': 1.5, 'Orbit': 3.5, 'Land': 9.0},
            'Dres':   {'Flyby': 1.5, 'Orbit': 3.5, 'Land': 7.0},
            'Jool':   {'Flight': 1.0, 'Flyby': 2.0, 'Orbit': 4.0},
            'Laythe': {'Flight': 1.0, 'Flyby': 2.0, 'Orbit': 4.5, 'Land': 7.0, 'Splashdown': 7.0},
            'Vall':   {'Flyby': 2.0, 'Orbit': 4.5, 'Land': 5.0},
            'Tylo':   {'Flyby': 2.5, 'Orbit': 5.0, 'Land': 10.0},
            'Bop':    {'Flyby': 2.0, 'Orbit': 4.5, 'Land': 5.0, 'PlantFlag': 5.0},
            'Pol':    {'Flyby': 2.0, 'Orbit': 4.5, 'Land': 5.0},
            'Eeloo':  {'Flyby': 2.5, 'Orbit': 5.5, 'Land': 12.0},
        }
        KSP_LEVELS = [2, 6, 16, 32, 64]

        for kerbal in kerbals.values():
            if kerbal.experience == 0.0 and kerbal.body_activities:
                xp = sum(
                    BODY_ACTIVITY_XP.get(body, {}).get(act, 0.0)
                    for body, acts in kerbal.body_activities.items()
                    for act in acts
                )
                kerbal.experience = round(xp, 2)
            kerbal.experience_level = sum(1 for t in KSP_LEVELS if kerbal.experience >= t)

        # Parse contracts (aggregated by type)
        print("Parsing contracts...")
        contracts = self.parse_contracts()

        # Parse individual contract records (for progression timeline)
        print("Parsing contract history...")
        contract_history = self.parse_contract_history()
        print(f"Contract history: {len(contract_history)} records")

        # Remove tourists from kerbals dict
        kerbals = {name: stats for name, stats in kerbals.items()
                   if not stats.is_tourist}

        return kerbals, all_tourists, contracts, contract_history, file_hash, game_ut


if __name__ == '__main__':
    # Test del parser
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python sfs_parser.py <path_to_persistent.sfs>")
        sys.exit(1)
    
    parser = SFSParser(sys.argv[1])
    kerbals, contracts, file_hash = parser.parse_all()
    
    print(f"\n=== File Hash: {file_hash} ===\n")
    
    print(f"=== Kerbals ({len(kerbals)}) ===")
    for name, stats in sorted(kerbals.items()):
        print(f"\n{name}:")
        print(f"  Flights: {stats.flights}")
        print(f"  Destinations:")
        for loc, count in sorted(stats.locations.items(), key=lambda x: x[1], reverse=True):
            print(f"    - {loc}: {count} times")

    print(f"\n=== Contracts by Type ===")
    total_contracts = sum(c.count for c in contracts.values())
    total_funds = sum(c.total_funds for c in contracts.values())

    for ctype, stats in sorted(contracts.items(), key=lambda x: x[1].total_funds, reverse=True):
        print(f"\n{ctype}:")
        print(f"  Count: {stats.count}")
        print(f"  Total funds: {stats.total_funds:,.2f} Funds")

    print(f"\n=== Totals ===")
    print(f"Completed contracts: {total_contracts}")
    print(f"Total funds: {total_funds:,.2f} Funds")
