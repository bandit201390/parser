const ZLSMA_LENGTH = 50;
const ATR_MULTIPLIER = 2;
const MAX_COUNTER_SLOPE = 0.05;
const STRATEGY_INTERVAL_MS = 5 * 60_000;
const DAILY_VOLATILITY_MS = 24 * 60 * 60_000;

function linearRegression(values, length) {
    if (values.length < length) return null;

    const window = values.slice(-length);
    const meanX = (length - 1) / 2;
    const meanY = window.reduce((sum, value) => sum + value, 0) / length;
    let covariance = 0;
    let variance = 0;
    for (let index = 0; index < length; index += 1) {
        covariance += (index - meanX) * (window[index] - meanY);
        variance += (index - meanX) ** 2;
    }
    const slope = covariance / variance;
    return meanY + slope * ((length - 1) - meanX);
}

function getZlsmaValues(candles) {
    const closes = candles.map((candle) => candle.close);
    const lsma = closes.map((_, index) => linearRegression(closes.slice(0, index + 1), ZLSMA_LENGTH));
    const lsma2 = [];
    const zlsma = [];

    for (let index = 0; index < lsma.length; index += 1) {
        if (lsma[index] === null) {
            lsma2.push(null);
            zlsma.push(null);
            continue;
        }
        const value = linearRegression(lsma.slice(0, index + 1), ZLSMA_LENGTH);
        lsma2.push(value);
        zlsma.push(value === null ? null : 2 * lsma[index] - value);
    }
    return zlsma;
}

function getLatestSignal(candles) {
    if (candles.length < ZLSMA_LENGTH * 2) return null;

    const zlsma = getZlsmaValues(candles);
    let direction = 1;
    let longStopPrevious = null;
    let shortStopPrevious = null;
    let previousDirection = null;
    let signal = null;

    for (let index = 0; index < candles.length; index += 1) {
        const candle = candles[index];
        const previousClose = index > 0 ? candles[index - 1].close : null;
        const trueRange = previousClose === null
            ? candle.high - candle.low
            : Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - previousClose),
                Math.abs(candle.low - previousClose)
            );
        let longStop = candle.close - ATR_MULTIPLIER * trueRange;
        const currentLongStopPrevious = longStopPrevious ?? longStop;
        if (previousClose !== null && previousClose > currentLongStopPrevious) {
            longStop = Math.max(longStop, currentLongStopPrevious);
        }

        let shortStop = candle.close + ATR_MULTIPLIER * trueRange;
        const currentShortStopPrevious = shortStopPrevious ?? shortStop;
        if (previousClose !== null && previousClose < currentShortStopPrevious) {
            shortStop = Math.min(shortStop, currentShortStopPrevious);
        }

        previousDirection = direction;
        direction = candle.close > currentShortStopPrevious
            ? 1
            : candle.close < currentLongStopPrevious
                ? -1
                : direction;

        const slopePct = index > 0 && zlsma[index - 1] !== null &&
            zlsma[index - 1] !== 0 && zlsma[index] !== null
            ? ((zlsma[index] - zlsma[index - 1]) / zlsma[index - 1]) * 100
            : null;
        const buy = direction === 1 && previousDirection === -1 &&
            zlsma[index] !== null && slopePct !== null &&
            candle.close > zlsma[index] && slopePct >= -MAX_COUNTER_SLOPE;
        const sell = direction === -1 && previousDirection === 1 &&
            zlsma[index] !== null && slopePct !== null &&
            candle.close < zlsma[index] && slopePct <= MAX_COUNTER_SLOPE;
        signal = buy ? 'BUY' : sell ? 'SELL' : null;

        longStopPrevious = longStop;
        shortStopPrevious = shortStop;
    }

    return signal ? {
        direction: signal,
        close: candles[candles.length - 1].close,
        time: candles[candles.length - 1].time
    } : null;
}

function rankMarketsByDailyVolatility(markets, endTime, limit = 10) {
    if (!Array.isArray(markets) || !Number.isFinite(endTime) ||
        !Number.isInteger(limit) || limit < 1) {
        throw new Error('Cannot rank markets by daily volatility: invalid input');
    }

    const startTime = endTime - DAILY_VOLATILITY_MS;
    const candleCount = DAILY_VOLATILITY_MS / STRATEGY_INTERVAL_MS;
    const ranked = [];
    const incomplete = [];

    for (const market of markets) {
        const candles = market.candles.filter((candle) =>
            candle.time >= startTime && candle.time < endTime
        );
        const completeHistory = candles.length === candleCount &&
            candles.every((candle, index) =>
                candle.time === startTime + index * STRATEGY_INTERVAL_MS
            );
        if (!completeHistory || candles[0].open <= 0) {
            incomplete.push(market.symbol);
            continue;
        }

        const high = Math.max(...candles.map((candle) => candle.high));
        const low = Math.min(...candles.map((candle) => candle.low));
        ranked.push({
            ...market,
            dailyVolatilityPct: ((high - low) / candles[0].open) * 100
        });
    }

    ranked.sort((left, right) =>
        right.dailyVolatilityPct - left.dailyVolatilityPct ||
        left.symbol.localeCompare(right.symbol)
    );
    return { ranked: ranked.slice(0, limit), incomplete };
}

function updateCandleWithPrice(candle, timestamp, price, intervalMs) {
    const bucket = Math.floor(timestamp / intervalMs) * intervalMs;
    if (!candle || bucket > candle.time) {
        return {
            candle: { time: bucket, open: price, high: price, low: price, close: price },
            closedCandle: candle || null
        };
    }
    if (bucket < candle.time) return { candle, closedCandle: null };

    return {
        candle: {
            ...candle,
            high: Math.max(candle.high, price),
            low: Math.min(candle.low, price),
            close: price
        },
        closedCandle: null
    };
}

function formatSignalAlert(symbol, signal) {
    const base = symbol.replace(/USDT$/, '');
    const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
    const link = `https://stobix.com/invite/qdjlyh?to=/futures/${encodeURIComponent(base)}/USDT`;
    return `${emoji} ${signal.direction} #${symbol} | Entry: ` +
        `${signal.entryPrice.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 8 })} | ` +
        `<a href="${link}">open on stobix</a>`;
}

module.exports = {
    formatSignalAlert,
    getLatestSignal,
    rankMarketsByDailyVolatility,
    updateCandleWithPrice
};
