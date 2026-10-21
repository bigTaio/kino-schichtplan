# Schichtplan Kino Murnau – Anleitung

Diese Website ersetzt den Papierkalender. Mitarbeiter tragen sich am Handy für Schichten ein,
der Kinobesitzer verwaltet alles im Bereich **/admin**.

- Mitarbeiter-Seite: `https://DEINE-ADRESSE/`
- Verwaltung für den Kinobesitzer: `https://DEINE-ADRESSE/admin`

---

## 1. Online stellen (empfohlen: Railway, ca. 5 $ im Monat)

Du brauchst: ein kostenloses GitHub-Konto, ein Railway-Konto und (für die KI) ein Anthropic-Konto.

1. **Code zu GitHub hochladen**
   - Auf github.com anmelden → oben rechts **„+“ → „New repository“** → Name z. B. `kino-schichtplan` → **Private** wählen → „Create repository“.
   - Auf der neuen Seite **„uploading an existing file“** anklicken und den Inhalt des Ordners `kino-schichtplan` hineinziehen,
     **außer** `node_modules`, `data` und `.env` (werden nicht gebraucht bzw. sind privat) → „Commit changes“.
     Hochladen: `public`, `src`, `test`, `server.js`, `package.json`, `package-lock.json`, `Dockerfile`,
     `ANLEITUNG.md`, `.gitignore`, `.env.example`.

2. **Bei Railway starten**
   - Auf railway.com mit dem GitHub-Konto anmelden.
   - **„New Project“ → „Deploy from GitHub repo“** → das Repository auswählen. Railway erkennt die Datei `Dockerfile` automatisch.
   - Unter **Settings → Region** einen Standort in der EU wählen (z. B. Amsterdam) – wichtig für den Datenschutz.

3. **Dauerhaften Speicher anlegen** (sonst gehen die Daten bei jedem Neustart verloren!)
   - Im Projekt **„+ New“ → „Volume“** → mit dem Dienst verbinden → **Mount Path: `/data`**.

4. **Geheime Werte eintragen** – im Dienst unter **„Variables“**:
   | Name | Wert |
   |---|---|
   | `ADMIN_PASSWORD` | ein langes Passwort für den Kinobesitzer |
   | `SHARED_PASSWORD` | das gemeinsame Kino-Passwort für alle Mitarbeiter |
   | `ANTHROPIC_API_KEY` | der KI-Schlüssel (siehe Schritt 6) |
   | `SEED_DEMO` | `false` (keine Beispiel-Mitarbeiter, direkt echter Start) |

   Diese Werte stehen nur auf dem Server und sind im Browser nie sichtbar.

5. **Adresse bekommen**: Dienst → **Settings → Networking → „Generate Domain“**.
   Optional eine eigene Adresse wie `schichtplan.kino-murnau.de`: dort „Custom Domain“ eintragen und den angezeigten
   CNAME-Eintrag beim Anbieter der Kino-Domain hinterlegen.

6. **KI-Schlüssel holen**: auf console.anthropic.com anmelden → **API Keys → Create Key** → Schlüssel kopieren und
   bei Railway als `ANTHROPIC_API_KEY` einfügen. Dort unter **Billing/Limits** ein Monatslimit (z. B. 10 $) setzen –
   dann kann nie mehr ausgegeben werden.

7. **Fertig machen**: Adresse öffnen, unten auf **„🔑 Kinobesitzer“** tippen, Admin-Passwort eingeben.
   In der Übersicht auf **„Programm holen“** → **„Programm aktualisieren“** → **„Übernehmen“**.
   Danach einmal als Mitarbeiter anmelden (Name + Kino-Passwort) und testweise eintragen und absagen.

8. **Updates später**: Geänderte Dateien bei GitHub genauso hochladen. Railway baut die Seite dann automatisch neu;
   die Daten im Speicher `/data` bleiben dabei erhalten.

