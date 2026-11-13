import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

import { createApp, type AuthStore, type MagicLinkSender, type OpenFinanceConnectionClient } from "../../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };
let server: Server;
let baseUrl: string;
let sentLink: URL | undefined;

test.beforeEach(async () => {
  const client: OpenFinanceConnectionClient = {
    async createConnection({ institution }) {
      return { financialOwnerCpf: owner.cpf, financialInstitution: { name: institution, dataFreshness: "2026-11-13T12:00:00.000Z" }, financialAccounts: [{ name: "Conta principal", balance: 1000, currency: "BRL" }], providerConnectionId: "item-123" };
    },
    async synchronizeTransactions() {
      return [{ id: "market", date: "2026-11-13", description: "Mercado Central", amount: -75, currency: "BRL", pending: false }];
    },
  };
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
    openFinanceConnectionClient: client,
    baseUrl: "http://dashboard.test",
    sessionSecret: "test-secret",
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

test("Financial Owner can categorize a Transaction and disconnect then reconnect an Open Finance Connection", async ({ page }) => {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("CPF").fill(owner.cpf);
  await page.getByLabel("E-mail").fill(owner.email);
  await page.getByRole("button", { name: "Enviar link de acesso" }).click();
  await page.goto(`${baseUrl}${sentLink!.pathname}${sentLink!.search}`);

  await page.getByRole("link", { name: "Transaction Categories" }).click();
  await page.getByLabel("Nome da categoria").fill("Alimentação");
  await page.getByRole("button", { name: "Criar categoria" }).click();
  await expect(page.getByRole("list", { name: "Categorias de transação" }).getByText("Alimentação", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Open Finance Connections" }).click();
  await page.getByLabel("Financial Institution").fill("Nubank");
  await page.getByLabel("Meu Pluggy item ID").fill("item-123");
  await page.getByRole("button", { name: "Adicionar Open Finance Connection" }).click();
  await page.getByRole("button", { name: "Sincronizar agora" }).click();
  await expect(page.getByRole("status")).toHaveText(/1 Transactions importadas/);

  await page.getByRole("link", { name: "Transactions" }).click();
  await page.getByRole("button", { name: "Editar interpretação" }).click();
  await page.getByLabel("Merchant").fill("Mercado do bairro");
  await page.getByLabel("Transaction Category").selectOption({ label: "Alimentação" });
  await page.getByRole("button", { name: "Salvar interpretação" }).click();
  await expect(page.getByText("Mercado do bairro", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Open Finance Connections" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Desconectar" }).click();
  await expect(page.getByText("Disconnected Open Finance Connection")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reconectar" }).click();
  await expect(page.getByText(/reconectada e atualizada/i)).toBeVisible();
});
