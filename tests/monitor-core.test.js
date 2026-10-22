const test = require('node:test');
const assert = require('node:assert/strict');
const {
    addPriceToCandles,
    advanceAlertState,
    calculateVolatility,
    filterMarketsByCommission,
    formatTelegramAlert,
    getAlertSchedule,
    markAlertsSent,
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

test('selects alert schedules at exact commission group boundaries', () => {
    assert.deepEqual(
        [0.0001, 0.00049, 0.0005, 0.00099, 0.001].map(getAlertSchedule),
        [
            { id: 'low-v2', firstThresholdTicks: 75, stepTicks: 25 },
            { id: 'low-v2', firstThresholdTicks: 75, stepTicks: 25 },
            { id: 'medium-v2', firstThresholdTicks: 100, stepTicks: 50 },
            { id: 'medium-v2', firstThresholdTicks: 100, stepTicks: 50 },
            { id: 'high-v2', firstThresholdTicks: 150, stepTicks: 75 }
        ]
    );
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

test('alerts on successive thresholds for a 0.1% commission pair', () => {
    const result = advanceAlertState(
        [{
            symbol: 'BTCUSDT',
            current_price: 65000,
            commissionRate: 0.001,
            volatilityValue: 2.4,
            priceChangePercent: 1.5
        }],
        { BTCUSDT: { scheduleId: 'high-v2', levelTicks: 150 } }
    );
    assert.deepEqual(result.alerts.map((alert) => alert.level), [2.25]);
    assert.deepEqual(result.alertState.BTCUSDT, { scheduleId: 'high-v2', levelTicks: 225 });
    assert.match(
        result.alerts[0].message,
        /^🟢#BTCUSDT: 65000 BUY 2\.40% <a href="https:\/\/stobix\.com\/invite\/qdjlyh\?to=\/futures\/BTC\/USDT">open on stobix<\/a>$/
    );
});

test('alerts at 0.75% and then every 0.25% for low commission pairs', () => {
    const result = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 1, commissionRate: 0.0002, volatilityValue: 1.01 }],
        { BTCUSDT: { scheduleId: 'low-v2', levelTicks: 75 } }
    );
    assert.deepEqual(result.alerts.map((alert) => alert.level), [1]);
    assert.deepEqual(result.alertState.BTCUSDT, { scheduleId: 'low-v2', levelTicks: 100 });
});

test('alerts at 1% and then every 0.5% for medium commission pairs', () => {
    const result = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 1, commissionRate: 0.0006, volatilityValue: 2.1 }],
        { BTCUSDT: { scheduleId: 'medium-v2', levelTicks: 50 } }
    );
    assert.deepEqual(result.alerts.map((alert) => alert.level), [1]);
    assert.deepEqual(result.alertState.BTCUSDT, { scheduleId: 'medium-v2', levelTicks: 200 });
});

test('suppresses repeated same-direction alerts and allows the next opposite direction', () => {
    const market = {
        symbol: 'BTCUSDT',
        current_price: 65000,
        commissionRate: 0.001,
        volatilityValue: 3,
        priceChangePercent: 1
    };
    const first = advanceAlertState([market], {
        BTCUSDT: { scheduleId: 'high-v2', levelTicks: 150 }
    });
    assert.deepEqual(first.alerts.map((alert) => alert.level), [2.25]);
    const afterFirstSend = markAlertsSent(first.alertState, first.alerts);
    assert.equal(afterFirstSend.BTCUSDT.lastDirection, 'BUY');

    const repeatedBuy = advanceAlertState([{
        ...market,
        volatilityValue: 3.8
    }], afterFirstSend);
    assert.deepEqual(repeatedBuy.alerts, []);
    assert.equal(repeatedBuy.alertState.BTCUSDT.levelTicks, 375);
    assert.equal(repeatedBuy.alertState.BTCUSDT.lastDirection, 'BUY');

    const sell = advanceAlertState([{
        ...market,
        volatilityValue: 4.6,
        priceChangePercent: -0.2
    }], repeatedBuy.alertState);
    assert.deepEqual(sell.alerts.map((alert) => alert.level), [4.5]);
    const afterSell = markAlertsSent(sell.alertState, sell.alerts);
    assert.equal(afterSell.BTCUSDT.lastDirection, 'SELL');

    const repeatedSell = advanceAlertState([{
        ...market,
        volatilityValue: 5.4,
        priceChangePercent: -0.5
    }], afterSell);
    assert.deepEqual(repeatedSell.alerts, []);
    assert.equal(repeatedSell.alertState.BTCUSDT.lastDirection, 'SELL');
});

