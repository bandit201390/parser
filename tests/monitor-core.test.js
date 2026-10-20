const test = require('node:test');
const assert = require('node:assert/strict');
const {
    addPriceToCandles,
    advanceAlertState,
    calculateVolatility,
    filterMarketsByCommission,
    formatTelegramAlert,
    pruneCandles
} = require('../scripts/monitor-core');
const { handleRatesUpdate, parseCarriedState } = require('../scripts/monitor');

test('calculates high-low volatility relative to the first candle open', () => {
    assert.ok(Math.abs(calculateVolatility([
        { open: 100, high: 102, low: 99 },
        { open: 101, high: 105, low: 98 }
    ]) - 7) < 1e-10);
});

test('returns null when candle data is missing or invalid', () => {
    assert.equal(calculateVolatility([]), null);
    assert.equal(calculateVolatility([{ open: 0, high: 1, low: 0 }]), null);
});

test('excludes pairs only when any LONG/SHORT entry/close commission exceeds 0.1%', () => {
    const makeMarket = (symbol, longEntry, longClose, shortEntry, shortClose) => ({
        symbol,
        markets: [
            { direction: 'LONG', entryFee: String(longEntry), closeFee: String(longClose) },
            { direction: 'SHORT', entryFee: String(shortEntry), closeFee: String(shortClose) }
        ]
    });
    const result = filterMarketsByCommission([
        makeMarket('KEEP/USDT', 0.001, 0.001, 0.0005, 0.001),
        makeMarket('DROP/USDT', 0.0005, 0.0005, 0.0011, 0.0005),
        makeMarket('DROP2/USDT', 0.0005, 0.0011, 0.0005, 0.0005),
        makeMarket('XAU/USD', 0.01, 0.01, 0.01, 0.01)
    ]);

    assert.deepEqual(result.eligible.map((market) => market.symbol), ['KEEP/USDT']);
    assert.deepEqual(result.excluded.map((market) => market.symbol), ['DROP/USDT', 'DROP2/USDT']);
});

test('fails explicitly when market commission data is missing or invalid', () => {
    assert.throws(() => filterMarketsByCommission([{
        symbol: 'BTC/USDT',
        markets: [{ direction: 'LONG', entryFee: '0.001', closeFee: '0.001' }]
    }]), /incomplete LONG\/SHORT/);
    assert.throws(() => filterMarketsByCommission([{
        symbol: 'BTC/USDT',
        markets: [
            { direction: 'LONG', entryFee: 'not-a-fee', closeFee: '0.001' },
            { direction: 'SHORT', entryFee: '0.001', closeFee: '0.001' }
        ]
    }]), /invalid commission values/);
});

test('updates a minute candle with incoming prices', () => {
    const candles = [{ time: 60_000, open: 100, high: 101, low: 99, close: 100 }];
    addPriceToCandles(candles, 119_000, 102);
    assert.deepEqual(candles[0], {
        time: 60_000,
        open: 100,
        high: 102,
        low: 99,
        close: 102
    });

    addPriceToCandles(candles, 120_000, 103);
    assert.equal(candles.length, 2);
    assert.equal(candles[1].open, 103);
});

test('retains only candles in the rolling hourly window', () => {
    const candles = [
        { time: 58 * 60_000 },
        { time: 59 * 60_000 },
        { time: 60 * 60_000 },
        { time: 120 * 60_000 }
    ];
    assert.deepEqual(pruneCandles(candles, 120 * 60_000).map((candle) => candle.time), [
        59 * 60_000,
        60 * 60_000,
        120 * 60_000
    ]);
});

test('alerts on each newly reached whole-percent level', () => {
    const result = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 65000, volatilityValue: 4.2, priceChangePercent: 1.5 }],
        { BTCUSDT: 1 }
    );
    assert.deepEqual(result.alerts.map((alert) => alert.level), [2, 3, 4]);
    assert.equal(result.alertState.BTCUSDT, 4);
    assert.match(
        result.alerts[0].message,
        /^🟢#BTCUSDT: 65000 BUY 4\.20% <a href="https:\/\/stobix\.com\/invite\/qdjlyh\?to=\/futures\/BTC\/USDT">open on stobix<\/a>$/
    );
});

