# Pluggy Open Finance / Meu Pluggy — research

**Scope and method.** Findings below use Pluggy-owned product pages and
documentation only, checked 2026-11-13. This is relevant to a
Brazil-only, personal-finance application; it is **not** a recommendation
to use Pluggy for a multi-customer product.

## Bottom line

The claimed permanent free tier exists, but it is **Meu Pluggy personal
use**, not Pluggy's production Data API plan: it is free for an individual's
own data, no due diligence, does not expire with the trial, permits up to
five connections, and prohibits commercial use. A production application
that onboards its own customers instead has a 15-day trial and then a paid
Data plan (advertised from R$2,500/month). [Personal-use guide][personal]
[Pricing][pricing]

The pricing page narrows the five-connection wording to “up to 5 active
connections from the same account holder.” The technical personal-use guide
says only “up to 5 connections.” Treat the **same-account-holder condition
as applicable**, but confirm enforcement/edge cases with Pluggy. [Pricing][pricing]
[Personal-use guide][personal]

## Plan, refresh, and freshness

| Topic | Verified finding |
| --- | --- |
| Permanent free use | Meu Pluggy is free, personal-use-only, and is explicitly separate from a company product integration. The normal API has a free sandbox with no time limit, but real production access is a 15-day trial, not permanently free. [Personal-use guide][personal] [Pricing][pricing] |
| Daily refresh | A bank connection created **inside Meu Pluggy** refreshes automatically every 24 hours at no charge. [Item documentation][item] |
| App-side proxy Item | An application connects to the `MeuPluggy` connector; its Item mirrors the original Meu Pluggy Item, receives its updates and webhooks, but has no auto-sync of its own and **cannot be manually updated**. [Personal-use guide][personal] [Item documentation][item] |
| New transaction latency | Pluggy says data is not real-time; it appears after a connection update. Regulated Open Finance transactions can take up to 24 hours to become available. [FAQ][faq] |
| Manual refresh generally | For ordinary Items, a real-time update can be requested through the widget or API; user input/MFA or new credentials may be required. Direct API updates for newly created teams are limited to once per hour, while widget updates are not subject to that limit. **This does not apply to MeuPluggy proxy Items.** [Data-sync guide][data-sync] [Update-widget guide][update-widget] |

**Ambiguity worth preserving:** Pluggy also documents production auto-sync
as a subscription-configured 24/12/8-hour feature. That applies to normal
production Items, whereas the free 24-hour statement applies to the original
Meu Pluggy connection. Do not model the proxy Item as independently
refreshable. [Item documentation][item]

## Read-only data surface

Pluggy's public Data API documents read endpoints for connected data; the
personal-use guide demonstrates `GET /accounts?itemId=…` and
`GET /transactions?accountId=…`. It does **not** establish that every API
endpoint in an application is read-only (Pluggy also sells payment products);
restrict this integration to the data endpoints. [Personal-use guide][personal]
[Pricing][pricing]

| Resource | What first-party docs establish |
| --- | --- |
| Accounts and balances | The account product returns bank (checking/savings) and credit-card accounts. `balance` is the available balance for bank accounts; for credit it is the open unpaid invoice balance (and, on regulated Open Finance, the used limit). [Accounts][accounts] |
| Transactions | Transactions are available for `BANK` and `CREDIT` accounts, with up to 12 months of history and cursor pagination. Pending card purchases/future installments are `PENDING`; credit-card charges are positive and payments negative. [Transactions][transactions] |
| Credit cards | Cards are represented as credit accounts (`type: CREDIT`, `subtype: CREDIT_CARD`) with last four digits, limits, due/close dates and card metadata where supplied. [Accounts][accounts] |
| Invoices/bills | The Bill entity represents a credit-card invoice, including due date, total, minimum payment, finance charges and recorded payments. It is mandatory for regulated Open Finance connections; direct-connection coverage is narrower. Open bills may not be returned until closed or overdue, depending on the institution. [Credit-card bills][bills] [Open-Finance considerations][of-considerations] |

Actual resources vary by connector, subscription and user consent. Pluggy
lists `ACCOUNTS`, `CREDIT_CARDS`, and `TRANSACTIONS` among supported Open
Finance products and says to inspect each connector's returned product list.
The docs do **not** explicitly promise that every Meu Pluggy connection
exposes all four resources above. [Open Finance overview][of-overview]

## Connection lifecycle: link, reconnect, consent, revoke

1. The user authorizes each bank separately in Meu Pluggy (bank-side
   CPF/app approval). The app then links through the MeuPluggy connector,
   using the same Pluggy account. Each bank becomes an app Item. [Personal-use guide][personal]
2. Store the resulting `itemId`: Meu Pluggy accounts cannot use `GET
   /v2/items` to enumerate Items. [Personal-use guide][personal]
