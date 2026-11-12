'use strict';
/**
 * Calculated diagnosis for the THZ 504 (no Node-RED dependency, unit-testable).
 *
 * Input: value objects from ThzReader (key, value, bitList …).
 * Output per update: { values: [calculated value objects], events: [event objects] }
 *
 * Models (fault-13 analysis, 11./12.11.2026, see README):
 *  - EXV = pilot (0x07F6) × P × I × D. The "refrigerant shortage" guard counts while
 *    EXV ≥ 2.975 × pilot and EXV < 100 %, resets otherwise and stops the compressor
 *    after 0x07EC minutes (10 min). It does not trigger with the controller at its limit.
 *  - Heating circuit: heating power relative (0x069A) = feed-forward + integral.
 *    Feed-forward = design output × (RT − AT_damped) / (RT − T_design), with
 *    RT − AT_damped = (HC target − RT − base point) / slope from the heating curve.
 *  - Fault lock: bit 6 (64) of 0x0176; error 13 itself is reported only once.
 */

const DEFAULT_GUARD_FACTOR = 2.975;
const DEFAULT_GUARD_S = 600;
const I_SAMPLE_S = 600;            // I factor "at 10 min"
const ROUTINE = { from: 10 * 60, to: 10 * 60 + 20 };   // 10 o'clock routine, minutes after midnight

const DEFS = {
    exv_ratio: { id_de: 'exv_verhaeltnis_vorsteuerung', de: 'EXV / Vorsteuerung', en: 'EXV / pilot ratio', digits: 3, state_class: 'measurement' },
    guard_counter: { id_de: 'waechter_zaehler', de: 'Wächterzähler Kältemittelmangel', en: 'Refrigerant guard counter', unit: 's', digits: 0, state_class: 'measurement' },
    guard_remaining: { id_de: 'waechter_restzeit', de: 'Restzeit bis Wächterstopp', en: 'Time to guard stop', unit: 's', digits: 0, state_class: 'measurement' },
    hc_feedforward: { id_de: 'hk_vorsteuerung_berechnet', de: 'HK-Vorsteuerung (berechnet)', en: 'HC feed-forward (calculated)', unit: '%', digits: 1, state_class: 'measurement' },
    hc_integral: { id_de: 'hk_integralanteil_berechnet', de: 'HK-Integralanteil (berechnet)', en: 'HC integral part (calculated)', unit: '%', digits: 1, state_class: 'measurement' },
    fault_lock: { id_de: 'stoersperre', de: 'Störsperre aktiv', en: 'Fault lock active', digits: 0 },
    last_run_duration: { id_de: 'letzter_lauf_dauer', de: 'Letzter Lauf: Dauer', en: 'Last run: duration', unit: 'min', digits: 1 },
    last_run_power_start: { id_de: 'letzter_lauf_heizleistung_start', de: 'Letzter Lauf: Heizleistung beim Start', en: 'Last run: heating power at start', unit: '%', digits: 0 },
    last_run_i_10min: { id_de: 'letzter_lauf_i_10min', de: 'Letzter Lauf: I-Faktor nach 10 min', en: 'Last run: I factor after 10 min', digits: 3 },
    last_run_max_ratio: { id_de: 'letzter_lauf_max_exv_verhaeltnis', de: 'Letzter Lauf: max. EXV / Vorsteuerung', en: 'Last run: max. EXV / pilot ratio', digits: 3 },
    last_stop_cause: { id_de: 'letzter_stopp_ursache', de: 'Letzter Stopp: Ursache', en: 'Last stop: cause', digits: null }
};
const CAUSES = { guard: { de: 'Wächter', en: 'guard' }, hot_water: { de: 'Warmwasser', en: 'hot water' }, fault_lock: { de: 'Störsperre', en: 'fault lock' },
    routine: { de: '10-Uhr-Routine', en: '10 o\'clock routine' }, regular: { de: 'regulär', en: 'regular' } };

function bit(v, key) { const b = (v.bitList || []).find(x => x.key === key); return b ? b.on : undefined; }
function minutesOfDay(ts) { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); }
function round(x, d) { if (d === null || typeof x !== 'number') return x; const f = Math.pow(10, d); return Math.round(x * f) / f; }

