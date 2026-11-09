'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const elster = require('../lib/elster');
const catalog = require('../lib/catalog');
const { ThzReader } = require('../lib/reader');
const { HaDiscovery } = require('../lib/ha');

// Simulated heat pump: answers read requests like the real THZ 504.
function respond(req, word) {
    const d = req.data, snd = req.canid;
    const dev = ((d[0] & 0xF0) << 3) | (d[1] & 0x7F);
    return { canfd: false, ext: false, canid: dev, dlc: 7, data: [((snd >> 3) & 0xF0) | 2, snd & 0x7F, 0xFA, d[3], d[4], word >> 8, word & 0xFF] };
}

test('read frame matches the request format used by the existing flows', () => {
    // existing Node-RED flow: canid 0x69F, data [0x31, 0, 0xFA, hi, lo, 0, 0]
    const f = elster.buildRead(0x69F, 0x180, 0x07F3);
    assert.equal(f.canid, 0x69F);
    assert.deepEqual(f.data, [0x31, 0x00, 0xFA, 0x07, 0xF3, 0, 0]);
    assert.deepEqual(elster.buildRead(0x69F, 0x301, 0x0011).data.slice(0, 2), [0x61, 0x01]);
});

test('read frames are always type 1, never write', () => {
    for (const dev of [0x180, 0x301]) for (const reg of [0, 0x0176, 0xC0F4, 0xFFFF]) {
        assert.equal(elster.buildRead(0x6A3, dev, reg).data[0] & 0x0F, elster.TYPE_READ);
    }
    assert.equal(typeof elster.buildWrite, 'undefined');
});

test('receiver whitelist and id checks', () => {
    assert.throws(() => elster.buildRead(0x6A3, 0x500, 1, [0x180, 0x301]), /not in the allowed list/);
    assert.throws(() => elster.buildRead(0x800, 0x180, 1), /valid 11-bit/);
    assert.throws(() => elster.buildRead(0x6A3, 0x180, 0x10000), /invalid register/);
});

test('sender address round trip for ids with more than 3 low bits', () => {
    const p = elster.parseFrame(respond(elster.buildRead(0x6A3, 0x180, 0x000C), 116));
    assert.equal(p.receiver, 0x6A3);
    assert.equal(p.sender, 0x180);
    assert.equal(p.type, elster.TYPE_RESPONSE);
});

test('decode types', () => {
    assert.equal(elster.decodeWord('deci_s', 116), 11.6);
    assert.equal(elster.decodeWord('deci_s', 0xFF9C), -10);
    assert.equal(elster.decodeWord('cent_s', 1650), 16.5);
    assert.equal(elster.decodeWord('hi_u', 0x0D00), 13);
    assert.equal(elster.decodeWord('hi_s_deci', 0xDA00), -3.8);
    assert.equal(elster.decodeWord('hi_s_deci', 0xD800), -4);
    assert.throws(() => elster.decodeWord('nope', 1), /unknown decode/);
});

test('catalog is consistent', () => {
    for (const model of catalog.listModels()) {
        const c = catalog.load(model);
        const keys = new Set();
        const addr = new Set();
        const groups = Object.keys(c.meta.groups);
        for (const e of c.entries) {
            assert.match(e.key, /^[a-z0-9_]+$/, e.key);
            assert.ok(!keys.has(e.key), 'duplicate key ' + e.key); keys.add(e.key);
            assert.ok(e.name && e.name.de && e.name.en, e.key + ' needs de/en names');
            assert.ok(groups.includes(e.group), e.key + ' unknown group ' + e.group);
            assert.ok(['verified', 'plausible', 'candidate'].includes(e.status), e.key);
            assert.ok([0x180, 0x301].includes(e.dev), e.key);
            assert.ok(Number.isInteger(e.interval) && e.interval >= 0, e.key + ' interval');
            if (e.decode === 'combo') assert.ok(e.parts.length >= 2, e.key);
            else elster.decodeWord(e.decode, 0, e);
            if (e.decode === 'bits') for (const b of Object.values(e.bits)) assert.ok(b.key && b.de && b.en, e.key + ' bit');
            for (const r of catalog.requestRegs(e)) {
                const a = e.dev + ':' + r;
                assert.ok(!addr.has(a), 'register used twice: ' + e.key + ' ' + r.toString(16)); addr.add(a);
            }
        }
        for (const [p, list] of Object.entries(c.presets)) {
            assert.ok(c.meta.presets[p], 'preset label missing: ' + p);
            for (const k of list) assert.ok(keys.has(k), `preset ${p}: unknown key ${k}`);
        }
    }
});

const SIM = { '384:12': 116, '384:374': 1030, '384:49396': 633, '384:49397': 14, '769:265': 0xDA00, '384:2330': 345, '384:2331': 2, '384:1958': 0x8000 };

function runCycle(reader, now) {
    const values = [];
    let r;
    while ((r = reader.next(now))) {
        const d = r.frame.data;
        const dev = ((d[0] & 0xF0) << 3) | (d[1] & 0x7F);
        const reg = (d[3] << 8) | d[4];
        const w = SIM[dev + ':' + reg];
        values.push(...reader.handleFrame(respond(r.frame, w === undefined ? 0x8000 : w), now));
    }
    return values;
}