> **Alternative für Technik-Kundige:** ein kleiner Server bei Hetzner (Deutschland, ca. 4–5 € im Monat) mit Docker:
> `docker build -t kino .` und `docker run -d -p 3000:3000 -v kino-daten:/data --env-file .env --restart always kino`,
> davor ein Webserver wie Caddy für HTTPS.

---

## 2. Was kostet das ungefähr?

Preise nach meinem Wissensstand – bitte beim Anbieter kurz nachprüfen.

| Posten | ca. pro Monat |
|---|---|
| Hosting (Railway Hobby, enthält 5 $ Nutzung – reicht für diese kleine Seite) | ca. 5 $ |
| Programm-Import | **0 €** – die Spielzeiten werden direkt aus der Kinoseite gelesen. Nur wenn die Kinoseite ihren Aufbau ändert, hilft die KI (ca. 0,20 $ pro Abgleich). |
| Mitarbeiter-Assistent (ca. 2–3 Cent pro Frage) | bei 100 Fragen ca. 2–3 $ |
| Admin-Assistent (ca. 5–8 Cent pro Befehl) | bei 50 Befehlen ca. 3–4 $ |
| **Gesamt** | **etwa 5–15 $ im Monat** |

Eingestellt ist das stärkste Modell (Claude Opus 5.5). Wer sparen möchte, trägt bei Railway die Variable
`CLAUDE_MODEL=claude-haiku-5-5` ein – das ist rund 40-mal günstiger, versteht schwierige Sätze aber etwas schlechter.
Ohne KI-Schlüssel funktioniert alles außer den beiden Assistenten.

---

## 3. So bedient der Kinobesitzer die Seite (`/admin`)

- **Übersicht** – Heute, Morgen, freie Schichten, Absagen der letzten Woche. Rote Karten = Warnung
  (jemand hat viele Minuspunkte). Dort direkt **„Sperren“** oder **„Punkte auf 0 setzen“**.
  Unten **„Letzte Änderungen“** mit **„Rückgängig“**.
- **Vorstellungen**
  - **„Programm aktualisieren“** holt das Programm von kino-murnau.de. Es wird **nichts automatisch übernommen**:
    Du siehst „Neu: 5 · geändert: 1 · entfallen: 2“, Warnungen bei schon eingetragenen Personen,
    und klickst **„Übernehmen“** oder **„Verwerfen“**. Das passiert außerdem jeden Morgen automatisch.
  - **„+ Vorstellung von Hand hinzufügen“** – geht immer, auch wenn der Import nicht klappt.
  - **Auf eine Vorstellung tippen** → jemanden eintragen, austragen, ändern, streichen (fällt aus), ganz löschen.
    Betroffene Mitarbeiter sehen sofort einen Hinweis und bekommen **keine** Minuspunkte.
- **Mitarbeiter** – Punktestand aller, sperren/entsperren, Punkte ändern oder auf 0 setzen, löschen.
  Neue Mitarbeiter tauchen automatisch auf, sobald sie sich zum ersten Mal angemeldet haben.
- **Assistent** – einfach schreiben, z. B. *„Morgen fällt der Film um 20 Uhr aus.“* oder
  *„Trag Anna am Samstag um 20:15 Uhr ein.“* Der Assistent zeigt erst, was er tun würde.
  Erst nach **„Ja, so machen“** wird etwas geändert, danach gibt es **„Rückgängig“**.
  Ist etwas unklar, fragt er nach.
- **Einstellungen** – Minuten vor Filmbeginn, Freigabe-Zeitpunkt (z. B. Sonntag 21:00 Uhr),
  alle Minuspunkt-Werte, Warnstufe, Kino-Passwort ändern, eigenes Passwort ändern, **Datensicherung**.
- **Protokoll** – alles, was passiert ist, mit Zeit und Namen. Mit Suchfeld.

