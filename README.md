# Personal Finance Dashboard

Private, read-only financial dashboard for one Financial Owner.

## Run with Docker

Copy `.env.example` to `.env`, set a strong `SESSION_SECRET`, then run:

```sh
docker compose up --build -d
docker compose exec -e FINANCIAL_OWNER_CPF -e FINANCIAL_OWNER_EMAIL app node dist/database/seed-owner.js
```

Open http://localhost:3000/login and enter the Financial Owner's CPF and verified email. The message is available in Mailpit at http://localhost:8025. Open its link to access the empty **Visão Geral**.

Magic links expire after 15 minutes, may be used once, and a new request invalidates an unused older link. Successful verification creates an opaque, HttpOnly session stored in PostgreSQL for a fixed eight hours. `GET /api/session` reports whether the current browser is authenticated; `POST /api/logout` revokes only that browser session.

## Local development

Run `npm run dev` to start Express on port 3000 and Vite on port 5173. Open the Vite URL while developing; it proxies `/api` and `/auth` to Express. Production builds are served by Express, including SPA routes, while API and authentication paths remain backend routes.

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

`DELETE /api/open-finance-connections/:financialInstitution` removes only the local connection and its cascading data. It stores an AES-256-GCM encrypted backup and sends an operational notification; manage the underlying Meu Pluggy connection and consent in Meu Pluggy.
