import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type CategoryStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

class DurableCategoryStore implements CategoryStore {
  categories: Array<{ id: string; name: string; parentCategoryId: string | null; archived: boolean; financialOwnerCpf: string }> = [];
  nextId = 1;

  async list(cpf: string) {
    return this.categories.filter((category) => category.financialOwnerCpf === cpf).map(({ financialOwnerCpf: _financialOwnerCpf, ...category }) => category);
  }

  async create(cpf: string, category: { name: string; parentCategoryId: string | null }) {
    const saved = { id: String(this.nextId++), ...category, archived: false, financialOwnerCpf: cpf };
    this.categories.push(saved);
    const { financialOwnerCpf: _financialOwnerCpf, ...result } = saved;
    return result;
  }

  async update(cpf: string, category: { id: string; name: string; parentCategoryId: string | null; archived: boolean }) {
    const saved = this.categories.find((candidate) => candidate.financialOwnerCpf === cpf && candidate.id === category.id);
    if (!saved) return null;
    Object.assign(saved, category);
    const { financialOwnerCpf: _financialOwnerCpf, ...result } = saved;
    return result;
  }
}

async function authenticatedApp(categoryStore: CategoryStore) {
  let sentLink: URL | undefined;
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    categoryStore,
    openFinanceConnectionClient: {
      async createConnection({ financialOwnerCpf, institution }) {
        return { financialOwnerCpf, financialInstitution: { name: institution, dataFreshness: "2026-11-13T00:00:00.000Z" }, financialAccounts: [] };
      },
      async synchronizeTransactions() {
        return [{ id: "market", date: "2026-11-12", description: "Mercado", amount: -50, currency: "BRL", pending: false }];
      },
    } satisfies OpenFinanceConnectionClient,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
    baseUrl: "http://dashboard.test",
    sessionSecret: "test-secret",
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.ok(sentLink);
  const verified = await fetch(`${baseUrl}${sentLink.pathname}${sentLink.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie");
  assert.ok(cookie);
  return { baseUrl, cookie, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("Transaction Categories survive an application restart and reject classifications to archived categories", async (t) => {
  const categoryStore = new DurableCategoryStore();
  const first = await authenticatedApp(categoryStore);
  t.after(first.close);

  const created = await fetch(`${first.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie: first.cookie }, body: JSON.stringify({ name: "Despesas" }) });
  assert.equal(created.status, 201);
  const parent = (await created.json()).category;
  const childResponse = await fetch(`${first.baseUrl}/api/categories`, { method: "POST", headers: { "content-type": "application/json", cookie: first.cookie }, body: JSON.stringify({ name: "Mercado", parentCategoryId: parent.id }) });
  assert.equal(childResponse.status, 201);
  const child = (await childResponse.json()).category;
  await fetch(`${first.baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie: first.cookie }, body: JSON.stringify({ institution: "Nubank" }) });
  await fetch(`${first.baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie: first.cookie } });
  const initialClassification = await fetch(`${first.baseUrl}/api/transactions/market`, { method: "PATCH", headers: { "content-type": "application/json", cookie: first.cookie }, body: JSON.stringify({ categoryId: child.id }) });
  assert.equal(initialClassification.status, 200);
  const archived = await fetch(`${first.baseUrl}/api/categories/${child.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: first.cookie }, body: JSON.stringify({ archived: true }) });
  assert.equal(archived.status, 200);
  const historical = await fetch(`${first.baseUrl}/api/transactions?categoryId=${child.id}`, { headers: { cookie: first.cookie } });
  assert.match((await historical.json()).transactions[0].id, /^transaction-/);
  const classification = await fetch(`${first.baseUrl}/api/transactions/market`, { method: "PATCH", headers: { "content-type": "application/json", cookie: first.cookie }, body: JSON.stringify({ categoryId: child.id }) });
  assert.equal(classification.status, 400);
  assert.deepEqual(await classification.json(), { error: "Transaction Category is unavailable for new classifications" });

  const second = await authenticatedApp(categoryStore);
  t.after(second.close);
  const categories = await fetch(`${second.baseUrl}/api/categories`, { headers: { cookie: second.cookie } });
  assert.deepEqual(await categories.json(), { categories: [
    { id: parent.id, name: "Despesas", parentCategoryId: null, archived: false },
    { id: child.id, name: "Mercado", parentCategoryId: parent.id, archived: true },
  ] });
});
