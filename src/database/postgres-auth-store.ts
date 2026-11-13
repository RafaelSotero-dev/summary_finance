import type { Pool } from "pg";
import type { AuthStore, AuthenticatedSession, FinancialOwner, SessionStore } from "../app.js";

export class PostgresAuthStore implements AuthStore, SessionStore {
  constructor(private readonly pool: Pool) {}

  async findVerifiedFinancialOwner(cpf: string, email: string): Promise<FinancialOwner | null> {
    const result = await this.pool.query<FinancialOwner>(
      "SELECT cpf, verified_email AS email FROM financial_owners WHERE cpf = $1 AND verified_email = $2",
      [cpf, email],
    );
    return result.rows[0] ?? null;
  }

  async invalidateUnusedMagicLinks(cpf: string): Promise<void> {
    await this.pool.query("UPDATE magic_links SET used_at = now() WHERE financial_owner_cpf = $1 AND used_at IS NULL", [cpf]);
  }

  async createMagicLink(cpf: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO magic_links (token_hash, financial_owner_cpf, expires_at) VALUES ($1, $2, $3)",
      [tokenHash, cpf, expiresAt],
    );
  }

  async consumeMagicLink(tokenHash: string, now: Date): Promise<string | null> {
    const result = await this.pool.query<{ financial_owner_cpf: string }>(
      "UPDATE magic_links SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING financial_owner_cpf",
      [tokenHash, now],
    );
    return result.rows[0]?.financial_owner_cpf ?? null;
  }

  async createSession(cpf: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO sessions (token_hash, financial_owner_cpf, expires_at) VALUES ($1, $2, $3)",
      [tokenHash, cpf, expiresAt],
    );
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<AuthenticatedSession | null> {
    const result = await this.pool.query<AuthenticatedSession>(
      "SELECT financial_owner_cpf AS cpf FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2",
      [tokenHash, now],
    );
    return result.rows[0] ?? null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash, now]);
  }
}