test('allows a new signal when direction changes back after an intervening opposite signal', () => {
    const market = {
        symbol: 'BTCUSDT',
        current_price: 1,
        commissionRate: 0.0005,
        volatilityValue: 1.5,
        priceChangePercent: -1
    };
    const previous = { BTCUSDT: { scheduleId: 'medium-v2', levelTicks: 100, lastDirection: 'BUY' } };
    const result = advanceAlertState([market], previous);

    assert.equal(result.alerts.length, 1);
    const afterSell = markAlertsSent(result.alertState, result.alerts);
    assert.equal(afterSell.BTCUSDT.lastDirection, 'SELL');

    const buyAgain = advanceAlertState([{
        ...market,
        volatilityValue: 2,
        priceChangePercent: 0.5
    }], afterSell);
    assert.equal(buyAgain.alerts.length, 1);
    assert.equal(markAlertsSent(buyAgain.alertState, buyAgain.alerts).BTCUSDT.lastDirection, 'BUY');
});

test('records a direction only after alerts have been confirmed sent', () => {
    const result = advanceAlertState([{
        symbol: 'BTCUSDT',
        current_price: 1,
        commissionRate: 0.001,
        volatilityValue: 1.5,
        priceChangePercent: 1
    }], { BTCUSDT: { scheduleId: 'high-v2', levelTicks: 75 } });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alertState.BTCUSDT.lastDirection, undefined);
    assert.equal(
        markAlertsSent(result.alertState, result.alerts).BTCUSDT.lastDirection,
        'BUY'
    );
});

test('rearms at the start of the schedule after volatility drops below its first threshold', () => {
    const dropped = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 1, commissionRate: 0.0002, volatilityValue: 0.74 }],
        { BTCUSDT: { scheduleId: 'low-v2', levelTicks: 75 } }
    );
    assert.deepEqual(dropped.alertState.BTCUSDT, { scheduleId: 'low-v2', levelTicks: 50 });
    const crossedAgain = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 1, commissionRate: 0.0002, volatilityValue: 0.75 }],
        dropped.alertState
    );
    assert.deepEqual(crossedAgain.alerts.map((alert) => alert.level), [0.75]);
});

test('does not emit catch-up alerts on startup or when commission group changes', () => {
    const result = advanceAlertState(
        [{ symbol: 'BTCUSDT', current_price: 1, commissionRate: 0.0006, volatilityValue: 1.26 }],
        { BTCUSDT: { scheduleId: 'low-v2', levelTicks: 120 } }
    );
    assert.deepEqual(result.alerts, []);
    assert.deepEqual(result.alertState.BTCUSDT, { scheduleId: 'medium-v2', levelTicks: 100 });
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
        parseCarriedState('{"BTCUSDT":{"scheduleId":"low-v2","levelTicks":50,"lastDirection":"BUY"}}'),
        { BTCUSDT: { scheduleId: 'low-v2', levelTicks: 50, lastDirection: 'BUY' } }
    );
    assert.deepEqual(
        parseCarriedState(Buffer.from('{"BTCUSDT":3}').toString('base64')),
        { BTCUSDT: 3 }
    );
    assert.throws(() => parseCarriedState('not-json'), /invalid JSON/);
    assert.throws(() => parseCarriedState('{"BTCUSDT":1.5}'), /invalid entry/);
    assert.throws(
        () => parseCarriedState('{"BTCUSDT":{"scheduleId":"low-v2","levelTicks":1.5}}'),
        /invalid entry/
    );
    assert.throws(
        () => parseCarriedState('{"BTCUSDT":{"scheduleId":"low-v2","levelTicks":50,"lastDirection":"UP"}}'),
        /invalid entry/
    );
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
