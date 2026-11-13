import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

import { createApp, type AuthStore, type MagicLinkSender } from "../../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };
let server: Server;
let baseUrl: string;
let sentLink: URL | undefined;

test.beforeEach(async () => {
  sentLink = undefined;
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
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

test("Financial Owner can create, rename, move, and archive Transaction Categories", async ({ page }) => {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("CPF").fill(owner.cpf);
  await page.getByLabel("E-mail").fill(owner.email);
  await page.getByRole("button", { name: "Enviar link de acesso" }).click();
  await page.goto(`${baseUrl}${sentLink!.pathname}${sentLink!.search}`);
  await page.getByRole("link", { name: "Categorias de transação" }).click();

  await page.getByLabel("Nome da categoria").fill("Despesas");
  await page.getByRole("button", { name: "Criar categoria" }).click();
  await expect(page.getByRole("list", { name: "Categorias de transação" }).getByText("Despesas", { exact: true })).toBeVisible();
  await page.getByLabel("Nome da categoria").fill("Mercado");
  await page.getByLabel("Categoria pai").selectOption({ label: "Despesas" });
  await page.getByRole("button", { name: "Criar categoria" }).click();
  await page.getByRole("button", { name: "Editar Mercado" }).click();
  await page.getByLabel("Renomear categoria").fill("Supermercado");
  await page.getByLabel("Mover para categoria pai").selectOption("");
  await page.getByRole("button", { name: "Salvar categoria" }).click();
  await page.getByRole("button", { name: "Arquivar Supermercado" }).click();
  await page.getByRole("button", { name: "Confirmar arquivamento" }).click();
  await expect(page.getByText("Arquivada", { exact: true })).toBeVisible();
});
