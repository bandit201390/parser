const fs = require('node:fs/promises');
const path = require('node:path');

const API_URL = 'https://api.stobix.com';
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'site');
const REQUEST_CONCURRENCY = 4;
const RETRIES = 4;

async function fetchJson(url) {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(20000)
            });

            if (response.ok) {
                return await response.json();
            }

            if (response.status !== 429 && response.status < 500) {
                throw new Error(`HTTP ${response.status} from ${url}`);
            }

            if (attempt === RETRIES) {
                throw new Error(`HTTP ${response.status} after retries from ${url}`);
            }

            const retryAfter = Number(response.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 1000 * (attempt + 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
        } catch (error) {
            if (attempt === RETRIES || /^HTTP \d/.test(error.message)) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }

    throw new Error('Request failed after retries');
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await mapper(items[index]);
            }
        }
    );

    await Promise.all(workers);
    return results;
}

function calculateVolatility(candles) {
    if (candles.length === 0 || candles[0].open <= 0) {
        return null;
    }

    const high = Math.max(...candles.map((candle) => candle.high));
    const low = Math.min(...candles.map((candle) => candle.low));
    return ((high - low) / candles[0].open) * 100;
}

async function loadMarket(symbol, startTime, endTime) {
    const query = new URLSearchParams({
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        symbol,
        interval: '1m'
    });
    const payload = await fetchJson(`${API_URL}/v1/rates/candles?${query}`);

    if (payload.s !== 'ok' || !Array.isArray(payload.t)) {
        throw new Error(`Stobix returned invalid candles for ${symbol}`);
    }

    const candles = payload.t.map((timestamp, index) => ({
        time: Number(timestamp) * 1000,
        open: Number(payload.o[index]),
        high: Number(payload.h[index]),
        low: Number(payload.l[index]),
        close: Number(payload.c[index])
    })).filter((candle) =>
        candle.time >= startTime.getTime() - 60_000 &&
        candle.time <= endTime.getTime() &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close)
    );

    if (candles.length === 0) {
        throw new Error(`Stobix returned no hourly candles for ${symbol}`);
    }

    return {
        symbol: symbol.replace('/', ''),
        current_price: candles[candles.length - 1].close,
        volatilityValue: calculateVolatility(candles)
    };
}

async function main() {
    const markets = await fetchJson(`${API_URL}/v1/futures/markets`);
    if (!Array.isArray(markets)) {
        throw new Error('Stobix returned an invalid futures markets list');
    }

    const symbols = [...new Set(markets
        .map((market) => market && market.symbol)
        .filter((symbol) => typeof symbol === 'string' && symbol.endsWith('/USDT')))];
    if (symbols.length === 0) {
        throw new Error('Stobix returned no USDT futures markets');
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);
    const results = await mapWithConcurrency(
        symbols,
        REQUEST_CONCURRENCY,
        async (symbol) => {
            try {
                return await loadMarket(symbol, startTime, endTime);
            } catch (error) {
                console.warn(`Unable to load ${symbol}: ${error.message}`);
                return {
                    symbol: symbol.replace('/', ''),
                    current_price: null,
                    volatilityValue: null
                };
            }
        }
    );

    const available = results.filter((market) => market.volatilityValue !== null).length;
    if (available === 0) {
        throw new Error('Stobix returned no candle data for any market; refusing to publish an empty snapshot');
    }

    const snapshot = {
        generatedAt: endTime.toISOString(),
        periodStart: startTime.toISOString(),
        periodEnd: endTime.toISOString(),
        markets: results.sort((a, b) => {
            if (a.volatilityValue === null) return 1;
            if (b.volatilityValue === null) return -1;
            return b.volatilityValue - a.volatilityValue;
        })
    };

    await fs.mkdir(path.join(OUTPUT_DIRECTORY, 'data'), { recursive: true });
    await fs.copyFile(
        path.join(REPOSITORY_ROOT, 'index.html'),
        path.join(OUTPUT_DIRECTORY, 'index.html')
    );
    await fs.writeFile(
        path.join(OUTPUT_DIRECTORY, 'data', 'market-snapshot.json'),
        `${JSON.stringify(snapshot)}\n`
    );
    await fs.writeFile(path.join(OUTPUT_DIRECTORY, '.nojekyll'), '');

    console.log(`Built static site with ${available}/${symbols.length} Stobix markets.`);
}

main().catch((error) => {
    console.error('Failed to build static market snapshot:', error);
    process.exitCode = 1;
});
