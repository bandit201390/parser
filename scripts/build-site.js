const fs = require('node:fs/promises');
const path = require('node:path');

const API_URL = 'https://api.stobix.com';
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'site');
const REPOSITORY = process.env.GITHUB_REPOSITORY || 'bandit201390/parser';
const [REPOSITORY_OWNER, REPOSITORY_NAME] = REPOSITORY.split('/');
const PAGES_URL = process.env.PAGES_URL || `https://${REPOSITORY_OWNER}.github.io/${REPOSITORY_NAME}/`;
const REQUEST_CONCURRENCY = 4;
const RETRIES = 4;
const FIRST_ALERT_THRESHOLD = 2;

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

function getPreviousMarketLevels(previousSnapshot) {
    const levels = new Map();
    if (!previousSnapshot) {
        return levels;
    }

    for (const market of previousSnapshot.markets) {
        if (Number.isFinite(market.volatilityValue)) {
            levels.set(market.symbol, Math.max(
                FIRST_ALERT_THRESHOLD - 1,
                Math.floor(market.volatilityValue)
            ));
        }
    }
    return levels;
}

function makeTelegramAlerts(markets, previousSnapshot) {
    const previousLevels = getPreviousMarketLevels(previousSnapshot);
    const savedLevels = previousSnapshot?.alertState || {};
    const alertState = {};
    const alerts = [];

    for (const market of markets) {
        const volatility = market.volatilityValue;
        if (!Number.isFinite(volatility)) {
            if (Number.isFinite(savedLevels[market.symbol])) {
                alertState[market.symbol] = savedLevels[market.symbol];
            }
            continue;
        }

        const fallbackLevel = previousLevels.get(market.symbol)
            ?? Math.max(FIRST_ALERT_THRESHOLD - 1, Math.floor(volatility));
        const previousLevel = Number.isFinite(savedLevels[market.symbol])
            ? savedLevels[market.symbol]
            : fallbackLevel;
        const currentLevel = Math.floor(volatility);

        if (currentLevel < FIRST_ALERT_THRESHOLD) {
            alertState[market.symbol] = FIRST_ALERT_THRESHOLD - 1;
            continue;
        }

        alertState[market.symbol] = previousLevel;
        for (let level = Math.max(FIRST_ALERT_THRESHOLD, previousLevel + 1); level <= currentLevel; level += 1) {
            alerts.push({
                symbol: market.symbol,
                level,
                message: `🔔 ${market.symbol.replace(/USDT$/, '/USDT')}: часовая волатильность достигла ${level}% (текущая ${volatility.toFixed(2)}%).`
            });
        }
    }

    return { alertState, alerts };
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
                text: messages.map((item) => item.message).join('\n')
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

    const previousSnapshot = await loadPreviousSnapshot();
    const { alertState, alerts } = makeTelegramAlerts(results, previousSnapshot);
    const telegramConfigured = Boolean(
        process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    );
    if (telegramConfigured) {
        if (alerts.length > 0) {
            await sendTelegramAlerts(alerts);
        } else {
            console.log('Telegram alerts are configured; no new volatility thresholds were crossed.');
        }
        for (const market of results) {
            if (!Number.isFinite(market.volatilityValue)) {
                continue;
            }

            const previousLevel = Number.isFinite(alertState[market.symbol])
                ? alertState[market.symbol]
                : FIRST_ALERT_THRESHOLD - 1;
            alertState[market.symbol] = Math.max(
                previousLevel,
                Math.floor(market.volatilityValue)
            );
            if (market.volatilityValue < FIRST_ALERT_THRESHOLD) {
                alertState[market.symbol] = FIRST_ALERT_THRESHOLD - 1;
            }
        }
    } else {
        console.log('Telegram delivery is not configured; add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID repository secrets to enable alerts.');
        for (const market of results) {
            if (Number.isFinite(market.volatilityValue)) {
                alertState[market.symbol] = Math.max(
                    FIRST_ALERT_THRESHOLD - 1,
                    Math.floor(market.volatilityValue)
                );
            }
        }
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
