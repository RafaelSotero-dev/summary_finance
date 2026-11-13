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
