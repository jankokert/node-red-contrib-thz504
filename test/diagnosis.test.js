'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const elster = require('../lib/elster');
const catalog = require('../lib/catalog');
const { ThzReader } = require('../lib/reader');
const { HaDiscovery, parseIdMap } = require('../lib/ha');
const { ThzDiagnosis, REQUIRED_KEYS } = require('../lib/diagnosis');

function respond(req, word) {
    const d = req.data, snd = req.canid;
    const dev = ((d[0] & 0xF0) << 3) | (d[1] & 0x7F);
    return { canfd: false, ext: false, canid: dev, dlc: 7, data: [((snd >> 3) & 0xF0) | 2, snd & 0x7F, 0xFA, d[3], d[4], word >> 8, word & 0xFF] };
}
const status = (word) => ({ key: 'operating_status', value: word, bitList: [
    { key: 'compressor', on: !!(word & 2) }, { key: 'hot_water', on: !!(word & 16) }, { key: 'service', on: !!(word & 64) }] });
const v = (key, value) => ({ key, value });

test('decodings from the fault-13 analysis', () => {
    const c = catalog.load('thz504');
    assert.equal(elster.decodeWord(c.byKey.heating_power_rel.decode, 65507), -29);
    assert.equal(elster.decodeWord('milli_s', 1882), 1.882);
    assert.equal(c.byKey.exv_i_factor.decode, 'milli_s');
    // EXV = pilot × P × I × D (example from the hand-over: 18.2 % × 1.013 × 1.882 = 34.7 %)
    const exv = 18.2 * elster.decodeWord('milli_s', 1013) * elster.decodeWord('milli_s', 1882) * elster.decodeWord('milli_s', 1000);
    assert.ok(Math.abs(exv - 34.6) < 0.2);
    assert.equal(c.byKey.superheat_guard_time.reg, 0x07EC);
    for (const k of REQUIRED_KEYS) assert.ok(c.presets.diagnosis.includes(k), 'diagnosis preset lacks ' + k);
});

test('reader: "10 s running" polls fast only while the compressor runs', () => {
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { exv_opening: -10 } });
    assert.equal(rd.selection.exv_opening, -10);
    rd.tick(0);
    const keysSent = () => { const k = []; let r; while ((r = rd.next(0))) k.push([r.key, r.frame]); return k; };
    let sent = keysSent();
    assert.deepEqual(sent.map(s => s[0]).sort(), ['exv_opening', 'operating_status']);   // internal status poll
    assert.equal(rd.interval('exv_opening'), 60);
    // status says compressor on -> 10 s
    const st = sent.find(s => s[0] === 'operating_status')[1];
    rd.handleFrame(respond(sent.find(s => s[0] === 'exv_opening')[1], 600), 900);
    rd.handleFrame(respond(st, 1031), 1000);
    assert.equal(rd.compressorOn, true);
    assert.equal(rd.interval('exv_opening'), 10);
    rd.tick(1000);
    assert.ok(rd.queue.some(q => q.key === 'exv_opening'), 'fast value due right after the start');
    assert.equal(rd.load().perMin, 6);
});

test('HA: id map keeps old entity ids, bits too', () => {
    const ha = new HaDiscovery({ idMap: '{"exv_opening": "sensor.thz504_diag_exv_oeffnung", "operating_status.compressor": "thz504_verdichter"}' });
    const m = ha.messages({ key: 'exv_opening', id: 'expansionsventil', name: 'EXV', value: 60.2, unit: '%', interval: 60 });
    assert.equal(m[0].payload.default_entity_id, 'sensor.thz504_diag_exv_oeffnung');
    const s = ha.messages({ key: 'operating_status', id: 'betriebsstatus', name: 'Status', value: 1031, bitList: [{ key: 'compressor', id: 'verdichter', name: 'Verdichter', on: true }] });
    assert.ok(s.some(x => x.payload.default_entity_id === 'binary_sensor.thz504_verdichter'));
    assert.throws(() => parseIdMap('{"a": "Sensor mit Leerzeichen"}'), /invalid entity id/);
    assert.throws(() => parseIdMap('{kaputt'));
    assert.deepEqual(parseIdMap(''), {});
});

test('HA: unit-less numbers are measurements with precision, text stays text, null waits', () => {
    const ha = new HaDiscovery({});
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A2, idLang: 'de', selection: { exv_i_factor: 60 } });
    rd.tick(0);
    const r = rd.next(0);
    const val = rd.handleFrame(respond(r.frame, 1931), 0)[0];
    const cfg = ha.messages(val).find(m => m.topic.endsWith('/config')).payload;
    assert.equal(cfg.state_class, 'measurement');
    assert.equal(cfg.suggested_display_precision, 3);
    assert.equal(cfg.unit_of_measurement, undefined);
    const txt = ha.messages({ key: 'last_stop_cause', id: 'x', name: 'Ursache', value: 'Wächter', group: 'diagnosis' }).find(m => m.topic.endsWith('/config')).payload;
    assert.equal(txt.state_class, undefined);
    assert.deepEqual(ha.messages({ key: 'heat_output', id: 'y', name: 'z', value: null }), []);
    const prog = ha.messages({ key: 'steigung', id: 's', name: 'Steigung', value: 0.3, group: 'settings', precision: 2 }).find(m => m.topic.endsWith('/config')).payload;
    assert.equal(prog.state_class, undefined);
});

