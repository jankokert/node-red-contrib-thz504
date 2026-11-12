'use strict';
/**
 * Home Assistant MQTT discovery messages for values produced by ThzReader.
 * No Node-RED dependency.
 */

const BIT_CLASSES = { compressor: 'running', heating_pump: 'running', service: 'problem', booster_heater: 'heat', defrost: 'cold', filter_change: 'problem', filter_extract: 'problem', filter_supply: 'problem' };

const CONFIG_GROUPS = new Set(['settings', 'programs']);
const DIAGNOSTIC_GROUPS = new Set(['settings', 'programs', 'research']);

/**
 * Parse the id map: {"key": "object_id"} or {"key": "sensor.object_id"}; bits as "key.bit".
 * Accepts an object or a JSON string; returns {} for empty input, throws on invalid JSON.
 */
function parseIdMap(m) {
    if (!m) return {};
    const o = typeof m === 'string' ? (m.trim() ? JSON.parse(m) : {}) : m;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
        if (v === false || v === null) { out[k] = false; continue; }   // do not publish this entity
        const id = String(v).trim().replace(/^(sensor|binary_sensor)\./, '');
        if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`invalid entity id for ${k}: ${v}`);
        out[k] = id;
    }
    return out;
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_'); }

class HaDiscovery {
    /**
     * @param {object} opt
     * @param {string} opt.baseTopic        e.g. 'thz504'
     * @param {string} opt.discoveryPrefix  e.g. 'homeassistant'
     * @param {string} opt.entityPrefix     entity id prefix, e.g. 'thz504' -> sensor.thz504_aussentemperatur
     * @param {string} opt.deviceName       e.g. 'THZ 504'
     * @param {string} opt.deviceId         unique device identifier
     * @param {object|string} [opt.idMap]   own entity ids per key, e.g. {"exv_opening": "thz504_diag_exv_oeffnung"}
     */
    constructor(opt) {
        this.o = Object.assign({ baseTopic: 'thz504', discoveryPrefix: 'homeassistant', entityPrefix: 'thz504', deviceName: 'THZ 504', deviceId: 'thz504' }, opt);
        this.o.baseTopic = this.o.baseTopic.replace(/\/+$/, '');
        this.idMap = parseIdMap(this.o.idMap);
        this.announced = new Set();
    }

    device() {
        return { identifiers: [this.o.deviceId], name: this.o.deviceName, manufacturer: 'Tecalor / Stiebel Eltron', model: 'THZ 504', via_device: undefined };
    }

    reset() { this.announced.clear(); }

    /** Messages for one value: discovery config (first time) and state. */
    messages(v) {
        const out = [];
        // v.key: stable internal key -> unique_id and config topic (survives a change of the id language)
        // v.id:  id in the chosen language -> entity id and state topic
        const vid = v.id || v.key;
        const skipMain = this.idMap[v.key] === false;            // id map "key": false -> no sensor (bits may still be published)
        const id = this.idMap[v.key] || (slug(this.o.entityPrefix) + '_' + vid);
        const stateTopic = this.o.baseTopic + '/' + vid;
        const bits = (v.bitList || []).filter(b => this.idMap[v.key + '.' + b.key] !== false);
        // announce with the first real value, so numeric/text can be told apart
        if (!this.announced.has(v.key) && v.value !== null && v.value !== undefined) {
            this.announced.add(v.key);
            const numeric = typeof v.value === 'number';
            if (!skipMain) out.push({ topic: `${this.o.discoveryPrefix}/sensor/${slug(this.o.deviceId)}/${v.key}/config`, retain: true, payload: clean({
                name: v.name,
                unique_id: slug(this.o.deviceId) + '_' + v.key,
                default_entity_id: 'sensor.' + id,
                state_topic: stateTopic,
                unit_of_measurement: v.unit || undefined,
                device_class: v.device_class,
                // numbers need a state_class, otherwise Home Assistant treats unit-less values (factors, modes) as text.
                // Settings and time programs are configuration, not measurements -> no statistics.
                state_class: v.state_class || (numeric && v.device_class !== 'duration' && !CONFIG_GROUPS.has(v.group) ? 'measurement' : undefined),
                suggested_display_precision: numeric && Number.isInteger(v.precision) ? v.precision : undefined,
                expire_after: v.interval > 0 ? Math.max(v.interval * 3, 180) : undefined,
                entity_category: DIAGNOSTIC_GROUPS.has(v.group) ? 'diagnostic' : undefined,
                device: clean(this.device())
            }) });
            for (const b of bits) {
                out.push({ topic: `${this.o.discoveryPrefix}/binary_sensor/${slug(this.o.deviceId)}/${v.key}_${b.key}/config`, retain: true, payload: clean({
                    name: b.name,
                    unique_id: slug(this.o.deviceId) + '_' + v.key + '_' + b.key,
                    default_entity_id: 'binary_sensor.' + (this.idMap[v.key + '.' + b.key] || id + '_' + b.id),
                    state_topic: stateTopic + '/' + b.id,
                    payload_on: 'ON', payload_off: 'OFF',
                    device_class: BIT_CLASSES[b.key],
                    device: clean(this.device())
                }) });
            }
        }
        if (v.value === null) return out;   // register "not available": publish no state, expire_after handles staleness
        if (!skipMain) out.push({ topic: stateTopic, payload: String(v.value), retain: true });
        for (const b of bits) out.push({ topic: stateTopic + '/' + b.id, payload: b.on ? 'ON' : 'OFF', retain: true });
        return out;
    }
}

function clean(o) {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
    return r;
}

module.exports = { HaDiscovery, parseIdMap };
