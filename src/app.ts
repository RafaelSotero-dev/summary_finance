import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import express from "express";

export type FinancialOwner = { cpf: string; email: string };

export interface AuthStore {
  findVerifiedFinancialOwner(cpf: string, email: string): Promise<FinancialOwner | null>;
}

export type AuthenticatedSession = { cpf: string };

export interface SessionStore {
  invalidateUnusedMagicLinks(cpf: string): Promise<void>;
  createMagicLink(cpf: string, tokenHash: string, expiresAt: Date): Promise<void>;
  consumeMagicLink(tokenHash: string, now: Date): Promise<string | null>;
  createSession(cpf: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findActiveSession(tokenHash: string, now: Date): Promise<AuthenticatedSession | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

declare global {
  namespace Express {
    interface Request {
      authenticatedSession?: AuthenticatedSession;
    }
  }
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
  includedInTotals?: boolean;
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
  includedInTotals?: boolean;
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
  consentStatus?: "active" | "reconnection-required";
};

export type OpenFinanceConnectionIdentity = Pick<OpenFinanceConnection, "financialOwnerCpf"> & { financialInstitution: string };

export function connectionIdentity(connection: OpenFinanceConnection): OpenFinanceConnectionIdentity {
  return { financialOwnerCpf: connection.financialOwnerCpf, financialInstitution: connection.financialInstitution.name };
}

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

export interface CategoryStore {
  list(financialOwnerCpf: string): Promise<TransactionCategory[]>;
  create(financialOwnerCpf: string, category: Pick<TransactionCategory, "name" | "parentCategoryId">): Promise<TransactionCategory>;
  update(financialOwnerCpf: string, category: TransactionCategory): Promise<TransactionCategory | null>;
}

type TransactionClassification = "standard" | "internal-transfer" | "refund";
type TransactionInterpretation = {
  merchant: string;
  categoryId: string | null;
  classification: TransactionClassification;
};
type CategorizationRule = { description: string; merchant: string; categoryId: string };

export interface OpenFinanceConnectionClient {
  createConnection(request: { financialOwnerCpf: string; institution: string; providerConnectionId?: string; consentScope: readonly ConsentScope[] }): Promise<OpenFinanceConnection>;
  synchronizeTransactions?(request: { connection: OpenFinanceConnection; since: Date; until: Date }): Promise<Transaction[]>;
  refreshConnection?(connection: OpenFinanceConnection): Promise<OpenFinanceConnection>;
  revokeConnection?(request: { providerConnectionId: string }): Promise<void>;
}

export interface EncryptedBackupStore {
  saveEncryptedBackup(financialOwnerCpf: string, encryptedBackup: string): Promise<void>;
}

export interface OperationalNotifier {
  sendConnectionRevoked(financialOwnerCpf: string, financialInstitution: string): Promise<void>;
}

export interface OpenFinanceConnectionStore {
  save(connection: OpenFinanceConnection): Promise<void>;
  findByFinancialOwnerCpf(cpf: string): Promise<OpenFinanceConnection[]>;
  findAll(): Promise<OpenFinanceConnection[]>;
  setConsentStatus(identity: OpenFinanceConnectionIdentity, status: "active" | "reconnection-required"): Promise<void>;
  replace(identity: OpenFinanceConnectionIdentity, connection: OpenFinanceConnection): Promise<void>;
  refresh(identity: OpenFinanceConnectionIdentity, connection: OpenFinanceConnection): Promise<void>;
  setFinancialAccountIncludedInTotals(identity: OpenFinanceConnectionIdentity, accountName: string, includedInTotals: boolean): Promise<FinancialAccount | null>;
  setCreditCardIncludedInTotals(identity: OpenFinanceConnectionIdentity, creditCardId: string, includedInTotals: boolean): Promise<CreditCard | null>;
  delete(identity: OpenFinanceConnectionIdentity): Promise<void>;
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
  const failedConnections: string[] = [];
  for (const connection of connections) {
    try {
      const since = connection.transactionsLastSynchronizedAt
        ? new Date(connection.transactionsLastSynchronizedAt)
        : new Date(Date.UTC(synchronizedAt.getUTCFullYear() - 1, synchronizedAt.getUTCMonth(), synchronizedAt.getUTCDate()));
      const transactions = await client.synchronizeTransactions({ connection, since, until: synchronizedAt });
      if (client.refreshConnection) await connectionStore.refresh(connectionIdentity(connection), await client.refreshConnection(connection));
      await transactionStore.upsert(financialOwnerCpf, connection, transactions, synchronizedAt);
      await connectionStore.setConsentStatus(connectionIdentity(connection), "active");
      imported += transactions.length;
    } catch {
      await connectionStore.setConsentStatus(connectionIdentity(connection), "reconnection-required");
      failedConnections.push(connection.financialInstitution.name);
    }
  }
  return failedConnections.length === 0 ? { imported } : { imported, failedConnections };
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
  categoryStore?: CategoryStore;
  encryptedBackupStore?: EncryptedBackupStore;
  operationalNotifier?: OperationalNotifier;
  baseUrl: string;
  sessionSecret: string;
  now?: () => Date;
};

function normalizeCpf(cpf: unknown) {
  return typeof cpf === "string" ? cpf.replace(/\D/g, "") : "";
}

function privateReturnPath(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/auth") ? value : "/";
}

function sessionFrom(request: Request, _secret: string, _now: Date) {
  return request.authenticatedSession ?? null;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie?.slice(`${name}=`.length);
}

function escapeCsv(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function institutionCardStatement(creditCards: CreditCard[]) {
  const cardsWithStatements = creditCards.filter((creditCard) => creditCard.statement);
  if (cardsWithStatements.length === 0) return undefined;
  const includedCardsWithStatements = cardsWithStatements.filter((creditCard) => creditCard.includedInTotals !== false);
  const firstStatement = includedCardsWithStatements[0]?.statement;
  return {
    amountDue: includedCardsWithStatements.reduce((total, creditCard) => total + creditCard.statement!.amountDue, 0),
    currency: cardsWithStatements[0].currency,
    ...(firstStatement?.dueDate ? { dueDate: firstStatement.dueDate } : {}),
    creditCards: cardsWithStatements.map(({ includedInTotals, ...creditCard }) => includedInTotals === false ? { ...creditCard, includedInTotals } : creditCard),
  };
}

type GroupedInstitution = { financialInstitution: FinancialInstitution; financialAccounts: FinancialAccount[]; creditCards: CreditCard[]; consentStatus: "active" | "reconnection-required" };

function groupByFinancialInstitution(connections: OpenFinanceConnection[]) {
  const groupedByInstitution = new Map<string, GroupedInstitution>();
  for (const connection of connections) {
    const name = connection.financialInstitution.name;
    const grouped = groupedByInstitution.get(name) ?? {
      financialInstitution: connection.financialInstitution,
      financialAccounts: [],
      creditCards: [],
      consentStatus: connection.consentStatus ?? "active",
    };
    grouped.financialAccounts.push(...connection.financialAccounts);
    grouped.creditCards.push(...(connection.creditCards ?? []));
    if (connection.consentStatus === "reconnection-required") grouped.consentStatus = "reconnection-required";
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
  const validIsoDate = (date: string | undefined) => !date || /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00.000Z`));
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) throw new Error("Report dates must use ISO dates");
  if (period === "custom" && (!startDate || !endDate)) throw new Error("A custom report range requires an initial and final date");
  if (startDate && endDate && startDate > endDate) throw new Error("The initial report date must not be later than the final date");
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

export function createApp({ authStore, magicLinkSender, openFinanceConnectionClient, openFinanceConnectionStore: suppliedOpenFinanceConnectionStore, transactionStore: suppliedTransactionStore, categoryStore: suppliedCategoryStore, encryptedBackupStore, operationalNotifier, baseUrl, sessionSecret, now = () => new Date() }: AppDependencies) {
  const app = express();
  const inMemoryMagicLinks = new Map<string, { cpf: string; expiresAt: Date; used: boolean }>();
  const inMemorySessions = new Map<string, { cpf: string; expiresAt: Date; revokedAt?: Date }>();
  const inMemorySessionStore: SessionStore = {
    async invalidateUnusedMagicLinks(cpf) {
      for (const link of inMemoryMagicLinks.values()) if (link.cpf === cpf && !link.used) link.used = true;
    },
    async createMagicLink(cpf, tokenHash, expiresAt) {
      inMemoryMagicLinks.set(tokenHash, { cpf, expiresAt, used: false });
    },
    async consumeMagicLink(tokenHash, currentTime) {
      const link = inMemoryMagicLinks.get(tokenHash);
      if (!link || link.used || link.expiresAt <= currentTime) return null;
      link.used = true;
      return link.cpf;
    },
    async createSession(cpf, tokenHash, expiresAt) {
      inMemorySessions.set(tokenHash, { cpf, expiresAt });
    },
    async findActiveSession(tokenHash, currentTime) {
      const session = inMemorySessions.get(tokenHash);
      return session && !session.revokedAt && session.expiresAt > currentTime ? { cpf: session.cpf } : null;
    },
    async revokeSession(tokenHash, currentTime) {
      const session = inMemorySessions.get(tokenHash);
      if (session) session.revokedAt = currentTime;
    },
  };
  const sessionStore: SessionStore = "createMagicLink" in authStore ? authStore as AuthStore & SessionStore : inMemorySessionStore;
  const manualSynchronizations = new Set<string>();
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
    async setConsentStatus(identity, status) {
      const connection = (connectionsByOwner.get(identity.financialOwnerCpf) ?? []).find((candidate) => candidate.financialInstitution.name === identity.financialInstitution);
      if (connection) connection.consentStatus = status;
    },
    async replace(identity, connection) {
      const connections = connectionsByOwner.get(identity.financialOwnerCpf) ?? [];
      const index = connections.findIndex((candidate) => candidate.financialInstitution.name === identity.financialInstitution);
      if (index === -1) connections.push(connection);
      else connections[index] = connection;
      connectionsByOwner.set(identity.financialOwnerCpf, connections);
    },
    async refresh(identity, connection) {
      const existing = (connectionsByOwner.get(identity.financialOwnerCpf) ?? []).find((candidate) => candidate.financialInstitution.name === identity.financialInstitution);
      if (!existing) return;
      const accountTotals = new Map(existing.financialAccounts.map((account) => [account.name, account.includedInTotals]));
      const cardTotals = new Map((existing.creditCards ?? []).map((card) => [card.id, card.includedInTotals]));
      Object.assign(existing, connection, {
        financialAccounts: connection.financialAccounts.map((account) => ({ ...account, includedInTotals: accountTotals.get(account.name) ?? account.includedInTotals })),
        creditCards: connection.creditCards?.map((card) => ({ ...card, includedInTotals: cardTotals.get(card.id) ?? card.includedInTotals })),
      });
    },
    async setFinancialAccountIncludedInTotals(identity, accountName, includedInTotals) {
      const account = (connectionsByOwner.get(identity.financialOwnerCpf) ?? []).find((candidate) => candidate.financialInstitution.name === identity.financialInstitution)
        ?.financialAccounts.find((candidate) => candidate.name === accountName);
      if (!account) return null;
      account.includedInTotals = includedInTotals;
      return account;
    },
    async setCreditCardIncludedInTotals(identity, creditCardId, includedInTotals) {
      const creditCard = (connectionsByOwner.get(identity.financialOwnerCpf) ?? []).find((candidate) => candidate.financialInstitution.name === identity.financialInstitution)
        ?.creditCards?.find((candidate) => candidate.id === creditCardId);
      if (!creditCard) return null;
      creditCard.includedInTotals = includedInTotals;
      return creditCard;
    },
    async delete(identity) {
      connectionsByOwner.set(identity.financialOwnerCpf, (connectionsByOwner.get(identity.financialOwnerCpf) ?? []).filter((connection) => connection.financialInstitution.name !== identity.financialInstitution));
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
  const inMemoryEncryptedBackupStore: EncryptedBackupStore = { async saveEncryptedBackup() {} };
  const backupStore = encryptedBackupStore ?? inMemoryEncryptedBackupStore;
  const categoriesByOwner = new Map<string, TransactionCategory[]>();
  const interpretationsByOwner = new Map<string, Map<string, TransactionInterpretation>>();
  const categorizationRulesByOwner = new Map<string, CategorizationRule[]>();
  let nextCategoryId = 1;
  const inMemoryCategoryStore: CategoryStore = {
    async list(cpf) {
      return categoriesByOwner.get(cpf) ?? [];
    },
    async create(cpf, category) {
      const saved = { id: `category-${nextCategoryId++}`, ...category, archived: false };
      const categories = categoriesByOwner.get(cpf) ?? [];
      categories.push(saved);
      categoriesByOwner.set(cpf, categories);
      return saved;
    },
    async update(cpf, category) {
      const existing = (categoriesByOwner.get(cpf) ?? []).find((candidate) => candidate.id === category.id);
      if (!existing) return null;
      Object.assign(existing, category);
      return existing;
    },
  };
  const categoryStore = suppliedCategoryStore ?? inMemoryCategoryStore;
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api", async (request, _response, next) => {
    try {
      const token = cookieValue(request, "session");
      if (token) {
        const session = await sessionStore.findActiveSession(createHash("sha256").update(token).digest("base64url"), now());
        if (session) request.authenticatedSession = session;
      }
      next();
    } catch (error) {
      next(error);
    }
  });

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

  function reportFor(cpf: string, transactions: StoredTransaction[], filters: ReportFilters, categories: TransactionCategory[]) {
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
    return {
      totals: { income, expenses, net: income - expenses },
      temporalSeries: [...temporal.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => ({ date, ...values, net: values.income - values.expenses })),
      expenseDistribution: [...categoryExpenses.entries()].map(([id, amount]) => {
        const category = categories.find((candidate) => candidate.id === id)!;
        return { category: { id: category.id, name: category.name }, amount };
      }),
    };
  }

  function historicalComparisonFor(cpf: string, transactions: StoredTransaction[], filters: ReportFilters, granularity: ComparisonGranularity, equivalentPeriod: boolean, categories: TransactionCategory[]) {
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
      const returnTo = privateReturnPath(request.body?.returnTo);
      const financialOwner = cpf && email ? await authStore.findVerifiedFinancialOwner(cpf, email) : null;
      if (financialOwner) {
        const token = randomBytes(32).toString("base64url");
        await sessionStore.invalidateUnusedMagicLinks(financialOwner.cpf);
        await sessionStore.createMagicLink(financialOwner.cpf, createHash("sha256").update(token).digest("base64url"), new Date(now().getTime() + 15 * 60_000));
        await magicLinkSender.sendMagicLink(financialOwner.email, new URL(`/auth/verify?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`, baseUrl).toString());
      }
      response.status(202).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/verify", async (request, response, next) => {
    try {
      const token = typeof request.query.token === "string" ? request.query.token : "";
      const returnTo = privateReturnPath(request.query.returnTo);
      const cpf = await sessionStore.consumeMagicLink(createHash("sha256").update(token).digest("base64url"), now());
      if (!cpf) return response.redirect(302, "/login?error=invalid-link");
      const session = randomBytes(32).toString("base64url");
      await sessionStore.createSession(cpf, createHash("sha256").update(session).digest("base64url"), new Date(now().getTime() + 8 * 60 * 60_000));
      response.setHeader("Set-Cookie", `session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      return response.redirect(302, returnTo);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/session", (request, response) => {
    if (!request.authenticatedSession) return response.status(401).json({ authenticated: false });
    return response.json({ authenticated: true });
  });

  app.post("/api/logout", async (request, response, next) => {
    try {
      const token = cookieValue(request, "session");
      if (token) await sessionStore.revokeSession(createHash("sha256").update(token).digest("base64url"), now());
      response.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
      return response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/open-finance-connections", async (request, response, next) => {
    try {
      const session = sessionFrom(request, sessionSecret, now());
      if (!session) return response.status(401).json({ error: "Authentication required" });
      if (!openFinanceConnectionClient) return response.status(503).json({ error: "Open Finance connections are unavailable" });

      const institution = typeof request.body?.institution === "string" ? request.body.institution.trim() : "";
      if (!institution) return response.status(400).json({ error: "Financial Institution is required" });
      const providerConnectionId = typeof request.body?.itemId === "string" ? request.body.itemId.trim() : "";
      const existingConnections = await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf);
      if (existingConnections.length >= 5) return response.status(409).json({ error: "At most five Open Finance Connections can be linked to this dashboard" });

      const connection = await openFinanceConnectionClient.createConnection({
        financialOwnerCpf: session.cpf,
        institution,
        ...(providerConnectionId ? { providerConnectionId } : {}),
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
      const financialInstitutions = groupByFinancialInstitution(await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf)).map(({ financialInstitution, financialAccounts, creditCards, consentStatus }) => {
        const statement = institutionCardStatement(creditCards);
        return {
          ...financialInstitution,
          consentStatus,
          financialAccounts: financialAccounts.map((account) => ({ ...account, includedInTotals: account.includedInTotals ?? true })),
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

  app.get("/api/consolidated-view/totals", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const connections = await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf);
      const financialAccountBalance = connections
        .flatMap((connection) => connection.financialAccounts)
        .filter((account) => account.includedInTotals !== false)
        .reduce((total, account) => total + account.balance, 0);
      return response.json({ financialAccountBalance });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/consolidated-view/summary", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const connections = await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf);
      const financialAccountBalance = connections
        .flatMap((connection) => connection.financialAccounts)
        .filter((account) => account.includedInTotals !== false)
        .reduce((total, account) => total + account.balance, 0);
      const creditCardStatementBalance = connections
        .flatMap((connection) => connection.creditCards ?? [])
        .filter((creditCard) => creditCard.includedInTotals !== false)
        .reduce((total, creditCard) => total + (creditCard.statement?.amountDue ?? 0), 0);
      return response.json({
        financialAccountBalance,
        creditCardStatementBalance,
        netBalance: financialAccountBalance - creditCardStatementBalance,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/open-finance-connections/:financialInstitution/financial-accounts/:accountName", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    if (typeof request.body?.includedInTotals !== "boolean") return response.status(400).json({ error: "includedInTotals must be a boolean" });
    try {
      const financialAccount = await openFinanceConnectionStore.setFinancialAccountIncludedInTotals({ financialOwnerCpf: session.cpf, financialInstitution: request.params.financialInstitution }, request.params.accountName, request.body.includedInTotals);
      if (!financialAccount) return response.status(404).json({ error: "Financial Account not found" });
      return response.json({ financialAccount: { ...financialAccount, includedInTotals: financialAccount.includedInTotals ?? true } });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/open-finance-connections/:financialInstitution/credit-cards/:creditCardId", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    if (typeof request.body?.includedInTotals !== "boolean") return response.status(400).json({ error: "includedInTotals must be a boolean" });
    try {
      const creditCard = await openFinanceConnectionStore.setCreditCardIncludedInTotals({ financialOwnerCpf: session.cpf, financialInstitution: request.params.financialInstitution }, request.params.creditCardId, request.body.includedInTotals);
      if (!creditCard) return response.status(404).json({ error: "Credit Card not found" });
      return response.json({ creditCard: { ...creditCard, includedInTotals: creditCard.includedInTotals ?? true } });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/categories", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      return response.json({ categories: await categoryStore.list(session.cpf) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/categories", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const parentCategoryId = typeof request.body?.parentCategoryId === "string" ? request.body.parentCategoryId : null;
    if (!name) return response.status(400).json({ error: "Category name is required" });
    const categories = await categoryStore.list(session.cpf);
    const parent = parentCategoryId ? categories.find((category) => category.id === parentCategoryId) : undefined;
    if (parentCategoryId && (!parent || parent.parentCategoryId !== null || parent.archived)) return response.status(400).json({ error: "A Category Hierarchy has at most two active levels" });
    try {
      const category = await categoryStore.create(session.cpf, { name, parentCategoryId });
      return response.status(201).json({ category });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/categories/:id", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    const categories = await categoryStore.list(session.cpf);
    const category = categories.find((candidate) => candidate.id === request.params.id);
    if (!category) return response.status(404).json({ error: "Transaction Category not found" });
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : undefined;
    const parentCategoryId = typeof request.body?.parentCategoryId === "string" ? request.body.parentCategoryId : request.body?.parentCategoryId === null ? null : undefined;
    if (name !== undefined && !name) return response.status(400).json({ error: "Category name is required" });
    if (parentCategoryId !== undefined) {
      const parent = parentCategoryId ? categories.find((candidate) => candidate.id === parentCategoryId) : undefined;
      if (parentCategoryId && (!parent || parent.id === category.id || parent.parentCategoryId !== null || parent.archived || categories.some((candidate) => candidate.parentCategoryId === category.id && candidate.id === parentCategoryId))) return response.status(400).json({ error: "A Category Hierarchy has at most two active levels" });
      if (parentCategoryId !== null && categories.some((candidate) => candidate.parentCategoryId === category.id)) return response.status(400).json({ error: "A Category with subcategories cannot be moved below another Category" });
      category.parentCategoryId = parentCategoryId;
    }
    if (name !== undefined) category.name = name;
    if (request.body?.archived === true && categories.some((candidate) => candidate.parentCategoryId === category.id && !candidate.archived)) return response.status(400).json({ error: "Move or archive subcategories before archiving this Transaction Category" });
    if (typeof request.body?.archived === "boolean") category.archived = request.body.archived;
    try {
      const saved = await categoryStore.update(session.cpf, category);
      if (!saved) return response.status(404).json({ error: "Transaction Category not found" });
      return response.json({ category: saved });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/transactions/synchronize", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    if (!openFinanceConnectionClient?.synchronizeTransactions) return response.status(503).json({ error: "Transaction synchronization is unavailable" });
    if (manualSynchronizations.has(session.cpf)) return response.status(409).json({ error: "Synchronization already in progress" });
    manualSynchronizations.add(session.cpf);
    try {
        return response.json(await synchronizeFinancialOwnerTransactions(session.cpf, openFinanceConnectionClient, openFinanceConnectionStore, transactionStore, now()));
    } catch (error) {
      next(error);
    } finally {
      manualSynchronizations.delete(session.cpf);
    }
  });

  app.post("/api/open-finance-connections/:financialInstitution/reconnect", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    if (!openFinanceConnectionClient) return response.status(503).json({ error: "Open Finance connections are unavailable" });
    try {
      const financialInstitution = request.params.financialInstitution;
      const existing = (await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf)).find((connection) => connection.financialInstitution.name === financialInstitution);
      if (!existing) return response.status(404).json({ error: "Open Finance Connection not found" });
      const connection = await openFinanceConnectionClient.createConnection({ financialOwnerCpf: session.cpf, institution: financialInstitution, providerConnectionId: existing.providerConnectionId, consentScope: approvedConsentScope });
      if (connection.financialOwnerCpf !== session.cpf) return response.status(403).json({ error: "Connection ownership does not match the Financial Owner" });
      await openFinanceConnectionStore.replace({ financialOwnerCpf: session.cpf, financialInstitution }, { ...connection, consentStatus: "active" });
      return response.json({ financialInstitution: connection.financialInstitution });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/open-finance-connections/:financialInstitution", async (request, response, next) => {
    const session = sessionFrom(request, sessionSecret, now());
    if (!session) return response.status(401).json({ error: "Authentication required" });
    try {
      const financialInstitution = request.params.financialInstitution;
      const connection = (await openFinanceConnectionStore.findByFinancialOwnerCpf(session.cpf)).find((candidate) => candidate.financialInstitution.name === financialInstitution);
      if (!connection) return response.status(404).json({ error: "Open Finance Connection not found" });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(sessionSecret).digest(), nonce);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(connection), "utf8"), cipher.final()]);
      const encryptedBackup = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
      await backupStore.saveEncryptedBackup(session.cpf, encryptedBackup);
      await openFinanceConnectionStore.delete({ financialOwnerCpf: session.cpf, financialInstitution });
      await operationalNotifier?.sendConnectionRevoked(session.cpf, financialInstitution);
      return response.status(204).end();
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
      const categories = await categoryStore.list(session.cpf);
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
      if (categoryId && !((await categoryStore.list(session.cpf)).some((category) => category.id === categoryId && !category.archived))) return response.status(400).json({ error: "Transaction Category is unavailable for new classifications" });
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
      const filters = reportFilters(request, now());
      const transactions = (await transactionStore.findTransactionsByFinancialOwnerCpf(session.cpf, "", filters.financialInstitution)).filter((transaction) => !transaction.pending && transactionMatchesFilters(session.cpf, transaction, filters));
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
      return response.json({
        totals: { income, expenses, net: income - expenses },
        uncategorizedTransactions,
        ...(granularity ? { historicalComparison: historicalComparisonFor(session.cpf, transactions, filters, granularity, request.query.equivalentPeriod === "true", await categoryStore.list(session.cpf)) } : {}),
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
          ...reportFor(session.cpf, transactions, filters, await categoryStore.list(session.cpf)),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  const clientDirectory = fileURLToPath(new URL("../dist/client", import.meta.url));
  app.use(express.static(clientDirectory));
  app.get("/{*path}", (request, response, next) => {
    if (request.path.startsWith("/api") || request.path.startsWith("/auth")) return next();
    return response.sendFile("index.html", { root: clientDirectory });
  });

  return app;
}
