'use strict';
const path = require('path');
const fs = require('fs');
const { toInt } = require('./elster');

const DIR = path.join(__dirname, '..', 'registers');
const cache = {};

function listModels() {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}

/** Raw catalog file (as shipped, hex strings) for the editor. */
function loadRaw(model) {
    if (!/^[a-z0-9_-]+$/i.test(model)) throw new Error('invalid model name');
    return JSON.parse(fs.readFileSync(path.join(DIR, model + '.json'), 'utf8'));
}

/** Catalog with numeric ids and lookup maps for the runtime. */
function load(model) {
    if (cache[model]) return cache[model];
    const raw = loadRaw(model);
    const entries = raw.registers.map(r => {
        const e = Object.assign({}, r, { dev: toInt(r.dev) });
        if (r.reg !== undefined) e.reg = toInt(r.reg);
        if (r.parts) e.parts = r.parts.map(p => ({ reg: toInt(p.reg), factor: p.factor }));
        return e;
    });
    const byKey = {};
    const byAddr = {};          // "dev:reg" -> [{entry, partIndex}]
    for (const e of entries) {
        byKey[e.key] = e;
        const regs = e.parts ? e.parts.map(p => p.reg) : [e.reg];
        regs.forEach((reg, i) => {
            const k = e.dev + ':' + reg;
            (byAddr[k] = byAddr[k] || []).push({ entry: e, part: e.parts ? i : -1 });
        });
    }
    const devices = Array.from(new Set(entries.map(e => e.dev)));
    const renamed = (raw.meta && raw.meta.renamed) || {};
    const byIdDe = {};
    for (const e of entries) if (e.id_de) byIdDe[e.id_de] = e.key;
    /** key, old (renamed) key or German id -> current key, or undefined */
    const resolve = (k) => byKey[k] ? k : (byKey[renamed[k]] ? renamed[k] : byIdDe[k]);
    cache[model] = { meta: raw.meta, presets: raw.presets || {}, entries, byKey, byAddr, devices, renamed, resolve };
    return cache[model];
}

/** All registers that have to be requested for one catalog entry. */
function requestRegs(entry) {
    return entry.parts ? entry.parts.map(p => p.reg) : [entry.reg];
}

module.exports = { listModels, loadRaw, load, requestRegs };