### Für die Mitarbeiter (einmal erklären)
1. Adresse am Handy öffnen (Tipp: „Zum Startbildschirm hinzufügen“ – dann ist es wie eine App).
2. Vor- und Nachname und das Kino-Passwort eingeben – fertig. Beim ersten Mal wird man automatisch angelegt.
3. Das Handy bleibt angemeldet. Jede Anmeldung, Eintragung und Absage steht mit Zeit im Protokoll.

Der Kinobesitzer tippt auf der Anmeldeseite unten auf **„🔑 Kinobesitzer“** und gibt sein Admin-Passwort ein.

---

## 4. Daten sichern

- **Einfach:** Verwaltung → **Einstellungen → „Sicherung herunterladen“**. Einmal pro Woche anklicken und
  die Datei (z. B. `kino-sicherung-2026-10-21.db`) auf dem Computer oder in der Cloud aufheben.
- **Zusätzlich:** Bei Railway unter dem Volume **„Backups“** automatische Sicherungen einschalten.
- **Zurückspielen** (nur im Notfall, am besten mit einem technischen Helfer): die Sicherungsdatei als
  `/data/kino.db` in das Volume legen und den Dienst neu starten.

Gespeichert wird nur das Nötigste: Vor- und Nachname, Punkte und Schichten.
Alte Vorstellungen werden nach 60 Tagen, Protokolleinträge nach einem Jahr automatisch gelöscht.

---

## 5. Wenn etwas nicht funktioniert

| Problem | Lösung |
|---|---|
| Seite lädt nicht | Bei Railway den Dienst öffnen → **„Restart“**. Unter „Deployments → Logs“ steht, was los ist. |
| „Programm aktualisieren“ klappt nicht | Nichts geht kaputt. Vorstellungen von Hand eintragen und später noch einmal versuchen. |
| Jemand hat unter fremdem Namen abgesagt | Im **Protokoll** steht, wann sich wer angemeldet und abgesagt hat. Die Person über **Vorstellungen** wieder eintragen und unter **Mitarbeiter** die Punkte korrigieren. |
| Kino-Passwort ist nach außen gelangt | Einstellungen → neues Kino-Passwort, Haken bei „Alle Mitarbeiter abmelden“. |
| Admin-Passwort vergessen | Bei Railway die Variable `ADMIN_PASSWORD_RESET` mit einem neuen Passwort anlegen, neu starten, anmelden, Variable wieder löschen. |
| Assistent sagt „nicht eingerichtet“ | `ANTHROPIC_API_KEY` bei Railway fehlt oder ist falsch. Alles andere funktioniert trotzdem. |
| Falsche Änderung gemacht | Übersicht oder Protokoll → **„Rückgängig“**. |

---

## 6. Für Technik-Helfer

- Node.js ab 22.13 (getestet mit 24), eine einzige Abhängigkeit: `@anthropic-ai/sdk`.
- Start lokal: `npm install`, dann `ADMIN_PASSWORD=… SHARED_PASSWORD=… node server.js` → http://localhost:3000
- Tests: `npm test` (Doppelbuchung mit 20 gleichzeitigen Klicks, Sommer-/Winterzeit, Zugriffsschutz, Karma, Rückgängig, Import,
  beide KI-Chats Ende-zu-Ende gegen einen Test-Ersatz der Claude-Schnittstelle in `test/fake-claude.js`, Anmeldung über Server-Neustart).
- KI-Chats ohne echten Schlüssel ausprobieren: `node test/fake-claude.js 4999` starten und den Server mit
  `ANTHROPIC_API_KEY=test-schluessel ANTHROPIC_BASE_URL=http://127.0.0.1:4999` starten. Der Test-Ersatz versteht nur einfache Beispielsätze.
- Aufbau: `server.js` (Webserver, Anmeldung, Schnittstellen), `src/logic.js` (Regeln), `src/importer.js` (Programm-Import),
  `src/chat.js` + `src/ai.js` (KI), `src/db.js` (SQLite), `public/` (Oberfläche, ohne Geheimnisse).
