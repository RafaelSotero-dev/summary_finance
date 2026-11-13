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

The authenticated `POST /api/transactions/synchronize` endpoint imports the available 12-month history on its first synchronization and preserves later history by upserting each source transaction. The app also synchronizes each Open Finance Connection once daily, one Financial Owner at a time, without overlapping daily runs. Use `GET /api/transactions?search=...&financialInstitution=...` to search or filter transactions. Pending Transactions are returned separately in `pendingTransactions` and never appear in `transactions` until the provider confirms the same source transaction.

## Categorization and analysis

Use authenticated `POST`, `GET`, and `PATCH /api/categories` endpoints to maintain a two-level Category Hierarchy. `PATCH /api/transactions/:id` records a Merchant, Transaction Category, or `internal-transfer`/`refund` classification without changing Source Transaction Data. A Merchant and Category correction becomes a reviewable suggestion on later matching Transactions. `GET /api/spending-analysis` returns income and expenses excluding Internal Transfers and offsetting Refunds, while retaining a count of Uncategorized Transactions.

## Connection management

When a transaction synchronization fails, the latest local data remains available with its Data Freshness and a `reconnection-required` consent status. Reconnect with `POST /api/open-finance-connections/:financialInstitution/reconnect`. Financial Accounts remain visible while `PATCH /api/open-finance-connections/:financialInstitution/financial-accounts/:accountName` with `{ "includedInTotals": false }` excludes them from `GET /api/consolidated-view/totals`.

`DELETE /api/open-finance-connections/:financialInstitution` revokes the provider link before removing the local connection and its cascading data. It stores an AES-256-GCM encrypted backup and sends only an operational revocation notification.
