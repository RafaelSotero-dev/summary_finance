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

export type CreditCardStatement = {
  amountDue: number;
  dueDate?: string;
};

export type CreditCard = {
  id: string;
  name: string;
  kind: "physical" | "virtual";
  currency: string;
  totalLimit?: number;
  usedLimit?: number;
  availableLimit?: number;
  statement?: CreditCardStatement;
};

export type OpenFinanceConnection = {
  financialOwnerCpf: string;
  financialInstitution: FinancialInstitution;
  financialAccounts: FinancialAccount[];
  creditCards?: CreditCard[];
  providerConnectionId?: string;
  transactionsLastSynchronizedAt?: string;
};

export type Transaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  pending: boolean;
  installmentPurchase?: {
    originalTransactionId: string;
    installmentNumber: number;
    totalInstallments: number;
  };
  cardStatementSettlement?: boolean;
};

export type StoredTransaction = Transaction & { financialInstitution: string };

export interface OpenFinanceConnectionClient {
  createConnection(request: { financialOwnerCpf: string; institution: string; consentScope: readonly ConsentScope[] }): Promise<OpenFinanceConnection>;
  synchronizeTransactions?(request: { connection: OpenFinanceConnection; since: Date; until: Date }): Promise<Transaction[]>;
}

export interface OpenFinanceConnectionStore {
  save(connection: OpenFinanceConnection): Promise<void>;
  findByFinancialOwnerCpf(cpf: string): Promise<OpenFinanceConnection[]>;
  findAll(): Promise<OpenFinanceConnection[]>;
}

export async function synchronizeFinancialOwnerTransactions(
  financialOwnerCpf: string,
  client: OpenFinanceConnectionClient,
  connectionStore: OpenFinanceConnectionStore,
  transactionStore: TransactionStore,
  synchronizedAt: Date,
) {
  if (!client.synchronizeTransactions) throw new Error("Transaction synchronization is unavailable");
  const connections = await connectionStore.findByFinancialOwnerCpf(financialOwnerCpf);
  let imported = 0;
  for (const connection of connections) {
    const since = connection.transactionsLastSynchronizedAt
      ? new Date(connection.transactionsLastSynchronizedAt)
      : new Date(Date.UTC(synchronizedAt.getUTCFullYear() - 1, synchronizedAt.getUTCMonth(), synchronizedAt.getUTCDate()));
    const transactions = await client.synchronizeTransactions({ connection, since, until: synchronizedAt });
    await transactionStore.upsert(financialOwnerCpf, connection, transactions, synchronizedAt);
    imported += transactions.length;
  }
  return imported;
}

export interface TransactionStore {
  upsert(financialOwnerCpf: string, connection: OpenFinanceConnection, transactions: Transaction[], synchronizedAt: Date): Promise<void>;
  findTransactionsByFinancialOwnerCpf(cpf: string, search: string, financialInstitution: string): Promise<StoredTransaction[]>;
}

