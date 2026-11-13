import type { ConsentScope, OpenFinanceConnection, OpenFinanceConnectionClient, Transaction } from "./app.js";

type BelvoLink = {
  id: string;
  institution?: { name?: string };
  owner?: { document_id?: string };
};

type BelvoAccount = { name: string; balance: number; currency: string };
type BelvoTransaction = {
  id: string;
  accounting_date: string;
  description: string;
  value: number;
  currency: string;
  status: string;
};

export class BelvoOpenFinanceConnectionClient implements OpenFinanceConnectionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secretId: string,
    private readonly secretPassword: string,
  ) {}

  async createConnection({ financialOwnerCpf, institution, consentScope }: { financialOwnerCpf: string; institution: string; consentScope: readonly ConsentScope[] }): Promise<OpenFinanceConnection> {
    const link = await this.request<BelvoLink>("/api/links/", {
      method: "POST",
      body: JSON.stringify({ institution, external_id: financialOwnerCpf, access_mode: "single", fetch_resources: consentScope }),
    });
    const accounts = await this.request<BelvoAccount[]>(`/api/accounts/?link=${encodeURIComponent(link.id)}`);
    return {
      financialOwnerCpf: link.owner?.document_id?.replace(/\D/g, "") ?? "",
      financialInstitution: { name: link.institution?.name ?? institution, dataFreshness: new Date().toISOString() },
      financialAccounts: accounts.map((account) => ({ name: account.name, balance: account.balance, currency: account.currency })),
      providerConnectionId: link.id,
    };
  }

  async synchronizeTransactions({ connection, since, until }: { connection: OpenFinanceConnection; since: Date; until: Date }): Promise<Transaction[]> {
    if (!connection.providerConnectionId) throw new Error("Open Finance Connection is missing its provider identifier");
    const query = new URLSearchParams({
      link: connection.providerConnectionId,
      date_from: since.toISOString().slice(0, 10),
      date_to: until.toISOString().slice(0, 10),
    });
    const transactions = await this.request<BelvoTransaction[]>(`/api/transactions/?${query}`);
    return transactions.map((transaction) => ({
      id: transaction.id,
      date: transaction.accounting_date,
      description: transaction.description,
      amount: transaction.value,
      currency: transaction.currency,
      pending: transaction.status.toUpperCase() === "PENDING",
    }));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.secretId}:${this.secretPassword}`).toString("base64")}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Belvo request failed with ${response.status}`);
    return response.json() as Promise<T>;
  }
}
