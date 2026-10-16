const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 4173;
const ROOT = __dirname;
const STOBIX_API = 'https://api.stobix.com';

const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET') {
        response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const requestUrl = new URL(request.url, `http://127.0.0.1:${PORT}`);

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(path.join(ROOT, 'index.html'))
            .on('error', (error) => {
                console.error('Failed to serve index.html:', error);
                if (!response.headersSent) {
                    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                }
                response.end('Unable to serve index.html');
            })
            .pipe(response);
        return;
    }

    let upstreamPath;
    if (requestUrl.pathname === '/api/futures/markets') {
        upstreamPath = '/v1/futures/markets';
    } else if (requestUrl.pathname === '/api/rates/candles') {
        upstreamPath = `/v1/rates/candles${requestUrl.search}`;
    } else {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    try {
        const upstream = await fetch(`${STOBIX_API}${upstreamPath}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(20000)
        });
        const body = await upstream.text();
        response.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        response.end(body);
    } catch (error) {
        console.error(`Stobix request failed (${upstreamPath}):`, error);
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
            error: 'Не удалось подключиться к API Stobix',
            details: error.message
        }));
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Coin Monitor: http://127.0.0.1:${PORT}`);
});

server.on('error', (error) => {
    console.error('Coin Monitor server failed to start:', error);
    process.exitCode = 1;
});
