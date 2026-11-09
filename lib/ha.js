'use strict';
/**
 * Home Assistant MQTT discovery messages for values produced by ThzReader.
 * No Node-RED dependency.
 */

const BIT_CLASSES = { compressor: 'running', heating_pump: 'running', service: 'problem', booster_heater: 'heat', defrost: 'cold', filter_change: 'problem', filter_extract: 'problem', filter_supply: 'problem' };

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_'); }

class HaDiscovery {
    /**
     * @param {object} opt
     * @param {string} opt.baseTopic        e.g. 'thz504'
     * @param {string} opt.discoveryPrefix  e.g. 'homeassistant'
     * @param {string} opt.entityPrefix     entity id prefix, e.g. 'thz504' -> sensor.thz504_aussentemperatur
     * @param {string} opt.deviceName       e.g. 'THZ 504'
     * @param {string} opt.deviceId         unique device identifier
     */
    constructor(opt) {
        this.o = Object.assign({ baseTopic: 'thz504', discoveryPrefix: 'homeassistant', entityPrefix: 'thz504', deviceName: 'THZ 504', deviceId: 'thz504' }, opt);
        this.o.baseTopic = this.o.baseTopic.replace(/\/+$/, '');
        this.announced = new Set();
    }

    device() {
        return { identifiers: [this.o.deviceId], name: this.o.deviceName, manufacturer: 'Tecalor / Stiebel Eltron', model: 'THZ 504', via_device: undefined };
    }

    reset() { this.announced.clear(); }

    /** Messages for one value: discovery config (first time) and state. */
    messages(v) {
        const out = [];
        const id = slug(this.o.entityPrefix) + '_' + v.key;
        const stateTopic = this.o.baseTopic + '/' + v.key;
        if (!this.announced.has(v.key)) {
            this.announced.add(v.key);
            const cfg = clean({
                name: v.name,
                unique_id: slug(this.o.deviceId) + '_' + v.key,
                default_entity_id: 'sensor.' + id,
                state_topic: stateTopic,
                unit_of_measurement: v.unit || undefined,
                device_class: v.device_class,
                state_class: v.state_class || (v.unit && v.device_class !== 'duration' ? 'measurement' : undefined),
                expire_after: v.interval > 0 ? Math.max(v.interval * 3, 180) : undefined,
                entity_category: v.group === 'settings' ? 'diagnostic' : undefined,
                device: clean(this.device())
            });
            out.push({ topic: `${this.o.discoveryPrefix}/sensor/${slug(this.o.deviceId)}/${v.key}/config`, payload: cfg, retain: true });
            if (v.bitNames) {
                for (const [name, label] of Object.entries(v.bitNames)) {
                    out.push({ topic: `${this.o.discoveryPrefix}/binary_sensor/${slug(this.o.deviceId)}/${v.key}_${name}/config`, retain: true, payload: clean({
                        name: label,
                        unique_id: slug(this.o.deviceId) + '_' + v.key + '_' + name,
                        default_entity_id: 'binary_sensor.' + id + '_' + name,
                        state_topic: stateTopic + '/' + name,
                        payload_on: 'ON', payload_off: 'OFF',
                        device_class: BIT_CLASSES[name],
                        device: clean(this.device())
                    }) });
                }
            }
        }
        if (v.value === null) return out;   // register "not available": publish no state, expire_after handles staleness
        out.push({ topic: stateTopic, payload: String(v.value), retain: true });
        if (v.bits) for (const [name, on] of Object.entries(v.bits)) out.push({ topic: stateTopic + '/' + name, payload: on ? 'ON' : 'OFF', retain: true });
        return out;
    }
}

function clean(o) {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
    return r;
}

module.exports = { HaDiscovery };
