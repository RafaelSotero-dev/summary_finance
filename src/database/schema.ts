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
    data_freshness TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS financial_accounts (
    id BIGSERIAL PRIMARY KEY,
    open_finance_connection_id BIGINT NOT NULL REFERENCES open_finance_connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    balance NUMERIC(18, 2) NOT NULL,
    currency CHAR(3) NOT NULL
  );
`;
