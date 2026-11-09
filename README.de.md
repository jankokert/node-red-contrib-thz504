# node-red-contrib-thz504

Node-RED-Knoten, die eine **Tecalor THZ 504** (baugleich Stiebel Eltron LWZ 504) über den CAN-Bus auslesen und die Werte auf Wunsch per MQTT-Discovery an Home Assistant übergeben.

- **Nur lesend.** Der Code kann keine Schreibtelegramme erzeugen.
- **Registerwissen inklusive.** Etwa 100 Register mit Skalierung, Einheit und Status (verifiziert, plausibel, Kandidat). Eigenes Reverse-Engineering ist nicht nötig.
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

Palette verwalten → Installieren → `node-red-contrib-thz504` (sobald veröffentlicht), oder lokal:

```bash
cd ~/.node-red
npm install /pfad/zu/node-red-contrib-thz504
```

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
| Absender-ID | Eigene CAN-ID, Standard `0x6A3`. Muss sich von anderen Teilnehmern unterscheiden. |
| Anfragen/s | Obergrenze, Standard 4 |
| Sprache der Namen | Deutsch oder Englisch, für Wert- und Entitätsnamen |
| Antworten mitlesen | Werte auch aus Antworten an andere Teilnehmer übernehmen. Schreibtelegramme anderer Geräte werden nie übernommen. |
| Werteliste | Je Wert ein Intervall von 10 s bis 1 h oder „nur beim Start“ |

Ausgang 2 liefert je Wert eine Nachricht:

```json
{ "topic": "thz504/outdoor_temp", "payload": 11.6,
  "thz504": { "key": "outdoor_temp", "name": "Außentemperatur", "unit": "°C", "status": "verified", "dev": 384, "reg": 12, "raw": 116 } }
```

Sofort lesen: `msg.topic = "read"`, `msg.payload = "all"`, ein Schlüssel oder ein Array.

### THZ 504 → HA

Erzeugt die Discovery-Konfiguration einmal je Wert und danach die Zustände, alles mit `retain`.
- Entitäts-IDs: `sensor.<Präfix>_<Schlüssel>`, z. B. `sensor.thz504_outdoor_temp`.
- Der Betriebsstatus wird zusätzlich in Binärsensoren zerlegt: Verdichter, Heizen, Warmwasser, Service, Abtauen …
- Einen `mqtt in` auf `homeassistant/status` anschließen, dann wird die Discovery nach einem HA-Neustart erneut gesendet.

## Registerkatalog

`registers/thz504.json` ist die gemeinsame Quelle. Jeder Eintrag hat:
- einen englischen Schlüssel,
- einen deutschen und einen englischen Namen,
- Gerät (`0x180` Wärmepumpe, `0x301` Heizkreisregler) und Register,
- die Dekodierung, Einheit, Gruppe und den Status,
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
