const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const {
    addPriceToCandles,
    advanceAlertState,
    calculateVolatility,
    filterMarketsByCommission,
    pruneCandles
} = require('./monitor-core');

const API_URL = 'https://api.stobix.com';
const [REPOSITORY_OWNER, REPOSITORY_NAME] = (
    process.env.GITHUB_REPOSITORY || 'bandit201390/parser'
).split('/');
const PAGES_URL = process.env.PAGES_URL || `https://${REPOSITORY_OWNER}.github.io/${REPOSITORY_NAME}/`;
const FIRST_ALERT_THRESHOLD = 2;
const REQUEST_CONCURRENCY = 4;
const RETRIES = 4;
const DEFAULT_MONITOR_DURATION_MS = 340 * 60_000;
const MINUTE_MS = 60_000;
const SNAPSHOT_URL = new URL('data/market-snapshot.json', PAGES_URL);
const WORKFLOW_FILE = 'monitor-stobix.yml';

async function fetchJson(url, timeoutMs = 20_000) {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs)
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
            await delay(Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 1000 * (attempt + 1));
        } catch (error) {
            if (attempt === RETRIES || /^HTTP \d/.test(error.message)) {
                throw error;
            }
            await delay(1000 * (attempt + 1));
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

function normalizeSymbol(symbol) {
    return symbol.replace('/', '').toUpperCase();
}

function parseCarriedState(value) {
    if (!value) {
        return {};
    }

    let state;
    try {
        const encoded = value.trim();
        const json = encoded.startsWith('{')
            ? encoded
            : Buffer.from(encoded, 'base64').toString('utf8');
        state = JSON.parse(json);
    } catch (error) {
        throw new Error(`The carried monitor state is invalid JSON: ${error.message}`);
    }

    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('The carried monitor state must be a JSON object');
    }

    for (const [symbol, level] of Object.entries(state)) {
        if (!/^[A-Z0-9]+USDT$/.test(symbol) || !Number.isInteger(level) || level < 0) {
            throw new Error(`The carried monitor state has an invalid entry for ${symbol}`);
        }
    }
    return state;
}

