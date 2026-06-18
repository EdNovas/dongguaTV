const fs = require('fs');
const http = require('http');
const path = require('path');

const mediaPath = path.resolve(process.env.TEST_MEDIA_FILE || '');
const port = Number(process.env.TEST_MEDIA_PORT || 31487);
const expectedReferer = process.env.TEST_MEDIA_REFERER || 'https://donggua.test/player';
const expectedUserAgent = process.env.TEST_MEDIA_USER_AGENT || 'DongguaTV-Player-Test/1.0';
const expectedAuthorization = process.env.TEST_MEDIA_AUTHORIZATION || 'Bearer local-player-test';

if (!mediaPath || !fs.existsSync(mediaPath)) {
    console.error('TEST_MEDIA_FILE must point to an existing media file.');
    process.exit(1);
}

function headersAccepted(req) {
    return req.headers.referer === expectedReferer
        && req.headers['user-agent'] === expectedUserAgent
        && req.headers.authorization === expectedAuthorization;
}

function writeEvent(req, statusCode, extra = {}) {
    console.log(JSON.stringify({
        method: req.method,
        path: String(req.url || '').split('?')[0],
        statusCode,
        hasRange: Boolean(req.headers.range),
        headersAccepted: headersAccepted(req),
        ...extra
    }));
}

const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
        res.statusCode = 405;
        res.end();
        writeEvent(req, 405);
        return;
    }

    if (!headersAccepted(req)) {
        res.statusCode = 403;
        res.end('Required playback headers were not forwarded.');
        writeEvent(req, 403);
        return;
    }

    const stat = fs.statSync(mediaPath);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    if (!range) {
        res.statusCode = 200;
        res.setHeader('Content-Length', stat.size);
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(mediaPath).pipe(res);
        writeEvent(req, 200, { contentLength: stat.size });
        return;
    }

    const match = String(range).match(/^bytes=(\d+)-(\d+)?$/);
    if (!match) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        writeEvent(req, 416);
        return;
    }

    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : stat.size - 1, stat.size - 1);
    if (start >= stat.size || end < start) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        writeEvent(req, 416);
        return;
    }

    const contentLength = end - start + 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', contentLength);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(mediaPath, { start, end }).pipe(res);
    writeEvent(req, 206, { start, end, contentLength });
});

server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
        ready: true,
        host: '127.0.0.1',
        port,
        mediaBytes: fs.statSync(mediaPath).size
    }));
});

function shutdown() {
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
