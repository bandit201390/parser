const DIRECTIONS = ['LONG', 'SHORT'];
const FEE_TYPES = ['entryFee', 'closeFee'];

function normalizeMarkets(payload) {
    if (!Array.isArray(payload) || payload.length === 0) {
        throw new Error('Stobix returned an invalid or empty futures markets list');
    }

    const markets = {};
    for (const market of payload) {
        if (!market || typeof market.symbol !== 'string' || !/^[A-Z0-9]+\/[A-Z0-9]+$/.test(market.symbol)) {
            throw new Error('Stobix returned a futures market with an invalid symbol');
        }
        if (!market.symbol.endsWith('/USDT')) continue;

        const symbol = market.symbol.replace('/', '');
        if (markets[symbol]) {
            throw new Error(`Stobix returned duplicate futures market ${symbol}`);
        }
        if (!Array.isArray(market.markets)) {
            throw new Error(`Stobix returned invalid fee data for ${symbol}`);
        }

        const sides = {};
        for (const side of market.markets) {
            if (!side || !DIRECTIONS.includes(side.direction) || sides[side.direction]) {
                throw new Error(`Stobix returned invalid direction fee data for ${symbol}`);
            }
            sides[side.direction] = {};
            for (const feeType of FEE_TYPES) {
                const fee = Number(side[feeType]);
                if (!Number.isFinite(fee) || fee < 0) {
                    throw new Error(`Stobix returned an invalid ${feeType} for ${symbol} ${side.direction}`);
                }
                sides[side.direction][feeType] = fee;
            }
        }
        if (DIRECTIONS.some((direction) => !sides[direction])) {
            throw new Error(`Stobix returned incomplete LONG/SHORT fee data for ${symbol}`);
        }
        markets[symbol] = sides;
    }
    if (Object.keys(markets).length === 0) {
        throw new Error('Stobix returned no USDT futures markets');
    }
    return Object.fromEntries(
        Object.entries(markets).sort(([left], [right]) => left.localeCompare(right))
    );
}

function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' ||
        typeof snapshot.generatedAt !== 'string' ||
        Number.isNaN(Date.parse(snapshot.generatedAt)) ||
        !snapshot.markets || typeof snapshot.markets !== 'object' ||
        Array.isArray(snapshot.markets) ||
        Object.keys(snapshot.markets).length === 0) {
        throw new Error('The saved Stobix fee snapshot has an invalid format');
    }

    const markets = {};
    for (const [symbol, sides] of Object.entries(snapshot.markets)) {
        if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
            throw new Error(`The saved Stobix fee snapshot has an invalid symbol: ${symbol}`);
        }
        markets[symbol] = {};
        for (const direction of DIRECTIONS) {
            const fees = sides && sides[direction];
            if (!fees) {
                throw new Error(`The saved Stobix fee snapshot is missing ${symbol} ${direction}`);
            }
            markets[symbol][direction] = {};
            for (const feeType of FEE_TYPES) {
                if (!Number.isFinite(fees[feeType]) || fees[feeType] < 0) {
                    throw new Error(`The saved Stobix fee snapshot has an invalid ${feeType} for ${symbol} ${direction}`);
                }
                markets[symbol][direction][feeType] = fees[feeType];
            }
        }
    }
    return { generatedAt: snapshot.generatedAt, markets };
}

function compareSnapshots(previous, current) {
    const previousSymbols = new Set(Object.keys(previous.markets));
    const currentSymbols = new Set(Object.keys(current.markets));
    const added = [...currentSymbols]
        .filter((symbol) => !previousSymbols.has(symbol))
        .sort();
    const removed = [...previousSymbols]
        .filter((symbol) => !currentSymbols.has(symbol))
        .sort();
    const feeChanges = [];

    for (const symbol of [...currentSymbols].filter((item) => previousSymbols.has(item)).sort()) {
        for (const direction of DIRECTIONS) {
            for (const feeType of FEE_TYPES) {
                const from = previous.markets[symbol][direction][feeType];
                const to = current.markets[symbol][direction][feeType];
                if (from !== to) {
                    feeChanges.push({ symbol, direction, feeType, from, to });
                }
            }
        }
    }
    return { added, removed, feeChanges };
}

function formatFee(fee) {
    return `${(fee * 100).toLocaleString('en-US', { maximumFractionDigits: 6 })}%`;
}

function formatWeeklyReport(changes, current) {
    const lines = [`Stobix weekly futures audit (${Object.keys(current.markets).length} pairs)`];
    if (changes.added.length) {
        lines.push('', `New pairs (${changes.added.length}):`);
        for (const symbol of changes.added) {
            const fees = current.markets[symbol];
            lines.push(
                `+ ${symbol} — LONG entry/close ${formatFee(fees.LONG.entryFee)}/${formatFee(fees.LONG.closeFee)}; ` +
                `SHORT entry/close ${formatFee(fees.SHORT.entryFee)}/${formatFee(fees.SHORT.closeFee)}`
            );
        }
    }
    if (changes.removed.length) {
        lines.push('', `Removed pairs (${changes.removed.length}):`);
        for (const symbol of changes.removed) {
            lines.push(`- ${symbol}`);
        }
    }
    if (changes.feeChanges.length) {
        const changesBySymbol = new Map();
        for (const change of changes.feeChanges) {
            if (!changesBySymbol.has(change.symbol)) {
                changesBySymbol.set(change.symbol, []);
            }
            changesBySymbol.get(change.symbol).push(change);
        }

        const pairCount = changesBySymbol.size;
        lines.push('', `Commission changes (${pairCount} ${pairCount === 1 ? 'pair' : 'pairs'}):`);
        for (const [symbol, symbolChanges] of changesBySymbol) {
            const changesByRate = new Map();
            for (const change of symbolChanges) {
                const key = `${change.from}:${change.to}`;
                if (!changesByRate.has(key)) {
                    changesByRate.set(key, {
                        from: change.from,
                        to: change.to,
                        fields: []
                    });
                }
                changesByRate.get(key).fields.push(change);
            }

            for (const { from, to, fields } of changesByRate.values()) {
                const fieldNames = fields
                    .map((change) => `${change.direction} ${change.feeType === 'entryFee' ? 'entry' : 'close'}`)
                    .sort();
                const allFields = ['LONG close', 'LONG entry', 'SHORT close', 'SHORT entry'];
                const scope = fieldNames.length === allFields.length &&
                    allFields.every((field) => fieldNames.includes(field))
                    ? 'all commissions'
                    : fieldNames.join(', ');
                lines.push(`~ ${symbol} ${scope}: ${formatFee(from)} → ${formatFee(to)}`);
            }
        }
    }
    if (!changes.added.length && !changes.removed.length && !changes.feeChanges.length) {
        lines.push('No pair or commission changes since the previous weekly check.');
    }
    return lines.join('\n');
}

module.exports = {
    compareSnapshots,
    formatWeeklyReport,
    normalizeMarkets,
    validateSnapshot
};
