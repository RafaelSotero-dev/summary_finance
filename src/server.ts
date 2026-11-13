import nodemailer from "nodemailer";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { BelvoOpenFinanceConnectionClient } from "./belvo-open-finance-connection-client.js";
import { PostgresAuthStore } from "./database/postgres-auth-store.js";
import { PostgresOpenFinanceConnectionStore } from "./database/postgres-open-finance-connection-store.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const port = Number(process.env.PORT ?? 3000);
const pool = new Pool({ connectionString: required("DATABASE_URL") });
const transport = nodemailer.createTransport({
  host: required("SMTP_HOST"),
  port: Number(process.env.SMTP_PORT ?? 1025),
  secure: process.env.SMTP_SECURE === "true",
});
const app = createApp({
  authStore: new PostgresAuthStore(pool),
  openFinanceConnectionClient: new BelvoOpenFinanceConnectionClient(
    required("BELVO_BASE_URL"),
    required("BELVO_SECRET_ID"),
    required("BELVO_SECRET_PASSWORD"),
  ),
  openFinanceConnectionStore: new PostgresOpenFinanceConnectionStore(pool),
  magicLinkSender: {
    sendMagicLink: async (email, link) => {
      await transport.sendMail({
        from: required("EMAIL_FROM"),
        to: email,
        subject: "Seu link de acesso",
        text: `Acesse sua Visão Geral: ${link}`,
      });
    },
  },
  baseUrl: required("APP_BASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
});

app.listen(port, () => console.log(`Personal Finance Dashboard listening on port ${port}`));
