'use strict';
/**
 * Node "thz504-diagnose": calculated diagnosis from the values of "thz504-read".
 *
 * Input:    messages from thz504-read output 2 (msg.thz504)
 * Output 1: calculated values (same format as thz504-read, so "THZ 504 → HA" can publish them)
 * Output 2: events (compressor start/stop with cause and run summary, fault lock on/off)
 */
const { ThzDiagnosis, REQUIRED_KEYS } = require('../lib/diagnosis');

module.exports = function (RED) {
    function Thz504DiagnoseNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const prefix = config.topicPrefix === undefined ? 'thz504/' : config.topicPrefix;
        const diag = new ThzDiagnosis({ nameLang: config.nameLang || 'en', idLang: config.idLang || 'en', guardFactor: config.guardFactor });
        const seen = new Set();
        // after 5 min, report required values that never arrived
        const timer = setTimeout(() => {
            const missing = REQUIRED_KEYS.filter(k => !seen.has(k));
            if (missing.length) node.warn(RED._('thz504-diagnose.warn.missing', { keys: missing.join(', ') }));
        }, 5 * 60 * 1000);

        function status() {
            const s = diag.summary();
            const text = RED._('thz504-diagnose.state.' + (s.compressor === 'on' ? 'running' : s.compressor === 'off' ? 'idle' : 'unknown'), { guard: s.guard, run: s.run });
            node.status({ fill: s.lock ? 'red' : s.guard > 300 ? 'yellow' : s.compressor === 'on' ? 'green' : 'grey', shape: s.lock ? 'ring' : 'dot',
                text: (s.lock ? RED._('thz504-diagnose.state.lock') + ' · ' : '') + text });
        }

        node.on('input', (msg, send, done) => {
            try {
                if (!msg.thz504 || !msg.thz504.key) { done(); return; }
                seen.add(msg.thz504.key);
                const r = diag.update(msg.thz504, Date.now());
                const values = r.values.map(v => ({ topic: prefix + v.id, payload: v.value, thz504: v }));
                const events = r.events.map(e => ({ topic: prefix + 'event/' + e.type, payload: e }));
                if (values.length || events.length) send([values.length ? values : null, events.length ? events : null]);
                status();
                done();
            } catch (e) { done(e); }
        });
        node.on('close', () => clearTimeout(timer));
        node.status({ fill: 'grey', shape: 'ring', text: RED._('thz504-diagnose.state.waiting') });
    }
    RED.nodes.registerType('thz504-diagnose', Thz504DiagnoseNode);
};
