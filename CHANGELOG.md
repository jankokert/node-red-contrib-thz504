# Changelog

## 0.4.3 – unreleased

- **Default sender id is now `0x6A2`.** The THZ 504 does not answer `0x6A3` (0 of 87 requests on 12.11.2026); `0x6A2` and `0x69F` work (70/70). Earlier "successful" tests with `0x6A3` only worked because other flows polled the same registers and the node read their responses passively. Nodes still set to `0x6A3` log a warning.

## 0.4.2 – unreleased

- THZ 504 → HA: `false` in the id map skips a value (or a single status bit), e.g. when another flow already provides that entity.

## 0.4.1 – unreleased

- Catalog: EXV I factor (`0x07F8`) is reset to 1.000 at every compressor start (briefly 0); at standstill it shows the last end value.

## 0.4.0 – unreleased

From the fault-13 analysis (hand-over 12.11.2026):

- New node **THZ 504 diagnosis**: EXV/pilot ratio, model of the "refrigerant shortage" guard (counter and time to stop), heating circuit feed-forward and integral, fault lock, last-run figures, events for compressor start/stop with cause and fault lock on/off.
- THZ 504 read: interval "10 s running" (10 s while the compressor runs, otherwise 60 s; compressor state polled internally).
- THZ 504 → HA: own entity ids (JSON map, also for status bits) to take over old entities.
- Catalog: heating power relative is signed (negative during hot water); EXV P/I/D factors and dynamic factor are raw/1000 (new decoding `milli_s`); superheat guard time `0x07EC`; notes on compressor demand, modes IWS/EVE, cycle lock, error code and status bits; 18 research candidates (group "Research"); presets "Refrigerant shortage diagnosis" and "Research".

## 0.3.1 – unreleased

- Compressor values checked with the compressor running (11.11.2026, 26 Hz):
  - motor current is raw /10 (5.3 A), voltage in V; √3 · U · I matches the motor power within 1–2 %,
  - speed, speed targets and compressor demand verified,
  - heating/cooling output `0xC0EE` stays 0 – the unit does not measure it.

## 0.3.0 – unreleased

- Register catalog extended from 97 to 241 values, based on the menu structure of the THZ 504 manual and a capture of the control panel traffic (10.11.2026):
  - heating circuit 2 (device `0x302`), solar, cooling, screed drying, humidity protection, pump cycles,
  - controller settings (proportional gain `0xC0DF`, integral `0xC0E0`, design temperature `0xC0D6`, bivalence point …),
  - expert analysis and inverter values (evaporator outlet, superheat recuperator, EXV PID factors, compressor demand and speed targets …),
  - weekly programs (heating HC1/HC2, hot water, fan) as one text value per weekday.
- Existing entries: menu path, control panel label, direct access code, range and factory setting added; 50 status upgrades after verification. Keys are unchanged.
- New decodings `qh_time` ("15:00") and `schedule` ("10:00–18:00, …").
- Dialog: menu filter (all menu levels) and a tooltip with menu path, direct code, range and factory setting.
- Home Assistant: settings and time programs are diagnostic entities without statistics.
- Not included: fault list (needs a write telegram), holiday/party program, device clock.

## 0.2.3 – unreleased

- Dialog: interval "1 d" added.

## 0.2.2 – unreleased

- Dialog: table header; click a column (selected, value, unit, group, status, interval) to sort, click again to reverse.

## 0.2.1 – unreleased

- Dialog: unit in its own column, device/register address only in the tooltip, narrower status column.
- Dialog: interval "at start only" no longer offered (still supported at runtime); such values show 1 h.

## 0.2.0 – unreleased

- Separate settings for display language and id language. The id language controls topics and Home Assistant entity ids (`thz504/aussentemperatur` or `thz504/outdoor_temp`).
- Every register and status bit has a German id (ASCII). The dialog shows the resulting id next to each value and switches names live.
- Keys `dhw_*` renamed to `hot_water_*`. Old selections are migrated automatically (`meta.renamed` in the catalog).
- Home Assistant: `unique_id` stays on the fixed key, entity id and state topic use the chosen id.
- `msg.thz504` now has `id`; status bits as `bits` (by id) and `bitList` (key, id, name, state).
- Read command accepts keys and German ids.
- Nodes from 0.1.x keep English ids, so their topics do not change.

## 0.1.1 – unreleased

- Editor: "Device" and "Use responses to other bus members" are hidden for now so the value table gets more height (settings are kept).
- First successful test on a real THZ 504 with sender id 0x6A3.

## 0.1.0 – unreleased

- `thz504-read`: scheduled read requests, response decoding, register picker with presets, search and per-value interval (German and English UI).
- `thz504-ha`: Home Assistant MQTT discovery (sensors, binary sensors for status bits).
- Register catalog `registers/thz504.json` (THZ 504, firmware 7.59) with status verified / plausible / candidate.
- Read only: the code cannot build write frames.
