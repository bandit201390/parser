# Stobix volatility monitor

The GitHub Pages site displays the latest published snapshot. Opening the page loads that snapshot once; **Обновить** fetches the latest already-published snapshot. The volatility change is shown in percentage points relative to the previously loaded snapshot. The page does not trigger a new GitHub Actions run, so the displayed data changes only after the scheduled publisher has published a new snapshot. Telegram alerts can be monitored independently of the page using the GitHub Actions WebSocket monitor.

## Start and stop continuous Telegram monitoring

1. Make sure the repository has the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` Actions secrets.
2. Open **Actions** → **Monitor Stobix volatility continuously** → **Run workflow** and start it once from the default branch. Leave the internal `carry_state` input unchanged.
3. The workflow subscribes to Stobix Futures rate updates and checks the rolling one-hour volatility once per minute. Alert thresholds depend on the highest of the pair's LONG/SHORT entry/close commissions: 0.01–0.049% starts at 0.5% volatility and repeats every 0.1%; 0.05–0.099% starts at 0.75% and repeats every 0.25%; 0.1% starts at 1% and repeats every 0.5%. Each alert links the pair to Stobix and shows a green or red indicator for the net price movement during that same hour.
4. To stop monitoring, cancel the active run in **Actions**. To resume it, run the workflow manually again.

GitHub-hosted jobs have a maximum runtime. This workflow runs for about 5 hours 40 minutes, passes alert state to a successor run, and starts it automatically. GitHub Actions is not a permanent-service host, so restarts can have gaps and are not guaranteed to run without interruption. If a run fails before it starts its successor, restart the workflow manually.

The Pages snapshot continues to use the separate scheduled publisher workflow. Telegram threshold checking does not depend on that schedule or on the browser page being open. No additional hosting provider is used; Stobix supplies market data and Telegram delivers notifications.

Only USDT futures pairs with LONG and SHORT entry and close commissions all at or below 0.1% are included in the monitor and published snapshot. A pair is excluded if any one of those per-side rates exceeds 0.1%; missing or invalid commission data stops the run rather than allowing an unverified pair through. Both the WebSocket monitor and Pages publisher re-evaluate fees whenever they load the Stobix markets list, so an excluded pair is eligible again once every fee is 0.1% or lower.

## Weekly market and commission audit

The **Weekly Stobix market and commission audit** workflow checks the futures market list every Monday at 09:00 UTC and can also be run manually. It compares newly listed and removed USDT pairs, and LONG/SHORT entry and close fees, then sends the changes (or a no-change summary) to Telegram. Fees are read from Stobix's `entryFee` and `closeFee` values and reported as percentages. The first run establishes the baseline without sending a report; subsequent runs compare against the saved `data/stobix-market-fees.json` file. The workflow requires the existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` Actions secrets and write access to the repository contents.
