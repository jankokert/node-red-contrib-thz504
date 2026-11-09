'use strict';
/**
 * Node "thz504-ha": turns values from thz504-read into Home Assistant
 * MQTT discovery and state messages for an mqtt-out node.
 *
 * Input:  messages from thz504-read output 2 (msg.thz504),
 *         or msg.topic = "homeassistant/status" with payload "online" (HA restart)
 *         or msg.topic = "announce" to send all discovery configs again with the next values
 * Output: { topic, payload, retain } for mqtt out
 */
const { HaDiscovery } = require('../lib/ha');

module.exports = function (RED) {
    function Thz504HaNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const ha = new HaDiscovery({
            baseTopic: config.baseTopic || 'thz504',
            discoveryPrefix: config.discoveryPrefix || 'homeassistant',
            entityPrefix: config.entityPrefix || 'thz504',
            deviceName: config.deviceName || 'THZ 504',
            deviceId: config.deviceId || config.entityPrefix || 'thz504'
        });
        let entities = 0;

        node.on('input', (msg, send, done) => {
            if (msg.topic === 'announce' || (msg.topic === ha.o.discoveryPrefix + '/status' && msg.payload === 'online')) {
                ha.reset();
                node.status({ fill: 'blue', shape: 'ring', text: RED._('thz504-ha.state.reannounce') });
                done();
                return;
            }
            if (!msg.thz504 || !msg.thz504.key) { done(); return; }
            const out = ha.messages(msg.thz504);
            entities = ha.announced.size;
            node.status({ fill: 'green', shape: 'dot', text: RED._('thz504-ha.state.running', { entities }) });
            send([out]);
            done();
        });
    }

    RED.nodes.registerType('thz504-ha', Thz504HaNode);
};