test('reader: start reads all selected, decodes combos, bits and signed bytes', () => {
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, lang: 'de', selection: { outdoor_temp: 60, operating_status: 15, compressor_starts: 900, room_temp_correction: 0, elec_dhw_today: 300, high_pressure: 15, does_not_exist: 5 } });
    assert.deepEqual(rd.unknownKeys, ['does_not_exist']);
    rd.tick(0);
    const v = Object.fromEntries(runCycle(rd, 0).map(x => [x.key, x]));
    assert.equal(v.outdoor_temp.value, 11.6);
    assert.equal(v.outdoor_temp.name, 'Außentemperatur');
    assert.equal(v.compressor_starts.value, 14633);
    assert.equal(v.room_temp_correction.value, -3.8);
    assert.equal(v.elec_dhw_today.value, 2.345);
    assert.equal(v.high_pressure.value, null);
    assert.equal(v.operating_status.bits.compressor, true);
    assert.equal(v.operating_status.bits.service, false);
    assert.equal(v.operating_status.bitNames.compressor, 'Verdichter');
    assert.equal(rd.stats.sent, 8);
    assert.equal(rd.stats.received, 8);
});

test('reader: english names', () => {
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, lang: 'en', selection: { outdoor_temp: 60 } });
    rd.tick(0);
    assert.equal(runCycle(rd, 0)[0].name, 'Outdoor temperature');
});

test('reader: intervals, minimum interval and interval 0', () => {
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { outdoor_temp: 60, operating_status: 1, room_temp_correction: 0 } });
    assert.equal(rd.selection.operating_status, 10);
    rd.tick(0); runCycle(rd, 0);
    rd.tick(5000); assert.equal(rd.queue.length, 0);
    rd.tick(10000); assert.deepEqual(rd.queue.map(q => q.key), ['operating_status']); runCycle(rd, 10000);
    rd.tick(60000); assert.deepEqual(rd.queue.map(q => q.key).sort(), ['operating_status', 'outdoor_temp']);
});

test('reader: timeouts and no duplicate requests while pending', () => {
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { outdoor_temp: 10 } });
    rd.tick(0); rd.next(0);
    rd.tick(1000); rd.request('outdoor_temp'); assert.equal(rd.queue.length, 0);
    rd.tick(6000); assert.equal(rd.stats.timeouts, 1);
    assert.throws(() => rd.request('xyz'), /unknown key/);
});

test('reader: passive values only from responses, never from write frames', () => {
    const foreign = respond(elster.buildRead(0x69F, 0x180, 0x000C), 120);
    const on = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { outdoor_temp: 60 } });
    assert.equal(on.handleFrame(foreign, 0)[0].source, 'passive');
    const write = Object.assign({}, foreign, { data: [foreign.data[0] & 0xF0, ...foreign.data.slice(1)] });
    assert.equal(on.handleFrame(write, 0).length, 0);
    const off = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { outdoor_temp: 60 }, passive: false });
    assert.equal(off.handleFrame(foreign, 0).length, 0);
    const notSelected = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { high_pressure: 60 } });
    assert.equal(notSelected.handleFrame(foreign, 0).length, 0);
});

test('reader: load estimate', () => {
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, selection: { outdoor_temp: 60, compressor_starts: 60 } });
    assert.equal(rd.load().perMin, 3);
});

test('HA discovery: config once, state every time, binary sensors for bits', () => {
    const ha = new HaDiscovery({ entityPrefix: 'thz504can', deviceId: 'thz504can' });
    const rd = new ThzReader({ model: 'thz504', sender: 0x6A3, lang: 'de', selection: { outdoor_temp: 60, operating_status: 15, high_pressure: 15 } });
    rd.tick(0);
    const vals = runCycle(rd, 0);
    const first = vals.flatMap(v => ha.messages(v));
    const cfg = first.find(m => m.topic === 'homeassistant/sensor/thz504can/outdoor_temp/config');
    assert.equal(cfg.payload.default_entity_id, 'sensor.thz504can_outdoor_temp');
    assert.equal(cfg.payload.name, 'Außentemperatur');
    assert.equal(cfg.payload.unit_of_measurement, '°C');
    assert.equal(cfg.payload.expire_after, 180);
    const bin = first.find(m => m.topic === 'homeassistant/binary_sensor/thz504can/operating_status_compressor/config');
    assert.equal(bin.payload.name, 'Verdichter');
    assert.equal(bin.payload.device_class, 'running');
    assert.ok(first.some(m => m.topic === 'thz504/operating_status/compressor' && m.payload === 'ON'));
    assert.ok(!first.some(m => m.topic === 'thz504/high_pressure'), 'no state for unavailable value');
    const second = vals.flatMap(v => ha.messages(v));
    assert.ok(second.every(m => !m.topic.endsWith('/config')));
    assert.equal(second.find(m => m.topic === 'thz504/outdoor_temp').payload, '11.6');
});
