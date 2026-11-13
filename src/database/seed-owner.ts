import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const cpf = process.env.FINANCIAL_OWNER_CPF?.replace(/\D/g, "");
const email = process.env.FINANCIAL_OWNER_EMAIL?.trim().toLowerCase();
if (!databaseUrl || !cpf || !email) throw new Error("DATABASE_URL, FINANCIAL_OWNER_CPF, and FINANCIAL_OWNER_EMAIL are required");
if (!/^\d{11}$/.test(cpf)) throw new Error("FINANCIAL_OWNER_CPF must contain 11 digits");
const pool = new Pool({ connectionString: databaseUrl });
await pool.query(
  "INSERT INTO financial_owners (cpf, verified_email) VALUES ($1, $2) ON CONFLICT (cpf) DO UPDATE SET verified_email = EXCLUDED.verified_email",
  [cpf, email],
);
await pool.end();
