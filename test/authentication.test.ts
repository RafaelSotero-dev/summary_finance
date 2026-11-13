import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type EncryptedBackupStore, type MagicLinkSender, type OpenFinanceConnectionClient, type OperationalNotifier } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

class MemoryAuthStore implements AuthStore {
  owners = [owner];

  async findVerifiedFinancialOwner(cpf: string, email: string) {
    return this.owners.find((candidate) => candidate.cpf === cpf && candidate.email === email) ?? null;
  }
}

async function runningApp(openFinanceConnectionClient?: OpenFinanceConnectionClient, now?: () => Date, options: { encryptedBackupStore?: EncryptedBackupStore; operationalNotifier?: OperationalNotifier } = {}) {
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
    ...options,
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

test("the React login shell is served at /login and private SPA routes", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  const login = await fetch(`${app.baseUrl}/login`);

  assert.equal(login.status, 200);
  const page = await login.text();
  assert.match(page, /<div id="root"><\/div>/);
  assert.match(page, /<script type="module"(?: crossorigin)? src="\/assets\/.+\.js"><\/script>/);

  const transactions = await fetch(`${app.baseUrl}/transactions`);
  assert.equal(transactions.status, 200);
  assert.equal(await transactions.text(), page);
});

test("SPA fallback does not intercept API or authentication routes", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  const api = await fetch(`${app.baseUrl}/api/unknown`);
  assert.equal(api.status, 404);
  assert.doesNotMatch(await api.text(), /id="root"/);

  const auth = await fetch(`${app.baseUrl}/auth/unknown`);
  assert.equal(auth.status, 404);
  assert.doesNotMatch(await auth.text(), /id="root"/);
});

test("a Financial Owner can connect a Financial Institution with the approved Consent Scope and see its Financial Accounts", async (t) => {
  let requestedConsentScope: readonly string[] | undefined;
  const app = await runningApp({
    async createConnection(request) {
      requestedConsentScope = request.consentScope;
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
         financialAccounts: [{ name: "Conta do Nubank", balance: 1234.56, currency: "BRL", includedInTotals: true }],
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
        consentStatus: "active",
        financialAccounts: [{ name: "Conta do Nubank", balance: 1234.56, currency: "BRL", includedInTotals: true }],
      }],
      creditCards: [],
    },
  });

  const shell = await fetch(`${app.baseUrl}/`, { headers: { cookie } });
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<div id="root"><\/div>/);
});

