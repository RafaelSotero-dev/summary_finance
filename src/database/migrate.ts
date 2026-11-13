import { Pool } from "pg";
import { environment } from "../environment.js";
import { schema } from "./schema.js";

const databaseUrl = environment.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });
await pool.query(schema);
await pool.end();
