const fs = require('node:fs/promises');
const path = require('node:path');
const {
    compareSnapshots,
    formatWeeklyReport,
    normalizeMarkets,
    validateSnapshot
} = require('./market-audit-core');

const API_URL = 'https://api.stobix.com';
const SNAPSHOT_PATH = path.resolve(__dirname, '..', 'data', 'stobix-market-fees.json');
const MAX_TELEGRAM_MESSAGE_LENGTH = 3500;

async function fetchMarkets() {
    const response = await fetch(`${API_URL}/v1/futures/markets`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
        throw new Error(`Stobix futures markets request failed with HTTP ${response.status}`);
    }
    return normalizeMarkets(await response.json());
}

function splitTelegramMessage(message) {
    const lines = message.split('\n');
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
        if (chunk && chunk.length + line.length + 1 > MAX_TELEGRAM_MESSAGE_LENGTH) {
            chunks.push(chunk);
            chunk = '';
        }
        if (line.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
            throw new Error('A weekly audit report line exceeds Telegram message limits');
        }
        chunk = chunk ? `${chunk}\n${line}` : line;
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length > 1) {
        return chunks.map((part, index) => `${part}\n(Part ${index + 1}/${chunks.length})`);
    }
    return chunks;
}

async function sendReport(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        throw new Error('Telegram secrets are missing; configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }

    for (const text of splitTelegramMessage(message)) {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                link_preview_options: { is_disabled: true }
            }),
            signal: AbortSignal.timeout(15_000)
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) {
            throw new Error(`Telegram rejected weekly audit report: ${result.description || `HTTP ${response.status}`}`);
        }
    }
}

async function readPreviousSnapshot() {
    try {
        const saved = JSON.parse(await fs.readFile(SNAPSHOT_PATH, 'utf8'));
        return validateSnapshot(saved);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`Unable to read the previous Stobix fee snapshot: ${error.message}`);
    }
}

async function main() {
    const markets = await fetchMarkets();
    const current = {
        generatedAt: new Date().toISOString(),
        markets
    };
    const previous = await readPreviousSnapshot();

    if (!previous) {
        console.log(`Initialized Stobix weekly audit baseline with ${Object.keys(markets).length} pairs.`);
    } else {
        const report = formatWeeklyReport(compareSnapshots(previous, current), current);
        await sendReport(report);
        console.log('Sent the Stobix weekly market and commission audit to Telegram.');
    }

    await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
    await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`);
}

main().catch((error) => {
    console.error('Failed to complete the Stobix weekly market audit:', error);
    process.exitCode = 1;
});