test('does not repeat reached levels and rearms below the first threshold', () => {
    const atThreshold = advanceAlertState(
        [{ symbol: 'BTCUSDT', volatilityValue: 3.8 }],
        { BTCUSDT: 3 }
    );
    assert.deepEqual(atThreshold.alerts, []);

    const belowThreshold = advanceAlertState(
        [{ symbol: 'BTCUSDT', volatilityValue: 1.9 }],
        { BTCUSDT: 3 }
    );
    assert.equal(belowThreshold.alertState.BTCUSDT, 1);

    const crossedAgain = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 1, volatilityValue: 2 }],
        belowThreshold.alertState
    );
    assert.deepEqual(crossedAgain.alerts.map((alert) => alert.level), [2]);
});

test('uses a supplied fallback level to avoid startup alerts', () => {
    const result = advanceAlertState(
        [{ symbol: 'BTCUSDT', volatilityValue: 5.1 }],
        {},
        { BTCUSDT: 5 }
    );
    assert.deepEqual(result.alerts, []);
    assert.equal(result.alertState.BTCUSDT, 5);
});

test('formats Telegram alerts with the requested short English text and linked Stobix label', () => {
    const message = formatTelegramAlert({
        symbol: 'FILUSDT',
        current_price: 5.9032,
        volatilityValue: 2.09,
        priceChangePercent: -0.4
    }, 2);

    assert.equal(
        message,
        '🔴#FILUSDT: 5.9032 SELL 2.09% ' +
        '<a href="https://stobix.com/invite/qdjlyh?to=/futures/FIL/USDT">open on stobix</a>'
    );
});

test('uses a neutral indicator when the hourly net price change is zero or unavailable', () => {
    const unchanged = formatTelegramAlert({
        symbol: 'ETHUSDT',
        current_price: 2500,
        volatilityValue: 2,
        priceChangePercent: 0
    }, 2);
    const unavailable = formatTelegramAlert({
        symbol: 'ETHUSDT',
        current_price: 2500,
        volatilityValue: 2,
        priceChangePercent: null
    }, 2);

    assert.match(unchanged, /^⚪#ETHUSDT: 2500 1h volatility/);
    assert.match(unavailable, /^⚪#ETHUSDT: 2500 1h volatility/);
});

test('escapes dynamic values in linked Telegram alerts', () => {
    const message = formatTelegramAlert({
        symbol: 'A&BUSDT',
        current_price: 0.000042,
        volatilityValue: 2.5,
        priceChangePercent: 1
    }, 2);

    assert.match(message, /stobix\.com\/invite\/qdjlyh\?to=\/futures\/A%26B\/USDT/);
    assert.match(message, /#A&amp;BUSDT: 0\.000042 BUY 2\.50%/);
    assert.match(message, /<a href="https:\/\/stobix\.com\/invite\/qdjlyh\?to=\/futures\/A%26B\/USDT">open on stobix<\/a>/);
});

test('parses carried alert state and rejects malformed state', () => {
    assert.deepEqual(parseCarriedState('{"BTCUSDT":3}'), { BTCUSDT: 3 });
    assert.deepEqual(
        parseCarriedState(Buffer.from('{"BTCUSDT":3}').toString('base64')),
        { BTCUSDT: 3 }
    );
    assert.throws(() => parseCarriedState('not-json'), /invalid JSON/);
    assert.throws(() => parseCarriedState('{"BTCUSDT":1.5}'), /invalid entry/);
});

test('applies Stobix WebSocket rate updates to the matching market candle', () => {
    const timestamp = Date.now();
    const minute = Math.floor(timestamp / 60_000) * 60_000;
    const market = {
        symbol: 'BTCUSDT',
        candles: [{ time: minute, open: 100, high: 100, low: 100, close: 100 }],
        currentPrice: 100,
        lastUpdate: timestamp
    };
    const updates = [];
    const count = handleRatesUpdate({
        d: {
            'BTC/USDT': { p: '103.5', t: new Date(timestamp).toISOString() },
            'NOT-A-MARKET/USDT': { p: '1', t: new Date(timestamp).toISOString() }
        }
    }, new Map([['BTCUSDT', market]]), (updated) => updates.push(updated));

    assert.equal(count, 1);
    assert.equal(market.currentPrice, 103.5);
    assert.equal(market.candles[0].high, 103.5);
    assert.equal(market.candles[0].close, 103.5);
    assert.deepEqual(updates, [1]);
});
