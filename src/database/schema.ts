export const schema = `
  CREATE TABLE IF NOT EXISTS financial_owners (
    cpf CHAR(11) PRIMARY KEY CHECK (cpf ~ '^[0-9]{11}$'),
    verified_email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS open_finance_connections (
    id BIGSERIAL PRIMARY KEY,
    financial_owner_cpf CHAR(11) NOT NULL REFERENCES financial_owners(cpf),
    financial_institution_name TEXT NOT NULL,
    data_freshness TIMESTAMPTZ NOT NULL,
    provider_connection_id TEXT,
    transactions_last_synchronized_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS financial_accounts (
    id BIGSERIAL PRIMARY KEY,
    open_finance_connection_id BIGINT NOT NULL REFERENCES open_finance_connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    balance NUMERIC(18, 2) NOT NULL,
    currency CHAR(3) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_cards (
    id BIGSERIAL PRIMARY KEY,
    open_finance_connection_id BIGINT NOT NULL REFERENCES open_finance_connections(id) ON DELETE CASCADE,
    source_credit_card_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    currency CHAR(3) NOT NULL,
    total_limit NUMERIC(18, 2),
    used_limit NUMERIC(18, 2),
    available_limit NUMERIC(18, 2),
    statement_amount_due NUMERIC(18, 2),
    statement_due_date DATE,
    UNIQUE (open_finance_connection_id, source_credit_card_id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    open_finance_connection_id BIGINT NOT NULL REFERENCES open_finance_connections(id) ON DELETE CASCADE,
    source_transaction_id TEXT NOT NULL,
    transaction_date DATE NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency CHAR(3) NOT NULL,
    pending BOOLEAN NOT NULL,
    installment_original_transaction_id TEXT,
    installment_number INTEGER,
    installment_total INTEGER,
    card_statement_settlement BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (open_finance_connection_id, source_transaction_id)
  );

  ALTER TABLE open_finance_connections ADD COLUMN IF NOT EXISTS provider_connection_id TEXT;
  ALTER TABLE open_finance_connections ADD COLUMN IF NOT EXISTS transactions_last_synchronized_at TIMESTAMPTZ;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment_original_transaction_id TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment_number INTEGER;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment_total INTEGER;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS card_statement_settlement BOOLEAN NOT NULL DEFAULT FALSE;
`;