async function loadPreviousAlertState() {
    const url = new URL(SNAPSHOT_URL);
    url.searchParams.set('v', Date.now());
    const response = await fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
    });

    if (response.status === 404) {
        return {};
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading the previous market snapshot`);
    }

    const snapshot = await response.json();
    if (!Array.isArray(snapshot.markets)) {
        throw new Error('The previous market snapshot has an invalid format');
    }
    return snapshot.alertState && typeof snapshot.alertState === 'object'
        ? snapshot.alertState
        : {};
}

async function loadCandles(symbol, startTime, endTime) {
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
        Number.isFinite(candle.time) &&
        candle.time >= startTime.getTime() - MINUTE_MS &&
        candle.time <= endTime.getTime() &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close)
    );

    if (candles.length === 0) {
        throw new Error(`Stobix returned no hourly candles for ${symbol}`);
    }
    return candles.sort((left, right) => left.time - right.time);
}

async function loadMarkets() {
    const payload = await fetchJson(`${API_URL}/v1/futures/markets`);
    if (!Array.isArray(payload)) {
        throw new Error('Stobix returned an invalid futures markets list');
    }

    const { eligible, excluded } = filterMarketsByCommission(payload);
    const symbols = eligible.map((market) => market.symbol);
    if (excluded.length > 0) {
        console.log(
            `Excluded ${excluded.length} market(s) with per-side commission above 0.1%: ` +
            excluded.map((market) => market.symbol.replace('/', '')).join(', ')
        );
    }

    const rates = await fetchJson(`${API_URL}/v1/rates?product=FUTURES`);
    if (!Array.isArray(rates)) {
        throw new Error('Stobix returned an invalid futures rates list');
    }

    const ratesBySymbol = new Map(rates.map((rate) => [rate.s, rate]));
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 60 * MINUTE_MS);
    const initialized = await mapWithConcurrency(
        symbols,
        REQUEST_CONCURRENCY,
        async (symbol) => {
            try {
                const candles = await loadCandles(symbol, startTime, endTime);
                const rate = ratesBySymbol.get(symbol);
                return {
                    symbol: normalizeSymbol(symbol),
                    candles,
                    currentPrice: rate && Number.isFinite(Number(rate.p))
                        ? Number(rate.p)
                        : candles[candles.length - 1].close,
                    lastUpdate: Date.now()
                };
            } catch (error) {
                console.warn(`Unable to initialize ${symbol}: ${error.message}`);
                return null;
            }
        }
    );

    const markets = initialized.filter(Boolean);
    if (markets.length !== symbols.length) {
        const unavailableSymbols = initialized.flatMap((market, index) =>
            market ? [] : [symbols[index]]
        );
        throw new Error(
            `Unable to initialize hourly candles for ${unavailableSymbols.length} market(s): ` +
            unavailableSymbols.join(', ')
        );
    }

    console.log(`Initialized ${markets.length}/${symbols.length} markets with hourly candles.`);
    return { markets, symbols };
}

function getCurrentMarketData(markets, now) {
    return markets.map((market) => {
        const candles = pruneCandles(market.candles, now)
            .filter((candle) =>
                candle.time >= Math.floor((now - 60 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS
            );
        return {
            symbol: market.symbol,
            current_price: market.currentPrice,
            volatilityValue: calculateVolatility(candles),
            priceChangePercent: candles.length && candles[0].open > 0
                ? ((market.currentPrice - candles[0].open) / candles[0].open) * 100
                : null
        };
    });
}

function handleRatesUpdate(message, marketsBySymbol, onUpdate) {
    if (!message || !message.d || typeof message.d !== 'object') {
        console.warn('Ignoring malformed Stobix rates event.');
        return 0;
    }

    let updated = 0;
    for (const [symbol, rate] of Object.entries(message.d)) {
        if (!rate || typeof rate !== 'object') {
            continue;
        }
        const market = marketsBySymbol.get(normalizeSymbol(symbol));
        const price = Number(rate.p);
        if (!market || !Number.isFinite(price) || price <= 0) {
            continue;
        }

        const timestamp = typeof rate.t === 'string' && Number.isFinite(Date.parse(rate.t))
            ? Date.parse(rate.t)
            : Date.now();
        addPriceToCandles(market.candles, timestamp, price);
        market.candles = pruneCandles(market.candles, Date.now());
        market.currentPrice = price;
        market.lastUpdate = timestamp;
        updated += 1;
    }

    if (updated) {
        onUpdate(updated);
    }
    return updated;
}

function connectRatesSocket(symbols, marketsBySymbol) {
    const socket = io(API_URL, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30_000,
        timeout: 20_000
    });

    let firstConnection;
    const connected = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timed out connecting to the Stobix rates WebSocket'));
        }, 120_000);
        firstConnection = () => {
            clearTimeout(timeout);
            resolve();
        };
    });

    socket.on('connect', () => {
        console.log('Connected to Stobix rates WebSocket.');
        socket.emit('subscribe', {
            channel: 'rates',
            params: { product: 'FUTURES', symbols }
        });
        if (firstConnection) {
            firstConnection();
            firstConnection = null;
        }
    });
    socket.on('disconnect', (reason) => {
        console.warn(`Stobix WebSocket disconnected: ${reason}`);
    });
    socket.on('connect_error', (error) => {
        console.warn(`Stobix WebSocket connection failed: ${error.message}`);
    });

    let lastStatusLogAt = 0;
    socket.on('rates', (message) => {
        handleRatesUpdate(message, marketsBySymbol, (count) => {
            const now = Date.now();
            if (count > 0 && now - lastStatusLogAt >= 60_000) {
                console.log(`Received Stobix rate updates for ${count} market(s).`);
                lastStatusLogAt = now;
            }
        });
    });
    socket.connect();

    return {
        socket,
        connected
    };
}

async function sendTelegramAlerts(alerts) {
    if (alerts.length === 0) {
        return;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        throw new Error('Telegram secrets are missing; configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
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
            signal: AbortSignal.timeout(15_000)
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) {
            throw new Error(`Telegram rejected alert delivery: ${result.description || `HTTP ${response.status}`}`);
        }
    }

    console.log(`Sent ${alerts.length} Telegram volatility threshold alert(s).`);
}

async function dispatchNextRun(alertState) {
    if (process.env.GITHUB_ACTIONS !== 'true') {
        console.log('Not running in GitHub Actions; automatic workflow continuation skipped.');
        return;
    }

    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const ref = process.env.GITHUB_REF_NAME;
    if (!token || !repository || !ref) {
        throw new Error('GitHub workflow continuation requires GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_REF_NAME');
    }

    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const apiUrl = process.env.GITHUB_API_URL || `${serverUrl}/api/v3`;
    const response = await fetch(
        `${apiUrl}/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ref,
                inputs: {
                    carry_state: Buffer.from(JSON.stringify(alertState)).toString('base64')
                }
            }),
            signal: AbortSignal.timeout(15_000)
        }
    );
    if (!response.ok) {
        throw new Error(`GitHub rejected the next monitor run: HTTP ${response.status} ${await response.text()}`);
    }
    console.log('Queued the next GitHub Actions monitor run.');
}

