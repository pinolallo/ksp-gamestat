# KSP GameStats - Mission Control Dashboard

Web application per analizzare e visualizzare le statistiche di gioco di Kerbal Space Program.

![KSP GameStats](https://img.shields.io/badge/KSP-GameStats-00d9ff?style=for-the-badge)

## 🚀 Caratteristiche

- **Parser Incrementale**: Parsing efficiente del file persistent.sfs (anche per file da 98MB+)
- **Cache Intelligente**: Sistema basato su hash per evitare parsing ripetuti non necessari
- **Database SQLite**: Salvataggio persistente dei dati
- **Dashboard Interattiva**: Interfaccia web space-themed con design distintivo
- **Statistiche Kerbals**: Voli completati e destinazioni visitate per ogni astronauta
- **Statistiche Contratti**: Analisi per tipologia con guadagni totali e medi

## 📋 Requisiti

- Python 3.8+
- Browser moderno (Chrome, Firefox, Safari, Edge)

## 🔧 Installazione

1. **Copia i file** nella directory del progetto:
   ```bash
   cd /Users/sdipietr/Projects/ksp-gamestat/
   ```

2. **Installa le dipendenze Python**:
   ```bash
   pip install -r requirements.txt
   ```

## 🎮 Utilizzo

### 1. Avvia il server

```bash
python app.py
```

Il server sarà disponibile su `http://localhost:5000`

### 2. Configura il path del file

1. Apri il browser su `http://localhost:5000`
2. Nella sezione "Configurazione Sistema", inserisci il path del tuo file persistent.sfs:
   ```
   /Users/sdipietr/Applications/Kerbal Space Program/saves/Conquer/persistent.sfs
   ```
3. Clicca su "Configura"

### 3. Esegui il parsing

1. Clicca su "Avvia Parsing" per analizzare il file
2. Attendi il completamento (il tempo dipende dalle dimensioni del file)
3. I dati verranno salvati nel database SQLite

### 4. Esplora le statistiche

- **Dashboard**: Visualizza statistiche generali (totale kerbals, voli, contratti, funds)
- **Tab Astronauti**: Vedi i dettagli di ogni Kerbal con voli e destinazioni visitate
- **Tab Contratti**: Analizza i contratti per tipologia con guadagni

## 🔄 Parsing Incrementale

Il sistema utilizza un hash MD5 del file per determinare se è necessario un nuovo parsing:

- **Primo parsing**: Analizza tutto il file e salva nel database
- **Parsing successivi**: Se il file non è cambiato, utilizza i dati in cache
- **Force Refresh**: Usa il pulsante "Force Refresh" per forzare un nuovo parsing

## 📊 Struttura Database

### Tabella `kerbals`
- `id`: ID univoco
- `name`: Nome del Kerbal
- `flights`: Numero di voli completati
- `is_tourist`: Flag per identificare i turisti (esclusi dalle statistiche)
- `last_updated`: Timestamp ultimo aggiornamento

### Tabella `kerbal_locations`
- `id`: ID univoco
- `kerbal_id`: FK verso kerbals
- `location`: Nome della destinazione
- `visit_count`: Numero di visite
- `last_updated`: Timestamp ultimo aggiornamento

### Tabella `contracts`
- `id`: ID univoco
- `contract_type`: Tipologia contratto
- `count`: Numero di contratti completati
- `total_funds`: Guadagno totale
- `last_updated`: Timestamp ultimo aggiornamento

### Tabella `file_metadata`
- `id`: ID univoco
- `filepath`: Path del file .sfs
- `file_hash`: Hash MD5 del file
- `last_parsed`: Timestamp ultimo parsing
- `parse_count`: Numero di parsing eseguiti

## 🎨 Design

L'interfaccia utilizza:

- **Font**: Orbitron (display) e IBM Plex Mono (body)
- **Tema**: Space-themed con palette blu/cyan e accenti arancio
- **Animazioni**: Starfield animato, hover effects, transizioni fluide
- **Responsive**: Ottimizzato per desktop e mobile

## 🛠️ Architettura

```
ksp-gamestat/
├── app.py                 # Backend Flask con API REST
├── sfs_parser.py          # Parser del file .sfs
├── database.py            # Database manager SQLite
├── requirements.txt       # Dipendenze Python
├── ksp_stats.db          # Database SQLite (generato)
├── static/
│   ├── index.html        # Interfaccia principale
│   ├── styles.css        # Stili CSS
│   └── app.js            # JavaScript frontend
└── README.md             # Questo file
```

## 🔍 API Endpoints

- `GET /api/config` - Ottieni configurazione corrente
- `POST /api/config` - Configura path file .sfs
- `POST /api/parse` - Esegui parsing del file
- `GET /api/summary` - Statistiche riassuntive
- `GET /api/kerbals` - Lista tutti i Kerbals
- `GET /api/kerbals/<name>` - Dettagli singolo Kerbal
- `GET /api/contracts` - Lista contratti per tipologia
- `GET /api/health` - Health check

## 🐛 Troubleshooting

### Il parsing è lento
- Il parsing di file da 98MB può richiedere alcuni minuti
- Il sistema utilizza parsing incrementale per ottimizzare i parsing successivi

### Errore "File not found"
- Verifica che il path del file .sfs sia corretto
- Usa il path assoluto completo
- Assicurati che il file esista e sia leggibile

### Database corrotto
- Elimina il file `ksp_stats.db` e riavvia l'applicazione
- Il database verrà ricreato automaticamente

## 📝 Note Tecniche

- **Encoding**: Il parser gestisce file UTF-8 con fallback su errori
- **Performance**: Lettura in chunks per file grandi (8KB)
- **Memoria**: Parser efficiente con uso minimo di memoria
- **Concorrenza**: Non supportata - esegui un parsing alla volta

## 🎯 Funzionalità Future

- [ ] Export dati in CSV/JSON
- [ ] Grafici interattivi con Chart.js
- [ ] Comparazione tra diverse save
- [ ] Tracking progressi nel tempo
- [ ] Filtri avanzati per Kerbals e contratti
- [ ] API per integrazioni esterne

## 👨‍💻 Sviluppo

Per contribuire o modificare:

1. Il parsing è gestito in `sfs_parser.py`
2. La logica database è in `database.py`
3. L'API REST è in `app.py`
4. Il frontend è in `static/`

## 📄 Licenza

Questo progetto è fornito "as-is" per uso personale.

## 🚀 Buon volo!

Che i tuoi Kerbals tornino sempre a casa! 🌍→🌙→🏠