3. A general Pluggy reconnect/update normally reuses the existing Item;
   reauthorizing an expired/revoked consent uses `PATCH`/the update widget
   and user interaction. A new connection otherwise creates a new Item.
   [Consents][consents] [FAQ][faq]
4. For the personal MeuPluggy app authorization specifically, authorization
   lasts one year; then reads return empty, the next update becomes
   `LOGIN_ERROR`/`USER_AUTHORIZATION_EXPIRED`, and the user must sign in
   and grant access again. A refresh cannot renew it. [Personal-use guide][personal]
5. Deleting an Item via `DELETE /items/{id}` ends the connection and removes
   associated data; Pluggy also says a user can revoke an Open Finance
   consent in the bank app, after which data endpoints are empty. [FAQ][faq]
   [Consents][consents]

**Unverified for this exact path:** the public docs do not clearly state
whether deleting the *app proxy Item* also revokes/deletes the underlying
Meu Pluggy bank connection, or whether that must be managed in Meu Pluggy.
Treat those as separate lifecycle operations until Pluggy confirms otherwise.

## Notifications and polling

Webhooks are supported: configure an HTTPS `webhookUrl` when making the
Connect Token/Item, or create a webhook subscription. Item events include
created, updated, deleted, errors and user-action states; transaction events
include created, updated and deleted. The recommended response is to treat a
notification as a signal and re-read the resource with the API. [Webhooks][webhooks]

Delivery requires a 2XX response within 10 seconds and is attempted up to
three times (with documented exceptions). For a personal app, webhooks are
useful, but periodic reads after the 24-hour update remain a viable
polling-style consumer pattern. The docs do not provide a documented polling
interval or a change-feed endpoint for Meu Pluggy. [Webhooks][webhooks]

## Authentication and production constraints

- Server-side: exchange Dashboard `clientId` and `clientSecret` at `POST
  /auth` for a full-scope API key (two-hour lifetime). Keep these secrets on
  the server. [Authentication][auth]
- Client-side linking: the server creates a Connect Token (30-minute
  lifetime); it is scoped to its Item/reduced account access and is the
  credential intended for the Connect Widget. [Authentication][auth]
- Normal production applications have distinct credentials from development;
  development is capped at 100 Items. Production provides automatic updates
  and unlimited Items, but the commercial plan applies. [FAQ][faq]
- Open Finance connectors are labelled a premium feature requiring sales
  enablement for a plan. This conflicts in appearance with the free
  personal-use route, which uses the distinct MeuPluggy connector. Do not
  assume free personal use grants generic regulated-connector access.
  [Open Finance overview][of-overview] [Personal-use guide][personal]
- Regulated Open Finance has network limits shared by CPF/CNPJ, institution,
  and product. Duplicating Items accelerates exhaustion; for example, recent
  account/card transactions are limited to 240 fetches/month and balances to
  420/month. [Open Finance rate limits][of-limits]
- Webhook receiver URLs must be public HTTPS; webhook configuration can
  include a secret header only for explicitly created webhook subscriptions,
  not an Item/Connect-Token `webhookUrl`. [Webhooks][webhooks]

## Decision-relevant unknowns

1. The sources confirm a personal-use route, not whether a local
   single-person desktop/mobile application meets Pluggy's interpretation of
   “app only you use”; confirm with Pluggy before release.
2. No first-party source found guarantees that all target Brazilian
   institutions, card bills, or every account type are available through
   MeuPluggy. Validate the live connector/product list and actual consented
   resources for target banks.
3. No source found states a service-level guarantee for the 24-hour refresh
   or webhook delivery; the documented cadence is not a real-time SLA.

[personal]: https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use
[pricing]: https://www.pluggy.ai/en/pricing
[item]: https://docs.pluggy.ai/en/docs/connections/item
[accounts]: https://docs.pluggy.ai/en/docs/products/accounts
[transactions]: https://docs.pluggy.ai/en/docs/products/transactions
[bills]: https://docs.pluggy.ai/en/docs/products/credit-card-bills
[of-considerations]: https://docs.pluggy.ai/en/docs/open-finance/considerations-faq
[of-overview]: https://docs.pluggy.ai/en/docs/open-finance/overview
[data-sync]: https://docs.pluggy.ai/en/docs/integration-checklist/data-sync
[update-widget]: https://docs.pluggy.ai/en/docs/connect-widget/updating-item
[faq]: https://docs.pluggy.ai/en/docs/get-started/faq
[consents]: https://docs.pluggy.ai/en/docs/connections/consents
[webhooks]: https://docs.pluggy.ai/en/docs/developer-tools/webhooks-ref
[auth]: https://docs.pluggy.ai/en/docs/authentication
[of-limits]: https://docs.pluggy.ai/en/docs/open-finance/rate-limits
