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

function formatTelegramAlert(market, level) {
    const pair = market.symbol.replace(/USDT$/, '/USDT');
    const [base, quote] = pair.split('/');
    const link = `https://app.stobix.com/futures/${encodeURIComponent(base)}/${encodeURIComponent(quote)}` +
        '?utm_source=invite&utm_medium=referral&utm_content=qdjlyh';
    const direction = Number.isFinite(market.priceChangePercent)
        ? market.priceChangePercent > 0
            ? '🟢⬆️'
            : market.priceChangePercent < 0
                ? '🔴⬇️'
                : '⚪↔️'
        : '⚪↔️';

    return `${direction} <a href="${escapeHtml(link)}">${escapeHtml(pair)}</a>: ` +
        `часовая волатильность достигла ${level}% (текущая ${market.volatilityValue.toFixed(2)}%).`;
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
                message: formatTelegramAlert(market, level)
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
    formatTelegramAlert,
    pruneCandles
};
