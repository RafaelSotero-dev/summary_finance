import type { Pool } from "pg";
import type { AuthStore, FinancialOwner } from "../app.js";

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}

  async findVerifiedFinancialOwner(cpf: string, email: string): Promise<FinancialOwner | null> {
    const result = await this.pool.query<FinancialOwner>(
      "SELECT cpf, verified_email AS email FROM financial_owners WHERE cpf = $1 AND verified_email = $2",
      [cpf, email],
    );
    return result.rows[0] ?? null;
  }
}
