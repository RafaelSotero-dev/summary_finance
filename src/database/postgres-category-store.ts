import type { Pool } from "pg";
import type { CategoryStore, TransactionCategory } from "../app.js";

type CategoryRow = {
  id: string;
  name: string;
  parent_category_id: string | null;
  archived: boolean;
};

function present(row: CategoryRow): TransactionCategory {
  return {
    id: row.id,
    name: row.name,
    parentCategoryId: row.parent_category_id,
    archived: row.archived,
  };
}

export class PostgresCategoryStore implements CategoryStore {
  constructor(private readonly pool: Pool) {}

  async list(financialOwnerCpf: string): Promise<TransactionCategory[]> {
    const result = await this.pool.query<CategoryRow>(
      `SELECT id::text, name, parent_category_id::text, archived
       FROM transaction_categories WHERE financial_owner_cpf = $1 ORDER BY id`,
      [financialOwnerCpf],
    );
    return result.rows.map(present);
  }

  async create(financialOwnerCpf: string, category: Pick<TransactionCategory, "name" | "parentCategoryId">): Promise<TransactionCategory> {
    const result = await this.pool.query<CategoryRow>(
      `INSERT INTO transaction_categories (financial_owner_cpf, name, parent_category_id)
       VALUES ($1, $2, $3) RETURNING id::text, name, parent_category_id::text, archived`,
      [financialOwnerCpf, category.name, category.parentCategoryId],
    );
    return present(result.rows[0]);
  }

  async update(financialOwnerCpf: string, category: TransactionCategory): Promise<TransactionCategory | null> {
    const result = await this.pool.query<CategoryRow>(
      `UPDATE transaction_categories
       SET name = $1, parent_category_id = $2, archived = $3
       WHERE id = $4 AND financial_owner_cpf = $5
       RETURNING id::text, name, parent_category_id::text, archived`,
      [category.name, category.parentCategoryId, category.archived, category.id, financialOwnerCpf],
    );
    return result.rows[0] ? present(result.rows[0]) : null;
  }
}