class ThzDiagnosis {
    /**
     * @param {object} [opt]
     * @param {string} [opt.nameLang] 'de' | 'en'
     * @param {string} [opt.idLang]   'de' | 'en'
     * @param {number} [opt.guardFactor] EXV/pilot threshold of the guard model (2.975)
     */
    constructor(opt = {}) {
        this.nameLang = opt.nameLang === 'de' ? 'de' : 'en';
        this.idLang = opt.idLang === 'de' ? 'de' : 'en';
        this.guardFactor = Number(opt.guardFactor) > 0 ? Number(opt.guardFactor) : DEFAULT_GUARD_FACTOR;
        this.v = {};                 // last value per key
        this.compressor = undefined; // true/false once known
        this.hotWater = false;
        this.lock = undefined;
        this.guard = { active: false, since: 0, counter: 0 };
        this.run = null;             // current run
        this.lastRun = null;
    }

    get guardLimitS() { const m = this.v.superheat_guard_time; return typeof m === 'number' && m > 0 ? m * 60 : DEFAULT_GUARD_S; }

    /** Feed one value object; returns calculated values and events. */
    update(val, now = Date.now()) {
        const out = { values: [], events: [] };
        if (!val || !val.key) return out;
        if (val.value !== null && val.value !== undefined) this.v[val.key] = val.value;
        switch (val.key) {
            case 'operating_status': this._status(val, now, out); break;
            case 'exv_opening': case 'exv_preset': this._guard(now, out); break;
            case 'heating_power_rel': this._hc(now, out); this._runSample('power', val.value); break;
            case 'exv_i_factor': this._runSample('i', val.value, now); break;
        }
        return out;
    }

    /** Short state text for the node status. */
    summary() {
        const c = this.compressor === undefined ? '?' : this.compressor ? 'on' : 'off';
        return { compressor: c, guard: Math.round(this.guard.counter), lock: !!this.lock, run: this.run ? Math.round((Date.now() - this.run.start) / 60000) : null };
    }

    _val(key, value, now) {
        const d = DEFS[key];
        return {
            key, id: this.idLang === 'de' ? d.id_de : key, name: d[this.nameLang], value: round(value, d.digits), precision: d.digits === null ? undefined : d.digits,
            unit: d.unit || '', state_class: d.state_class, group: 'diagnosis', status: 'calculated',
            interval: 0, source: 'calculated', ts: new Date(now).toISOString()
        };
    }

    _event(type, data, now) {
        return Object.assign({ type, ts: new Date(now).toISOString() }, data);
    }

    _status(val, now, out) {
        const on = bit(val, 'compressor');
        const ww = bit(val, 'hot_water');
        const lock = bit(val, 'service');
        if (ww) { this.hotWater = true; if (this.run) this.run.hotWater = true; }
        if (lock !== undefined && lock !== this.lock) {
            if (this.lock !== undefined || lock) out.events.push(this._event(lock ? 'fault_lock_on' : 'fault_lock_off', {}, now));
            this.lock = lock;
            out.values.push(this._val('fault_lock', lock ? 1 : 0, now));
        }
        if (on === undefined || on === this.compressor) { if (!ww) this.hotWater = false; return; }
        const was = this.compressor;
        this.compressor = on;
        if (on) {
            this.run = { start: now, hotWater: !!ww, powerStart: this.v.heating_power_rel, iAt10: null, maxRatio: null, guardMax: 0 };
            if (was !== undefined) out.events.push(this._event('compressor_start', { heating_power_rel: this.v.heating_power_rel, compressor_demand: this.v.compressor_demand, hot_water: !!ww }, now));
        } else if (this.run) {
            const r = this.run;
            const duration = (now - r.start) / 1000;
            const cause = this._cause(r, lock, now);
            this.lastRun = { duration, cause, powerStart: r.powerStart, iAt10: r.iAt10, maxRatio: r.maxRatio };
            out.events.push(this._event('compressor_stop', {
                duration_s: Math.round(duration), cause, cause_text: CAUSES[cause][this.nameLang],
                heating_power_start: r.powerStart, i_factor_10min: r.iAt10, max_exv_ratio: r.maxRatio,
                guard_counter_max: Math.round(r.guardMax), hot_water: r.hotWater
            }, now));
            out.values.push(this._val('last_run_duration', duration / 60, now));
            if (typeof r.powerStart === 'number') out.values.push(this._val('last_run_power_start', r.powerStart, now));
            if (typeof r.iAt10 === 'number') out.values.push(this._val('last_run_i_10min', r.iAt10, now));
            if (typeof r.maxRatio === 'number') out.values.push(this._val('last_run_max_ratio', r.maxRatio, now));
            out.values.push(Object.assign(this._val('last_stop_cause', CAUSES[cause][this.nameLang], now), { cause }));
            this.run = null;
            this._resetGuard(now, out);
        }
        if (!ww) this.hotWater = false;
    }

