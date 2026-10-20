const fs = require('node:fs/promises');
const path = require('node:path');
const {
    advanceAlertState,
    calculateVolatility,
    filterMarketsByCommission
} = require('./monitor-core');

const API_URL = 'https://api.stobix.com';
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'site');
const REPOSITORY = process.env.GITHUB_REPOSITORY || 'bandit201390/parser';
const [REPOSITORY_OWNER, REPOSITORY_NAME] = REPOSITORY.split('/');
const PAGES_URL = process.env.PAGES_URL || `https://${REPOSITORY_OWNER}.github.io/${REPOSITORY_NAME}/`;
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
    candles.sort((left, right) => left.time - right.time);

    if (candles.length === 0) {
        throw new Error(`Stobix returned no hourly candles for ${symbol}`);
    }

    return {
        symbol: symbol.replace('/', ''),
        current_price: candles[candles.length - 1].close,
        volatilityValue: calculateVolatility(candles),
        priceChangePercent: candles[0].open > 0
            ? ((candles[candles.length - 1].close - candles[0].open) / candles[0].open) * 100
            : null
    };
}

async function loadPreviousSnapshot() {
    try {
        const snapshotUrl = new URL('data/market-snapshot.json', PAGES_URL);
        snapshotUrl.searchParams.set('v', Date.now());
        const response = await fetch(snapshotUrl, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10000)
        });
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} while loading the previous snapshot`);
        }

        const snapshot = await response.json();
        if (!Array.isArray(snapshot.markets)) {
            throw new Error('The previous market snapshot has an invalid format');
        }
        return snapshot;
    } catch (error) {
        if (error.message.startsWith('HTTP ') || error.message.startsWith('The previous')) {
            throw error;
        }
        throw new Error(`Unable to load the previous snapshot: ${error.message}`);
    }
}

async function sendTelegramAlerts(alerts) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId || alerts.length === 0) {
        return false;
    }

    const batches = [];
    let batch = [];
    let batchLength = 0;
    for (const alert of alerts) {
        if (batch.length && batchLength + alert.message.length + 1 > 3500) {
            batches.push(batch);
            batch = [];
            batchLength = 0;
        }
        batch.push(alert);
        batchLength += alert.message.length + 1;
    }
    if (batch.length) {
        batches.push(batch);
    }

    for (const messages of batches) {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: messages.map((item) => item.message).join('\n'),
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true }
            }),
            signal: AbortSignal.timeout(15000)
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) {
            throw new Error(`Telegram rejected alert delivery: ${result.description || `HTTP ${response.status}`}`);
        }
    }

    console.log(`Sent ${alerts.length} Telegram volatility threshold alert(s).`);
    return true;
}

async function main() {
    const markets = await fetchJson(`${API_URL}/v1/futures/markets`);
    if (!Array.isArray(markets)) {
        throw new Error('Stobix returned an invalid futures markets list');
    }

    const { eligible, excluded } = filterMarketsByCommission(markets);
    const symbols = eligible.map((market) => market.symbol);
    const eligibleBySymbol = new Map(eligible.map((market) => [market.symbol, market]));
    if (excluded.length > 0) {
        console.log(
            `Excluded ${excluded.length} market(s) with per-side commission above 0.1%: ` +
            excluded.map((market) => market.symbol.replace('/', '')).join(', ')
        );
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);
    const results = await mapWithConcurrency(
        symbols,
        REQUEST_CONCURRENCY,
        async (symbol) => {
            try {
                return {
                    ...await loadMarket(symbol, startTime, endTime),
                    commissionRate: eligibleBySymbol.get(symbol).commissionRate
                };
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

    const previousSnapshot = await loadPreviousSnapshot();
    const { alertState, alerts } = advanceAlertState(
        results,
        previousSnapshot?.alertState || {}
    );
    const telegramConfigured = Boolean(
        process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    );
    if (telegramConfigured) {
        if (alerts.length > 0) {
            await sendTelegramAlerts(alerts);
        } else {
            console.log('Telegram alerts are configured; no new volatility thresholds were crossed.');
        }
    } else {
        console.log('Telegram delivery is not configured; add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID repository secrets to enable alerts.');
        if (alerts.length) {
            console.log('Telegram alerts are pending configuration; add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID repository secrets.');
        }
    }

    const snapshot = {
        generatedAt: endTime.toISOString(),
        periodStart: startTime.toISOString(),
        periodEnd: endTime.toISOString(),
        alertState,
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
