import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

class MemoryAuthStore implements AuthStore {
  owners = [owner];

  async findVerifiedFinancialOwner(cpf: string, email: string) {
    return this.owners.find((candidate) => candidate.cpf === cpf && candidate.email === email) ?? null;
  }
}

async function runningApp(openFinanceConnectionClient?: OpenFinanceConnectionClient, now?: () => Date) {
  let sentLink: URL | undefined;
  const sender: MagicLinkSender = {
    async sendMagicLink(_email, link) {
      sentLink = new URL(link);
    },
  };
  const app = createApp({
    authStore: new MemoryAuthStore(),
    magicLinkSender: sender,
    baseUrl: "http://dashboard.test",
    sessionSecret: "test-secret",
    openFinanceConnectionClient,
    now,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    get sentLink() {
      return sentLink;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("a verified Financial Owner can access an empty Consolidated View with a magic link", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  const requested = await fetch(`${app.baseUrl}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(owner),
  });
  assert.equal(requested.status, 202);
  assert.ok(app.sentLink);

  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  assert.equal(verified.status, 302);
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual(await overview.json(), {
    financialOwner: { cpf: owner.cpf },
    consolidatedView: { financialInstitutions: [], creditCards: [] },
  });
});

test("a Financial Owner can connect a Financial Institution with the approved Consent Scope and see its Financial Accounts", async (t) => {
  let requestedConsentScope: readonly string[] | undefined;
  const app = await runningApp({
    async createConnection(request) {
      requestedConsentScope = request.consentScope;
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [{ name: "Conta do Nubank", balance: 1234.56, currency: "BRL" }],
      };
    },
  }, () => new Date("2026-11-12T15:00:00.000Z"));
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(owner),
  });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  const connected = await fetch(`${app.baseUrl}/api/open-finance-connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ institution: "Nubank" }),
  });
  assert.equal(connected.status, 201);
  assert.deepEqual(requestedConsentScope, ["accounts", "credit_cards", "balances", "transactions", "invoices"]);

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual(await overview.json(), {
    financialOwner: { cpf: owner.cpf },
    consolidatedView: {
      financialInstitutions: [{
        name: "Nubank",
        dataFreshness: "2026-11-12T15:00:00.000Z",
        financialAccounts: [{ name: "Conta do Nubank", balance: 1234.56, currency: "BRL" }],
      }],
      creditCards: [],
    },
  });

  const page = await fetch(`${app.baseUrl}/`, { headers: { cookie } });
  const pageHtml = await page.text();
  assert.match(pageHtml, /Nubank/);
  assert.match(pageHtml, /Conta do Nubank/);
  assert.match(pageHtml, /R\$\s?1\.234,56/);
});

test("a Financial Owner can manually synchronize and search imported Transactions", async (t) => {
  const synchronizedSince: Date[] = [];
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
      };
    },
    async synchronizeTransactions(request) {
      synchronizedSince.push(request.since);
      return [{
        id: "transaction-1",
        date: "2026-11-10",
        description: "Padaria Central",
        amount: -25.5,
        currency: "BRL",
        pending: false,
      }];
    },
  }, () => new Date("2026-11-12T15:00:00.000Z"));
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(owner),
  });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  await fetch(`${app.baseUrl}/api/open-finance-connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ institution: "Nubank" }),
  });

  const synchronized = await fetch(`${app.baseUrl}/api/transactions/synchronize`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(synchronized.status, 200);
  assert.equal(synchronizedSince.length, 1);
  assert.equal(synchronizedSince[0].toISOString(), "2025-11-12T00:00:00.000Z");

  const transactions = await fetch(`${app.baseUrl}/api/transactions?search=padaria`, { headers: { cookie } });
  assert.deepEqual(await transactions.json(), {
    transactions: [{
      id: "transaction-1",
      financialInstitution: "Nubank",
      date: "2026-11-10",
      description: "Padaria Central",
       amount: -25.5,
       currency: "BRL",
       pending: false,
       merchant: "Padaria Central",
       categoryId: null,
       classification: "standard",
     }],
    pendingTransactions: [],
  });
});

test("a confirmed Transaction replaces its Pending Transaction record without duplicating it", async (t) => {
  let synchronization = 0;
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
      };
    },
    async synchronizeTransactions() {
      synchronization += 1;
      return [{
        id: "transaction-1",
        date: "2026-11-10",
        description: "Mercado",
        amount: -100,
        currency: "BRL",
        pending: synchronization === 1,
      }];
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  const pending = await fetch(`${app.baseUrl}/api/transactions`, { headers: { cookie } });
  assert.equal((await pending.json()).pendingTransactions.length, 1);

  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  const confirmed = await fetch(`${app.baseUrl}/api/transactions`, { headers: { cookie } });
  const result = await confirmed.json();
  assert.equal(result.transactions.length, 1);
  assert.equal(result.pendingTransactions.length, 0);
});

test("a Financial Owner cannot save a connection belonging to a different CPF", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: "11111111111",
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
      };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(owner),
  });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  const connected = await fetch(`${app.baseUrl}/api/open-finance-connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ institution: "Nubank" }),
  });
  assert.equal(connected.status, 403);

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual((await overview.json()).consolidatedView.financialInstitutions, []);
});

