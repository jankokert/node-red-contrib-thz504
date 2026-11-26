# node-red-contrib-thz504

Node-RED-Knoten, die eine **Tecalor THZ 504** (baugleich Stiebel Eltron LWZ 504) über den CAN-Bus auslesen und die Werte auf Wunsch per MQTT-Discovery an Home Assistant übergeben.

- **Nur lesend.** Der Code kann keine Schreibtelegramme erzeugen.
- **Registerwissen inklusive.** Über 240 Werte mit Skalierung, Einheit und Status (verifiziert, plausibel, Kandidat), zugeordnet zur Menüstruktur des Bediengeräts, mit Direktzugriffscode, Wertebereich und Werkseinstellung. Eigenes Reverse-Engineering ist nicht nötig.
- **Auch Heizkreis 2, Solar und Zeitprogramme.** Die Heiz-, Warmwasser- und Lüfterprogramme erscheinen je Wochentag als lesbarer Text, z. B. „10:00–18:00“.
- **Bedienung im Editor.** Werte ankreuzen, je Wert ein Intervall wählen oder Vorlagen nutzen („Basis“, „Kältekreis-Diagnose“, „Energie und Zähler“ …). Die Buslast wird angezeigt.
- **Home Assistant.** Sensoren und Binärsensoren erscheinen automatisch, ohne YAML.

> Getestet nur mit einer THZ 504, Software 7.59. Andere Geräte und Softwarestände können abweichen.

## Voraussetzungen

