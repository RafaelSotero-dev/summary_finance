import type { ConsentScope, CreditCard, OpenFinanceConnection, OpenFinanceConnectionClient, Transaction } from "./app.js";

type PluggyAccount = {
  id: string;
  type: "BANK" | "CREDIT";
  name: string;
  balance: number;
  currencyCode: string;
  creditData?: { creditLimit?: number; availableCreditLimit?: number; balanceDueDate?: string };
};

type PluggyTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  currencyCode: string;
  status?: string;
  accountId?: string;
};

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Reads the read-only Meu Pluggy item that the Financial Owner created in
 * Pluggy's dashboard. It deliberately never asks Pluggy to refresh an item:
 * Meu Pluggy owns the 24-hour refresh cadence.
 */
export class PluggyOpenFinanceConnectionClient implements OpenFinanceConnectionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async createConnection({ financialOwnerCpf, institution, providerConnectionId }: { financialOwnerCpf: string; institution: string; providerConnectionId?: string; consentScope: readonly ConsentScope[] }): Promise<OpenFinanceConnection> {
    if (!providerConnectionId) throw new Error("Meu Pluggy item ID is required");
    return this.readConnection(financialOwnerCpf, institution, providerConnectionId);
  }

  async refreshConnection(connection: OpenFinanceConnection): Promise<OpenFinanceConnection> {
    if (!connection.providerConnectionId) throw new Error("Open Finance Connection is missing its Meu Pluggy item ID");
    return this.readConnection(connection.financialOwnerCpf, connection.financialInstitution.name, connection.providerConnectionId);
  }

  async synchronizeTransactions({ connection, since, until }: { connection: OpenFinanceConnection; since: Date; until: Date }): Promise<Transaction[]> {
    if (!connection.providerConnectionId) throw new Error("Open Finance Connection is missing its Meu Pluggy item ID");
    const apiKey = await this.apiKey();
    const accounts = await this.accounts(connection.providerConnectionId, apiKey);
    const transactions = await Promise.all(accounts.map(async (account) => {
      const all: PluggyTransaction[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          accountId: account.id,
          from: since.toISOString().slice(0, 10),
          to: until.toISOString().slice(0, 10),
        });
        if (cursor) query.set("cursor", cursor);
        const response = await this.request<{ results?: PluggyTransaction[]; cursor?: string; nextCursor?: string }>(`/transactions?${query}`, apiKey);
        all.push(...(response.results ?? []));
        cursor = response.nextCursor ?? response.cursor;
      } while (cursor);
      return all.map((transaction) => ({
        id: transaction.id,
        date: transaction.date.slice(0, 10),
        description: transaction.description,
        // Pluggy reports credit-card purchases as positive movements. At the
        // adapter boundary they become expenses, while a negative card refund
        // becomes positive income for the reporting model.
        amount: account.type === "CREDIT" ? -transaction.amount : transaction.amount,
        currency: transaction.currencyCode,
        pending: transaction.status?.toUpperCase() === "PENDING",
        ...(account.type === "BANK" ? { financialAccount: account.name } : { creditCardId: account.id }),
      }));
    }));
    return transactions.flat();
  }

  private async readConnection(financialOwnerCpf: string, institution: string, itemId: string): Promise<OpenFinanceConnection> {
    const apiKey = await this.apiKey();
    const accounts = await this.accounts(itemId, apiKey);
    return {
      financialOwnerCpf,
      financialInstitution: { name: institution, dataFreshness: new Date().toISOString() },
      financialAccounts: accounts.filter((account) => account.type === "BANK").map((account) => ({ name: account.name, balance: account.balance, currency: account.currencyCode })),
      creditCards: accounts.filter((account) => account.type === "CREDIT").map((account): CreditCard => ({
        id: account.id,
        name: account.name,
        kind: "physical",
        currency: account.currencyCode,
        ...(account.creditData?.creditLimit === undefined ? {} : { totalLimit: account.creditData.creditLimit }),
        usedLimit: account.balance,
        ...(account.creditData?.availableCreditLimit === undefined ? {} : { availableLimit: account.creditData.availableCreditLimit }),
        statement: { amountDue: account.balance, ...(account.creditData?.balanceDueDate ? { dueDate: account.creditData.balanceDueDate } : {}) },
      })),
      providerConnectionId: itemId,
    };
  }

  private async accounts(itemId: string, apiKey: string) {
    const response = await this.request<{ results?: PluggyAccount[] }>(`/accounts?itemId=${encodeURIComponent(itemId)}`, apiKey);
    return response.results ?? [];
  }

  private async apiKey() {
    const response = await this.fetcher(new URL("/auth", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
    });
    if (!response.ok) throw new Error(`Pluggy authentication failed with ${response.status}`);
    const body = await response.json() as { apiKey?: string };
    if (!body.apiKey) throw new Error("Pluggy authentication response is missing an API key");
    return body.apiKey;
  }

  private async request<T>(path: string, apiKey: string): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), { headers: { "X-API-KEY": apiKey } });
    if (!response.ok) throw new Error(`Pluggy request failed with ${response.status}`);
    return response.json() as Promise<T>;
  }
}
