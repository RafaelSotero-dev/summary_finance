import type { Pool, PoolClient } from "pg";
import type { CreditCard, EncryptedBackupStore, OpenFinanceConnection, OpenFinanceConnectionIdentity, OpenFinanceConnectionStore, StoredTransaction, Transaction, TransactionStore } from "../app.js";

type ConnectionRow = {
  id: number;
  financial_owner_cpf: string;
  financial_institution_name: string;
  data_freshness: Date;
  provider_connection_id: string | null;
  transactions_last_synchronized_at: Date | null;
  consent_status: "active" | "reconnection-required";
};

type AccountRow = { open_finance_connection_id: number; name: string; balance: string; currency: string; included_in_totals: boolean };

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
  included_in_totals: boolean;
};

type TransactionRow = {
  id: number;
  source_transaction_id: string;
  financial_institution_name: string;
  transaction_date: string;
  description: string;
  amount: string;
  currency: string;
  pending: boolean;
  financial_account: string | null;
  credit_card_id: string | null;
  installment_original_transaction_id: string | null;
  installment_number: number | null;
  installment_total: number | null;
  card_statement_settlement: boolean;
};

export class PostgresOpenFinanceConnectionStore implements OpenFinanceConnectionStore, TransactionStore, EncryptedBackupStore {
  constructor(private readonly pool: Pool) {}