test("an unauthenticated visitor cannot access the Consolidated View", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  const overview = await fetch(`${app.baseUrl}/api/overview`);
  assert.equal(overview.status, 401);
});

test("a Financial Owner can organize a two-level Category Hierarchy", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  const expenses = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Despesas" }) });
  assert.equal(expenses.status, 201);
  const { category: parent } = await expenses.json() as { category: { id: string } };

  const food = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Alimentação", parentCategoryId: parent.id }) });
  assert.equal(food.status, 201);
  const { category: child } = await food.json() as { category: { id: string } };

  const renamed = await fetch(`${app.baseUrl}/api/categories/${child.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Restaurantes", archived: true }) });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { category: { id: child.id, name: "Restaurantes", parentCategoryId: parent.id, archived: true } });

  const categories = await fetch(`${app.baseUrl}/api/categories`, { headers: { cookie } });
  assert.deepEqual(await categories.json(), { categories: [
    { id: parent.id, name: "Despesas", parentCategoryId: null, archived: false },
    { id: child.id, name: "Restaurantes", parentCategoryId: parent.id, archived: true },
  ] });

  const thirdLevel = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Jantar", parentCategoryId: child.id }) });
  assert.equal(thirdLevel.status, 400);
});

test("a Financial Owner can review categorization suggestions and analyze Transactions without transfers or refunds as income", async (t) => {
  let synchronization = 0;
  const app = await runningApp({
    async createConnection() {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" }, financialAccounts: [] };
    },
    async synchronizeTransactions() {
      synchronization += 1;
      return synchronization === 1 ? [
        { id: "meal", date: "2026-11-10", description: "Padaria Central", amount: -100, currency: "BRL", pending: false },
        { id: "uncategorized", date: "2026-11-10", description: "Farmácia", amount: -10, currency: "BRL", pending: false },
        { id: "transfer", date: "2026-11-10", description: "Transferência", amount: -200, currency: "BRL", pending: false },
        { id: "refund", date: "2026-11-10", description: "Estorno", amount: 30, currency: "BRL", pending: false },
        { id: "salary", date: "2026-11-10", description: "Salário", amount: 1000, currency: "BRL", pending: false },
      ] : [{ id: "next-meal", date: "2026-11-11", description: "Padaria Central", amount: -20, currency: "BRL", pending: false }];
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });

  const categoryResponse = await fetch(`${app.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Alimentação" }) });
  const { category } = await categoryResponse.json() as { category: { id: string } };
  const corrected = await fetch(`${app.baseUrl}/api/transactions/meal`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ merchant: "Padaria da Ana", categoryId: category.id }) });
  assert.deepEqual(await corrected.json(), { transaction: { id: "meal", date: "2026-11-10", description: "Padaria Central", amount: -100, currency: "BRL", pending: false, financialInstitution: "Nubank", merchant: "Padaria da Ana", categoryId: category.id, classification: "standard" } });

  await fetch(`${app.baseUrl}/api/transactions/transfer`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ classification: "internal-transfer" }) });
  await fetch(`${app.baseUrl}/api/transactions/refund`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ classification: "refund" }) });
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });

  const transactions = await fetch(`${app.baseUrl}/api/transactions`, { headers: { cookie } });
  const result = await transactions.json() as { transactions: Array<{ id: string; suggestedMerchant?: string; suggestedCategoryId?: string }> };
  assert.deepEqual(result.transactions.find((transaction) => transaction.id === "next-meal"), { id: "next-meal", date: "2026-11-11", description: "Padaria Central", amount: -20, currency: "BRL", pending: false, financialInstitution: "Nubank", merchant: "Padaria Central", categoryId: null, classification: "standard", suggestedMerchant: "Padaria da Ana", suggestedCategoryId: category.id });

  const analysis = await fetch(`${app.baseUrl}/api/spending-analysis`, { headers: { cookie } });
  assert.deepEqual(await analysis.json(), { totals: { income: 1000, expenses: 100, net: 900 }, uncategorizedTransactions: 2 });
});

test("a magic link is sent only to the Financial Owner's verified email", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  const requested = await fetch(`${app.baseUrl}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cpf: owner.cpf, email: "unverified@example.com" }),
  });
  assert.equal(requested.status, 202);
  assert.equal(app.sentLink, undefined);
});