async function runMonitor() {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        throw new Error('Telegram secrets are missing; configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }
    const duration = Number(process.env.MONITOR_DURATION_MS || DEFAULT_MONITOR_DURATION_MS);
    if (!Number.isFinite(duration) || duration < MINUTE_MS) {
        throw new Error('MONITOR_DURATION_MS must be at least 60,000 milliseconds');
    }

    let alertState = parseCarriedState(process.env.CARRY_STATE);
    if (Object.keys(alertState).length === 0) {
        alertState = await loadPreviousAlertState();
    }

    const { markets, symbols } = await loadMarkets();
    const marketsBySymbol = new Map(markets.map((market) => [market.symbol, market]));
    const ratesSocket = connectRatesSocket(symbols, marketsBySymbol);
    try {
        await ratesSocket.connected;
    } catch (error) {
        ratesSocket.socket.disconnect();
        throw error;
    }

    try {
        console.log(`Checking hourly volatility once per minute for ${markets.length} markets.`);
        if (process.env.GITHUB_STEP_SUMMARY) {
            await fs.appendFile(
                process.env.GITHUB_STEP_SUMMARY,
                'Stobix WebSocket monitoring is active. Hourly volatility and Telegram thresholds are checked once per minute. ' +
                'This run will start a successor before the GitHub-hosted runner limit; cancel the active run to stop monitoring.\n'
            );
        }
        const deadline = Date.now() + duration;
        let nextCheck = Date.now();
        let pendingAlerts = [];

        while (Date.now() < deadline) {
            const now = Date.now();
            const currentMarkets = getCurrentMarketData(markets, now);
            const hasInitialState = Object.keys(alertState).length > 0;
            const fallbackLevels = {};
            if (!hasInitialState) {
                for (const market of currentMarkets) {
                    if (Number.isFinite(market.volatilityValue)) {
                        fallbackLevels[market.symbol] = Math.max(
                            FIRST_ALERT_THRESHOLD - 1,
                            Math.floor(market.volatilityValue)
                        );
                    }
                }
            }

            const { alertState: nextState, alerts } = advanceAlertState(
                currentMarkets,
                alertState,
                fallbackLevels,
                FIRST_ALERT_THRESHOLD
            );
            const pendingKeys = new Set(pendingAlerts.map((alert) => `${alert.symbol}:${alert.level}`));
            for (const alert of alerts) {
                const key = `${alert.symbol}:${alert.level}`;
                if (!pendingKeys.has(key)) {
                    pendingAlerts.push(alert);
                    pendingKeys.add(key);
                }
            }

            try {
                await sendTelegramAlerts(pendingAlerts);
                alertState = nextState;
                pendingAlerts = [];
            } catch (error) {
                console.error(`Telegram alert delivery failed; will retry next minute: ${error.message}`);
            }

            const staleMarkets = markets.filter((market) => now - market.lastUpdate > 3 * MINUTE_MS);
            if (staleMarkets.length) {
                console.warn(`${staleMarkets.length} market(s) have not received a recent Stobix rate update.`);
            }

            nextCheck += MINUTE_MS;
            if (nextCheck < Date.now()) {
                nextCheck = Date.now() + MINUTE_MS;
            }
            await delay(Math.min(nextCheck - Date.now(), Math.max(0, deadline - Date.now())));
        }
    } finally {
        ratesSocket.socket.disconnect();
    }

    await dispatchNextRun(alertState);
}

if (require.main === module) {
    runMonitor().catch((error) => {
        console.error('Stobix minute monitor failed:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    handleRatesUpdate,
    parseCarriedState,
    runMonitor
};
