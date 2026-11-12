'use strict';
/* Runs both nodes in a minimal fake Node-RED runtime with a simulated heat pump. */
const test = require('node:test');
const assert = require('node:assert/strict');

function fakeRED() {
    const types = {};
    const routes = {};
    return {
        types, routes,
        _: (k, o) => k + (o ? ' ' + JSON.stringify(o) : ''),
        nodes: {
            registerType: (name, ctor) => { types[name] = ctor; },
            createNode: (node) => {
                node.handlers = {};
                node.sent = [];
                node.statuses = [];
                node.warnings = [];
                node.on = (ev, fn) => { node.handlers[ev] = fn; };
                node.send = (m) => node.sent.push(m);
                node.status = (s) => node.statuses.push(s);
                node.warn = (w) => node.warnings.push(w);
                node.log = () => {};
                node.error = (e) => { throw new Error(e); };
            }
        },
        httpAdmin: { get: (path, auth, fn) => { routes[path] = fn; } },
        auth: { needsPermission: () => (req, res, next) => next && next() }
    };
}

function inject(node, msg) {
    return new Promise((resolve, reject) => {
        const outs = [];
        node.handlers.input(msg, (m) => outs.push(m), (err) => (err ? reject(err) : resolve(outs)));
    });
}

const RAW = { '384:12': 116, '384:374': 1030, '384:49396': 633, '384:49397': 14 };
function answer(frame) {
    const d = frame.data, snd = frame.canid;
    const dev = ((d[0] & 0xF0) << 3) | (d[1] & 0x7F);
    const reg = (d[3] << 8) | d[4];
    const w = RAW[dev + ':' + reg] === undefined ? 0x8000 : RAW[dev + ':' + reg];
    return { canfd: false, ext: false, canid: dev, dlc: 7, data: [((snd >> 3) & 0xF0) | 2, snd & 0x7F, 0xFA, d[3], d[4], w >> 8, w & 0xFF] };
}

test('thz504-read + thz504-ha end to end with fake runtime and timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const RED = fakeRED();
    require('../nodes/thz504-read')(RED);
    require('../nodes/thz504-ha')(RED);
    assert.ok(RED.types['thz504-read'] && RED.types['thz504-ha']);
    assert.ok(RED.routes['/thz504/catalog/:model']);

    const read = {};
    RED.types['thz504-read'].call(read, { model: 'thz504', senderId: '0x6A3', rate: 4, lang: 'de', passive: true, topicPrefix: 'thz504/',
        selection: { outdoor_temp: 60, operating_status: 15, compressor_starts: 900, unknown_x: 60 } });
    assert.equal(read.warnings.length, 1);

    const ha = {};
    RED.types['thz504-ha'].call(ha, { baseTopic: 'thz504can', discoveryPrefix: 'homeassistant', entityPrefix: 'thz504can', deviceName: 'THZ 504' });

    t.mock.timers.tick(3000);        // start delay
    t.mock.timers.tick(2000);        // 8 send slots at 4/s
    const requests = read.sent.map(m => m[0]).filter(Boolean);
    assert.equal(requests.length, 4); // outdoor, status, 2 parts of starts
    for (const r of requests) assert.equal(r.payload.data[0] & 0x0F, 1, 'read type only');

    const values = [];
    for (const r of requests) for (const out of await inject(read, { payload: answer(r.payload) })) values.push(...out[1]);
    const byKey = Object.fromEntries(values.map(v => [v.thz504.key, v]));
    assert.equal(byKey.outdoor_temp.payload, 11.6);
    assert.equal(byKey.outdoor_temp.topic, 'thz504/outdoor_temp');
    assert.equal(byKey.compressor_starts.payload, 14633);
    assert.equal(byKey.operating_status.thz504.bits.compressor, true);

    const mqtt = [];
    for (const v of values) for (const out of await inject(ha, v)) mqtt.push(...out[0]);
    assert.ok(mqtt.some(m => m.topic === 'homeassistant/sensor/thz504can/outdoor_temp/config' && m.retain));
    assert.ok(mqtt.some(m => m.topic === 'thz504can/outdoor_temp' && m.payload === '11.6'));

    // manual read command
    await inject(read, { topic: 'read', payload: 'outdoor_temp' });
    await assert.rejects(inject(read, { topic: 'read', payload: 'nope' }), /unknown key/);

    // status after a while
    t.mock.timers.tick(5000);
    const last = read.statuses[read.statuses.length - 1];
    assert.equal(last.fill, 'green');

    read.handlers.close();
});

test('thz504-read with German ids: topic uses the German id', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const RED = fakeRED();
    require('../nodes/thz504-read')(RED);
    const n = {};
    RED.types['thz504-read'].call(n, { model: 'thz504', senderId: '0x6A3', nameLang: 'de', idLang: 'de', topicPrefix: 'thz504/', selection: { dhw_temp: 60 } });
    t.mock.timers.tick(3000);
    t.mock.timers.tick(1000);
    const req = n.sent.map(m => m[0]).filter(Boolean)[0];
    assert.ok(req, 'request sent for migrated key');
    const out = await inject(n, { payload: answer(req.payload) });
    // 0x000E is not in RAW -> not available -> no value message; check with a known value instead
    assert.equal(out.length, 0);
    RAW['384:14'] = 379;
    const out2 = await inject(n, { payload: answer(req.payload) });
    assert.equal(out2[0][1][0].topic, 'thz504/warmwasser_ist');
    assert.equal(out2[0][1][0].thz504.name, 'Warmwasser Ist');
    n.handlers.close();
});

test('thz504-diagnose node: values on output 1, events on output 2', async () => {
    const RED = fakeRED();
    require('../nodes/thz504-diagnose')(RED);
    const n = {};
    RED.types['thz504-diagnose'].call(n, { nameLang: 'de', idLang: 'de', topicPrefix: 'thz504/', guardFactor: 2.975 });
    const st = (w) => ({ thz504: { key: 'operating_status', value: w, bitList: [{ key: 'compressor', on: !!(w & 2) }, { key: 'hot_water', on: false }, { key: 'service', on: !!(w & 64) }] } });
    await inject(n, st(1024));
    const start = await inject(n, st(1026));
    assert.equal(start[0][1][0].topic, 'thz504/event/compressor_start');
    await inject(n, { thz504: { key: 'exv_preset', value: 20 } });
    const g = await inject(n, { thz504: { key: 'exv_opening', value: 65 } });
    assert.ok(g[0][0].some(m => m.topic === 'thz504/waechter_zaehler'));
    const lock = await inject(n, st(1024 + 64));
    assert.ok(lock[0][1].some(m => m.topic === 'thz504/event/fault_lock_on'));
    n.handlers.close();
});

test('thz504-read without selection stays idle', () => {
    const RED = fakeRED();
    require('../nodes/thz504-read')(RED);
    const n = {};
    RED.types['thz504-read'].call(n, { model: 'thz504', senderId: '0x6A3', selection: {} });
    assert.equal(n.statuses[0].fill, 'grey');
    n.handlers.close();
});
