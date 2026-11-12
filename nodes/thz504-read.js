'use strict';
/**
 * Node "thz504-read": schedules read requests and decodes responses.
 *
 * Input:    CAN frames from socketcan-out (which RECEIVES from the bus),
 *           or control messages: msg.topic = "read", msg.payload = "all" | key | [keys]
 * Output 1: read requests for socketcan-in (which SENDS to the bus)
 * Output 2: one message per value: msg.topic = <prefix><id>, msg.payload = value, msg.thz504 = details
 *           (id = English key or German id, depending on the "id language" setting)
 */
const { ThzReader } = require('../lib/reader');
const catalog = require('../lib/catalog');
const elster = require('../lib/elster');

const START_DELAY_MS = 3000;
// The THZ 504 answers only certain sender ids: 0x69F and 0x6A2 work, 0x6A3 is not answered (checked 12.11.2026).
const DEFAULT_SENDER = '0x6A2';
const UNANSWERED_SENDERS = [0x6A3];
const TICK_MS = 1000;
const STATUS_MS = 5000;

module.exports = function (RED) {
    RED.httpAdmin.get('/thz504/models', RED.auth.needsPermission('thz504-read.read'), (req, res) => {
        res.json(catalog.listModels());
    });
    RED.httpAdmin.get('/thz504/catalog/:model', RED.auth.needsPermission('thz504-read.read'), (req, res) => {
        try { res.json(catalog.loadRaw(req.params.model)); } catch (e) { res.status(404).json({ error: e.message }); }
    });

    function Thz504ReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const timers = [];
        const prefix = config.topicPrefix === undefined ? 'thz504/' : config.topicPrefix;
        let valueCount = 0;
        let reader;

        try {
            reader = new ThzReader({
                model: config.model || 'thz504',
                sender: elster.toInt(config.senderId || DEFAULT_SENDER),
                selection: config.selection || {},
                passive: config.passive !== false,
                nameLang: config.nameLang || config.lang || 'en',   // 'lang' = setting name up to 0.1.x
                idLang: config.idLang || 'en'                        // nodes from 0.1.x keep English ids
            });
        } catch (e) {
            node.error(e.message);
            node.status({ fill: 'red', shape: 'ring', text: RED._('thz504-read.state.error') + ': ' + e.message });
            return;
        }
        if (UNANSWERED_SENDERS.includes(reader.sender)) node.warn(RED._('thz504-read.warn.sender', { id: '0x' + reader.sender.toString(16).toUpperCase(), def: DEFAULT_SENDER }));
        if (reader.unknownKeys.length) node.warn(RED._('thz504-read.warn.unknownKeys', { keys: reader.unknownKeys.join(', ') }));
        const migrated = Object.entries(reader.migratedKeys);
        if (migrated.length) node.log(RED._('thz504-read.warn.migrated', { keys: migrated.map(([a, b]) => a + ' → ' + b).join(', ') }));
        if (!reader.selectedKeys.length) {
            node.status({ fill: 'grey', shape: 'ring', text: RED._('thz504-read.warn.noSelection') });
        } else {
            node.status({ fill: 'yellow', shape: 'ring', text: RED._('thz504-read.state.starting') });
            const rate = Math.min(Math.max(Number(config.rate) || 4, 1), 10);
            timers.push(setTimeout(() => {
                reader.tick(Date.now());
                timers.push(setInterval(() => reader.tick(Date.now()), TICK_MS));
                timers.push(setInterval(() => {
                    const r = reader.next(Date.now());
                    if (r) node.send([{ topic: prefix + 'request/' + r.key, payload: r.frame }, null]);
                }, Math.round(1000 / rate)));
                timers.push(setInterval(() => {
                    const s = reader.stats;
                    node.status({
                        fill: s.received > 0 ? 'green' : 'yellow', shape: 'dot',
                        text: RED._('thz504-read.state.running', { values: valueCount, sent: s.sent, received: s.received, timeouts: s.timeouts })
                    });
                }, STATUS_MS));
            }, START_DELAY_MS));
        }

        node.on('input', (msg, send, done) => {
            try {
                const p = msg.payload;
                if (p && typeof p === 'object' && p.canid !== undefined && p.data !== undefined) {
                    const out = [];
                    for (const v of reader.handleFrame(p, Date.now())) {
                        if (v.value === null) continue;
                        valueCount++;
                        out.push({ topic: prefix + v.id, payload: v.value, thz504: v });
                    }
                    if (out.length) send([null, out]);
                } else if (msg.topic === 'read') {
                    if (p === 'all' || p === undefined || p === '') reader.requestAll();
                    else reader.request(p);
                }
                done();
            } catch (e) {
                done(e);
            }
        });

        node.on('close', () => { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); });
    }

    RED.nodes.registerType('thz504-read', Thz504ReadNode);
};
