import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";

import { createApp, type AuthStore, type MagicLinkSender } from "../../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };
let server: Server;
let baseUrl: string;
let sentLink: URL | undefined;

test.beforeEach(async () => {
  sentLink = undefined;
  const authStore: AuthStore = { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } };
  const sender: MagicLinkSender = { async sendMagicLink(_email, link) { sentLink = new URL(link); } };
  server = createServer(createApp({ authStore, magicLinkSender: sender, baseUrl: "http://dashboard.test", sessionSecret: "test-secret" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("private navigation redirects to login, and logout returns the current browser to login", async ({ page }) => {
  await page.goto(`${baseUrl}/transactions?period=this-month`);
  await expect(page).toHaveURL(/\/login\?next=%2Ftransactions%3Fperiod%3Dthis-month$/);
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();

  await page.getByLabel("CPF").fill("52998224725");
  await page.getByLabel("E-mail").fill(owner.email);
  await page.getByRole("button", { name: "Enviar link de acesso" }).click();
  await expect(page.getByRole("status")).toHaveText(/você receberá um link/i);
  expect(sentLink).toBeDefined();

  await page.goto(`${baseUrl}${sentLink!.pathname}${sentLink!.search}`);
  await expect(page).toHaveURL(`${baseUrl}/transactions?period=this-month`);
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Transaction Categories" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Spending Analysis" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Finance Connections" })).toBeVisible();
  await page.getByRole("link", { name: "Open Finance Connections" }).click();
  await expect(page).toHaveURL(`${baseUrl}/open-finance-connections`);
  await expect(page.getByRole("heading", { name: "Open Finance Connections" })).toBeVisible();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(`${baseUrl}/login`);
});

test("Open Finance Connections guides creation and shows synchronization results", async ({ page }) => {
  let connections = [{
    financialInstitution: { name: "Nubank", dataFreshness: "2026-11-12T15:00:00.000Z" },
    dataAvailability: ["Financial Accounts", "Transactions"],
    consentStatus: "reconnection-required",
    transactionsLastSynchronizedAt: null,
  }];
  await page.route("**/api/open-finance-connections", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { openFinanceConnections: connections } });
    connections = [...connections, {
      financialInstitution: { name: "Itaú", dataFreshness: "2026-11-13T15:00:00.000Z" },
      dataAvailability: ["Financial Accounts", "Transactions"],
      consentStatus: "active",
      transactionsLastSynchronizedAt: null,
    }];
    return route.fulfill({ status: 201, json: {} });
  });
  await page.route("**/api/transactions/synchronize", (route) => route.fulfill({ json: { imported: 12, failedConnections: ["Nubank"] } }));

  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("CPF").fill(owner.cpf);
  await page.getByLabel("E-mail").fill(owner.email);
  await page.getByRole("button", { name: "Enviar link de acesso" }).click();
  await page.goto(`${baseUrl}${sentLink!.pathname}${sentLink!.search}`);
  await page.getByRole("link", { name: "Open Finance Connections" }).click();

  await expect(page.getByText(/Use o item ID criado no Meu Pluggy/i)).toBeVisible();
  await expect(page.getByText("Reconnection Required")).toBeVisible();
  await page.getByLabel("Financial Institution").fill("Itaú");
  await page.getByLabel("Meu Pluggy item ID").fill("item-itau");
  await page.getByRole("button", { name: "Adicionar Open Finance Connection" }).click();
  await expect(page.getByText("Itaú")).toBeVisible();
  await page.getByRole("button", { name: "Sincronizar agora" }).click();
  await expect(page.getByRole("status")).toHaveText(/12 Transactions importadas.*Nubank requer reconexão/i);
});