    /**
     * Stop cause: fault lock > hot water > guard > 10 o'clock routine > regular.
     * Guard: the guard counter reached its limit (minus one fast poll), or the stop happened
     * with HC actual below target, without hot water and outside the 10 o'clock routine.
     */
    _cause(r, lock, now) {
        if (lock) return 'fault_lock';
        if (r.hotWater) return 'hot_water';
        const m = minutesOfDay(now);
        const routine = m >= ROUTINE.from && m < ROUTINE.to;
        if (r.guardMax >= this.guardLimitS - 15) return 'guard';
        const ist = this.v.hc1_temp, soll = this.v.hc1_target_controller;
        if (!routine && typeof ist === 'number' && typeof soll === 'number' && ist < soll) return 'guard';
        return routine ? 'routine' : 'regular';
    }

    _guard(now, out) {
        const exv = this.v.exv_opening, pilot = this.v.exv_preset;
        if (typeof exv !== 'number' || typeof pilot !== 'number') return;
        if (pilot > 0 && this.compressor !== false) {
            const ratio = exv / pilot;
            out.values.push(this._val('exv_ratio', ratio, now));
            if (this.run) this.run.maxRatio = Math.max(this.run.maxRatio || 0, round(ratio, 3));
        }
        const cond = this.compressor !== false && pilot > 0 && exv >= this.guardFactor * pilot && exv < 100;
        const g = this.guard;
        if (cond) {
            if (!g.active) { g.active = true; g.since = now; }
            g.counter = (now - g.since) / 1000;
            if (this.run) this.run.guardMax = Math.max(this.run.guardMax, g.counter);
        } else {
            g.active = false; g.counter = 0;
        }
        out.values.push(this._val('guard_counter', g.counter, now));
        out.values.push(this._val('guard_remaining', Math.max(this.guardLimitS - g.counter, 0), now));
    }

    _resetGuard(now, out) {
        if (!this.guard.active && this.guard.counter === 0) return;
        this.guard = { active: false, since: 0, counter: 0 };
        out.values.push(this._val('guard_counter', 0, now));
        out.values.push(this._val('guard_remaining', this.guardLimitS, now));
    }

    _hc(now, out) {
        const hl = this.v.heating_power_rel;
        const soll = this.v.hc1_target_controller, rt = this.v.room_target_active, fp = this.v.heating_curve_base,
            st = this.v.heating_curve_slope, ausl = this.v.design_output_heating, tausl = this.v.design_temp;
        if (![hl, soll, rt, fp, st, ausl, tausl].every(x => typeof x === 'number') || st <= 0 || rt <= tausl) return;
        const dT = (soll - rt - fp) / st;
        const ff = ausl * dT / (rt - tausl);
        out.values.push(this._val('hc_feedforward', ff, now));
        out.values.push(this._val('hc_integral', hl - ff, now));
    }

    _runSample(kind, value, now) {
        if (!this.run || typeof value !== 'number') return;
        if (kind === 'power' && this.run.powerStart === undefined) this.run.powerStart = value;
        if (kind === 'i' && this.run.iAt10 === null && now - this.run.start >= I_SAMPLE_S * 1000) this.run.iAt10 = value;
    }
}

/** Catalog keys the diagnosis needs from "THZ 504 read". */
const REQUIRED_KEYS = ['operating_status', 'exv_opening', 'exv_preset', 'exv_i_factor', 'heating_power_rel', 'superheat_guard_time',
    'hc1_temp', 'hc1_target_controller', 'room_target_active', 'heating_curve_base', 'heating_curve_slope', 'design_output_heating', 'design_temp'];

module.exports = { ThzDiagnosis, REQUIRED_KEYS, DEFS, CAUSES, DEFAULT_GUARD_FACTOR };
