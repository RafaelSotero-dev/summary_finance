# Personal Finance Dashboard

Private, read-only financial dashboard for one Financial Owner.

## Run with Docker

Copy `.env.example` to `.env`, set a strong `SESSION_SECRET`, then run:

```sh
docker compose up --build -d
docker compose exec -e FINANCIAL_OWNER_CPF -e FINANCIAL_OWNER_EMAIL app node dist/database/seed-owner.js
```

Request a magic link with the Financial Owner's CPF and verified email:

```sh
curl -X POST http://localhost:3000/auth/magic-link \
  -H 'content-type: application/json' \
  -d '{"cpf":"52998224725","email":"owner@example.com"}'
```

The message is available in Mailpit at http://localhost:8025. Open its link to access the empty **Visão Geral**.

## Open Finance Connections

Set the Belvo credentials in `.env`. The authenticated `POST /api/open-finance-connections` endpoint creates a read-only Belvo link for an institution. It requests only accounts, credit cards, balances, transactions, and invoices; the returned ownership document must match the authenticated Financial Owner CPF before the connection is saved.

## Transactions

The authenticated `POST /api/transactions/synchronize` endpoint imports the available 12-month history on its first synchronization and preserves later history by upserting each source transaction. The app also synchronizes each Open Finance Connection once daily, one Financial Owner at a time, without overlapping daily runs. Use `GET /api/transactions` with `search`, `financialInstitution`, `financialAccount`, `creditCard`, `type` (`income` or `expense`), `categoryId`, and either a `period` shortcut (`today`, `this-week`, `this-month`, `last-month`, or `this-year`) or `startDate`/`endDate` to filter the list. Pending Transactions are returned separately in `pendingTransactions` and never appear in `transactions` until the provider confirms the same source transaction.

## Credit Cards

Connected Credit Cards are included in `GET /api/overview`. The `institutionCardStatement` combines cards from the same Financial Institution and retains the card-level statement, physical or virtual kind, and any limits supplied by Open Finance. Installment Purchases retain their original purchase reference; Card Statement Settlements are returned with `expenseAmount: 0` so they do not create another expense.

## Categorization and analysis

Use authenticated `POST`, `GET`, and `PATCH /api/categories` endpoints to maintain a two-level Category Hierarchy. `PATCH /api/transactions/:id` records a Merchant, Transaction Category, or `internal-transfer`/`refund` classification without changing Source Transaction Data. A Merchant and Category correction becomes a reviewable suggestion on later matching Transactions. `GET /api/spending-analysis` returns income and expenses excluding Internal Transfers and offsetting Refunds, while retaining a count of Uncategorized Transactions.

## Dashboard

`GET /api/dashboard` provides a Consolidated View of current Financial Account balances and Institution Card Statements plus a filtered report with income, expenses, net result, a daily temporal series, and expense distribution by Transaction Category. It accepts the same period and financial filters as the Transaction list.

## Connection management

When a transaction synchronization fails, the latest local data remains available with its Data Freshness and a `reconnection-required` consent status. Reconnect with `POST /api/open-finance-connections/:financialInstitution/reconnect`. Financial Accounts and Credit Cards remain visible while their `PATCH /api/open-finance-connections/:financialInstitution/financial-accounts/:accountName` or `PATCH /api/open-finance-connections/:financialInstitution/credit-cards/:creditCardId` endpoint with `{ "includedInTotals": false }` excludes them from their respective Consolidated View totals.

`DELETE /api/open-finance-connections/:financialInstitution` revokes the provider link before removing the local connection and its cascading data. It stores an AES-256-GCM encrypted backup and sends only an operational revocation notification.
