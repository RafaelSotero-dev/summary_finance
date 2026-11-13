import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

import { createApp, type AuthStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };
let server: Server;
let baseUrl: string;
let sentLink: URL | undefined;

test.beforeEach(async () => {
  const client: OpenFinanceConnectionClient = {
    async createConnection({ institution }) { return { financialOwnerCpf: owner.cpf, financialInstitution: { name: institution, dataFreshness: "2026-11-12T00:00:00.000Z" }, financialAccounts: [] }; },
    async synchronizeTransactions() {
      return Array.from({ length: 52 }, (_, index) => ({ id: `transaction-${index}`, date: index === 51 ? "2026-10-01" : "2026-11-12", description: index === 51 ? "Compra pendente" : `Compra ${index}`, amount: -10, currency: "BRL", pending: index === 51 }));
    },
  };
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
    openFinanceConnectionClient: client, baseUrl: "http://dashboard.test", sessionSecret: "test-secret",
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

test("Transactions keeps filters in the URL, separates Pending Transactions, and paginates fifty results", async ({ page }) => {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("CPF").fill(owner.cpf);
  await page.getByLabel("E-mail").fill(owner.email);
  await page.getByRole("button", { name: "Enviar link de acesso" }).click();
  await page.goto(`${baseUrl}${sentLink!.pathname}${sentLink!.search}`);
  await page.request.post(`${baseUrl}/api/open-finance-connections`, { data: { institution: "Nubank" } });
  await page.request.post(`${baseUrl}/api/transactions/synchronize`);
  await page.goto(`${baseUrl}/transactions`);

  await expect(page.getByRole("heading", { name: "Confirmadas" })).toBeVisible();
  await expect(page.locator(".transaction-list").first().locator("li")).toHaveCount(50);
  await page.getByLabel("Busca").fill("Compra");
  await page.getByRole("button", { name: "Aplicar filtros" }).click();
  await expect(page).toHaveURL(/\/transactions\?search=Compra&limit=50$/);
  await expect(page.getByRole("link", { name: "Exportar CSV" })).toHaveAttribute("href", "/api/transactions/export?search=Compra&limit=50");
  await page.getByRole("button", { name: "Próxima página" }).click();
  await expect(page.getByRole("heading", { name: "Pendentes" })).toBeVisible();
  await expect(page.getByText("Compra pendente")).toBeVisible();
});
