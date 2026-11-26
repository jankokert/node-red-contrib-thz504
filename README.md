# node-red-contrib-thz504

Node-RED nodes that read a **Tecalor THZ 504** (identical to the Stiebel Eltron LWZ 504) via CAN bus and, optionally, hand the values to Home Assistant via MQTT discovery.

[Deutsche Anleitung](README.de.md)

- **Read only.** The code cannot build write frames.
- **Register knowledge included.** More than 240 values with scaling, unit and status (verified, plausible, candidate), mapped to the control panel's menu structure with direct access code, range and factory setting. No reverse engineering needed.
- **Heating circuit 2, solar and time programs too.** Heating, hot water and fan programs appear per weekday as readable text, e.g. "10:00–18:00".
- **Configured in the editor.** Tick values, choose an interval per value, or use presets ("Basic", "Refrigerant diagnostics", "Energy and counters" …). The bus load is shown.
- **Home Assistant.** Sensors and binary sensors appear automatically, no YAML.

> Tested only with a THZ 504, software 7.59. Other units and software versions may differ.

## Requirements

| | |
|---|---|
| Hardware | CAN adapter on a Linux host (e.g. Raspberry Pi with an MCP2515 HAT), interface `can0` at 20 kbit/s |
| Node-RED | 3.0 or later, Node.js 18 or later |
| Palette | [`node-red-contrib-socketcan`](https://flows.nodered.org/node/node-red-contrib-socketcan) |
| Home Assistant (optional) | MQTT broker and MQTT integration, HA 2025.10 or later |

```bash
sudo ip link set can0 up type can bitrate 20000
```

## Install

Manage palette → Install → `node-red-contrib-thz504`, or on the command line:

```bash
cd ~/.node-red
npm install node-red-contrib-thz504
```

Restart Node-RED after an update.

## Quick start

1. Menu → Import → Examples → `node-red-contrib-thz504` → **thz504-to-home-assistant**.
2. Check the CAN interface in the socketcan config and set your MQTT broker.
3. Open **THZ 504 read**, pick values, deploy.

```
socketcan-out ──► THZ 504 read ──(1)──► socketcan-in
 (receives)            │                  (sends)
                       └──(2)──► THZ 504 → HA ──► mqtt out
```

> **Note:** in `node-red-contrib-socketcan`, `socketcan-out` **receives** and `socketcan-in` **sends**.

## Nodes

### THZ 504 read

| Setting | Meaning |
|---|---|
| Sender ID | Own CAN id, default `0x6A2`. The THZ 504 answers only certain senders: `0x6A2` and `0x69F` work, `0x6A3` does not. With an ESP32 (kr0ner, also `0x6A2`) on the bus, choose `0x69F`. |
| Requests/s | Upper limit, default 4 |
| Display language | German or English for display names (`msg.thz504.name`, entity name in HA) and for the table in the dialog |
| ID language | German or English for topics and entity ids, e.g. `thz504/outdoor_temp` or `thz504/aussentemperatur`. Independent of the display language. |
| Use responses to others | Also take values from responses to other bus members. Write frames of other devices are never used. |
| Value list | Interval per value from 10 s to 1 d. All selected values are read once right after every deploy. |
| "10 s running" | 10 s while the compressor runs, otherwise 60 s. The node polls the compressor state itself every 10 s for this. |

Output 2 sends one message per value:

```json
{ "topic": "thz504/outdoor_temp", "payload": 11.6,
  "thz504": { "key": "outdoor_temp", "name": "Outdoor temperature", "unit": "°C", "status": "verified", "dev": 384, "reg": 12, "raw": 116 } }
```

Read now: `msg.topic = "read"`, `msg.payload = "all"`, a key or id, or an array of them.

#### Keys, ids and names

| Level | Example | Used for |
|---|---|---|
| Key (fixed, English) | `hot_water_temp` | Stored selection, `unique_id` in HA |
| ID (language selectable) | `hot_water_temp` / `warmwasser_ist` | Topic and entity id |
| Display name (language selectable) | "Hot water temperature" / "Warmwasser Ist" | `msg.thz504.name`, name in HA |

German ids are ASCII (ä→ae, ö→oe, ü→ue, ß→ss). The dialog shows the resulting id next to each value.

### THZ 504 → HA

Sends the discovery config once per value, then the states, all retained.
- Entity ids: `sensor.<prefix>_<id>`, e.g. `sensor.thz504_outdoor_temp`.
- The `unique_id` stays on the fixed key, so switching the id language later does not create duplicates. Home Assistant does not rename existing entity ids, though; do that in HA if needed.
- The operating status is also split into binary sensors: compressor, heating, hot water, service, defrost …
- Connect an `mqtt in` on `homeassistant/status` to re-send discovery after a Home Assistant restart.
- **Own entity ids** (advanced): JSON map "key → entity id", e.g. `{"exv_opening": "thz504_diag_exv_oeffnung", "operating_status.compressor": "thz504_verdichter"}`. New sensors can take over the ids of old entities; delete the old entity in HA first so history and statistics continue.

### THZ 504 diagnosis

Calculates diagnostic values from the read values and reports compressor runs. Based on the analysis of error 13 (refrigerant shortage) in November 2026. In the read node, choose the preset **Refrigerant shortage diagnosis**.

```
THZ 504 read ──(2)──► THZ 504 diagnosis ──(1)──► THZ 504 → HA ──► mqtt out
                             └──(2)──► events (debug, file, notification)
```

| Value | Meaning |
|---|---|
| EXV / pilot ratio | ≈ P · I · D of the superheat controller (EXV = pilot × P × I × D, confirmed within ±1 % on 19 runs) |
| Guard counter, time to stop | Model of the "refrigerant shortage" guard: counts while EXV ≥ 2.975 × pilot, EXV < 100 % and the I factor is below its limit 4.0, stop after 0x07EC minutes (10 min). 12/16 hits, no false alarm. |
| HC feed-forward, HC integral | Heating power relative = feed-forward + integral |
| Fault lock active | Bit 64 of 0x0176 – the error code is reported only once |
| Last run | Duration, heating power at start, I factor after 10 min, max. EXV/pilot, stop cause |

Events: `compressor_start`, `compressor_stop` (cause `guard`, `hot_water`, `fault_lock`, `routine`, `regular`, `reset`), `fault_lock_on`, `fault_lock_off`, `reset` (operating status 0: manual reset or power failure).

## Register catalog

`registers/thz504.json` is the single source. Each entry has:
- an English key,
- German and English names,
- device (`0x180` heat pump, `0x301` heating circuit controller) and register,
- decoding, unit, group and status,
- where known: menu path on the control panel (`menu`), label on the unit (`label`), direct access code, min, max and factory setting,
- a suggested interval.

Combined values such as compressor starts or energy counters consist of several registers (`parts`).

Contributions are welcome. For new registers, please state what the value was checked against.

## Known quirks of the THZ 504

- With the pump running and the compressor off, flow minus return shows about 1.7 K sensor offset.
- The internal electricity counter reads considerably lower than an external meter in front of the heat pump.
- Error 13 (refrigerant shortage) is reported only once, so error code 0 does not mean all clear.
- Bit 6 of the operating status (service) blocks the compressor until reset.

## Disclaimer

Use at your own risk. The nodes only send read requests, but they do access the heat pump's internal bus.

## License

MIT
