const MARKET_DIRECTIONS = ['LONG', 'SHORT'];
const MARKET_FEE_TYPES = ['entryFee', 'closeFee'];
const MAX_PER_SIDE_COMMISSION = 0.001;
const ALERT_SCHEDULES = {
    low: { firstThresholdTicks: 75, stepTicks: 25 },
    medium: { firstThresholdTicks: 100, stepTicks: 50 },
    high: { firstThresholdTicks: 150, stepTicks: 75 }
};
const VOLATILITY_TICKS_PER_PERCENT = 100;

function getAlertSchedule(commissionRate) {
    if (!Number.isFinite(commissionRate) ||
        commissionRate < 0 ||
        commissionRate > MAX_PER_SIDE_COMMISSION) {
        throw new Error(`Cannot select alert thresholds for invalid commission rate ${commissionRate}`);
    }
    if (commissionRate < 0.0005) {
        return { id: 'low-v2', ...ALERT_SCHEDULES.low };
    }
    if (commissionRate < MAX_PER_SIDE_COMMISSION) {
        return { id: 'medium-v2', ...ALERT_SCHEDULES.medium };
    }
    return { id: 'high-v2', ...ALERT_SCHEDULES.high };
}

function getThresholdTicks(volatility, schedule) {
    const { firstThresholdTicks, stepTicks } = schedule;
    if (volatility * VOLATILITY_TICKS_PER_PERCENT < firstThresholdTicks) {
        return firstThresholdTicks - stepTicks;
    }
    const steps = Math.floor(
        (volatility * VOLATILITY_TICKS_PER_PERCENT - firstThresholdTicks + 1e-9) / stepTicks
    );
    return firstThresholdTicks + steps * stepTicks;
}

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
            eligible.push({ ...market, commissionRate: maxMarketCommission });
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

function getAlertDirection(market) {
    if (!Number.isFinite(market.priceChangePercent) || market.priceChangePercent === 0) {
        return 'NEUTRAL';
    }
    return market.priceChangePercent > 0 ? 'BUY' : 'SELL';
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
    const direction = {
        BUY: { emoji: '🟢', label: 'BUY' },
        SELL: { emoji: '🔴', label: 'SELL' },
        NEUTRAL: { emoji: '⚪', label: '1h volatility' }
    }[getAlertDirection(market)];

    return `${direction.emoji}#${escapeHtml(ticker)}: ${price} ${direction.label} ${market.volatilityValue.toFixed(2)}% ` +
        `<a href="${escapeHtml(link)}">open on stobix</a>`;
}

function advanceAlertState(markets, previousLevels) {
    const alertState = {};
    const alerts = [];

    for (const market of markets) {
        const volatility = market.volatilityValue;
        if (!Number.isFinite(volatility)) {
            if (previousLevels[market.symbol] !== undefined) {
                alertState[market.symbol] = previousLevels[market.symbol];
            }
            continue;
        }

        const schedule = getAlertSchedule(market.commissionRate);
        const currentThresholdTicks = getThresholdTicks(volatility, schedule);
        const storedState = previousLevels[market.symbol];
        const previousThresholdTicks = storedState &&
            typeof storedState === 'object' &&
            storedState.scheduleId === schedule.id &&
            Number.isInteger(storedState.levelTicks)
            ? storedState.levelTicks
            : getThresholdTicks(volatility, schedule);
        const lastSentDirection = storedState &&
            typeof storedState === 'object' &&
            ['BUY', 'SELL', 'NEUTRAL'].includes(storedState.lastDirection)
            ? storedState.lastDirection
            : undefined;
        let lastCandidateDirection = lastSentDirection;

        if (volatility * VOLATILITY_TICKS_PER_PERCENT < schedule.firstThresholdTicks) {
            alertState[market.symbol] = {
                scheduleId: schedule.id,
                levelTicks: schedule.firstThresholdTicks - schedule.stepTicks,
                ...(lastSentDirection ? { lastDirection: lastSentDirection } : {})
            };
            continue;
        }

        for (
            let thresholdTicks = Math.max(
                schedule.firstThresholdTicks,
                previousThresholdTicks + schedule.stepTicks
            );
            thresholdTicks <= currentThresholdTicks;
            thresholdTicks += schedule.stepTicks
        ) {
            const level = thresholdTicks / VOLATILITY_TICKS_PER_PERCENT;
            const direction = getAlertDirection(market);
            if (direction !== lastCandidateDirection) {
                alerts.push({
                    symbol: market.symbol,
                    level,
                    direction,
                    message: formatTelegramAlert(market)
                });
                lastCandidateDirection = direction;
            }
        }
        alertState[market.symbol] = {
            scheduleId: schedule.id,
            levelTicks: currentThresholdTicks,
            ...(lastSentDirection ? { lastDirection: lastSentDirection } : {})
        };
    }

    return { alertState, alerts };
}

function markAlertsSent(alertState, alerts) {
    const nextState = { ...alertState };
    for (const alert of alerts) {
        const state = nextState[alert.symbol];
        if (!state || typeof state !== 'object') {
            throw new Error(`Cannot save sent alert direction without threshold state for ${alert.symbol}`);
        }
        nextState[alert.symbol] = { ...state, lastDirection: alert.direction };
    }
    return nextState;
}

module.exports = {
    addPriceToCandles,
    advanceAlertState,
    calculateVolatility,
    filterMarketsByCommission,
    formatTelegramAlert,
    getAlertSchedule,
    markAlertsSent,
    pruneCandles
};
