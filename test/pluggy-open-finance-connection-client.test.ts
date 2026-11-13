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
