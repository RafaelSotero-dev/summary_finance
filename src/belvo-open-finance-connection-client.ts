import type { ConsentScope, OpenFinanceConnection, OpenFinanceConnectionClient } from "./app.js";

type BelvoLink = {
  id: string;
  institution?: { name?: string };
  owner?: { document_id?: string };
};

type BelvoAccount = { name: string; balance: number; currency: string };

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
    };
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
