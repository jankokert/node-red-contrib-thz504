'use strict';
/**
 * Transport-independent read logic (no Node-RED dependency, unit-testable).
 *
 *   tick(now)          -> puts due registers into the send queue
 *   next(now)          -> next read frame to send (or null)
 *   handleFrame(frame) -> decoded values [{key, value, ...}]
 */
const elster = require('./elster');
const catalog = require('./catalog');

const MIN_INTERVAL_S = 10;

function localName(n, lang) {
    if (!n) return '';
    if (typeof n === 'string') return n;
    return n[lang] || n.en || n.de || '';
}
const RESPONSE_TIMEOUT_MS = 5000;

class ThzReader {
    /**
     * @param {object} opt
     * @param {string} opt.model      catalog name, e.g. 'thz504'
     * @param {number} opt.sender     own CAN id
     * @param {object} opt.selection  { key: intervalSeconds } (0 = only at start)
     * @param {boolean} [opt.passive] also emit selected values from responses to other bus members
     * @param {string}  [opt.nameLang] 'de' or 'en' for display names (default 'en'; opt.lang is accepted as alias)
     * @param {string}  [opt.idLang]   'de' or 'en' for ids used in topics and entity ids (default 'en')
     */
    constructor(opt) {
        this.cat = catalog.load(opt.model);
        this.sender = opt.sender;
        this.passive = opt.passive !== false;
        this.nameLang = (opt.nameLang || opt.lang) === 'de' ? 'de' : 'en';
        this.idLang = opt.idLang === 'de' ? 'de' : 'en';
        this.selection = {};
        this.unknownKeys = [];
        this.migratedKeys = {};
        for (const [raw, iv] of Object.entries(opt.selection || {})) {
            const key = this.cat.resolve(raw);
            if (!key) { this.unknownKeys.push(raw); continue; }
            if (key !== raw) this.migratedKeys[raw] = key;
            const n = Number(iv);
            this.selection[key] = n > 0 ? Math.max(n, MIN_INTERVAL_S) : 0;
        }
        this.due = {};          // key -> next due timestamp (ms)
        this.queue = [];        // [{key, reg}]
        this.queued = new Set();// "dev:reg"
        this.pending = new Map();// "dev:reg" -> sent timestamp
        this.parts = {};        // key -> {partIndex: word}
        this.stats = { sent: 0, received: 0, timeouts: 0, unavailable: 0 };
        this.started = false;
    }

    get selectedKeys() { return Object.keys(this.selection); }

    /** Request every selected value once (also those with interval 0). */
    requestAll() { for (const k of this.selectedKeys) this._enqueue(this.cat.byKey[k]); }

    /** Request one value (or several) now. Accepts keys and German or English ids. */
    request(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const bad = list.filter(k => !this.cat.resolve(k));
        if (bad.length) throw new Error('unknown key(s): ' + bad.join(', '));
        list.forEach(k => this._enqueue(this.cat.byKey[this.cat.resolve(k)]));
    }

    tick(now) {
        if (!this.started) { this.started = true; this.requestAll(); for (const k of this.selectedKeys) this.due[k] = now + this.selection[k] * 1000; }
        for (const k of this.selectedKeys) {
            const iv = this.selection[k];
            if (iv > 0 && now >= this.due[k]) { this.due[k] = now + iv * 1000; this._enqueue(this.cat.byKey[k]); }
        }
        for (const [addr, t] of this.pending) {
            if (now - t > RESPONSE_TIMEOUT_MS) { this.pending.delete(addr); this.stats.timeouts++; }
        }
    }

    _enqueue(entry) {
        for (const reg of catalog.requestRegs(entry)) {
            const addr = entry.dev + ':' + reg;
            if (this.queued.has(addr) || this.pending.has(addr)) continue;
            this.queued.add(addr);
            this.queue.push({ key: entry.key, dev: entry.dev, reg });
        }
    }

    /** Next frame to send, or null when the queue is empty. */
    next(now) {
        const item = this.queue.shift();
        if (!item) return null;
        const addr = item.dev + ':' + item.reg;
        this.queued.delete(addr);
        this.pending.set(addr, now);
        this.stats.sent++;
        return { key: item.key, frame: elster.buildRead(this.sender, item.dev, item.reg, this.cat.devices) };
    }

    /** Decode an incoming CAN frame. Returns an array of value objects. */
    handleFrame(frame, now) {
        const f = elster.parseFrame(frame);
        if (!f) return [];
        // Only responses carry measured values. Write frames of other bus members
        // (e.g. the control panel) may contain set points and are ignored on purpose.
        if (f.type !== elster.TYPE_RESPONSE) return [];
        const addr = f.sender + ':' + f.register;
        const own = f.receiver === this.sender;
        if (own) { this.pending.delete(addr); this.stats.received++; }
        const hits = this.cat.byAddr[addr];
        if (!hits) return [];
        const out = [];
        for (const { entry, part } of hits) {
            if (!(entry.key in this.selection)) continue;
            if (!own && !this.passive) continue;
            if (!f.available) { this.stats.unavailable++; out.push(this._value(entry, null, f, own, now)); continue; }
            if (part >= 0) {
                const p = this.parts[entry.key] = this.parts[entry.key] || {};
                p[part] = f.value;
                if (Object.keys(p).length < entry.parts.length) continue;
                this.parts[entry.key] = {};
                if (entry.decode === 'schedule') {
                    out.push(this._value(entry, elster.decodeSchedule(entry.parts.map((d, i) => p[i])), f, own, now));
                } else {
                    const v = entry.parts.reduce((s, def, i) => s + p[i] * def.factor, 0);
                    out.push(this._value(entry, Math.round(v * 1000) / 1000, f, own, now));
                }
            } else {
                out.push(this._value(entry, elster.decodeWord(entry.decode, f.value, entry), f, own, now));
            }
        }
        return out;
    }

    _value(entry, value, f, own, now) {
        const v = {
            key: entry.key, id: this.idLang === 'de' ? entry.id_de : entry.key,
            name: localName(entry.name, this.nameLang), value, unit: entry.unit || '',
            device_class: entry.device_class, state_class: entry.state_class,
            group: entry.group, status: entry.status, interval: this.selection[entry.key],
            dev: entry.dev, reg: f.register, raw: f.value, source: own ? 'response' : 'passive',
            ts: new Date(now || Date.now()).toISOString()
        };
        if (entry.decode === 'bits' && value !== null) {
            // bits: { <id>: true|false } for flows; bitList: details for Home Assistant
            v.bits = {};
            v.bitList = [];
            for (const [bit, def] of Object.entries(entry.bits)) {
                const on = (f.value & (1 << Number(bit))) !== 0;
                const id = this.idLang === 'de' ? def.id_de : def.key;
                v.bits[id] = on;
                v.bitList.push({ key: def.key, id, name: localName(def, this.nameLang), on });
            }
        }
        return v;
    }

    /** Requests per minute and approximate bus load at 20 kbit/s. */
    load() {
        let perMin = 0;
        for (const k of this.selectedKeys) {
            const iv = this.selection[k];
            if (iv > 0) perMin += catalog.requestRegs(this.cat.byKey[k]).length * 60 / iv;
        }
        // request + response, ~130 bit per 7-byte standard frame incl. stuffing
        const busLoadPct = perMin / 60 * 2 * 130 / 20000 * 100;
        return { perMin: Math.round(perMin * 10) / 10, busLoadPct: Math.round(busLoadPct * 100) / 100 };
    }
}

module.exports = { ThzReader, localName, MIN_INTERVAL_S, RESPONSE_TIMEOUT_MS };