test('HA: id map false skips a sensor, its bits stay', () => {
    const ha = new HaDiscovery({ idMap: { operating_status: false, 'operating_status.defrost': false } });
    const m = ha.messages({ key: 'operating_status', id: 'betriebsstatus', name: 'Status', value: 1031,
        bitList: [{ key: 'compressor', id: 'verdichter', name: 'Verdichter', on: true }, { key: 'defrost', id: 'abtauen', name: 'Abtauen', on: false }] });
    assert.ok(!m.some(x => x.topic.includes('/sensor/')));
    assert.ok(!m.some(x => x.topic === 'thz504/betriebsstatus'));
    assert.ok(m.some(x => x.payload.default_entity_id === 'binary_sensor.thz504_betriebsstatus_verdichter'));
    assert.ok(!m.some(x => x.topic.includes('abtauen') || x.topic.includes('defrost')));
});

test('diagnosis: guard counter runs while EXV ≥ 2.975 × pilot and < 100 %', () => {
    const d = new ThzDiagnosis({ idLang: 'de', nameLang: 'de' });
    d.update(v('superheat_guard_time', 10), 0);
    d.update(status(1031), 0);
    d.update(v('exv_preset', 20), 0);
    let r = d.update(v('exv_opening', 50), 0);          // 2.5 × -> no guard
    assert.equal(r.values.find(x => x.key === 'guard_counter').value, 0);
    assert.equal(r.values.find(x => x.key === 'exv_ratio').value, 2.5);
    d.update(v('exv_opening', 60), 10000);               // 3.0 × -> starts
    r = d.update(v('exv_opening', 61), 130000);
    assert.equal(r.values.find(x => x.key === 'guard_counter').value, 120);
    assert.equal(r.values.find(x => x.key === 'guard_remaining').value, 480);
    assert.equal(r.values.find(x => x.key === 'guard_counter').id, 'waechter_zaehler');
    r = d.update(v('exv_opening', 100), 140000);         // at the limit -> reset
    assert.equal(r.values.find(x => x.key === 'guard_counter').value, 0);
});

test('diagnosis: heating circuit feed-forward and integral', () => {
    const d = new ThzDiagnosis();
    for (const [k, x] of Object.entries({ hc1_target_controller: 27.4, room_target_active: 21, heating_curve_base: 2, heating_curve_slope: 0.3, design_output_heating: 100, design_temp: -10 })) d.update(v(k, x), 0);
    const r = d.update(v('heating_power_rel', 40), 0);
    // RT − AT = (27.4 − 21 − 2)/0.3 = 14.67 K; feed-forward = 100 × 14.67/31 = 47.3 %
    assert.equal(r.values.find(x => x.key === 'hc_feedforward').value, 47.3);
    assert.equal(r.values.find(x => x.key === 'hc_integral').value, -7.3);
});

test('diagnosis: runs, stop causes and fault lock', () => {
    const d = new ThzDiagnosis({ nameLang: 'de' });
    const day = new Date(2026, 10, 12, 14, 0, 0).getTime();
    d.update(status(1024), day);                          // off, known
    d.update(v('heating_power_rel', 41), day);
    let r = d.update(status(1026), day + 1000);           // compressor on
    assert.equal(r.events[0].type, 'compressor_start');
    d.update(v('exv_preset', 20), day + 2000);
    d.update(v('exv_opening', 60), day + 2000);
    d.update(v('exv_opening', 61), day + 2000 + 600000);  // guard counter reaches 600 s
    d.update(v('exv_i_factor', 2.95), day + 1000 + 610000);
    r = d.update(status(1024), day + 1000 + 620000);       // stop
    const stop = r.events.find(e => e.type === 'compressor_stop');
    assert.equal(stop.cause, 'guard');
    assert.equal(stop.cause_text, 'Wächter');
    assert.equal(stop.i_factor_10min, 2.95);
    assert.equal(stop.heating_power_start, 41);
    assert.equal(r.values.find(x => x.key === 'last_stop_cause').value, 'Wächter');
    // hot water run
    d.update(status(1042), day + 2000000);                // compressor + hot water
    r = d.update(status(1024), day + 2600000);
    assert.equal(r.events.find(e => e.type === 'compressor_stop').cause, 'hot_water');
    // fault lock
    r = d.update(status(1024 + 64 + 1), day + 3000000);
    assert.equal(r.events[0].type, 'fault_lock_on');
    assert.equal(r.values.find(x => x.key === 'fault_lock').value, 1);
});

test('diagnosis: regular stop and 10 o\'clock routine', () => {
    const d = new ThzDiagnosis();
    const t = new Date(2026, 10, 12, 10, 5, 0).getTime();
    d.update(v('hc1_temp', 25), t); d.update(v('hc1_target_controller', 27), t);
    d.update(status(1024), t); d.update(status(1026), t + 1000);
    assert.equal(d.update(status(1024), t + 300000).events[0].cause, 'routine');
    const t2 = new Date(2026, 10, 12, 15, 0, 0).getTime();
    d.update(v('hc1_temp', 28), t2);
    d.update(status(1026), t2 + 1000);
    assert.equal(d.update(status(1024), t2 + 3600000).events[0].cause, 'regular');
});
