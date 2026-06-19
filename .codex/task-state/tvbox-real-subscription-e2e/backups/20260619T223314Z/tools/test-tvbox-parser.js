const assert = require('assert');
const crypto = require('crypto');
const { parseTvboxJson } = require('../server/adapters/tvbox/tvboxParser');

function pad(value) {
    return String(value).padEnd(16, '0');
}

function encodeFongMiCbc(json) {
    const keyText = 'testkey';
    const ivText = 'iv-vector-123';
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(pad(keyText)), Buffer.from(pad(ivText)));
    const encrypted = Buffer.concat([cipher.update(Buffer.from(json)), cipher.final()]);
    return [
        Buffer.from(`$#${keyText}#$`).toString('hex'),
        encrypted.toString('hex'),
        Buffer.from(ivText).toString('hex')
    ].join('');
}

const fixture = JSON.stringify({
    sites: [
        {
            key: 'fixture',
            name: 'Fixture source',
            type: 1,
            api: 'https://example.com/api.php/provide/vod/'
        }
    ],
    lives: [],
    parses: []
});

const plain = parseTvboxJson(fixture);
assert.strictEqual(plain.sites[0].key, 'fixture');
assert.strictEqual(plain._parserDiagnostics.decodeMode, 'plain-text');

const base64 = parseTvboxJson(`12345678**${Buffer.from(fixture).toString('base64')}`);
assert.strictEqual(base64.sites[0].key, 'fixture');
assert.strictEqual(base64._parserDiagnostics.decodeMode, 'fongmi-base64');

const encrypted = parseTvboxJson(encodeFongMiCbc(fixture));
assert.strictEqual(encrypted.sites[0].key, 'fixture');
assert.strictEqual(encrypted._parserDiagnostics.decodeMode, 'fongmi-aes-cbc');

assert.throws(
    () => parseTvboxJson(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
    error => error && error.code === 'image-config-unsupported'
);

console.log('TVBox parser fixtures passed: plain, Base64, AES-CBC, image diagnostic.');
