import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

async function runningTransactions() {
  let link: URL | undefined;
  const client: OpenFinanceConnectionClient = {
    async createConnection({ institution }) {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: institution, dataFreshness: "2026-11-12T00:00:00.000Z" }, financialAccounts: [] };
    },
    async synchronizeTransactions({ connection }) {
      return Array.from({ length: 52 }, (_, index) => ({
        id: index === 0 ? "shared-source-id" : `${connection.financialInstitution}-${index}`,
        date: `2026-11-${String(12 - Math.floor(index / 5)).padStart(2, "0")}`,
        description: index === 51 ? "Compra pendente" : `Compra ${index}`,
        amount: -index - 1,
        currency: "BRL",
        pending: index === 51,
      }));
    },
  };
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, value) { link = new URL(value); } } satisfies MagicLinkSender,
    openFinanceConnectionClient: client,
    baseUrl: "http://dashboard.test",
    sessionSecret: "test-secret",
    now: () => new Date("2026-11-12T12:00:00.000Z"),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await fetch(`${baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const verified = await fetch(`${baseUrl}${link!.pathname}${link!.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie")!;
  for (const institution of ["Nubank", "Itaú"]) await fetch(`${baseUrl}/api/open-finance-connections`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ institution }) });
  await fetch(`${baseUrl}/api/transactions/synchronize`, { method: "POST", headers: { cookie } });
  return { baseUrl, cookie, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("Transactions have globally stable IDs, paginate by an opaque cursor, validate filters, and export every filtered result", async (t) => {
  const app = await runningTransactions();
  t.after(app.close);
  const headers = { cookie: app.cookie };

  const first = await fetch(`${app.baseUrl}/api/transactions?financialInstitution=Nubank&limit=50`, { headers });
  assert.equal(first.status, 200);
  const firstPage = await first.json() as { transactions: Array<{ id: string; date: string }>; pendingTransactions: unknown[]; nextCursor?: string };
  assert.equal(firstPage.transactions.length, 50);
  assert.equal(firstPage.pendingTransactions.length, 0);
  assert.match(firstPage.transactions[0].id, /^transaction-/);
  assert.ok(firstPage.nextCursor);

  const second = await fetch(`${app.baseUrl}/api/transactions?financialInstitution=Nubank&limit=50&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, { headers });
  const secondPage = await second.json() as { transactions: Array<{ id: string }>; pendingTransactions: Array<{ id: string }> };
  assert.equal(secondPage.transactions.length, 1);
  assert.equal(secondPage.pendingTransactions.length, 1);
  assert.notEqual(firstPage.transactions[0].id, (await (await fetch(`${app.baseUrl}/api/transactions?financialInstitution=Itaú&limit=1`, { headers })).json() as { transactions: Array<{ id: string }> }).transactions[0].id);

  for (const query of ["limit=0", "limit=101", "cursor=not-a-cursor", "startDate=2026-13-01", "startDate=2026-11-12&endDate=2026-11-01", "type=other"]) {
    assert.equal((await fetch(`${app.baseUrl}/api/transactions?${query}`, { headers })).status, 400, query);
  }
  const exported = await fetch(`${app.baseUrl}/api/transactions/export?financialInstitution=Nubank&search=Compra`, { headers });
  assert.equal(exported.status, 200);
  assert.equal((await exported.text()).trim().split("\n").length, 53);
});
