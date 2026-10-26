const test = require('node:test');
const assert = require('node:assert/strict');
const {
    compareSnapshots,
    formatWeeklyReport,
    normalizeMarkets,
    validateSnapshot
} = require('../scripts/market-audit-core');

const market = (symbol, longEntry, longClose = longEntry, shortEntry = longEntry, shortClose = shortEntry) => ({
    symbol,
    markets: [
        { direction: 'LONG', entryFee: String(longEntry), closeFee: String(longClose) },
        { direction: 'SHORT', entryFee: String(shortEntry), closeFee: String(shortClose) }
    ]
});

test('normalizes Stobix market fees into sorted USDT symbols', () => {
    assert.deepEqual(normalizeMarkets([
        market('ZEN/USDT', 0.001),
        market('XAU/USD', 0.0001),
        market('BTC/USDT', 0.0006)
    ]), {
        BTCUSDT: {
            LONG: { entryFee: 0.0006, closeFee: 0.0006 },
            SHORT: { entryFee: 0.0006, closeFee: 0.0006 }
        },
        ZENUSDT: {
            LONG: { entryFee: 0.001, closeFee: 0.001 },
            SHORT: { entryFee: 0.001, closeFee: 0.001 }
        }
    });
});

test('rejects incomplete or invalid Stobix fee data', () => {
    assert.throws(() => normalizeMarkets([]), /invalid or empty/);
    assert.throws(() => normalizeMarkets([market('BTC/USDT', -1)]), /invalid entryFee/);
    assert.throws(() => normalizeMarkets([{
        symbol: 'BTC/USDT',
        markets: [{ direction: 'LONG', entryFee: '0.001', closeFee: '0.001' }]
    }]), /incomplete LONG\/SHORT/);
});

test('compares newly listed and removed pairs plus direction-specific fee changes', () => {
    const previous = validateSnapshot({
        generatedAt: '2026-10-12T09:00:00.000Z',
        markets: normalizeMarkets([
            market('BTC/USDT', 0.0006),
            market('OLD/USDT', 0.0005)
        ])
    });
    const current = validateSnapshot({
        generatedAt: '2026-10-19T09:00:00.000Z',
        markets: normalizeMarkets([
            market('BTC/USDT', 0.0007, 0.0006, 0.0006, 0.0006),
            market('NEW/USDT', 0.001)
        ])
    });

    const changes = compareSnapshots(previous, current);
    assert.deepEqual(changes.added, ['NEWUSDT']);
    assert.deepEqual(changes.removed, ['OLDUSDT']);
    assert.deepEqual(changes.feeChanges, [{
        symbol: 'BTCUSDT',
        direction: 'LONG',
        feeType: 'entryFee',
        from: 0.0006,
        to: 0.0007
    }]);

    const report = formatWeeklyReport(changes, current);
    assert.match(report, /New pairs \(1\):\n\+ NEWUSDT — LONG entry\/close 0\.1%\/0\.1%; SHORT entry\/close 0\.1%\/0\.1%/);
    assert.match(report, /Removed pairs \(1\):\n- OLDUSDT/);
    assert.match(report, /Commission changes \(1 pair\):\n~ BTCUSDT LONG entry: 0\.06% → 0\.07%/);
});

test('groups identical entry and close commission changes across both directions', () => {
    const previous = validateSnapshot({
        generatedAt: '2026-10-19T09:00:00.000Z',
        markets: normalizeMarkets([market('MSTR/USDT', 0.0005)])
    });
    const current = validateSnapshot({
        generatedAt: '2026-10-26T09:00:00.000Z',
        markets: normalizeMarkets([market('MSTR/USDT', 0.0007)])
    });
    const changes = compareSnapshots(previous, current);
    const report = formatWeeklyReport(changes, current);

    assert.equal(changes.feeChanges.length, 4);
    assert.match(report, /Commission changes \(1 pair\):\n~ MSTRUSDT all commissions: 0\.05% → 0\.07%/);
    assert.equal(report.split('\n').filter((line) => line.startsWith('~ MSTRUSDT')).length, 1);
});

test('keeps distinct commission changes explicit when fee values differ', () => {
    const previous = validateSnapshot({
        generatedAt: '2026-10-19T09:00:00.000Z',
        markets: normalizeMarkets([market('BTC/USDT', 0.0006)])
    });
    const current = validateSnapshot({
        generatedAt: '2026-10-26T09:00:00.000Z',
        markets: normalizeMarkets([
            market('BTC/USDT', 0.0007, 0.0008, 0.0007, 0.0008)
        ])
    });
    const report = formatWeeklyReport(compareSnapshots(previous, current), current);

    assert.match(report, /~ BTCUSDT LONG entry, SHORT entry: 0\.06% → 0\.07%/);
    assert.match(report, /~ BTCUSDT LONG close, SHORT close: 0\.06% → 0\.08%/);
});

test('formats a no-change weekly summary', () => {
    const current = validateSnapshot({
        generatedAt: '2026-10-19T09:00:00.000Z',
        markets: normalizeMarkets([market('BTC/USDT', 0.0006)])
    });

    assert.equal(
        formatWeeklyReport({ added: [], removed: [], feeChanges: [] }, current),
        'Stobix weekly futures audit (1 pairs)\nNo pair or commission changes since the previous weekly check.'
    );
});
