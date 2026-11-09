# Changelog

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