test("a Meu Pluggy creation failure is a safe and actionable API error", async (t) => {
  const app = await runningApp({
    async createConnection() {
      throw new Error("provider token: private-value");
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  const response = await fetch(`${app.baseUrl}/api/open-finance-connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ institution: "Nubank", itemId: "item-123" }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Não foi possível concluir a operação com o Meu Pluggy. Confira o item ID e tente novamente mais tarde.",
  });
});

test("a Financial Owner cannot link more than five Open Finance Connections", async (t) => {
  const app = await runningApp({
    async createConnection({ institution, providerConnectionId }) {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: institution, dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
        providerConnectionId,
      };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);

  for (let number = 1; number <= 5; number += 1) {
    const connected = await fetch(`${app.baseUrl}/api/open-finance-connections`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ institution: `Instituição ${number}`, itemId: `item-${number}` }),
    });
    assert.equal(connected.status, 201);
  }
  const rejected = await fetch(`${app.baseUrl}/api/open-finance-connections`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ institution: "Sexta", itemId: "item-6" }),
  });
  assert.equal(rejected.status, 409);
});

test("the overview API reports a Financial Institution with no Financial Accounts", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" }, financialAccounts: [] };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual((await overview.json()).consolidatedView.financialInstitutions[0].financialAccounts, []);
});

test("a Financial Owner cannot start a second manual synchronization while one is running", async (t) => {
  let releaseSynchronization: (() => void) | undefined;
  let startedSynchronization: (() => void) | undefined;
  const synchronizationStarted = new Promise<void>((resolve) => { startedSynchronization = resolve; });
  const app = await runningApp({
    async createConnection() {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" }, financialAccounts: [] };
    },
    async synchronizeTransactions() {
      startedSynchronization?.();
      await new Promise<void>((resolve) => { releaseSynchronization = resolve; });
      return [];
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const first = fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  await synchronizationStarted;
  const second = await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  assert.equal(second.status, 409);
  releaseSynchronization?.();
  assert.equal((await first).status, 200);
});

test("synchronization refreshes Financial Account balances, Credit Card limits and statements, and Data Freshness", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-10T10:00:00.000Z" },
        financialAccounts: [{ name: "Conta", balance: 100, currency: "BRL" }],
        creditCards: [{ id: "card", name: "Card", kind: "physical", currency: "BRL", totalLimit: 1000, statement: { amountDue: 50 } }],
      };
    },
    async synchronizeTransactions() { return []; },
    async refreshConnection(connection) {
      return {
        ...connection,
        financialInstitution: { ...connection.financialInstitution, dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [{ name: "Conta", balance: 200, currency: "BRL" }],
        creditCards: [{ id: "card", name: "Card", kind: "physical", currency: "BRL", totalLimit: 2000, statement: { amountDue: 75 } }],
      };
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

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  const institution = (await overview.json()).consolidatedView.financialInstitutions[0];
  assert.equal(institution.dataFreshness, "2026-11-12T15:00:00.000Z");
  assert.equal(institution.financialAccounts[0].balance, 200);
  assert.deepEqual(institution.institutionCardStatement, { amountDue: 75, currency: "BRL", creditCards: [{ id: "card", name: "Card", kind: "physical", currency: "BRL", totalLimit: 2000, statement: { amountDue: 75 } }] });
});

test("a Financial Owner can view an Institution Card Statement aggregated and detailed by physical and virtual Credit Card", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
        creditCards: [
          {
            id: "physical-card",
            name: "Nubank Platinum",
            kind: "physical",
            currency: "BRL",
            totalLimit: 5000,
            usedLimit: 1200,
            availableLimit: 3800,
            statement: { amountDue: 1200, dueDate: "2026-11-20" },
          },
          {
            id: "virtual-card",
            name: "Nubank Virtual",
            kind: "virtual",
            currency: "BRL",
            statement: { amountDue: 300, dueDate: "2026-11-20" },
          },
        ],
      };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  const result = await overview.json();
  assert.deepEqual(result.consolidatedView.financialInstitutions[0].institutionCardStatement, {
    amountDue: 1500,
    currency: "BRL",
    dueDate: "2026-11-20",
    creditCards: [
      { id: "physical-card", name: "Nubank Platinum", kind: "physical", currency: "BRL", totalLimit: 5000, usedLimit: 1200, availableLimit: 3800, statement: { amountDue: 1200, dueDate: "2026-11-20" } },
      { id: "virtual-card", name: "Nubank Virtual", kind: "virtual", currency: "BRL", statement: { amountDue: 300, dueDate: "2026-11-20" } },
    ],
  });
});

test("an Institution Card Statement aggregates Credit Cards from the same Financial Institution", async (t) => {
  let connectionCount = 0;
  const app = await runningApp({
    async createConnection() {
      connectionCount += 1;
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
        creditCards: [{ id: `card-${connectionCount}`, name: `Nubank Card ${connectionCount}`, kind: "physical", currency: "BRL", statement: { amountDue: connectionCount * 100 } }],
      };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  for (const institution of ["Nubank", "Nubank"]) {
    await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution }) });
  }

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  const result = await overview.json();
  assert.equal(result.consolidatedView.financialInstitutions.length, 1);
  assert.equal(result.consolidatedView.financialInstitutions[0].institutionCardStatement.amountDue, 300);
  assert.equal(result.consolidatedView.financialInstitutions[0].institutionCardStatement.creditCards.length, 2);
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
  const listed = await transactions.json() as { transactions: Array<{ id: string; description: string }> };
  assert.equal(listed.transactions[0].description, "Padaria Central");
  assert.match(listed.transactions[0].id, /^transaction-/);
});

test("an Installment Purchase identifies its original purchase and a Card Statement Settlement has no expense amount", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
      };
    },
    async synchronizeTransactions() {
      return [
        { id: "purchase-1", date: "2026-11-01", description: "Notebook", amount: -500, currency: "BRL", pending: false },
        {
          id: "purchase-1-installment-2",
          date: "2026-12-01",
          description: "Notebook 2/10",
          amount: -500,
          currency: "BRL",
          pending: false,
          installmentPurchase: { originalTransactionId: "purchase-1", installmentNumber: 2, totalInstallments: 10 },
        },
        { id: "settlement-1", date: "2026-11-20", description: "Pagamento de fatura", amount: -1000, currency: "BRL", pending: false, cardStatementSettlement: true },
      ];
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

  const transactions = await fetch(`${app.baseUrl}/api/transactions`, { headers: { cookie } });
  const result = await transactions.json();
  assert.deepEqual(result.transactions.find((transaction: { description: string }) => transaction.description === "Notebook 2/10").installmentPurchase, {
    originalTransactionId: "purchase-1",
    installmentNumber: 2,
    totalInstallments: 10,
  });
  assert.equal(result.transactions.find((transaction: { description: string }) => transaction.description === "Pagamento de fatura").expenseAmount, 0);

  const analysis = await fetch(`${app.baseUrl}/api/spending-analysis`, { headers: { cookie } });
  assert.equal((await analysis.json()).totals.expenses, 1000);
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

test("a failed Open Finance synchronization retains the last data freshness and can be reconnected", async (t) => {
  let synchronizationFails = true;
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-10T10:00:00.000Z" },
        financialAccounts: [{ name: "Conta", balance: 100, currency: "BRL" }],
        providerConnectionId: "nubank-link",
      };
    },
    async synchronizeTransactions() {
      if (synchronizationFails) throw new Error("Consent expired");
      return [];
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const synchronization = await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  assert.deepEqual(await synchronization.json(), { imported: 0, failedConnections: ["Nubank"] });

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual((await overview.json()).consolidatedView.financialInstitutions, [{
    name: "Nubank",
    dataFreshness: "2026-11-10T10:00:00.000Z",
    consentStatus: "reconnection-required",
    financialAccounts: [{ name: "Conta", balance: 100, currency: "BRL", includedInTotals: true }],
  }]);

  synchronizationFails = false;
  const reconnected = await fetch(`${app.baseUrl}/api/open-finance-connections/Nubank/reconnect`, { method: "POST", headers: { cookie } });
  assert.equal(reconnected.status, 200);
  assert.deepEqual(await reconnected.json(), { financialInstitution: { name: "Nubank", dataFreshness: "2026-11-10T10:00:00.000Z" } });
});

test("a Financial Owner can exclude a Financial Account from Consolidated View totals without removing it", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [
          { name: "Conta diária", balance: 100, currency: "BRL" },
          { name: "Reserva", balance: 900, currency: "BRL" },
        ],
      };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const hidden = await fetch(`${app.baseUrl}/api/open-finance-connections/Nubank/financial-accounts/Reserva`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ includedInTotals: false }),
  });
  assert.equal(hidden.status, 200);
  assert.deepEqual(await hidden.json(), { financialAccount: { name: "Reserva", balance: 900, currency: "BRL", includedInTotals: false } });

  const totals = await fetch(`${app.baseUrl}/api/consolidated-view/totals`, { headers: { cookie } });
  assert.deepEqual(await totals.json(), { financialAccountBalance: 100 });
  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.equal((await overview.json()).consolidatedView.financialInstitutions[0].financialAccounts.length, 2);
});

test("a Financial Owner can exclude a Credit Card from an Institution Card Statement without removing it", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return {
        financialOwnerCpf: owner.cpf,
        financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
        financialAccounts: [],
        creditCards: [
          { id: "included-card", name: "Included Card", kind: "physical", currency: "BRL", statement: { amountDue: 100 } },
          { id: "hidden-card", name: "Hidden Card", kind: "virtual", currency: "BRL", statement: { amountDue: 900 } },
        ],
      };
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const hidden = await fetch(`${app.baseUrl}/api/open-finance-connections/Nubank/credit-cards/hidden-card`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ includedInTotals: false }),
  });
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json()).creditCard.includedInTotals, false);

  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  const statement = (await overview.json()).consolidatedView.financialInstitutions[0].institutionCardStatement;
  assert.equal(statement.amountDue, 100);
  assert.deepEqual(statement.creditCards.map((card: { id: string }) => card.id), ["included-card", "hidden-card"]);
  assert.equal(statement.creditCards[1].includedInTotals, false);
});

test("disconnecting an Open Finance Connection preserves its local history while excluding current values", async (t) => {
  const backups: string[] = [];
  const notifications: string[] = [];
  let revokedProviderConnection: string | undefined;
  const app = await runningApp({
    async createConnection() {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" }, financialAccounts: [{ name: "Conta", balance: 100, currency: "BRL" }], providerConnectionId: "link-1" };
    },
    async revokeConnection({ providerConnectionId }) {
      revokedProviderConnection = providerConnectionId;
    },
  }, undefined, {
    encryptedBackupStore: { async saveEncryptedBackup(_cpf, encryptedBackup) { backups.push(encryptedBackup); } },
    operationalNotifier: { async sendConnectionRevoked(_cpf, financialInstitution) { notifications.push(financialInstitution); } },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(app.sentLink);
  const verified = await fetch(`${app.baseUrl}${app.sentLink.pathname}${app.sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  await fetch(`${app.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution: "Nubank" }) });

  const revoked = await fetch(`${app.baseUrl}/api/open-finance-connections/Nubank`, { method: "DELETE", headers: { cookie } });
  assert.equal(revoked.status, 204);
  assert.equal(revokedProviderConnection, undefined);
  assert.deepEqual(notifications, []);
  assert.equal(backups.length, 0);
  const overview = await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie } });
  assert.deepEqual((await overview.json()).consolidatedView.financialInstitutions, []);
  const connections = await fetch(`${app.baseUrl}/api/open-finance-connections`, { headers: { cookie } });
  assert.equal((await connections.json()).openFinanceConnections[0].consentStatus, "disconnected");
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
  const correctedTransaction = (await corrected.json() as { transaction: { id: string; merchant: string; categoryId: string } }).transaction;
  assert.match(correctedTransaction.id, /^transaction-/);
  assert.deepEqual({ merchant: correctedTransaction.merchant, categoryId: correctedTransaction.categoryId }, { merchant: "Padaria da Ana", categoryId: category.id });

  await fetch(`${app.baseUrl}/api/transactions/transfer`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ classification: "internal-transfer" }) });
  await fetch(`${app.baseUrl}/api/transactions/refund`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ classification: "refund" }) });
  await fetch(`${app.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });

  const transactions = await fetch(`${app.baseUrl}/api/transactions`, { headers: { cookie } });
  const result = await transactions.json() as { transactions: Array<{ id: string; suggestedMerchant?: string; suggestedCategoryId?: string }> };
  assert.deepEqual(result.transactions.find((transaction) => transaction.suggestedMerchant === "Padaria da Ana")?.suggestedCategoryId, category.id);

  const analysis = await fetch(`${app.baseUrl}/api/spending-analysis`, { headers: { cookie } });
  assert.deepEqual(await analysis.json(), { totals: { income: 1000, expenses: 100, net: 900 }, uncategorizedTransactions: 2 });
});

test("a Financial Owner can export currently filtered Transactions as a private CSV download", async (t) => {
  const app = await runningApp({
    async createConnection() {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" }, financialAccounts: [] };
    },
    async synchronizeTransactions() {
      return [
        { id: "groceries", date: "2026-11-10", description: "Mercado Central", amount: -123.45, currency: "BRL", pending: false, financialAccountOrCreditCard: "Cartão Platinum" },
        { id: "other", date: "2026-11-11", description: "Farmácia", amount: -20, currency: "BRL", pending: true, financialAccountOrCreditCard: "Conta corrente" },
      ];
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
  await fetch(`${app.baseUrl}/api/transactions/groceries`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ categoryId: category.id }) });

  const exported = await fetch(`${app.baseUrl}/api/transactions/export?search=mercado&financialInstitution=Nubank`, { headers: { cookie } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="transacoes\.csv"$/);
  assert.equal(await exported.text(), "Data,Valor,Instituição Financeira,Conta Financeira ou Cartão,Categoria,Status\r\n2026-11-10,-123.45,Nubank,Cartão Platinum,Alimentação,Confirmada\r\n");
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

test("a magic link is single-use, supersedes unused links, and an active session can be revoked without revoking another device", async (t) => {
  let currentTime = new Date("2026-11-13T12:00:00.000Z");
  const app = await runningApp(undefined, () => currentTime);
  t.after(app.close);

  const requestLink = async () => {
    const requested = await fetch(`${app.baseUrl}/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(owner),
    });
    assert.equal(requested.status, 202);
    assert.ok(app.sentLink);
    return `${app.sentLink.pathname}${app.sentLink.search}`;
  };

  const firstLink = await requestLink();
  const secondLink = await requestLink();
  const superseded = await fetch(`${app.baseUrl}${firstLink}`, { redirect: "manual" });
  assert.equal(superseded.status, 302);
  assert.match(superseded.headers.get("location") ?? "", /^\/login\?error=invalid-link$/);

  const firstVerification = await fetch(`${app.baseUrl}${secondLink}`, { redirect: "manual" });
  assert.equal(firstVerification.status, 302);
  const firstCookie = firstVerification.headers.get("set-cookie");
  assert.ok(firstCookie);

  const reused = await fetch(`${app.baseUrl}${secondLink}`, { redirect: "manual" });
  assert.equal(reused.status, 302);
  assert.match(reused.headers.get("location") ?? "", /^\/login\?error=invalid-link$/);

  const thirdLink = await requestLink();
  const secondVerification = await fetch(`${app.baseUrl}${thirdLink}`, { redirect: "manual" });
  const secondCookie = secondVerification.headers.get("set-cookie");
  assert.ok(secondCookie);

  const status = await fetch(`${app.baseUrl}/api/session`, { headers: { cookie: firstCookie } });
  assert.deepEqual(await status.json(), { authenticated: true });
  const logout = await fetch(`${app.baseUrl}/api/logout`, { method: "POST", headers: { cookie: firstCookie } });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie: firstCookie } })).status, 401);
  assert.equal((await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie: secondCookie } })).status, 200);

  currentTime = new Date("2026-11-13T20:00:00.001Z");
  assert.equal((await fetch(`${app.baseUrl}/api/overview`, { headers: { cookie: secondCookie } })).status, 401);

  const expiredLink = await requestLink();
  currentTime = new Date("2026-11-13T20:16:00.001Z");
  const expired = await fetch(`${app.baseUrl}${expiredLink}`, { redirect: "manual" });
  assert.match(expired.headers.get("location") ?? "", /^\/login\?error=invalid-link$/);
});
