# Changelog

## 0.1.1 – unreleased

- Editor: "Device" and "Use responses to other bus members" are hidden for now so the value table gets more height (settings are kept).
- First successful test on a real THZ 504 with sender id 0x6A3.

## 0.1.0 – unreleased

- `thz504-read`: scheduled read requests, response decoding, register picker with presets, search and per-value interval (German and English UI).
- `thz504-ha`: Home Assistant MQTT discovery (sensors, binary sensors for status bits).
- Register catalog `registers/thz504.json` (THZ 504, firmware 7.59) with status verified / plausible / candidate.
- Read only: the code cannot build write frames.
