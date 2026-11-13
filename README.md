# Personal Finance Dashboard

Private, read-only financial dashboard for one Financial Owner.

## Run with Docker

Copy `.env.example` to `.env`, set a strong `SESSION_SECRET`, then run:

```sh
docker compose up --build -d
docker compose exec -e FINANCIAL_OWNER_CPF -e FINANCIAL_OWNER_EMAIL app node dist/database/seed-owner.js
```

Open http://localhost:3000/login and enter the Financial Owner's CPF and verified email. The message is available in Mailpit at http://localhost:8025. Open its link to access the empty **Visão Consolidada**. Docker's documented HTTP flow deliberately issues a non-`Secure` cookie; deploy behind HTTPS with `APP_BASE_URL=https://…` to issue a `Secure` session cookie.

Magic links expire after 15 minutes, may be used once, and a new request invalidates an unused older link. Successful verification creates an opaque, HttpOnly session stored in PostgreSQL for a fixed eight hours. `GET /api/session` reports whether the current browser is authenticated; `POST /api/logout` revokes only that browser session.

## Local development

Run `npm ci` then `npm run dev` to start Express on port 3000 and Vite on port 5173. Open the Vite URL while developing; it proxies `/api` and `/auth` to Express. Production builds are served by Express, including SPA routes, while API and authentication paths remain backend routes.

## Tests

Run `npm ci`, then `npx playwright install --with-deps chromium` and `npm test && npm run test:browser`. The Playwright browser installation is required once per environment and is intentionally not assumed by `npm install`.

## Open Finance Connections

Set the Pluggy credentials in `.env`. This app uses Pluggy's **Meu Pluggy** personal-use route: connect each Financial Institution in Meu Pluggy, link the MeuPluggy connector to the Pluggy application, then supply that item ID as `itemId` when creating the dashboard connection with `POST /api/open-finance-connections`. Meu Pluggy refreshes data every 24 hours; the dashboard reads its latest snapshot and never requests a bank refresh.

## Transactions

The application reads each Open Finance Connection daily, imports up to 12 months on its first read, and preserves later history by upserting each source transaction. It does not offer immediate bank updates. Use `GET /api/transactions` with `search`, `financialInstitution`, `financialAccount`, `creditCard`, `type` (`income` or `expense`), `categoryId`, and either a `period` shortcut (`today`, `this-week`, `this-month`, `last-month`, or `this-year`) or `startDate`/`endDate` to filter the list. Pending Transactions are returned separately in `pendingTransactions` and never appear in `transactions` until the provider confirms the same source transaction.

## Credit Cards

Connected Credit Cards are included in `GET /api/overview`. The `institutionCardStatement` combines cards from the same Financial Institution and retains the card-level statement, physical or virtual kind, and any limits supplied by Open Finance. Installment Purchases retain their original purchase reference; Card Statement Settlements are returned with `expenseAmount: 0` so they do not create another expense.

## Categorization and analysis

Use authenticated `POST`, `GET`, and `PATCH /api/categories` endpoints to maintain a PostgreSQL-persisted, two-level Category Hierarchy. Categories may be renamed, moved, and archived. Archived Transaction Categories remain in historical Transaction results and filters but cannot be selected for new classifications. `PATCH /api/transactions/:id` records a Merchant, Transaction Category, or `internal-transfer`/`refund` classification without changing Source Transaction Data. A Merchant and Category correction becomes a reviewable suggestion on later matching Transactions. `GET /api/spending-analysis` returns income and expenses excluding Internal Transfers and offsetting Refunds, while retaining a count of Uncategorized Transactions. Add `granularity=day`, `month`, or `year` with `startDate` and `endDate` to compare categorized historical expenses; add `equivalentPeriod=true` to compare matching month-and-day ranges across years. The analysis reports recorded history only; it never includes forecasts, recommendations, or payment instructions.

## Dashboard

`GET /api/dashboard` provides a Consolidated View of current Financial Account balances and Institution Card Statements plus a filtered report with income, expenses, net result, a daily temporal series, and expense distribution by Transaction Category. It accepts the same period and financial filters as the Transaction list.

## Connection management

When a transaction synchronization fails, the latest local data remains available with its Data Freshness and a `reconnection-required` consent status. Reconnect with `POST /api/open-finance-connections/:financialInstitution/reconnect`. Financial Accounts and Credit Cards remain visible while their `PATCH /api/open-finance-connections/:financialInstitution/financial-accounts/:accountName` or `PATCH /api/open-finance-connections/:financialInstitution/credit-cards/:creditCardId` endpoint with `{ "includedInTotals": false }` excludes them from their respective Consolidated View totals.

`DELETE /api/open-finance-connections/:financialInstitution` creates a Disconnected Open Finance Connection: it stops future dashboard synchronization and excludes current values from the Consolidated View while retaining local history, interpretations, and Categorization Rules. Manage the underlying Meu Pluggy connection and consent in Meu Pluggy.
