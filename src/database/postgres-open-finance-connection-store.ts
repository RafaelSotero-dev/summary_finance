import type { Pool } from "pg";
import type { CreditCard, OpenFinanceConnection, OpenFinanceConnectionStore, StoredTransaction, Transaction, TransactionStore } from "../app.js";

type ConnectionRow = {
  id: number;
  financial_owner_cpf: string;
  financial_institution_name: string;
  data_freshness: Date;
  provider_connection_id: string | null;
  transactions_last_synchronized_at: Date | null;
};

type AccountRow = { open_finance_connection_id: number; name: string; balance: string; currency: string };

type CreditCardRow = {
  open_finance_connection_id: number;
  source_credit_card_id: string;
  name: string;
  kind: "physical" | "virtual";
  currency: string;
  total_limit: string | null;
  used_limit: string | null;
  available_limit: string | null;
  statement_amount_due: string | null;
  statement_due_date: string | null;
};

type TransactionRow = {
  source_transaction_id: string;
  financial_institution_name: string;
  transaction_date: string;
  description: string;
  amount: string;
  currency: string;
  pending: boolean;
  installment_original_transaction_id: string | null;
  installment_number: number | null;
  installment_total: number | null;
  card_statement_settlement: boolean;
};

export class PostgresOpenFinanceConnectionStore implements OpenFinanceConnectionStore, TransactionStore {
  constructor(private readonly pool: Pool) {}

  async save(connection: OpenFinanceConnection) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query<{ id: number }>(
        `INSERT INTO open_finance_connections (financial_owner_cpf, financial_institution_name, data_freshness, provider_connection_id, transactions_last_synchronized_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [connection.financialOwnerCpf, connection.financialInstitution.name, connection.financialInstitution.dataFreshness, connection.providerConnectionId ?? null, connection.transactionsLastSynchronizedAt ?? null],
      );
      for (const account of connection.financialAccounts) {
        await client.query(
          `INSERT INTO financial_accounts (open_finance_connection_id, name, balance, currency)
           VALUES ($1, $2, $3, $4)`,
          [saved.rows[0].id, account.name, account.balance, account.currency],
        );
      }
      for (const creditCard of connection.creditCards ?? []) {
        await client.query(
          `INSERT INTO credit_cards (open_finance_connection_id, source_credit_card_id, name, kind, currency, total_limit, used_limit, available_limit, statement_amount_due, statement_due_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [saved.rows[0].id, creditCard.id, creditCard.name, creditCard.kind, creditCard.currency, creditCard.totalLimit ?? null, creditCard.usedLimit ?? null, creditCard.availableLimit ?? null, creditCard.statement?.amountDue ?? null, creditCard.statement?.dueDate ?? null],
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
        `SELECT id, financial_owner_cpf, financial_institution_name, data_freshness, provider_connection_id, transactions_last_synchronized_at
       FROM open_finance_connections WHERE financial_owner_cpf = $1 ORDER BY id`,
      [cpf],
    );
    if (connections.rows.length === 0) return [];

    const accounts = await this.pool.query<AccountRow>(
      `SELECT open_finance_connection_id, name, balance, currency
       FROM financial_accounts WHERE open_finance_connection_id = ANY($1::bigint[]) ORDER BY id`,
      [connections.rows.map((connection) => connection.id)],
    );
    const creditCards = await this.pool.query<CreditCardRow>(
      `SELECT open_finance_connection_id, source_credit_card_id, name, kind, currency, total_limit, used_limit, available_limit, statement_amount_due, statement_due_date
       FROM credit_cards WHERE open_finance_connection_id = ANY($1::bigint[]) ORDER BY id`,
      [connections.rows.map((connection) => connection.id)],
    );
    return connections.rows.map((connection) => ({
      financialOwnerCpf: connection.financial_owner_cpf.trim(),
        financialInstitution: {
        name: connection.financial_institution_name,
        dataFreshness: connection.data_freshness.toISOString(),
        },
        providerConnectionId: connection.provider_connection_id ?? undefined,
        transactionsLastSynchronizedAt: connection.transactions_last_synchronized_at?.toISOString(),
       financialAccounts: accounts.rows
        .filter((account) => account.open_finance_connection_id === connection.id)
         .map((account) => ({ name: account.name, balance: Number(account.balance), currency: account.currency.trim() })),
      creditCards: creditCards.rows
        .filter((creditCard) => creditCard.open_finance_connection_id === connection.id)
        .map((creditCard): CreditCard => ({
          id: creditCard.source_credit_card_id,
          name: creditCard.name,
          kind: creditCard.kind,
          currency: creditCard.currency.trim(),
          ...(creditCard.total_limit === null ? {} : { totalLimit: Number(creditCard.total_limit) }),
          ...(creditCard.used_limit === null ? {} : { usedLimit: Number(creditCard.used_limit) }),
          ...(creditCard.available_limit === null ? {} : { availableLimit: Number(creditCard.available_limit) }),
          ...(creditCard.statement_amount_due === null ? {} : { statement: { amountDue: Number(creditCard.statement_amount_due), ...(creditCard.statement_due_date ? { dueDate: creditCard.statement_due_date } : {}) } }),
        })),
    }));
  }

