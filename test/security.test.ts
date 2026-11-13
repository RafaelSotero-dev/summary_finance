import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp, type AuthStore, type CategoryStore, type MagicLinkSender } from "../src/app.js";

const owner = { cpf: "52998224725", email: "owner@example.com" };

async function runningApp(options: { categoryStore?: CategoryStore; appBaseUrl?: string } = {}) {
  let sentLink: URL | undefined;
  const app = createApp({
    authStore: { async findVerifiedFinancialOwner(cpf, email) { return cpf === owner.cpf && email === owner.email ? owner : null; } } satisfies AuthStore,
    magicLinkSender: { async sendMagicLink(_email, link) { sentLink = new URL(link); } } satisfies MagicLinkSender,
    baseUrl: options.appBaseUrl ?? "http://dashboard.test",
    sessionSecret: "test-secret",
    ...options,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, sentLink: () => sentLink, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("production responses use security headers and secure session cookies", async (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { process.env.NODE_ENV = previousEnvironment; });
  const app = await runningApp({ appBaseUrl: "https://dashboard.test" });
  t.after(app.close);

  const login = await fetch(`${app.baseUrl}/login`);
  assert.match(login.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(login.headers.get("x-content-type-options"), "nosniff");
  assert.equal(login.headers.get("x-frame-options"), "DENY");
  assert.match(login.headers.get("strict-transport-security") ?? "", /max-age=/);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const verified = await fetch(`${app.baseUrl}${app.sentLink()!.pathname}${app.sentLink()!.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test("production authenticated mutations reject an untrusted Origin", async (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { process.env.NODE_ENV = previousEnvironment; });
  const app = await runningApp();
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const verified = await fetch(`${app.baseUrl}${app.sentLink()!.pathname}${app.sentLink()!.search}`, { redirect: "manual" });
  const cookie = verified.headers.get("set-cookie")!;
  const rejected = await fetch(`${app.baseUrl}/api/logout`, { method: "POST", headers: { cookie, origin: "https://attacker.example" } });

  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "Untrusted request origin" });
});

test("magic-link requests are rate limited without revealing the Financial Owner", async (t) => {
  const app = await runningApp();
  t.after(app.close);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) })).status, 202);
  }
  const limited = await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Too many requests. Try again later." });

  const anotherIdentity = await fetch(`${app.baseUrl}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cpf: owner.cpf, email: "other@example.com" }),
  });
  assert.equal(anotherIdentity.status, 202);
});

test("unexpected API failures return a safe JSON error", async (t) => {
  const app = await runningApp({
    categoryStore: {
      async list() { throw new Error("database password: secret"); },
      async create() { throw new Error("not used"); },
      async update() { throw new Error("not used"); },
    },
  });
  t.after(app.close);

  await fetch(`${app.baseUrl}/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  const verified = await fetch(`${app.baseUrl}${app.sentLink()!.pathname}${app.sentLink()!.search}`, { redirect: "manual" });
  const response = await fetch(`${app.baseUrl}/api/categories`, { headers: { cookie: verified.headers.get("set-cookie")! } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "An unexpected error occurred. Please try again." });
});
