import type { ConsentScope, CreditCard, OpenFinanceConnection, OpenFinanceConnectionClient, Transaction } from "./app.js";

type BelvoLink = {
  id: string;
  institution?: { name?: string };
  owner?: { document_id?: string };
};

type BelvoAccount = { name: string; balance: number; currency: string };
type BelvoCreditCard = {
  id: string;
  name?: string;
  card_name?: string;
  type?: string;
  currency: string;
  credit_limit?: number;
  available_credit?: number;
  balance?: number;
};
type BelvoInvoice = {
  credit_card?: string;
  credit_card_id?: string;
  total_amount?: number;
  payment_due_date?: string;
};
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
    const [accounts, cards, invoices] = await Promise.all([
      this.request<BelvoAccount[]>(`/api/accounts/?link=${encodeURIComponent(link.id)}`),
      this.request<BelvoCreditCard[]>(`/api/credit-cards/?link=${encodeURIComponent(link.id)}`),
      this.request<BelvoInvoice[]>(`/api/invoices/?link=${encodeURIComponent(link.id)}`),
    ]);
    return {
      financialOwnerCpf: link.owner?.document_id?.replace(/\D/g, "") ?? "",
      financialInstitution: { name: link.institution?.name ?? institution, dataFreshness: new Date().toISOString() },
      financialAccounts: accounts.map((account) => ({ name: account.name, balance: account.balance, currency: account.currency })),
      creditCards: cards.map((card): CreditCard => {
        const invoice = invoices.find((candidate) => (candidate.credit_card_id ?? candidate.credit_card) === card.id);
        const kind = card.type?.toUpperCase() === "VIRTUAL" ? "virtual" : "physical";
        return {
          id: card.id,
          name: card.name ?? card.card_name ?? "Credit Card",
          kind,
          currency: card.currency,
          ...(card.credit_limit === undefined ? {} : { totalLimit: card.credit_limit }),
          ...(card.balance === undefined ? {} : { usedLimit: card.balance }),
          ...(card.available_credit === undefined ? {} : { availableLimit: card.available_credit }),
          ...(invoice?.total_amount === undefined ? {} : { statement: { amountDue: invoice.total_amount, ...(invoice.payment_due_date ? { dueDate: invoice.payment_due_date } : {}) } }),
        };
      }),
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

  async refreshConnection(connection: OpenFinanceConnection): Promise<OpenFinanceConnection> {
    if (!connection.providerConnectionId) throw new Error("Open Finance Connection is missing its provider identifier");
    const link = encodeURIComponent(connection.providerConnectionId);
    const [accounts, cards, invoices] = await Promise.all([
      this.request<BelvoAccount[]>(`/api/accounts/?link=${link}`),
      this.request<BelvoCreditCard[]>(`/api/credit-cards/?link=${link}`),
      this.request<BelvoInvoice[]>(`/api/invoices/?link=${link}`),
    ]);
    return {
      ...connection,
      financialInstitution: { ...connection.financialInstitution, dataFreshness: new Date().toISOString() },
      financialAccounts: accounts.map((account) => ({ name: account.name, balance: account.balance, currency: account.currency })),
      creditCards: cards.map((card): CreditCard => {
        const invoice = invoices.find((candidate) => (candidate.credit_card_id ?? candidate.credit_card) === card.id);
        return {
          id: card.id,
          name: card.name ?? card.card_name ?? "Credit Card",
          kind: card.type?.toUpperCase() === "VIRTUAL" ? "virtual" : "physical",
          currency: card.currency,
          ...(card.credit_limit === undefined ? {} : { totalLimit: card.credit_limit }),
          ...(card.balance === undefined ? {} : { usedLimit: card.balance }),
          ...(card.available_credit === undefined ? {} : { availableLimit: card.available_credit }),
          ...(invoice?.total_amount === undefined ? {} : { statement: { amountDue: invoice.total_amount, ...(invoice.payment_due_date ? { dueDate: invoice.payment_due_date } : {}) } }),
        };
      }),
    };
  }

  async revokeConnection({ providerConnectionId }: { providerConnectionId: string }) {
    await this.request(`/api/links/${encodeURIComponent(providerConnectionId)}/`, { method: "DELETE" });
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