| | |
|---|---|
| Hardware | CAN-Adapter am Linux-Rechner (z. B. Raspberry Pi mit MCP2515-HAT), Interface `can0` mit 20 kbit/s |
| Node-RED | ab 3.0, Node.js ab 18 |
| Palette | [`node-red-contrib-socketcan`](https://flows.nodered.org/node/node-red-contrib-socketcan) |
| Home Assistant (optional) | MQTT-Broker und MQTT-Integration, HA ab 2025.10 |

CAN-Interface einrichten (Beispiel):

```bash
sudo ip link set can0 up type can bitrate 20000
```

## Installation

Palette verwalten → Installieren → `node-red-contrib-thz504`, oder auf der Kommandozeile:

```bash
cd ~/.node-red
npm install node-red-contrib-thz504
```

Nach einem Update Node-RED neu starten.

## Schnellstart

1. Menü → Import → Beispiele → `node-red-contrib-thz504` → **thz504-to-home-assistant**.
2. In der socketcan-Konfiguration das Interface prüfen und den MQTT-Broker eintragen.
3. **THZ 504 lesen** öffnen, Werte auswählen und deployen.

```
socketcan-out ──► THZ 504 lesen ──(1)──► socketcan-in
  (empfängt)            │                  (sendet)
                        └──(2)──► THZ 504 → HA ──► mqtt out
```

> **Achtung:** In `node-red-contrib-socketcan` **empfängt** `socketcan-out` und **sendet** `socketcan-in`.

## Knoten

### THZ 504 lesen

| Einstellung | Bedeutung |
|---|---|
| Absender-ID | Eigene CAN-ID, Standard `0x6A2`. Die THZ 504 antwortet nur bestimmten Absendern: `0x6A2` und `0x69F` funktionieren, `0x6A3` nicht. Mit einem ESP32 (kr0ner, ebenfalls `0x6A2`) am Bus hier `0x69F` wählen. |
| Anfragen/s | Obergrenze, Standard 4 |
| Sprache Anzeige | Deutsch oder Englisch für Anzeigenamen (`msg.thz504.name`, Name der Entität in HA) und für die Tabelle im Dialog |
| Sprache IDs | Deutsch oder Englisch für Topics und Entitäts-IDs, z. B. `thz504/aussentemperatur` oder `thz504/outdoor_temp`. Unabhängig von der Anzeigesprache. |
| Antworten mitlesen | Werte auch aus Antworten an andere Teilnehmer übernehmen. Schreibtelegramme anderer Geräte werden nie übernommen. |
| Werteliste | Je Wert ein Intervall von 10 s bis 1 d. Nach jedem Deploy werden alle gewählten Werte sofort einmal gelesen. |
| „10 s im Lauf“ | 10 s bei laufendem Verdichter, sonst 60 s. Den Verdichterzustand fragt der Knoten dafür selbst alle 10 s ab. So lassen sich die ersten Minuten nach einem Start auflösen, ohne den Bus im Stillstand zu belasten. |

Ausgang 2 liefert je Wert eine Nachricht:

```json
{ "topic": "thz504/outdoor_temp", "payload": 11.6,
  "thz504": { "key": "outdoor_temp", "name": "Außentemperatur", "unit": "°C", "status": "verified", "dev": 384, "reg": 12, "raw": 116 } }
```

Sofort lesen: `msg.topic = "read"`, `msg.payload = "all"`, ein Schlüssel bzw. eine ID oder ein Array davon.

#### Schlüssel, IDs und Namen

| Ebene | Beispiel | Verwendung |
|---|---|---|
| Schlüssel (fest, englisch) | `hot_water_temp` | Speichern der Auswahl, `unique_id` in HA |
| ID (Sprache wählbar) | `warmwasser_ist` / `hot_water_temp` | Topic und Entitäts-ID |
| Anzeigename (Sprache wählbar) | „Warmwasser Ist“ / „Hot water temperature“ | `msg.thz504.name`, Name in HA |

In IDs werden Umlaute zu ae, oe, ue und ß zu ss, weil HA und MQTT dort nur ASCII erlauben. Die Tabelle im Dialog zeigt die entstehende ID klein neben jedem Wert, die Einheit in einer eigenen Spalte und die Adresse (Gerät/Register) im Tooltip.

### THZ 504 → HA

Erzeugt die Discovery-Konfiguration einmal je Wert und danach die Zustände, alles mit `retain`.
- Entitäts-IDs: `sensor.<Präfix>_<ID>`, z. B. `sensor.thz504_aussentemperatur`.
- Die `unique_id` bleibt beim festen Schlüssel. Wird die ID-Sprache später umgestellt, entstehen keine doppelten Entitäten. HA benennt bestehende Entitäts-IDs dabei aber nicht um; das geht bei Bedarf in HA selbst.
- Der Betriebsstatus wird zusätzlich in Binärsensoren zerlegt: Verdichter, Heizen, Warmwasser, Service, Abtauen …
- Einen `mqtt in` auf `homeassistant/status` anschließen, dann wird die Discovery nach einem HA-Neustart erneut gesendet.
- **Eigene Entitäts-IDs** (Erweitert): JSON-Zuordnung „Schlüssel → Entitäts-ID“, z. B. `{"exv_opening": "thz504_diag_exv_oeffnung", "operating_status.compressor": "thz504_verdichter"}`. Damit übernehmen neue Sensoren die IDs alter Entitäten; die alte Entität vorher in HA löschen, dann laufen Verlauf und Statistik weiter.

### THZ 504 Diagnose

Berechnet aus den gelesenen Werten Diagnosegrößen und meldet Verdichterläufe. Grundlage ist die Analyse von Fehler 13 (Kältemittelmangel) im November 2026.

```
THZ 504 lesen ──(2)──► THZ 504 Diagnose ──(1)──► THZ 504 → HA ──► mqtt out
                              └──(2)──► Ereignisse (Debug, Datei, Benachrichtigung)
```

Im Lese-Knoten die Vorlage **Diagnose Kältemittelmangel** wählen.

| Wert | Bedeutung |
|---|---|
| EXV / Vorsteuerung | ≈ P · I · D des Überhitzungsreglers (EXV = Vorsteuerung × P × I × D, an 19 Läufen auf ±1 % bestätigt) |
| Wächterzähler, Restzeit | Modell des Wächters „Kältemittelmangel“: Zähler läuft, solange EXV ≥ 2,975 × Vorsteuerung, EXV < 100 % und der I-Faktor unter seinem Anschlag 4,0 liegt, Abschaltung nach 0x07EC Minuten (10 min). Trefferquote 12/16, kein Fehlalarm. |
| HK-Vorsteuerung, HK-Integralanteil | Heizleistung relativ = Vorsteuerung + Integral; Vorsteuerung = Leistung Auslegung × (RT − AT gedämpft)/(RT − T Auslegung) |
| Störsperre aktiv | Bit 64 von 0x0176 – die Fehlernummer wird nur einmal gemeldet |
| Letzter Lauf | Dauer, Heizleistung beim Start, I-Faktor nach 10 min, max. EXV/Vorsteuerung, Stopp-Ursache |

Ereignisse: `compressor_start`, `compressor_stop` (Ursache `guard` = Wächter, `hot_water`, `fault_lock`, `routine` = 10-Uhr-Routine, `regular`, `reset`), `fault_lock_on`, `fault_lock_off`, `reset` (Betriebsstatus 0: Reset von Hand oder Netzausfall).

## Registerkatalog

`registers/thz504.json` ist die gemeinsame Quelle. Jeder Eintrag hat:
- einen englischen Schlüssel,
- einen deutschen und einen englischen Namen,
- Gerät (`0x180` Wärmepumpe, `0x301` Heizkreisregler) und Register,
- die Dekodierung, Einheit, Gruppe und den Status,
- wo vorhanden: Menüpfad am Bediengerät (`menu`), Bezeichnung am Gerät (`label`), Direktzugriffscode, min, max und Werkseinstellung,
- ein empfohlenes Intervall.

Zusammengesetzte Werte wie Verdichterstarts oder Energiezähler bestehen aus mehreren Registern (`parts`).

Ergänzungen sind willkommen. Bitte bei neuen Registern angeben, womit der Wert abgeglichen wurde.

## Bekannte Eigenheiten der THZ 504

- Vorlauf minus Rücklauf zeigt bei laufender Pumpe ohne Verdichter etwa 1,7 K Fühler-Offset.
- Der interne Stromzähler liegt deutlich unter einem externen Zähler vor der WP.
- Fehler 13 (Kältemittelmangel) wird nur einmal gemeldet. Eine 0 bei der Fehlernummer ist deshalb keine Entwarnung.
- Bit 6 im Betriebsstatus (Service) sperrt den Verdichter bis zum Reset.

## Haftung

Nutzung auf eigene Gefahr. Der Knoten sendet nur Leseanfragen, greift aber auf den internen Bus der Wärmepumpe zu.

## Lizenz

MIT
