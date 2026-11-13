export const schema = `
  CREATE TABLE IF NOT EXISTS financial_owners (
    cpf CHAR(11) PRIMARY KEY CHECK (cpf ~ '^[0-9]{11}$'),
    verified_email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;
