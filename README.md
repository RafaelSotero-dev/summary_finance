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
