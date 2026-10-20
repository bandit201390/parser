const MARKET_DIRECTIONS = ['LONG', 'SHORT'];
const MARKET_FEE_TYPES = ['entryFee', 'closeFee'];
const MAX_PER_SIDE_COMMISSION = 0.001;

function filterMarketsByCommission(markets, maxCommission = MAX_PER_SIDE_COMMISSION) {
    if (!Array.isArray(markets) || !Number.isFinite(maxCommission) || maxCommission < 0) {
        throw new Error('Cannot filter Stobix markets: invalid market list or commission limit');
    }

    const eligible = [];
    const excluded = [];
    for (const market of markets) {
        if (!market || typeof market.symbol !== 'string' ||
            !/^[A-Z0-9]+\/[A-Z0-9]+$/.test(market.symbol)) {
            throw new Error('Stobix returned a futures market with an invalid symbol');
        }
        if (!market.symbol.endsWith('/USDT')) continue;
        if (!Array.isArray(market.markets)) {
            throw new Error(`Stobix returned invalid commission data for ${market.symbol}`);
        }

        const feesByDirection = new Map();
        for (const side of market.markets) {
            if (!side || !MARKET_DIRECTIONS.includes(side.direction) || feesByDirection.has(side.direction)) {
                throw new Error(`Stobix returned invalid direction commission data for ${market.symbol}`);
            }
            const fees = MARKET_FEE_TYPES.map((feeType) => Number(side[feeType]));
            if (fees.some((fee) => !Number.isFinite(fee) || fee < 0)) {
                throw new Error(`Stobix returned invalid commission values for ${market.symbol} ${side.direction}`);
            }
            feesByDirection.set(side.direction, fees);
        }
        if (MARKET_DIRECTIONS.some((direction) => !feesByDirection.has(direction))) {
            throw new Error(`Stobix returned incomplete LONG/SHORT commission data for ${market.symbol}`);
        }

        const maxMarketCommission = Math.max(...[...feesByDirection.values()].flat());
        if (maxMarketCommission > maxCommission) {
            excluded.push({ ...market, maxCommission: maxMarketCommission });
        } else {
            eligible.push(market);
        }
    }

    if (eligible.length === 0) {
        throw new Error('No USDT futures markets meet the per-side commission limit');
    }
    return { eligible, excluded };
}

function calculateVolatility(candles) {
    if (candles.length === 0 || candles[0].open <= 0) {
        return null;
    }

    const high = Math.max(...candles.map((candle) => candle.high));
    const low = Math.min(...candles.map((candle) => candle.low));
    return ((high - low) / candles[0].open) * 100;
}

function addPriceToCandles(candles, timestamp, price) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) {
        return;
    }

    const minute = Math.floor(timestamp / 60_000) * 60_000;
    const candle = candles.find((item) => item.time === minute);
    if (candle) {
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        return;
    }

    candles.push({
        time: minute,
        open: price,
        high: price,
        low: price,
        close: price
    });
    candles.sort((left, right) => left.time - right.time);
}

function pruneCandles(candles, now) {
    const earliestMinute = Math.floor((now - 61 * 60_000) / 60_000) * 60_000;
    return candles.filter((candle) =>
        candle.time >= earliestMinute && candle.time <= now
    );
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTelegramAlert(market) {
    const ticker = market.symbol;
    const base = ticker.replace(/USDT$/, '');
    if (!Number.isFinite(market.current_price)) {
        throw new Error(`Cannot format Telegram alert for ${ticker}: current price is unavailable`);
    }
    const price = market.current_price.toLocaleString('en-US', {
        useGrouping: false,
        maximumFractionDigits: 8
    });
    const link = `https://stobix.com/invite/qdjlyh?to=/futures/${encodeURIComponent(base)}/USDT`;
    const direction = Number.isFinite(market.priceChangePercent)
        ? market.priceChangePercent > 0
            ? { emoji: '🟢', label: 'BUY' }
            : market.priceChangePercent < 0
                ? { emoji: '🔴', label: 'SELL' }
                : { emoji: '⚪', label: '1h volatility' }
        : { emoji: '⚪', label: '1h volatility' };

    return `${direction.emoji}#${escapeHtml(ticker)}: ${price} ${direction.label} ${market.volatilityValue.toFixed(2)}% ` +
        `<a href="${escapeHtml(link)}">open on stobix</a>`;
}

function advanceAlertState(markets, previousLevels, fallbackLevels = {}, firstThreshold = 2) {
    const alertState = {};
    const alerts = [];

    for (const market of markets) {
        const volatility = market.volatilityValue;
        if (!Number.isFinite(volatility)) {
            if (Number.isFinite(previousLevels[market.symbol])) {
                alertState[market.symbol] = previousLevels[market.symbol];
            }
            continue;
        }

        const currentLevel = Math.floor(volatility);
        const previousLevel = Number.isFinite(previousLevels[market.symbol])
            ? previousLevels[market.symbol]
            : Number.isFinite(fallbackLevels[market.symbol])
                ? fallbackLevels[market.symbol]
                : Math.max(firstThreshold - 1, currentLevel);

        if (currentLevel < firstThreshold) {
            alertState[market.symbol] = firstThreshold - 1;
            continue;
        }

        for (
            let level = Math.max(firstThreshold, previousLevel + 1);
            level <= currentLevel;
            level += 1
        ) {
            alerts.push({
                symbol: market.symbol,
                level,
                message: formatTelegramAlert(market)
            });
        }
        alertState[market.symbol] = currentLevel;
    }

    return { alertState, alerts };
}

module.exports = {
    addPriceToCandles,
    advanceAlertState,
    calculateVolatility,
    filterMarketsByCommission,
    formatTelegramAlert,
    pruneCandles
};
