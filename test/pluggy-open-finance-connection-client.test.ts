import assert from "node:assert/strict";
import test from "node:test";

import { PluggyOpenFinanceConnectionClient } from "../src/pluggy-open-finance-connection-client.js";

test("Pluggy client reads a Meu Pluggy item without requesting a bank refresh", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new PluggyOpenFinanceConnectionClient(
    "https://api.pluggy.test",
    "client-id",
    "client-secret",
    async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/auth")) return Response.json({ apiKey: "api-key" });
      if (String(input).includes("/accounts?itemId=item-1")) {
        return Response.json({ results: [
          { id: "account-1", type: "BANK", name: "Conta corrente", balance: 1200, currencyCode: "BRL" },
          { id: "card-1", type: "CREDIT", name: "Cartão", balance: 50, currencyCode: "BRL", creditData: { creditLimit: 1000, availableCreditLimit: 950, balanceDueDate: "2026-12-10" } },
        ] });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  );

  const connection = await client.createConnection({
    financialOwnerCpf: "52998224725",
    institution: "Nubank",
    providerConnectionId: "item-1",
    consentScope: ["accounts", "credit_cards", "balances", "transactions", "invoices"],
  });

  assert.deepEqual(connection, {
    financialOwnerCpf: "52998224725",
    financialInstitution: { name: "Nubank", dataFreshness: connection.financialInstitution.dataFreshness },
    financialAccounts: [{ name: "Conta corrente", balance: 1200, currency: "BRL" }],
    creditCards: [{ id: "card-1", name: "Cartão", kind: "physical", currency: "BRL", totalLimit: 1000, usedLimit: 50, availableLimit: 950, statement: { amountDue: 50, dueDate: "2026-12-10" } }],
    providerConnectionId: "item-1",
  });
  assert.equal(requests.some(({ url }) => /\/items\/.*\/update/.test(url)), false);
});

test("Pluggy transaction import paginates the requested date window and normalizes Credit Card purchases as expenses", async () => {
  const requests: string[] = [];
  const client = new PluggyOpenFinanceConnectionClient("https://api.pluggy.test", "client-id", "client-secret", async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth")) return Response.json({ apiKey: "api-key" });
    if (url.includes("/accounts?itemId=item-1")) return Response.json({ results: [{ id: "card-1", type: "CREDIT", name: "Cartão", balance: 0, currencyCode: "BRL" }] });
    if (url.includes("cursor=next")) return Response.json({ results: [{ id: "refund", date: "2026-11-12", description: "Estorno", amount: -20, currencyCode: "BRL" }] });
    if (url.includes("/transactions?")) return Response.json({ results: [{ id: "purchase", date: "2026-11-11", description: "Mercado", amount: 50, currencyCode: "BRL" }], nextCursor: "next" });
    throw new Error(`Unexpected request: ${url}`);
  });

  const transactions = await client.synchronizeTransactions({
    connection: { financialOwnerCpf: "52998224725", financialInstitution: { name: "Nubank", dataFreshness: "2026-11-13T00:00:00.000Z" }, financialAccounts: [], providerConnectionId: "item-1" },
    since: new Date("2026-11-01T00:00:00.000Z"),
    until: new Date("2026-11-13T00:00:00.000Z"),
  });

  assert.deepEqual(transactions.map(({ id, amount }) => ({ id, amount })), [{ id: "purchase", amount: -50 }, { id: "refund", amount: 20 }]);
  assert.equal(requests.filter((request) => request.includes("/transactions?")).length, 2);
  assert.match(requests.find((request) => request.includes("/transactions?"))!, /from=2026-11-01&to=2026-11-13/);
});
