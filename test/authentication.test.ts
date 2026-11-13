import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type MagicLinkSender } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

class MemoryAuthStore implements AuthStore {
  owners = [owner];

  async findVerifiedFinancialOwner(cpf: string, email: string) {
    return this.owners.find((candidate) => candidate.cpf === cpf && candidate.email === email) ?? null;
  }
}

async function runningApp() {
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
    consolidatedView: { financialAccounts: [], creditCards: [] },
  });
});

test("an unauthenticated visitor cannot access the Consolidated View", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  const overview = await fetch(`${app.baseUrl}/api/overview`);
  assert.equal(overview.status, 401);
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
