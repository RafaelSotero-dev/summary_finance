import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import express from "express";

export type FinancialOwner = { cpf: string; email: string };

export interface AuthStore {
  findVerifiedFinancialOwner(cpf: string, email: string): Promise<FinancialOwner | null>;
}

export interface MagicLinkSender {
  sendMagicLink(email: string, link: string): Promise<void>;
}

export const approvedConsentScope = ["accounts", "credit_cards", "balances", "transactions", "invoices"] as const;

export type ConsentScope = typeof approvedConsentScope[number];

export type FinancialInstitution = {
  name: string;
  dataFreshness: string;
};

export type FinancialAccount = {
  name: string;
  balance: number;
  currency: string;
};

export type OpenFinanceConnection = {
  financialOwnerCpf: string;
  financialInstitution: FinancialInstitution;
  financialAccounts: FinancialAccount[];
};

export interface OpenFinanceConnectionClient {
  createConnection(request: { financialOwnerCpf: string; institution: string; consentScope: readonly ConsentScope[] }): Promise<OpenFinanceConnection>;
}

export interface OpenFinanceConnectionStore {
  save(connection: OpenFinanceConnection): Promise<void>;
  findByFinancialOwnerCpf(cpf: string): Promise<OpenFinanceConnection[]>;
}

export type AppDependencies = {
  authStore: AuthStore;
  magicLinkSender: MagicLinkSender;
  openFinanceConnectionClient?: OpenFinanceConnectionClient;
  openFinanceConnectionStore?: OpenFinanceConnectionStore;
  baseUrl: string;
  sessionSecret: string;
  now?: () => Date;
};

type AuthToken = { cpf: string; purpose: "magic-link" | "session"; expiresAt: number };

function sign(token: AuthToken, secret: string) {
  const payload = Buffer.from(JSON.stringify(token)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readToken(value: string | undefined, secret: string, purpose: AuthToken["purpose"], now: Date): AuthToken | null {
  if (!value) return null;
  const [payload, receivedSignature] = value.split(".");
  if (!payload || !receivedSignature) return null;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(expectedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  try {
    const token = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthToken;
    return token.purpose === purpose && token.expiresAt > now.getTime() ? token : null;
  } catch {
    return null;
  }
}

function normalizeCpf(cpf: unknown) {
  return typeof cpf === "string" ? cpf.replace(/\D/g, "") : "";
}

function sessionFrom(request: Request, secret: string, now: Date) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("session="));
  return readToken(cookie?.slice("session=".length), secret, "session", now);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function renderOverview(connections: OpenFinanceConnection[]) {
  if (connections.length === 0) return "<!doctype html><title>Visão Geral</title><main><h1>Visão Geral</h1><p>Nenhum dado financeiro conectado.</p></main>";
  const institutions = connections.map((connection) => {
    const accounts = connection.financialAccounts.map((account) =>
      `<li>${escapeHtml(account.name)}: ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: account.currency }).format(account.balance)}</li>`,
    ).join("");
    return `<section><h2>${escapeHtml(connection.financialInstitution.name)}</h2><p>Data Freshness: ${escapeHtml(connection.financialInstitution.dataFreshness)}</p><ul>${accounts}</ul></section>`;
  }).join("");
  return `<!doctype html><title>Visão Geral</title><main><h1>Visão Geral</h1>${institutions}</main>`;
}

export function createApp({ authStore, magicLinkSender, openFinanceConnectionClient, openFinanceConnectionStore: suppliedOpenFinanceConnectionStore, baseUrl, sessionSecret, now = () => new Date() }: AppDependencies) {
  const app = express();
  const connectionsByOwner = new Map<string, OpenFinanceConnection[]>();
  const inMemoryOpenFinanceConnectionStore: OpenFinanceConnectionStore = {
    async save(connection) {
      const connections = connectionsByOwner.get(connection.financialOwnerCpf) ?? [];
      connections.push(connection);
      connectionsByOwner.set(connection.financialOwnerCpf, connections);
    },
    async findByFinancialOwnerCpf(cpf) {
      return connectionsByOwner.get(cpf) ?? [];
    },
  };
  const openFinanceConnectionStore = suppliedOpenFinanceConnectionStore ?? inMemoryOpenFinanceConnectionStore;
  app.use(express.json());

  app.post("/auth/magic-link", async (request, response, next) => {
    try {
      const cpf = normalizeCpf(request.body?.cpf);
      const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
      const financialOwner = cpf && email ? await authStore.findVerifiedFinancialOwner(cpf, email) : null;
      if (financialOwner) {
        const token = sign({ cpf, purpose: "magic-link", expiresAt: now().getTime() + 15 * 60_000 }, sessionSecret);
        await magicLinkSender.sendMagicLink(financialOwner.email, new URL(`/auth/verify?token=${encodeURIComponent(token)}`, baseUrl).toString());
      }
      response.status(202).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/verify", (request, response) => {
    const token = readToken(typeof request.query.token === "string" ? request.query.token : undefined, sessionSecret, "magic-link", now());
    if (!token) return response.status(401).send("This magic link is invalid or has expired.");
    const session = sign({ cpf: token.cpf, purpose: "session", expiresAt: now().getTime() + 8 * 60 * 60_000 }, sessionSecret);
    response.setHeader("Set-Cookie", `session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    return response.redirect(302, "/");
  });

  app.post("/api/open-finance-connections", async (request, response, next) => {
    try {
      const session = sessionFrom(request, sessionSecret, now());
      if (!session) return response.status(401).json({ error: "Authentication required" });
      if (!openFinanceConnectionClient) return response.status(503).json({ error: "Open Finance connections are unavailable" });

      const institution = typeof request.body?.institution === "string" ? request.body.institution.trim() : "";
      if (!institution) return response.status(400).json({ error: "Financial Institution is required" });

      const connection = await openFinanceConnectionClient.createConnection({
        financialOwnerCpf: session.cpf,
        institution,
        consentScope: approvedConsentScope,
      });
      if (connection.financialOwnerCpf !== session.cpf) return response.status(403).json({ error: "Connection ownership does not match the Financial Owner" });

      await openFinanceConnectionStore.save(connection);
      return response.status(201).json({ financialInstitution: connection.financialInstitution });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/overview", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const financialInstitutions = (await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf)).map((connection) => ({
        ...connection.financialInstitution,
        financialAccounts: connection.financialAccounts,
      }));
      return response.json({
        financialOwner: { cpf: session.cpf },
        consolidatedView: { financialInstitutions, creditCards: [] },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).send("Authentication required");
    try {
      return response.type("html").send(renderOverview(await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf)));
    } catch (error) {
      next(error);
    }
  });

  return app;
}
