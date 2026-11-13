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

export type AppDependencies = {
  authStore: AuthStore;
  magicLinkSender: MagicLinkSender;
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

export function createApp({ authStore, magicLinkSender, baseUrl, sessionSecret, now = () => new Date() }: AppDependencies) {
  const app = express();
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

  app.get("/api/overview", (request, response) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    return response.json({
      financialOwner: { cpf: session.cpf },
      consolidatedView: { financialAccounts: [], creditCards: [] },
    });
  });

  app.get("/", (request, response) => {
    if (!sessionFrom(request, sessionSecret, now())) return response.status(401).send("Authentication required");
    return response.type("html").send("<!doctype html><title>Visão Geral</title><main><h1>Visão Geral</h1><p>Nenhum dado financeiro conectado.</p></main>");
  });

  return app;
}
