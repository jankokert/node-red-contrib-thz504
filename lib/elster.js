'use strict';
/**
 * Elster CAN protocol helpers (Stiebel Eltron / Tecalor).
 *
 * Frame layout (7 data bytes, extended register form 0xFA):
 *   byte 0 = ((receiver >> 3) & 0xF0) | type
 *   byte 1 =   receiver & 0x7F
 *   byte 2 =   0xFA
 *   byte 3/4 = register (big endian)
 *   byte 5/6 = value (big endian), 0x8000 = "not available"
 *
 * Types: 0 = write, 1 = read request, 2 = response.
 *
 * SAFETY: this module can only BUILD read requests. There is deliberately
 * no function that builds a write frame.
 */

const TYPE_WRITE = 0;
const TYPE_READ = 1;
const TYPE_RESPONSE = 2;
const NOT_AVAILABLE = 0x8000;

function toInt(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v.trim().toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
    return NaN;
}

function checkId(id, what) {
    if (!Number.isInteger(id) || id < 0 || id > 0x7FF) throw new Error(`${what} is not a valid 11-bit CAN id: ${id}`);
}

/**
 * Build a read request frame in the message format of node-red-contrib-socketcan.
 * @param {number} sender   own CAN id (e.g. 0x6A3)
 * @param {number} receiver target device (e.g. 0x180)
 * @param {number} register Elster register (0x0000-0xFFFF)
 * @param {number[]} allowedReceivers whitelist of target devices
 */
function buildRead(sender, receiver, register, allowedReceivers) {
    checkId(sender, 'sender');
    checkId(receiver, 'receiver');
    if (allowedReceivers && !allowedReceivers.includes(receiver)) {
        throw new Error(`receiver 0x${receiver.toString(16)} is not in the allowed list`);
    }
    if (!Number.isInteger(register) || register < 0 || register > 0xFFFF) throw new Error(`invalid register: ${register}`);
    return {
        canfd: false, ext: false, rtr: false, canid: sender, dlc: 7,
        data: [((receiver >> 3) & 0xF0) | TYPE_READ, receiver & 0x7F, 0xFA, register >> 8, register & 0xFF, 0, 0]
    };
}

/**
 * Parse a CAN frame (socketcan message payload). Returns null for frames
 * that are not in the extended Elster register form.
 */
function parseFrame(frame) {
    if (!frame || frame.data === undefined || frame.canid === undefined) return null;
    const d = Array.from(frame.data);
    if (d.length < 7 || d[2] !== 0xFA) return null;
    const value = (d[5] << 8) | d[6];
    return {
        sender: Number(frame.canid),
        receiver: ((d[0] & 0xF0) << 3) | (d[1] & 0x7F),
        type: d[0] & 0x0F,
        register: (d[3] << 8) | d[4],
        value,
        available: value !== NOT_AVAILABLE
    };
}

function s16(w) { return w >= 0x8000 ? w - 0x10000 : w; }
function round(v, digits) { const f = Math.pow(10, digits); return Math.round(v * f) / f; }

/**
 * Decode a 16-bit word according to a catalog decode type.
 * Combined (two-register) values are handled by the caller.
 */
function decodeWord(decode, word, entry) {
    switch (decode) {
        case 'deci_s': return round(s16(word) / 10, 1);
        case 'cent_s': return round(s16(word) / 100, 2);
        case 'u16': return word;
        case 's16': return s16(word);
        case 'deci_u': return round(word / 10, 1);
        case 'hi_u': return word >> 8;
        case 'hi_s_deci': { const b = word >> 8; return round((b >= 128 ? b - 256 : b) / 10, 1); }
        case 'bits': return word;
        case 'qh_time': return qhTime(word);
        default: throw new Error(`unknown decode type '${decode}'${entry ? ' for ' + entry.key : ''}`);
    }
}

const SPAN_UNUSED = 0x8080;

/** Quarter hours since midnight -> "HH:MM" (96 = 24:00). */
function qhTime(q) {
    if (!Number.isInteger(q) || q < 0 || q > 96) return null;
    return String(Math.floor(q / 4)).padStart(2, '0') + ':' + String((q % 4) * 15).padStart(2, '0');
}

/**
 * Weekly program spans: each word = high byte start, low byte end (quarter hours),
 * 0x8080 = unused. Returns "HH:MM–HH:MM, …" or "–" when no span is set.
 */
function decodeSchedule(words) {
    const spans = [];
    for (const w of words) {
        if (w === SPAN_UNUSED || w === NOT_AVAILABLE) continue;
        const a = qhTime(w >> 8), b = qhTime(w & 0xFF);
        if (a && b) spans.push(a + '–' + b);
    }
    return spans.length ? spans.join(', ') : '–';
}

/** bits: { "1": { key: "compressor", ... } } -> { compressor: true, ... } */
function decodeBits(word, bits) {
    const out = {};
    for (const [bit, def] of Object.entries(bits || {})) out[def.key] = (word & (1 << Number(bit))) !== 0;
    return out;
}

module.exports = {
    TYPE_WRITE, TYPE_READ, TYPE_RESPONSE, NOT_AVAILABLE,
    toInt, buildRead, parseFrame, decodeWord, decodeBits, decodeSchedule, qhTime, s16
};