export type AppDependencies = {
  authStore: AuthStore;
  magicLinkSender: MagicLinkSender;
  openFinanceConnectionClient?: OpenFinanceConnectionClient;
  openFinanceConnectionStore?: OpenFinanceConnectionStore;
  transactionStore?: TransactionStore;
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

function institutionCardStatement(creditCards: CreditCard[]) {
  const cardsWithStatements = creditCards.filter((creditCard) => creditCard.statement);
  if (cardsWithStatements.length === 0) return undefined;
  const firstStatement = cardsWithStatements[0].statement!;
  return {
    amountDue: cardsWithStatements.reduce((total, creditCard) => total + creditCard.statement!.amountDue, 0),
    currency: cardsWithStatements[0].currency,
    dueDate: firstStatement.dueDate,
    creditCards,
  };
}

type GroupedInstitution = { financialInstitution: FinancialInstitution; financialAccounts: FinancialAccount[]; creditCards: CreditCard[] };

function groupByFinancialInstitution(connections: OpenFinanceConnection[]) {
  const groupedByInstitution = new Map<string, GroupedInstitution>();
  for (const connection of connections) {
    const name = connection.financialInstitution.name;
    const grouped = groupedByInstitution.get(name) ?? {
      financialInstitution: connection.financialInstitution,
      financialAccounts: [],
      creditCards: [],
    };
    grouped.financialAccounts.push(...connection.financialAccounts);
    grouped.creditCards.push(...(connection.creditCards ?? []));
    groupedByInstitution.set(name, grouped);
  }
  return [...groupedByInstitution.values()];
}

function renderOverview(connections: OpenFinanceConnection[]) {
  if (connections.length === 0) return "<!doctype html><title>Visão Geral</title><main><h1>Visão Geral</h1><p>Nenhum dado financeiro conectado.</p></main>";
  const institutions = groupByFinancialInstitution(connections).map(({ financialInstitution, financialAccounts, creditCards }) => {
    const accounts = financialAccounts.map((account) =>
      `<li>${escapeHtml(account.name)}: ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: account.currency }).format(account.balance)}</li>`,
    ).join("");
    const statement = institutionCardStatement(creditCards);
    const cards = creditCards.map((creditCard) => `<li>${escapeHtml(creditCard.name)} (${escapeHtml(creditCard.kind)})</li>`).join("");
    const statementAmount = statement ? `<p>Fatura da Instituição: ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: statement.currency }).format(statement.amountDue)}</p>` : "";
    return `<section><h2>${escapeHtml(financialInstitution.name)}</h2><p>Data Freshness: ${escapeHtml(financialInstitution.dataFreshness)}</p><ul>${accounts}</ul>${statementAmount}<ul>${cards}</ul></section>`;
  }).join("");
  return `<!doctype html><title>Visão Geral</title><main><h1>Visão Geral</h1>${institutions}</main>`;
}

export function createApp({ authStore, magicLinkSender, openFinanceConnectionClient, openFinanceConnectionStore: suppliedOpenFinanceConnectionStore, transactionStore: suppliedTransactionStore, baseUrl, sessionSecret, now = () => new Date() }: AppDependencies) {
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
    async findAll() {
      return [...connectionsByOwner.values()].flat();
    },
  };
  const openFinanceConnectionStore = suppliedOpenFinanceConnectionStore ?? inMemoryOpenFinanceConnectionStore;
  const transactionsByOwner = new Map<string, StoredTransaction[]>();
  const inMemoryTransactionStore: TransactionStore = {
    async upsert(cpf, connection, transactions, synchronizedAt) {
      const financialInstitution = connection.financialInstitution.name;
      const current = transactionsByOwner.get(cpf) ?? [];
      for (const transaction of transactions) {
        const index = current.findIndex((candidate) => candidate.id === transaction.id && candidate.financialInstitution === financialInstitution);
        const stored = { ...transaction, financialInstitution };
        if (index === -1) current.push(stored);
        else current[index] = stored;
      }
      transactionsByOwner.set(cpf, current);
      const connections = await openFinanceConnectionStore.findByFinancialOwnerCpf(cpf);
      for (const connection of connections) {
        if (connection.financialInstitution.name === financialInstitution) connection.transactionsLastSynchronizedAt = synchronizedAt.toISOString();
      }
    },
    async findTransactionsByFinancialOwnerCpf(cpf, search, financialInstitution) {
      const normalizedSearch = search.toLocaleLowerCase();
      return (transactionsByOwner.get(cpf) ?? []).filter((transaction) =>
        (!financialInstitution || transaction.financialInstitution === financialInstitution)
        && (!normalizedSearch || transaction.description.toLocaleLowerCase().includes(normalizedSearch)),
      );
    },
  };
  const transactionStore = suppliedTransactionStore ?? inMemoryTransactionStore;
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
      const financialInstitutions = groupByFinancialInstitution(await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf)).map(({ financialInstitution, financialAccounts, creditCards }) => {
        const statement = institutionCardStatement(creditCards);
        return {
          ...financialInstitution,
          financialAccounts,
          ...(statement ? { institutionCardStatement: statement } : {}),
        };
      });
      return response.json({
        financialOwner: { cpf: session.cpf },
        consolidatedView: { financialInstitutions, creditCards: [] },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/transactions/synchronize", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    if (!openFinanceConnectionClient?.synchronizeTransactions) return response.status(503).json({ error: "Transaction synchronization is unavailable" });
    try {
      const imported = await synchronizeFinancialOwnerTransactions(session.cpf, openFinanceConnectionClient, openFinanceConnectionStore, transactionStore, now());
      return response.json({ imported });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/transactions", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
      const financialInstitution = typeof request.query.financialInstitution === "string" ? request.query.financialInstitution.trim() : "";
      const transactions = await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, search, financialInstitution);
      const presentedTransactions = transactions.map((transaction) => transaction.cardStatementSettlement
        ? { ...transaction, expenseAmount: 0 }
        : transaction,
      );
      return response.json({
        transactions: presentedTransactions.filter((transaction) => !transaction.pending),
        pendingTransactions: presentedTransactions.filter((transaction) => transaction.pending),
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
