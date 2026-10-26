const test = require('node:test');
const assert = require('node:assert/strict');
const {
    formatSignalAlert,
    getLatestSignal,
    rankMarketsByDailyVolatility,
    updateCandleWithPrice
} = require('../scripts/strategy-core');
const { parseRateTimestamp, parseState } = require('../scripts/strategy-monitor');

test('returns no signal until ZLSMA has enough candle history', () => {
    assert.equal(getLatestSignal(Array.from({ length: 99 }, (_, index) => ({
        time: index * 300_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100
    }))), null);
});

test('does not signal on a steady uptrend', () => {
    const candles = Array.from({ length: 150 }, (_, index) => {
        const close = 100 + index;
        return {
            time: index * 300_000,
            open: close - 0.5,
            high: close + 1,
            low: close - 1,
            close
        };
    });
    assert.equal(getLatestSignal(candles), null);
});

test('detects filtered BUY and SELL direction changes on candle close', () => {
    const makeCandles = (closes) => closes.map((close, index) => ({
        time: index * 300_000,
        open: close,
        high: close + 0.2,
        low: close - 0.2,
        close
    }));
    const rising = Array.from({ length: 120 }, (_, index) => 100 + index * 0.1);
    const falling = Array.from({ length: 50 }, (_, index) => 112 - index);

    assert.equal(
        getLatestSignal(makeCandles([...rising, ...falling, 200])).direction,
        'BUY'
    );
    assert.equal(
        getLatestSignal(makeCandles([...rising, 50])).direction,
        'SELL'
    );
});

test('closes one candle when price updates move into the next interval', () => {
    const current = { time: 0, open: 10, high: 12, low: 9, close: 11 };
    const result = updateCandleWithPrice(current, 300_000, 13, 300_000);
    assert.deepEqual(result, {
        candle: { time: 300_000, open: 13, high: 13, low: 13, close: 13 },
        closedCandle: current
    });
});

test('ranks only pairs with a complete 24h of 5m candles by high-low percentage', () => {
    const makeMarket = (symbol, range, count = 288) => ({
        symbol,
        candles: Array.from({ length: count }, (_, index) => ({
            time: (index - 288) * 300_000,
            open: 100,
            high: 100 + range,
            low: 100,
            close: 100
        }))
    });
    const result = rankMarketsByDailyVolatility([
        makeMarket('LOWUSDT', 1),
        makeMarket('HIGHUSDT', 5),
        makeMarket('MIDUSDT', 3),
        makeMarket('NEWUSDT', 8, 100)
    ], 0, 2);

    assert.deepEqual(result.ranked.map((market) => market.symbol), ['HIGHUSDT', 'MIDUSDT']);
    assert.deepEqual(result.ranked.map((market) => market.dailyVolatilityPct), [5, 3]);
    assert.deepEqual(result.incomplete, ['NEWUSDT']);
});

test('breaks equal daily-volatility rankings by symbol', () => {
    const candles = Array.from({ length: 288 }, (_, index) => ({
        time: (index - 288) * 300_000,
        open: 100,
        high: 102,
        low: 100,
        close: 101
    }));
    const result = rankMarketsByDailyVolatility([
        { symbol: 'ZZZUSDT', candles },
        { symbol: 'AAAUSDT', candles }
    ], 0);
    assert.deepEqual(result.ranked.map((market) => market.symbol), ['AAAUSDT', 'ZZZUSDT']);
});

test('formats a linked BUY or SELL alert with the signal candle close', () => {
    assert.equal(
        formatSignalAlert('BTCUSDT', { direction: 'BUY', close: 65000 }),
        '🟢 ZLSMACE BUY #BTCUSDT | 5m close: 65000 | ' +
        '<a href="https://stobix.com/invite/qdjlyh?to=/futures/BTC/USDT">open on stobix</a>'
    );
});

test('parses carried monitor state and rejects invalid symbols or alerts', () => {
    assert.deepEqual(parseState('{}'), { lastProcessed: {}, pendingAlerts: [] });
    const carried = {
        lastProcessed: { BTCUSDT: 300_000 },
        pendingAlerts: [{
            symbol: 'ETHUSDT',
            direction: 'SELL',
            time: 600_000,
            message: 'alert'
        }]
    };
    assert.deepEqual(parseState(Buffer.from(JSON.stringify(carried)).toString('base64')), carried);
    assert.throws(() => parseState(JSON.stringify({
        lastProcessed: { 'BTC/USD': 300_000 },
        pendingAlerts: []
    })), /invalid entry/);
});

test('normalizes Stobix rate timestamps in seconds and milliseconds', () => {
    assert.equal(parseRateTimestamp(1_700_000_000), 1_700_000_000_000);
    assert.equal(parseRateTimestamp(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(parseRateTimestamp('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
});
