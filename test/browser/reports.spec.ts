import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

import { createApp, type AuthStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };
let server: Server;
let baseUrl: string;
let sentLink: URL | undefined;

test.beforeEach(async () => {
  sentLink = undefined;
  const client: OpenFinanceConnectionClient = {
    async createConnection({ institution }) {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: institution, dataFreshness: "2026-11-12T15:00:00.000Z" }, financialAccounts: [{ name: "Conta principal", balance: 1200, currency: "BRL" }] };
    },
    async synchronizeTransactions() {
      return [{ id: "mercado", date: "2026-11-11", description: "Mercado", amount: -100, currency: "BRL", pending: false, financialAccount: "Conta principal" }];
    },
  };
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
    openFinanceConnectionClient: client, baseUrl: "http://dashboard.test", sessionSecret: "test-secret",
    now: () => new Date("2026-11-12T15:00:00.000Z"),
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("Financial Owner sees accessible reports and shares applicable filters through the URL", async ({ page }) => {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("CPF").fill(owner.cpf);
  await page.getByLabel("E-mail").fill(owner.email);
  await page.getByRole("button", { name: "Enviar link de acesso" }).click();
  await page.goto(`${baseUrl}${sentLink!.pathname}${sentLink!.search}`);
  await page.evaluate(async () => {
    await fetch("/api/open-finance-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ institution: "Nubank" }) });
    await fetch("/api/transactions/synchronize", { method: "POST" });
  });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Relatórios do período" })).toBeVisible();
  await expect(page.getByRole("table").first()).toBeVisible();
  await page.getByLabel("Período").first().selectOption("custom");
  await page.getByLabel("Data inicial").fill("2026-11-01");
  await page.getByLabel("Data final").fill("2026-11-12");
  await expect(page).toHaveURL(/period=custom.*startDate=2026-11-01.*endDate=2026-11-12/);

  await page.getByRole("link", { name: "Spending Analysis" }).click();
  await expect(page.getByRole("heading", { name: "Spending Analysis" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Granularidade" })).toBeVisible();
});
