# Stobix volatility monitor

The GitHub Pages site displays the latest published snapshot. Opening the page loads that snapshot once; **Обновить** fetches the latest already-published snapshot. To calculate fresh Stobix data on demand, use **Получить свежие данные**, press **Run workflow** on the GitHub Actions page that opens, then return to the monitor page. It waits for publication and displays the volatility change in percentage points relative to the previously loaded snapshot. GitHub requires an authenticated user action to dispatch the workflow, so the static page cannot start it directly or expose a token. Telegram alerts can be monitored independently of the page using the GitHub Actions WebSocket monitor.

## Start and stop continuous Telegram monitoring

1. Make sure the repository has the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` Actions secrets.
2. Open **Actions** → **Monitor Stobix volatility continuously** → **Run workflow** and start it once from the default branch. Leave the internal `carry_state` input unchanged.
3. The workflow subscribes to Stobix Futures rate updates and checks the rolling one-hour volatility once per minute. Telegram alerts are sent when a market reaches 2%, 3%, 4%, and each further whole-percent level. Each alert links the pair to Stobix and shows a green up arrow or red down arrow for the net price movement during that same hour.
4. To stop monitoring, cancel the active run in **Actions**. To resume it, run the workflow manually again.

GitHub-hosted jobs have a maximum runtime. This workflow runs for about 5 hours 40 minutes, passes alert state to a successor run, and starts it automatically. GitHub Actions is not a permanent-service host, so restarts can have gaps and are not guaranteed to run without interruption. If a run fails before it starts its successor, restart the workflow manually.

The Pages snapshot continues to use the separate scheduled publisher workflow. Telegram threshold checking does not depend on that schedule or on the browser page being open. No additional hosting provider is used; Stobix supplies market data and Telegram delivers notifications.
