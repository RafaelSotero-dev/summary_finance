import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

async function runningDashboard() {
  let sentLink: URL | undefined;
  const client: OpenFinanceConnectionClient = {
    async createConnection({ institution }) {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: institution, dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [{ name: `Conta ${institution}`, balance: institution === "Nubank" ? 1200 : 800, currency: "BRL" }],
        creditCards: institution === "Nubank" ? [{ id: "nubank-card", name: "Nubank Platinum", kind: "physical", currency: "BRL", statement: { amountDue: 40 } }] : [],
      };
    },
    async synchronizeTransactions({ connection }) {
      if (connection.financialInstitution.name === "Itaú") {
        return [{ id: "itau-expense", date: "2026-11-11", description: "Aluguel", amount: -300, currency: "BRL", pending: false, financialAccount: "Conta Itaú" }];
      }
      return [
        { id: "salary", date: "2026-11-10", description: "Salário", amount: 1000, currency: "BRL", pending: false, financialAccount: "Conta Nubank" },
        { id: "groceries", date: "2026-11-11", description: "Mercado", amount: -100, currency: "BRL", pending: false, financialAccount: "Conta Nubank" },
        { id: "restaurant", date: "2026-11-12", description: "Restaurante", amount: -40, currency: "BRL", pending: false, creditCardId: "nubank-card" },
        { id: "older", date: "2026-10-31", description: "Compra antiga", amount: -200, currency: "BRL", pending: false, financialAccount: "Conta Nubank" },
        { id: "last-year", date: "2025-11-11", description: "Mercado anterior", amount: -80, currency: "BRL", pending: false, financialAccount: "Conta Nubank" },
      ];
    },
  };
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
    openFinanceConnectionClient: client,
    baseUrl: "http://dashboard.test",
    sessionSecret: "test-secret",
    now: () => new Date("2026-11-12T15:00:00.000Z"),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, sentLink: () => sentLink, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("a Financial Owner can filter the dashboard and Transaction list by period, Financial Institution, Financial Account, Credit Card, type, and Transaction Category", async (t) => {
  const app = await runningDashboard();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const link = app.sentLink();
  assert.ok(link);
  const verified = await fetch(`${app.baseUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  for (const institution of ["Nubank", "Itaú"]) {
    await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution }) });
  }
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });

  const categoryResponse = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Alimentação" }) });
  const { category } = await categoryResponse.json() as { category: { id: string; name: string } };
  for (const id of ["groceries", "restaurant"]) {
    await fetch(`${app.baseUrl}/api/transactions/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ categoryId: category.id }) });
  }

  const dashboard = await fetch(`${app.baseUrl}/api/dashboard?period=this-month&financialInstitution=Nubank`, { headers: { cookie } });
  assert.deepEqual(await dashboard.json(), {
    consolidatedView: { financialInstitutions: [{ name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z", financialAccounts: [{ name: "Conta Nubank", balance: 1200, currency: "BRL" }], institutionCardStatement: { amountDue: 40, currency: "BRL", creditCards: [{ id: "nubank-card", name: "Nubank Platinum", kind: "physical", currency: "BRL", statement: { amountDue: 40 } }] } }] },
    report: {
      period: { startDate: "2026-11-01", endDate: "2026-11-12" },
      totals: { income: 1000, expenses: 140, net: 860 },
      temporalSeries: [{ date: "2026-11-10", income: 1000, expenses: 0, net: 1000 }, { date: "2026-11-11", income: 0, expenses: 100, net: -100 }, { date: "2026-11-12", income: 0, expenses: 40, net: -40 }],
      expenseDistribution: [{ category: { id: category.id, name: "Alimentação" }, amount: 140 }],
    },
  });

  const accountList = await fetch(`${app.baseUrl}/api/transactions?startDate=2026-11-01&endDate=2026-11-12&financialInstitution=Nubank&financialAccount=Conta%20Nubank&type=expense&categoryId=${category.id}`, { headers: { cookie } });
  assert.deepEqual((await accountList.json()).transactions.map((transaction: { id: string }) => transaction.id), ["groceries"]);
  const cardList = await fetch(`${app.baseUrl}/api/transactions?period=this-month&creditCard=nubank-card&type=expense&categoryId=${category.id}`, { headers: { cookie } });
  assert.deepEqual((await cardList.json()).transactions.map((transaction: { id: string }) => transaction.id), ["restaurant"]);
});

test("a Financial Owner sees Consolidated View data and can include Financial Accounts and Credit Cards in its totals", async (t) => {
  const app = await runningDashboard();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const link = app.sentLink();
  assert.ok(link);
  const verified = await fetch(`${app.baseUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual(await overview.json(), {
    financialOwner: { cpf: owner.cpf },
    consolidatedView: {
      financialInstitutions: [{
        name: "Nubank",
        dataFreshness: "2026-11-12T15:00:00.000Z",
        consentStatus: "active",
        financialAccounts: [{ name: "Conta Nubank", balance: 1200, currency: "BRL", includedInTotals: true }],
        institutionCardStatement: {
          amountDue: 40,
          currency: "BRL",
          creditCards: [{ id: "nubank-card", name: "Nubank Platinum", kind: "physical", currency: "BRL", statement: { amountDue: 40 } }],
        },
      }],
      creditCards: [],
    },
  });

  let totals = await fetch(`${app.baseUrl}/api/consolidated-view/summary`, { headers: { cookie } });
  assert.deepEqual(await totals.json(), { financialAccountBalance: 1200, creditCardStatementBalance: 40, netBalance: 1160 });

  await fetch(`${app.baseUrl}/api/open-finance-connections/Nubank/financial-accounts/Conta%20Nubank`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ includedInTotals: false }),
  });
  await fetch(`${app.baseUrl}/api/open-finance-connections/Nubank/credit-cards/nubank-card`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ includedInTotals: false }),
  });

  totals = await fetch(`${app.baseUrl}/api/consolidated-view/summary`, { headers: { cookie } });
  assert.deepEqual(await totals.json(), { financialAccountBalance: 0, creditCardStatementBalance: 0, netBalance: 0 });
});

test("a Financial Owner can compare daily expenses by Transaction Category", async (t) => {
  const app = await runningDashboard();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const link = app.sentLink();
  assert.ok(link);
  const verified = await fetch(`${app.baseUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  const categoryResponse = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Alimentação" }) });
  const { category } = await categoryResponse.json() as { category: { id: string; name: string } };
  for (const id of ["groceries", "restaurant"]) {
    await fetch(`${app.baseUrl}/api/transactions/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ categoryId: category.id }) });
  }

  const analysis = await fetch(`${app.baseUrl}/api/spending-analysis?granularity=day&startDate=2026-11-11&endDate=2026-11-12`, { headers: { cookie } });

  assert.deepEqual((await analysis.json()).historicalComparison, {
    granularity: "day",
    categories: [{
      category: { id: category.id, name: "Alimentação" },
      periods: [{ period: "2026-11-11", expenses: 100 }, { period: "2026-11-12", expenses: 40 }],
    }],
  });
});

test("Spending Analysis totals and Uncategorized Transactions honor its filters", async (t) => {
  const app = await runningDashboard();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const link = app.sentLink();
  assert.ok(link);
  const verified = await fetch(`${app.baseUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  for (const institution of ["Nubank", "Itaú"]) {
    await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution }) });
  }
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  const categoryResponse = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Alimentação" }) });
  const { category } = await categoryResponse.json() as { category: { id: string } };
  await fetch(`${app.baseUrl}/api/transactions/groceries`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ categoryId: category.id }) });

  const analysis = await fetch(`${app.baseUrl}/api/spending-analysis?startDate=2026-11-01&endDate=2026-11-12&financialInstitution=Nubank&financialAccount=Conta%20Nubank&type=expense&categoryId=${category.id}`, { headers: { cookie } });
  assert.deepEqual(await analysis.json(), { totals: { income: 0, expenses: 100, net: -100 }, uncategorizedTransactions: 0 });
});