  private async insertConnection(client: PoolClient, connection: OpenFinanceConnection) {
    const saved = await client.query<{ id: number }>(
      `INSERT INTO open_finance_connections (financial_owner_cpf, financial_institution_name, data_freshness, provider_connection_id, transactions_last_synchronized_at, consent_status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [connection.financialOwnerCpf, connection.financialInstitution.name, connection.financialInstitution.dataFreshness, connection.providerConnectionId ?? null, connection.transactionsLastSynchronizedAt ?? null, connection.consentStatus ?? "active"],
    );
    for (const account of connection.financialAccounts) {
      await client.query(
        `INSERT INTO financial_accounts (open_finance_connection_id, name, balance, currency, included_in_totals)
         VALUES ($1, $2, $3, $4, $5)`,
        [saved.rows[0].id, account.name, account.balance, account.currency, account.includedInTotals ?? true],
      );
    }
    for (const creditCard of connection.creditCards ?? []) {
      await client.query(
        `INSERT INTO credit_cards (open_finance_connection_id, source_credit_card_id, name, kind, currency, total_limit, used_limit, available_limit, statement_amount_due, statement_due_date, included_in_totals)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [saved.rows[0].id, creditCard.id, creditCard.name, creditCard.kind, creditCard.currency, creditCard.totalLimit ?? null, creditCard.usedLimit ?? null, creditCard.availableLimit ?? null, creditCard.statement?.amountDue ?? null, creditCard.statement?.dueDate ?? null, creditCard.includedInTotals ?? true],
      );
    }
  }

  async save(connection: OpenFinanceConnection) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.insertConnection(client, connection);
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
        `SELECT id, financial_owner_cpf, financial_institution_name, data_freshness, provider_connection_id, transactions_last_synchronized_at, consent_status
       FROM open_finance_connections WHERE financial_owner_cpf = $1 ORDER BY id`,
      [cpf],
    );
    if (connections.rows.length === 0) return [];

    const accounts = await this.pool.query<AccountRow>(
      `SELECT open_finance_connection_id, name, balance, currency, included_in_totals
       FROM financial_accounts WHERE open_finance_connection_id = ANY($1::bigint[]) ORDER BY id`,
      [connections.rows.map((connection) => connection.id)],
    );
    const creditCards = await this.pool.query<CreditCardRow>(
      `SELECT open_finance_connection_id, source_credit_card_id, name, kind, currency, total_limit, used_limit, available_limit, statement_amount_due, statement_due_date, included_in_totals
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
        consentStatus: connection.consent_status,
        financialAccounts: accounts.rows
          .filter((account) => account.open_finance_connection_id === connection.id)
          .map((account) => ({ name: account.name, balance: Number(account.balance), currency: account.currency.trim(), includedInTotals: account.included_in_totals })),
      creditCards: creditCards.rows
        .filter((creditCard) => creditCard.open_finance_connection_id === connection.id)
        .map((creditCard): CreditCard => ({
          id: creditCard.source_credit_card_id,
          name: creditCard.name,
          kind: creditCard.kind,
          currency: creditCard.currency.trim(),
          includedInTotals: creditCard.included_in_totals,
          ...(creditCard.total_limit === null ? {} : { totalLimit: Number(creditCard.total_limit) }),
          ...(creditCard.used_limit === null ? {} : { usedLimit: Number(creditCard.used_limit) }),
          ...(creditCard.available_limit === null ? {} : { availableLimit: Number(creditCard.available_limit) }),
          ...(creditCard.statement_amount_due === null ? {} : { statement: { amountDue: Number(creditCard.statement_amount_due), ...(creditCard.statement_due_date ? { dueDate: creditCard.statement_due_date } : {}) } }),
        })),
    }));
  }

  async findAll(): Promise<OpenFinanceConnection[]> {
    const connections = await this.pool.query<ConnectionRow>(
      `SELECT id, financial_owner_cpf, financial_institution_name, data_freshness, provider_connection_id, transactions_last_synchronized_at, consent_status
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
      consentStatus: connection.consent_status,
      financialAccounts: [],
    }));
  }

  async setConsentStatus(identity: OpenFinanceConnectionIdentity, status: "active" | "reconnection-required") {
    await this.pool.query(
      "UPDATE open_finance_connections SET consent_status = $1 WHERE financial_owner_cpf = $2 AND financial_institution_name = $3",
      [status, identity.financialOwnerCpf, identity.financialInstitution],
    );
  }

  async replace(identity: OpenFinanceConnectionIdentity, connection: OpenFinanceConnection) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM open_finance_connections WHERE financial_owner_cpf = $1 AND financial_institution_name = $2", [identity.financialOwnerCpf, identity.financialInstitution]);
      await this.insertConnection(client, connection);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refresh(identity: OpenFinanceConnectionIdentity, connection: OpenFinanceConnection) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query<{ id: number }>(
        `UPDATE open_finance_connections SET data_freshness = $1, provider_connection_id = $2
         WHERE financial_owner_cpf = $3 AND financial_institution_name = $4 RETURNING id`,
        [connection.financialInstitution.dataFreshness, connection.providerConnectionId ?? null, identity.financialOwnerCpf, identity.financialInstitution],
      );
      if (!saved.rows[0]) throw new Error("Open Finance Connection was not found");
      const connectionId = saved.rows[0].id;
      const accountTotals = await client.query<{ name: string; included_in_totals: boolean }>("SELECT name, included_in_totals FROM financial_accounts WHERE open_finance_connection_id = $1", [connectionId]);
      const cardTotals = await client.query<{ source_credit_card_id: string; included_in_totals: boolean }>("SELECT source_credit_card_id, included_in_totals FROM credit_cards WHERE open_finance_connection_id = $1", [connectionId]);
      await client.query("DELETE FROM financial_accounts WHERE open_finance_connection_id = $1", [connectionId]);
      await client.query("DELETE FROM credit_cards WHERE open_finance_connection_id = $1", [connectionId]);
      for (const account of connection.financialAccounts) {
        await client.query("INSERT INTO financial_accounts (open_finance_connection_id, name, balance, currency, included_in_totals) VALUES ($1, $2, $3, $4, $5)", [connectionId, account.name, account.balance, account.currency, accountTotals.rows.find((row) => row.name === account.name)?.included_in_totals ?? account.includedInTotals ?? true]);
      }
      for (const card of connection.creditCards ?? []) {
        await client.query(`INSERT INTO credit_cards (open_finance_connection_id, source_credit_card_id, name, kind, currency, total_limit, used_limit, available_limit, statement_amount_due, statement_due_date, included_in_totals)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [connectionId, card.id, card.name, card.kind, card.currency, card.totalLimit ?? null, card.usedLimit ?? null, card.availableLimit ?? null, card.statement?.amountDue ?? null, card.statement?.dueDate ?? null, cardTotals.rows.find((row) => row.source_credit_card_id === card.id)?.included_in_totals ?? card.includedInTotals ?? true]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setFinancialAccountIncludedInTotals(identity: OpenFinanceConnectionIdentity, accountName: string, includedInTotals: boolean) {
    const result = await this.pool.query<AccountRow>(
      `UPDATE financial_accounts a SET included_in_totals = $1
       FROM open_finance_connections c
       WHERE a.open_finance_connection_id = c.id AND c.financial_owner_cpf = $2
         AND c.financial_institution_name = $3 AND a.name = $4
       RETURNING a.open_finance_connection_id, a.name, a.balance, a.currency, a.included_in_totals`,
      [includedInTotals, identity.financialOwnerCpf, identity.financialInstitution, accountName],
    );
    const account = result.rows[0];
    return account && { name: account.name, balance: Number(account.balance), currency: account.currency.trim(), includedInTotals: account.included_in_totals };
  }

  async setCreditCardIncludedInTotals(identity: OpenFinanceConnectionIdentity, creditCardId: string, includedInTotals: boolean) {
    const result = await this.pool.query<CreditCardRow>(
      `UPDATE credit_cards card SET included_in_totals = $1
       FROM open_finance_connections connection
       WHERE card.open_finance_connection_id = connection.id AND connection.financial_owner_cpf = $2
         AND connection.financial_institution_name = $3 AND card.source_credit_card_id = $4
       RETURNING card.open_finance_connection_id, card.source_credit_card_id, card.name, card.kind, card.currency, card.total_limit, card.used_limit, card.available_limit, card.statement_amount_due, card.statement_due_date, card.included_in_totals`,
      [includedInTotals, identity.financialOwnerCpf, identity.financialInstitution, creditCardId],
    );
    const creditCard = result.rows[0];
    return creditCard && {
      id: creditCard.source_credit_card_id,
      name: creditCard.name,
      kind: creditCard.kind,
      currency: creditCard.currency.trim(),
      includedInTotals: creditCard.included_in_totals,
      ...(creditCard.total_limit === null ? {} : { totalLimit: Number(creditCard.total_limit) }),
      ...(creditCard.used_limit === null ? {} : { usedLimit: Number(creditCard.used_limit) }),
      ...(creditCard.available_limit === null ? {} : { availableLimit: Number(creditCard.available_limit) }),
      ...(creditCard.statement_amount_due === null ? {} : { statement: { amountDue: Number(creditCard.statement_amount_due), ...(creditCard.statement_due_date ? { dueDate: creditCard.statement_due_date } : {}) } }),
    };
  }

  async delete(identity: OpenFinanceConnectionIdentity) {
    await this.pool.query(
      "DELETE FROM open_finance_connections WHERE financial_owner_cpf = $1 AND financial_institution_name = $2",
      [identity.financialOwnerCpf, identity.financialInstitution],
    );
  }

  async saveEncryptedBackup(financialOwnerCpf: string, encryptedBackup: string) {
    await this.pool.query(
      "INSERT INTO encrypted_connection_backups (financial_owner_cpf, encrypted_payload) VALUES ($1, $2)",
      [financialOwnerCpf, encryptedBackup],
    );
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
          `INSERT INTO transactions (open_finance_connection_id, source_transaction_id, transaction_date, description, amount, currency, pending, financial_account, credit_card_id, installment_original_transaction_id, installment_number, installment_total, card_statement_settlement)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (open_finance_connection_id, source_transaction_id) DO UPDATE SET
              transaction_date = EXCLUDED.transaction_date, description = EXCLUDED.description, amount = EXCLUDED.amount,
              currency = EXCLUDED.currency, pending = EXCLUDED.pending, financial_account = EXCLUDED.financial_account, credit_card_id = EXCLUDED.credit_card_id, installment_original_transaction_id = EXCLUDED.installment_original_transaction_id,
              installment_number = EXCLUDED.installment_number, installment_total = EXCLUDED.installment_total, card_statement_settlement = EXCLUDED.card_statement_settlement`,
           [savedConnection.rows[0].id, transaction.id, transaction.date, transaction.description, transaction.amount, transaction.currency, transaction.pending, transaction.financialAccount ?? null, transaction.creditCardId ?? null, transaction.installmentPurchase?.originalTransactionId ?? null, transaction.installmentPurchase?.installmentNumber ?? null, transaction.installmentPurchase?.totalInstallments ?? null, transaction.cardStatementSettlement ?? false],
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
       `SELECT t.id, t.source_transaction_id, c.financial_institution_name, t.transaction_date::text, t.description, t.amount, t.currency, t.pending, t.financial_account, t.credit_card_id, t.installment_original_transaction_id, t.installment_number, t.installment_total, t.card_statement_settlement
       FROM transactions t JOIN open_finance_connections c ON c.id = t.open_finance_connection_id
       WHERE c.financial_owner_cpf = $1
         AND ($2 = '' OR c.financial_institution_name = $2)
         AND ($3 = '' OR t.description ILIKE '%' || $3 || '%')
       ORDER BY t.transaction_date DESC, t.id DESC`,
      [cpf, financialInstitution, search],
    );
    return transactions.rows.map((transaction) => ({
       id: `transaction-${transaction.id}`,
       sourceTransactionId: transaction.source_transaction_id,
      financialInstitution: transaction.financial_institution_name,
      date: transaction.transaction_date,
      description: transaction.description,
      amount: Number(transaction.amount),
      currency: transaction.currency.trim(),
      pending: transaction.pending,
      ...(transaction.financial_account === null ? {} : { financialAccount: transaction.financial_account }),
      ...(transaction.credit_card_id === null ? {} : { creditCardId: transaction.credit_card_id }),
      ...(transaction.installment_original_transaction_id === null ? {} : { installmentPurchase: { originalTransactionId: transaction.installment_original_transaction_id, installmentNumber: transaction.installment_number!, totalInstallments: transaction.installment_total! } }),
      ...(transaction.card_statement_settlement ? { cardStatementSettlement: true } : {}),
    }));
  }
}
