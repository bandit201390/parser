const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const { filterMarketsByCommission } = require('./monitor-core');
const {
    formatSignalAlert,
    getLatestSignal,
    rankMarketsByDailyVolatility,
    updateCandleWithPrice
} = require('./strategy-core');

const API_URL = 'https://api.stobix.com';
const WORKFLOW_FILE = 'monitor-zlsmace.yml';
const INTERVAL = '5m';
const INTERVAL_MS = 5 * 60_000;
const HISTORY_BARS = 500;
const REQUEST_CONCURRENCY = 4;
const RETRIES = 4;
const DEFAULT_MONITOR_DURATION_MS = 340 * 60_000;

async function fetchJson(url, timeoutMs = 20_000) {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (response.ok) return await response.json();
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
            if (attempt === RETRIES || /^HTTP \d/.test(error.message)) throw error;
            await delay(1000 * (attempt + 1));
        }
    }
    throw new Error('Stobix request failed after retries');
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await mapper(items[index]);
            }
        }
    ));
    return results;
}

function normalizeSymbol(symbol) {
    return symbol.replace('/', '').toUpperCase();
}

function parseRateTimestamp(value) {
    if (typeof value === 'string') {
        const parsedDate = Date.parse(value);
        if (Number.isFinite(parsedDate)) return parsedDate;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return Date.now();
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function parseState(value) {
    if (!value) return { lastProcessed: {}, pendingAlerts: [] };
    let state;
    try {
        const text = value.trim();
        state = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
    } catch (error) {
        throw new Error(`The carried ZLSMACE state is invalid JSON: ${error.message}`);
    }
    if (state && typeof state === 'object' && !Array.isArray(state) &&
        Object.keys(state).length === 0) {
        return { lastProcessed: {}, pendingAlerts: [] };
    }
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        !state.lastProcessed || typeof state.lastProcessed !== 'object' ||
        Array.isArray(state.lastProcessed) || !Array.isArray(state.pendingAlerts)) {
        throw new Error('The carried ZLSMACE state has an invalid format');
    }
    for (const [symbol, timestamp] of Object.entries(state.lastProcessed)) {
        if (!/^[A-Z0-9]+USDT$/.test(symbol) || !Number.isFinite(timestamp)) {
            throw new Error(`The carried ZLSMACE state has an invalid entry for ${symbol}`);
        }
    }
    for (const alert of state.pendingAlerts) {
        if (!alert || !/^[A-Z0-9]+USDT$/.test(alert.symbol) ||
            !['BUY', 'SELL'].includes(alert.direction) ||
            !Number.isFinite(alert.time) || typeof alert.message !== 'string') {
            throw new Error('The carried ZLSMACE state has an invalid pending alert');
        }
    }
    return state;
}

async function loadCandles(symbol, startTime, endTime) {
    const query = new URLSearchParams({
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        symbol,
        interval: INTERVAL
    });
    const payload = await fetchJson(`${API_URL}/v1/rates/candles?${query}`);
    if (payload.s !== 'ok' || !Array.isArray(payload.t) ||
        !Array.isArray(payload.o) || !Array.isArray(payload.h) ||
        !Array.isArray(payload.l) || !Array.isArray(payload.c)) {
        throw new Error(`Stobix returned invalid ${INTERVAL} candles for ${symbol}`);
    }
    return payload.t.map((timestamp, index) => ({
        time: Number(timestamp) * 1000,
        open: Number(payload.o[index]),
        high: Number(payload.h[index]),
        low: Number(payload.l[index]),
        close: Number(payload.c[index])
    })).filter((candle) =>
        Number.isFinite(candle.time) &&
        [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    ).sort((left, right) => left.time - right.time);
}

async function loadMarkets(lastProcessed) {
    const payload = await fetchJson(`${API_URL}/v1/futures/markets`);
    if (!Array.isArray(payload)) throw new Error('Stobix returned an invalid futures markets list');
    const { eligible, excluded } = filterMarketsByCommission(payload);
    const symbols = eligible.map((market) => market.symbol);
    if (excluded.length) {
        console.log(`Excluded ${excluded.length} pair(s) above the 0.1% commission limit.`);
    }

    const now = Date.now();
    const currentBucket = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
    const startTime = new Date(now - HISTORY_BARS * INTERVAL_MS);
    const endTime = new Date(now);
    const rates = await fetchJson(`${API_URL}/v1/rates?product=FUTURES`);
    if (!Array.isArray(rates)) throw new Error('Stobix returned an invalid futures rates list');
    const ratesBySymbol = new Map(rates.map((rate) => [rate.s, rate]));
    const initialized = await mapWithConcurrency(symbols, REQUEST_CONCURRENCY, async (symbol) => {
        const candles = await loadCandles(symbol, startTime, endTime);
        const closedCandles = candles.filter((candle) => candle.time < currentBucket);
        if (closedCandles.length < 2 * 50) {
            throw new Error(`Stobix returned too few historical candles for ${symbol}`);
        }
        const marketSymbol = normalizeSymbol(symbol);
        const lastClosedTime = closedCandles[closedCandles.length - 1].time;
        if (lastProcessed[marketSymbol] === undefined) {
            lastProcessed[marketSymbol] = lastClosedTime;
        }
        const rate = ratesBySymbol.get(symbol);
        const currentPrice = Number(rate && rate.p);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            throw new Error(`Stobix returned no valid current price for ${symbol}`);
        }
        const currentCandle = candles.find((candle) => candle.time === currentBucket) || {
            time: currentBucket,
            open: currentPrice,
            high: currentPrice,
            low: currentPrice,
            close: currentPrice
        };
        return {
            symbol: marketSymbol,
            apiSymbol: symbol,
            candles: closedCandles,
            currentCandle,
            lastUpdate: now
        };
    });
    const { ranked, incomplete } = rankMarketsByDailyVolatility(initialized, currentBucket);
    if (incomplete.length) {
        console.log(
            `Excluded ${incomplete.length} pair(s) without a complete contiguous 24h of 5m candles: ` +
            incomplete.join(', ')
        );
    }
    if (ranked.length === 0) {
        throw new Error('No eligible USDT futures pairs have a complete 24h of 5m candles');
    }
    console.log(
        `Selected top ${ranked.length} of ${initialized.length} eligible pairs by 24h range: ` +
        ranked.map((market) => `${market.symbol} ${market.dailyVolatilityPct.toFixed(2)}%`).join(', ')
    );
    return { markets: ranked, symbols: ranked.map((market) => market.apiSymbol) };
}

function connectRatesSocket(symbols, marketsBySymbol, onClosedCandle) {
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
        const timeout = setTimeout(() => reject(
            new Error('Timed out connecting to the Stobix rates WebSocket')
        ), 120_000);
        firstConnection = () => {
            clearTimeout(timeout);
            resolve();
        };
    });
    socket.on('connect', () => {
        socket.emit('subscribe', { channel: 'rates', params: { product: 'FUTURES', symbols } });
        if (firstConnection) {
            firstConnection();
            firstConnection = null;
        }
        console.log('Connected to Stobix rates WebSocket.');
    });
    socket.on('disconnect', (reason) => console.warn(`Stobix WebSocket disconnected: ${reason}`));
    socket.on('connect_error', (error) => console.warn(`Stobix WebSocket error: ${error.message}`));
    socket.on('rates', (message) => {
        if (!message || !message.d || typeof message.d !== 'object') return;
        for (const [symbol, rate] of Object.entries(message.d)) {
            const market = marketsBySymbol.get(normalizeSymbol(symbol));
            const price = Number(rate && rate.p);
            if (!market || !Number.isFinite(price) || price <= 0) continue;
            const timestamp = parseRateTimestamp(rate.t);
            const update = updateCandleWithPrice(
                market.currentCandle,
                timestamp,
                price,
                INTERVAL_MS
            );
            market.currentCandle = update.candle;
            market.lastUpdate = timestamp;
            if (!update.closedCandle) continue;
            market.candles.push(update.closedCandle);
            if (market.candles.length > HISTORY_BARS) market.candles.shift();
            onClosedCandle(market, update.closedCandle);
        }
    });
    socket.connect();
    return { socket, connected };
}