test("a Financial Owner can compare monthly and yearly expenses for equivalent periods without forecasts or recommendations", async (t) => {
  const app = await runningDashboard();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const link = app.sentLink();
  assert.ok(link);
  const verified = await fetch(`${app.baseUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  const categoryResponse = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Alimentação" }) });
  const { category } = await categoryResponse.json() as { category: { id: string; name: string } };
  for (const id of ["groceries", "restaurant", "older", "last-year"]) {
    await fetch(`${app.baseUrl}/api/transactions/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ categoryId: category.id }) });
  }

  const monthly = await fetch(`${app.baseUrl}/api/spending-analysis?granularity=month&startDate=2025-11-01&endDate=2026-11-30`, { headers: { cookie } });
  assert.deepEqual((await monthly.json()).historicalComparison, {
    granularity: "month",
    categories: [{ category: { id: category.id, name: "Alimentação" }, periods: [
      { period: "2025-11", expenses: 80 },
      { period: "2026-10", expenses: 200 },
      { period: "2026-11", expenses: 140 },
    ] }],
  });

  const yearly = await fetch(`${app.baseUrl}/api/spending-analysis?granularity=year&equivalentPeriod=true&startDate=2025-11-11&endDate=2026-11-12`, { headers: { cookie } });
  const yearlyComparison = (await yearly.json()).historicalComparison;
  assert.deepEqual(yearlyComparison, {
    granularity: "year",
    categories: [{ category: { id: category.id, name: "Alimentação" }, periods: [
      { period: "2025", expenses: 80 },
      { period: "2026", expenses: 140 },
    ] }],
  });
  assert.equal("forecast" in yearlyComparison, false);
  assert.equal("recommendations" in yearlyComparison, false);
  assert.equal("paymentInstructions" in yearlyComparison, false);
});

test("a Financial Owner can view active Open Finance Connections with freshness, availability, and consent state", async (t) => {
  const app = await runningDashboard();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const link = app.sentLink();
  assert.ok(link);
  const verified = await fetch(`${app.baseUrl}${link.pathname}${link.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ institution: "Nubank", itemId: "pluggy-item-123" }),
  });

  const response = await fetch(`${app.baseUrl}/api/open-finance-connections`, { headers: { cookie } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    openFinanceConnections: [{
      financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
      dataAvailability: ["Financial Accounts", "Credit Cards", "Institution Card Statements", "Transactions"],
      consentStatus: "active",
      transactionsLastSynchronizedAt: null,
    }],
  });
});
