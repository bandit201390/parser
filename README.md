# Stobix volatility monitor

The GitHub Pages site displays the latest published snapshot. Telegram alerts can be monitored independently of the page using the GitHub Actions WebSocket monitor.

## Start and stop continuous Telegram monitoring

1. Make sure the repository has the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` Actions secrets.
2. Open **Actions** → **Monitor Stobix volatility continuously** → **Run workflow** and start it once from the default branch. Leave the internal `carry_state` input unchanged.
3. The workflow subscribes to Stobix Futures rate updates and checks the rolling one-hour volatility once per minute. Telegram alerts are sent when a market reaches 2%, 3%, 4%, and each further whole-percent level.
4. To stop monitoring, cancel the active run in **Actions**. To resume it, run the workflow manually again.

GitHub-hosted jobs have a maximum runtime. This workflow runs for about 5 hours 40 minutes, passes alert state to a successor run, and starts it automatically. GitHub Actions is not a permanent-service host, so restarts can have gaps and are not guaranteed to run without interruption. If a run fails before it starts its successor, restart the workflow manually.

The Pages snapshot continues to use the separate scheduled publisher workflow. Telegram threshold checking does not depend on that schedule or on the browser page being open. No additional hosting provider is used; Stobix supplies market data and Telegram delivers notifications.
