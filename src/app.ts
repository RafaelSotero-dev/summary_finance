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
  financialAccount?: string;
  creditCardId?: string;
  financialAccountOrCreditCard?: string;
  installmentPurchase?: {
    originalTransactionId: string;
    installmentNumber: number;
    totalInstallments: number;
  };
  cardStatementSettlement?: boolean;
};

export type StoredTransaction = Transaction & { financialInstitution: string };

export type TransactionCategory = {
  id: string;
  name: string;
  parentCategoryId: string | null;
  archived: boolean;
};

type TransactionClassification = "standard" | "internal-transfer" | "refund";
type TransactionInterpretation = {
  merchant: string;
  categoryId: string | null;
  classification: TransactionClassification;
};
type CategorizationRule = { description: string; merchant: string; categoryId: string };

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

function escapeCsv(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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

type ReportFilters = {
  startDate?: string;
  endDate?: string;
  financialInstitution: string;
  financialAccount: string;
  creditCard: string;
  type: "income" | "expense" | "";
  categoryId: string;
};

type ComparisonGranularity = "day" | "month" | "year";

function dateInUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

function reportFilters(request: Request, currentDate: Date): ReportFilters {
  const value = (name: string) => typeof request.query[name] === "string" ? request.query[name].trim() : "";
  const period = value("period");
  let startDate = value("startDate") || undefined;
  let endDate = value("endDate") || undefined;
  const today = dateInUtc(currentDate);
  if (!startDate && !endDate) {
    const year = currentDate.getUTCFullYear();
    const month = currentDate.getUTCMonth();
    if (period === "today") startDate = endDate = today;
    if (period === "this-week") {
      const monday = new Date(Date.UTC(year, month, currentDate.getUTCDate() - ((currentDate.getUTCDay() + 6) % 7)));
      startDate = dateInUtc(monday);
      endDate = today;
    }
    if (period === "this-month") {
      startDate = dateInUtc(new Date(Date.UTC(year, month, 1)));
      endDate = today;
    }
    if (period === "last-month") {
      startDate = dateInUtc(new Date(Date.UTC(year, month - 1, 1)));
      endDate = dateInUtc(new Date(Date.UTC(year, month, 0)));
    }
    if (period === "this-year") {
      startDate = `${year}-01-01`;
      endDate = today;
    }
  }
  const type = value("type");
  return { startDate, endDate, financialInstitution: value("financialInstitution"), financialAccount: value("financialAccount"), creditCard: value("creditCard"), type: type === "income" || type === "expense" ? type : "", categoryId: value("categoryId") };
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
  const categoriesByOwner = new Map<string, TransactionCategory[]>();
  const interpretationsByOwner = new Map<string, Map<string, TransactionInterpretation>>();
  const categorizationRulesByOwner = new Map<string, CategorizationRule[]>();
  let nextCategoryId = 1;
  app.use(express.json());

  function presentTransaction(cpf: string, transaction: StoredTransaction) {
    const interpretation = interpretationsByOwner.get(cpf)?.get(`${transaction.financialInstitution}:${transaction.id}`);
    const rule = !interpretation ? categorizationRulesByOwner.get(cpf)?.find((candidate) => candidate.description === transaction.description) : undefined;
    return {
      ...transaction,
      merchant: interpretation?.merchant ?? transaction.description,
      categoryId: interpretation?.categoryId ?? null,
      classification: interpretation?.classification ?? "standard" as TransactionClassification,
      ...(rule ? { suggestedMerchant: rule.merchant, suggestedCategoryId: rule.categoryId } : {}),
    };
  }

  function transactionMatchesFilters(cpf: string, transaction: StoredTransaction, filters: ReportFilters) {
    const presented = presentTransaction(cpf, transaction);
    if (filters.startDate && transaction.date < filters.startDate) return false;
    if (filters.endDate && transaction.date > filters.endDate) return false;
    if (filters.financialInstitution && transaction.financialInstitution !== filters.financialInstitution) return false;
    if (filters.financialAccount && transaction.financialAccount !== filters.financialAccount) return false;
    if (filters.creditCard && transaction.creditCardId !== filters.creditCard) return false;
    if (filters.categoryId && presented.categoryId !== filters.categoryId) return false;
    if (filters.type === "income" && !(presented.classification === "standard" && transaction.amount > 0)) return false;
    if (filters.type === "expense" && !(presented.classification === "standard" && transaction.amount < 0)) return false;
    return true;
  }

  function reportFor(cpf: string, transactions: StoredTransaction[], filters: ReportFilters) {
    let income = 0;
    let expenses = 0;
    const temporal = new Map<string, { income: number; expenses: number }>();
    const categoryExpenses = new Map<string, number>();
    for (const transaction of transactions.filter((candidate) => !candidate.pending && transactionMatchesFilters(cpf, candidate, filters))) {
      const presented = presentTransaction(cpf, transaction);
      if (transaction.cardStatementSettlement || presented.classification === "internal-transfer") continue;
      const point = temporal.get(transaction.date) ?? { income: 0, expenses: 0 };
      if (presented.classification === "refund") {
        expenses -= transaction.amount;
        point.expenses -= transaction.amount;
      } else if (transaction.amount > 0) {
        income += transaction.amount;
        point.income += transaction.amount;
      } else {
        const amount = -transaction.amount;
        expenses += amount;
        point.expenses += amount;
        if (presented.categoryId) categoryExpenses.set(presented.categoryId, (categoryExpenses.get(presented.categoryId) ?? 0) + amount);
      }
      temporal.set(transaction.date, point);
    }
    const categories = categoriesByOwner.get(cpf) ?? [];
    return {
      totals: { income, expenses, net: income - expenses },
      temporalSeries: [...temporal.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => ({ date, ...values, net: values.income - values.expenses })),
      expenseDistribution: [...categoryExpenses.entries()].map(([id, amount]) => {
        const category = categories.find((candidate) => candidate.id === id)!;
        return { category: { id: category.id, name: category.name }, amount };
      }),
    };
  }

  function historicalComparisonFor(cpf: string, transactions: StoredTransaction[], filters: ReportFilters, granularity: ComparisonGranularity, equivalentPeriod: boolean) {
    const expensesByCategory = new Map<string, Map<string, number>>();
    for (const transaction of transactions.filter((candidate) => {
      if (candidate.pending || !transactionMatchesFilters(cpf, candidate, filters)) return false;
      if (!equivalentPeriod || !filters.startDate || !filters.endDate) return true;
      const startDay = filters.startDate.slice(5);
      const endDay = filters.endDate.slice(5);
      const transactionDay = candidate.date.slice(5);
      return startDay <= endDay
        ? transactionDay >= startDay && transactionDay <= endDay
        : transactionDay >= startDay || transactionDay <= endDay;
    })) {
      if (transaction.cardStatementSettlement) continue;
      const presented = presentTransaction(cpf, transaction);
      if (presented.classification === "internal-transfer" || !presented.categoryId) continue;
      const expenses = expensesByCategory.get(presented.categoryId) ?? new Map<string, number>();
      const period = granularity === "day" ? transaction.date : granularity === "month" ? transaction.date.slice(0, 7) : transaction.date.slice(0, 4);
      if (presented.classification === "refund") expenses.set(period, (expenses.get(period) ?? 0) - transaction.amount);
      else if (transaction.amount < 0) expenses.set(period, (expenses.get(period) ?? 0) - transaction.amount);
      else continue;
      expensesByCategory.set(presented.categoryId, expenses);
    }
    const categories = categoriesByOwner.get(cpf) ?? [];
    return {
      granularity,
      categories: [...expensesByCategory.entries()].map(([categoryId, expenses]) => {
        const category = categories.find((candidate) => candidate.id === categoryId)!;
        return {
          category: { id: category.id, name: category.name },
          periods: [...expenses.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([period, amount]) => ({ period, expenses: amount })),
        };
      }),
    };
  }

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

  app.get("/api/categories", (request, response) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    return response.json({ categories: categoriesByOwner.get(session.cpf) ?? [] });
  });

  app.post("/api/categories", (request, response) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const parentCategoryId = typeof request.body?.parentCategoryId === "string" ? request.body.parentCategoryId : null;
    if (!name) return response.status(400).json({ error: "Category name is required" });
    const categories = categoriesByOwner.get(session.cpf) ?? [];
    const parent = parentCategoryId ? categories.find((category) => category.id === parentCategoryId) : undefined;
    if (parentCategoryId && (!parent || parent.parentCategoryId !== null)) return response.status(400).json({ error: "A Category Hierarchy has at most two levels" });
    const category = { id: `category-${nextCategoryId++}`, name, parentCategoryId, archived: false };
    categories.push(category);
    categoriesByOwner.set(session.cpf, categories);
    return response.status(201).json({ category });
  });

  app.patch("/api/categories/:id", (request, response) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    const categories = categoriesByOwner.get(session.cpf) ?? [];
    const category = categories.find((candidate) => candidate.id === request.params.id);
    if (!category) return response.status(404).json({ error: "Transaction Category not found" });
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : undefined;
    const parentCategoryId = typeof request.body?.parentCategoryId === "string" ? request.body.parentCategoryId : request.body?.parentCategoryId === null ? null : undefined;
    if (name !== undefined && !name) return response.status(400).json({ error: "Category name is required" });
    if (parentCategoryId !== undefined) {
      const parent = parentCategoryId ? categories.find((candidate) => candidate.id === parentCategoryId) : undefined;
      if (parentCategoryId && (!parent || parent.id === category.id || parent.parentCategoryId !== null || categories.some((candidate) => candidate.parentCategoryId === category.id && candidate.id === parentCategoryId))) return response.status(400).json({ error: "A Category Hierarchy has at most two levels" });
      if (parentCategoryId !== null && categories.some((candidate) => candidate.parentCategoryId === category.id)) return response.status(400).json({ error: "A Category with subcategories cannot be moved below another Category" });
      category.parentCategoryId = parentCategoryId;
    }
    if (name !== undefined) category.name = name;
    if (typeof request.body?.archived === "boolean") category.archived = request.body.archived;
    return response.json({ category });
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
      const filters = reportFilters(request, now());
      const transactions = (await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, search, filters.financialInstitution)).filter((transaction) => transactionMatchesFilters(session.cpf, transaction, filters));
      return response.json({
        transactions: transactions.filter((transaction) => !transaction.pending).map((transaction) => ({
          ...presentTransaction(session.cpf, transaction),
          ...(transaction.cardStatementSettlement ? { expenseAmount: 0 } : {}),
        })),
        pendingTransactions: transactions.filter((transaction) => transaction.pending).map((transaction) => ({
          ...presentTransaction(session.cpf, transaction),
          ...(transaction.cardStatementSettlement ? { expenseAmount: 0 } : {}),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/transactions/export", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
      const filters = reportFilters(request, now());
      const transactions = (await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, search, filters.financialInstitution)).filter((transaction) => transactionMatchesFilters(session.cpf, transaction, filters));
      const categories = categoriesByOwner.get(session.cpf) ?? [];
      const rows = transactions.map((transaction) => {
        const interpretation = interpretationsByOwner.get(session.cpf)?.get(`${transaction.financialInstitution}:${transaction.id}`);
        const category = interpretation?.categoryId ? categories.find((candidate) => candidate.id === interpretation.categoryId)?.name ?? "" : "";
        return [
          transaction.date,
          transaction.amount,
          transaction.financialInstitution,
          transaction.financialAccount ?? transaction.creditCardId ?? transaction.financialAccountOrCreditCard ?? "",
          category,
          transaction.pending ? "Pendente" : "Confirmada",
        ].map(escapeCsv).join(",");
      });
      return response
        .setHeader("Content-Type", "text/csv; charset=utf-8")
        .setHeader("Content-Disposition", 'attachment; filename="transacoes.csv"')
        .send(["Data,Valor,Instituição Financeira,Conta Financeira ou Cartão,Categoria,Status", ...rows, ""].join("\r\n"));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/transactions/:id", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const transactions = await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, "", "");
      const transaction = transactions.find((candidate) => candidate.id === request.params.id);
      if (!transaction) return response.status(404).json({ error: "Transaction not found" });
      const existing = interpretationsByOwner.get(session.cpf)?.get(`${transaction.financialInstitution}:${transaction.id}`);
      const merchant = typeof request.body?.merchant === "string" ? request.body.merchant.trim() : existing?.merchant ?? transaction.description;
      const categoryId = typeof request.body?.categoryId === "string" ? request.body.categoryId : request.body?.categoryId === null ? null : existing?.categoryId ?? null;
      const classification = typeof request.body?.classification === "string" ? request.body.classification : existing?.classification ?? "standard";
      if (!merchant || !["standard", "internal-transfer", "refund"].includes(classification)) return response.status(400).json({ error: "Invalid Transaction interpretation" });
      if (categoryId && !categoriesByOwner.get(session.cpf)?.some((category) => category.id === categoryId)) return response.status(400).json({ error: "Transaction Category not found" });
      const interpretation: TransactionInterpretation = { merchant, categoryId, classification: classification as TransactionClassification };
      const interpretations = interpretationsByOwner.get(session.cpf) ?? new Map<string, TransactionInterpretation>();
      interpretations.set(`${transaction.financialInstitution}:${transaction.id}`, interpretation);
      interpretationsByOwner.set(session.cpf, interpretations);
      if (typeof request.body?.merchant === "string" && typeof request.body?.categoryId === "string") {
        const rules = categorizationRulesByOwner.get(session.cpf) ?? [];
        const index = rules.findIndex((rule) => rule.description === transaction.description);
        const rule = { description: transaction.description, merchant, categoryId };
        if (index === -1) rules.push(rule);
        else rules[index] = rule;
        categorizationRulesByOwner.set(session.cpf, rules);
      }
      return response.json({ transaction: presentTransaction(session.cpf, transaction) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/spending-analysis", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const transactions = (await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, "", "")).filter((transaction) => !transaction.pending);
      let income = 0;
      let expenses = 0;
      let uncategorizedTransactions = 0;
      for (const transaction of transactions) {
        if (transaction.cardStatementSettlement) continue;
        const interpretation = interpretationsByOwner.get(session.cpf)?.get(`${transaction.financialInstitution}:${transaction.id}`);
        const classification = interpretation?.classification ?? "standard";
        if (classification === "internal-transfer") continue;
        if (classification === "refund") {
          expenses -= transaction.amount;
          continue;
        }
        if (transaction.amount > 0) income += transaction.amount;
        else {
          expenses -= transaction.amount;
          if (!interpretation?.categoryId) uncategorizedTransactions += 1;
        }
      }
      const granularity = typeof request.query.granularity === "string" && ["day", "month", "year"].includes(request.query.granularity)
        ? request.query.granularity as ComparisonGranularity
        : undefined;
      const filters = reportFilters(request, now());
      return response.json({
        totals: { income, expenses, net: income - expenses },
        uncategorizedTransactions,
        ...(granularity ? { historicalComparison: historicalComparisonFor(session.cpf, transactions, filters, granularity, request.query.equivalentPeriod === "true") } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/dashboard", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const filters = reportFilters(request, now());
      const connections = await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf);
      const financialInstitutions = groupByFinancialInstitution(connections)
        .filter(({ financialInstitution }) => !filters.financialInstitution || financialInstitution.name === filters.financialInstitution)
        .map(({ financialInstitution, financialAccounts, creditCards }) => {
          const statement = institutionCardStatement(creditCards);
          return { ...financialInstitution, financialAccounts, ...(statement ? { institutionCardStatement: statement } : {}) };
        });
      const transactions = await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, "", filters.financialInstitution);
      return response.json({
        consolidatedView: { financialInstitutions },
        report: {
          period: { ...(filters.startDate ? { startDate: filters.startDate } : {}), ...(filters.endDate ? { endDate: filters.endDate } : {}) },
          ...reportFor(session.cpf, transactions, filters),
        },
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