  async findAll(): Promise<OpenFinanceConnection[]> {
    const connections = await this.pool.query<ConnectionRow>(
      `SELECT id, financial_owner_cpf, financial_institution_name, data_freshness, provider_connection_id, transactions_last_synchronized_at
       FROM open_finance_connections ORDER BY id`,
    );
    return connections.rows.map((connection) => ({
      financialOwnerCpf: connection.financial_owner_cpf.trim(),
      financialInstitution: {
        name: connection.financial_institution_name,
        dataFreshness: connection.data_freshness.toISOString(),
      },
      providerConnectionId: connection.provider_connection_id ?? undefined,
      transactionsLastSynchronizedAt: connection.transactions_last_synchronized_at?.toISOString(),
      financialAccounts: [],
    }));
  }

  async upsert(financialOwnerCpf: string, connection: OpenFinanceConnection, transactions: Transaction[], synchronizedAt: Date) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const savedConnection = await client.query<{ id: number }>(
        `SELECT id FROM open_finance_connections
         WHERE financial_owner_cpf = $1 AND financial_institution_name = $2
           AND provider_connection_id IS NOT DISTINCT FROM $3
         ORDER BY id DESC LIMIT 1`,
        [financialOwnerCpf, connection.financialInstitution.name, connection.providerConnectionId ?? null],
      );
      if (!savedConnection.rows[0]) throw new Error("Open Finance Connection was not found");
      for (const transaction of transactions) {
        await client.query(
          `INSERT INTO transactions (open_finance_connection_id, source_transaction_id, transaction_date, description, amount, currency, pending, installment_original_transaction_id, installment_number, installment_total, card_statement_settlement)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (open_finance_connection_id, source_transaction_id) DO UPDATE SET
              transaction_date = EXCLUDED.transaction_date, description = EXCLUDED.description, amount = EXCLUDED.amount,
              currency = EXCLUDED.currency, pending = EXCLUDED.pending, installment_original_transaction_id = EXCLUDED.installment_original_transaction_id,
              installment_number = EXCLUDED.installment_number, installment_total = EXCLUDED.installment_total, card_statement_settlement = EXCLUDED.card_statement_settlement`,
           [savedConnection.rows[0].id, transaction.id, transaction.date, transaction.description, transaction.amount, transaction.currency, transaction.pending, transaction.installmentPurchase?.originalTransactionId ?? null, transaction.installmentPurchase?.installmentNumber ?? null, transaction.installmentPurchase?.totalInstallments ?? null, transaction.cardStatementSettlement ?? false],
        );
      }
      await client.query(
        "UPDATE open_finance_connections SET transactions_last_synchronized_at = $1 WHERE id = $2",
        [synchronizedAt, savedConnection.rows[0].id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findTransactionsByFinancialOwnerCpf(cpf: string, search: string, financialInstitution: string): Promise<StoredTransaction[]> {
    const transactions = await this.pool.query<TransactionRow>(
      `SELECT t.source_transaction_id, c.financial_institution_name, t.transaction_date::text, t.description, t.amount, t.currency, t.pending, t.installment_original_transaction_id, t.installment_number, t.installment_total, t.card_statement_settlement
       FROM transactions t JOIN open_finance_connections c ON c.id = t.open_finance_connection_id
       WHERE c.financial_owner_cpf = $1
         AND ($2 = '' OR c.financial_institution_name = $2)
         AND ($3 = '' OR t.description ILIKE '%' || $3 || '%')
       ORDER BY t.transaction_date DESC, t.id DESC`,
      [cpf, financialInstitution, search],
    );
    return transactions.rows.map((transaction) => ({
      id: transaction.source_transaction_id,
      financialInstitution: transaction.financial_institution_name,
      date: transaction.transaction_date,
      description: transaction.description,
      amount: Number(transaction.amount),
      currency: transaction.currency.trim(),
      pending: transaction.pending,
      ...(transaction.installment_original_transaction_id === null ? {} : { installmentPurchase: { originalTransactionId: transaction.installment_original_transaction_id, installmentNumber: transaction.installment_number!, totalInstallments: transaction.installment_total! } }),
      ...(transaction.card_statement_settlement ? { cardStatementSettlement: true } : {}),
    }));
  }
}
