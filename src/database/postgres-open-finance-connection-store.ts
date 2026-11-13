import type { Pool } from "pg";
import type { OpenFinanceConnection, OpenFinanceConnectionStore } from "../app.js";

type ConnectionRow = {
  id: number;
  financial_owner_cpf: string;
  financial_institution_name: string;
  data_freshness: Date;
};

type AccountRow = { open_finance_connection_id: number; name: string; balance: string; currency: string };

export class PostgresOpenFinanceConnectionStore implements OpenFinanceConnectionStore {
  constructor(private readonly pool: Pool) {}

  async save(connection: OpenFinanceConnection) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query<{ id: number }>(
        `INSERT INTO open_finance_connections (financial_owner_cpf, financial_institution_name, data_freshness)
         VALUES ($1, $2, $3) RETURNING id`,
        [connection.financialOwnerCpf, connection.financialInstitution.name, connection.financialInstitution.dataFreshness],
      );
      for (const account of connection.financialAccounts) {
        await client.query(
          `INSERT INTO financial_accounts (open_finance_connection_id, name, balance, currency)
           VALUES ($1, $2, $3, $4)`,
          [saved.rows[0].id, account.name, account.balance, account.currency],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findByFinancialOwnerCpf(cpf: string): Promise<OpenFinanceConnection[]> {
    const connections = await this.pool.query<ConnectionRow>(
      `SELECT id, financial_owner_cpf, financial_institution_name, data_freshness
       FROM open_finance_connections WHERE financial_owner_cpf = $1 ORDER BY id`,
      [cpf],
    );
    if (connections.rows.length === 0) return [];

    const accounts = await this.pool.query<AccountRow>(
      `SELECT open_finance_connection_id, name, balance, currency
       FROM financial_accounts WHERE open_finance_connection_id = ANY($1::bigint[]) ORDER BY id`,
      [connections.rows.map((connection) => connection.id)],
    );
    return connections.rows.map((connection) => ({
      financialOwnerCpf: connection.financial_owner_cpf.trim(),
      financialInstitution: {
        name: connection.financial_institution_name,
        dataFreshness: connection.data_freshness.toISOString(),
      },
      financialAccounts: accounts.rows
        .filter((account) => account.open_finance_connection_id === connection.id)
        .map((account) => ({ name: account.name, balance: Number(account.balance), currency: account.currency.trim() })),
    }));
  }
}