async function sendTelegramAlert(alert) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error('Telegram secrets are missing');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: alert.message,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true }
        }),
        signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
        throw new Error(`Telegram rejected ZLSMACE alert: ${result.description || `HTTP ${response.status}`}`);
    }
}

async function dispatchNextRun(state) {
    if (process.env.GITHUB_ACTIONS !== 'true') {
        console.log('Not running in GitHub Actions; automatic workflow continuation skipped.');
        return;
    }
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const ref = process.env.GITHUB_REF_NAME;
    if (!token || !repository || !ref) {
        throw new Error('Workflow continuation requires GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_REF_NAME');
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
                inputs: { carry_state: Buffer.from(JSON.stringify(state)).toString('base64') }
            }),
            signal: AbortSignal.timeout(15_000)
        }
    );
    if (!response.ok) {
        throw new Error(`GitHub rejected the next strategy monitor run: HTTP ${response.status} ${await response.text()}`);
    }
}

async function runMonitor() {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        throw new Error('Telegram secrets are missing; configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }
    const duration = Number(process.env.MONITOR_DURATION_MS || DEFAULT_MONITOR_DURATION_MS);
    if (!Number.isFinite(duration) || duration < 60_000) {
        throw new Error('MONITOR_DURATION_MS must be at least 60,000 milliseconds');
    }
    const state = parseState(process.env.CARRY_STATE);
    const { markets, symbols } = await loadMarkets(state.lastProcessed);
    const marketsBySymbol = new Map(markets.map((market) => [market.symbol, market]));
    const ratesSocket = connectRatesSocket(symbols, marketsBySymbol, (market, candle) => {
        if (candle.time <= state.lastProcessed[market.symbol]) return;
        const signal = getLatestSignal([...market.candles]);
        state.lastProcessed[market.symbol] = candle.time;
        if (!signal) return;
        const alert = {
            symbol: market.symbol,
            direction: signal.direction,
            time: signal.time,
            message: formatSignalAlert(market.symbol, {
                ...signal,
                entryPrice: market.currentCandle.open
            })
        };
        if (!state.pendingAlerts.some((item) =>
            item.symbol === alert.symbol && item.time === alert.time
        )) {
            state.pendingAlerts.push(alert);
        }
    });
    try {
        await ratesSocket.connected;
    } catch (error) {
        ratesSocket.socket.disconnect();
        throw error;
    }

    try {
        console.log(`Monitoring the top ${markets.length} USDT futures pairs by 24h volatility for 5m ZLSMACE signals.`);
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) {
            if (state.pendingAlerts.length) {
                for (const alert of [...state.pendingAlerts]) {
                    try {
                        await sendTelegramAlert(alert);
                        state.pendingAlerts = state.pendingAlerts.filter((item) =>
                            item.symbol !== alert.symbol || item.time !== alert.time
                        );
                        console.log(`Sent ${alert.direction} signal for ${alert.symbol}.`);
                    } catch (error) {
                        console.error(`Telegram delivery failed; will retry: ${error.message}`);
                        break;
                    }
                }
            }
            await delay(Math.min(10_000, Math.max(0, deadline - Date.now())));
        }
    } finally {
        ratesSocket.socket.disconnect();
    }
    await dispatchNextRun(state);
}

if (require.main === module) {
    runMonitor().catch((error) => {
        console.error('Stobix ZLSMACE monitor failed:', error);
        process.exitCode = 1;
    });
}

module.exports = { parseRateTimestamp, parseState, runMonitor };
