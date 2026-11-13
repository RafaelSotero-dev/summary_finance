import nodemailer from "nodemailer";
import { Pool } from "pg";
import { createApp, synchronizeFinancialOwnerTransactions } from "./app.js";
import { PluggyOpenFinanceConnectionClient } from "./pluggy-open-finance-connection-client.js";
import { PostgresAuthStore } from "./database/postgres-auth-store.js";
import { PostgresOpenFinanceConnectionStore } from "./database/postgres-open-finance-connection-store.js";
import { PostgresCategoryStore } from "./database/postgres-category-store.js";

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
const openFinanceConnectionClient = new PluggyOpenFinanceConnectionClient(
  process.env.PLUGGY_BASE_URL ?? "https://api.pluggy.ai",
  required("PLUGGY_CLIENT_ID"),
  required("PLUGGY_CLIENT_SECRET"),
);
const openFinanceConnectionStore = new PostgresOpenFinanceConnectionStore(pool);
const app = createApp({
  authStore: new PostgresAuthStore(pool),
  openFinanceConnectionClient,
  openFinanceConnectionStore,
  transactionStore: openFinanceConnectionStore,
  interpretationStore: openFinanceConnectionStore,
  categoryStore: new PostgresCategoryStore(pool),
  encryptedBackupStore: openFinanceConnectionStore,
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
  operationalNotifier: {
    sendConnectionRevoked: async (_financialOwnerCpf, financialInstitution) => {
      await transport.sendMail({
        from: required("EMAIL_FROM"),
        to: required("FINANCIAL_OWNER_EMAIL"),
        subject: "Conexão Open Finance revogada",
        text: `A Conexão Open Finance com ${financialInstitution} foi revogada e os dados locais foram removidos.`,
      });
    },
  },
  baseUrl: required("APP_BASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
});

let dailySynchronizationRunning = false;
const synchronizeDaily = async () => {
  if (dailySynchronizationRunning) return;
  dailySynchronizationRunning = true;
  try {
    const financialOwners = new Set((await openFinanceConnectionStore.findAll()).map((connection) => connection.financialOwnerCpf));
    for (const financialOwnerCpf of financialOwners) {
      await synchronizeFinancialOwnerTransactions(financialOwnerCpf, openFinanceConnectionClient, openFinanceConnectionStore, openFinanceConnectionStore, new Date());
    }
  } catch (error) {
    console.error("Daily transaction synchronization failed", error);
  } finally {
    dailySynchronizationRunning = false;
  }
};
setInterval(() => void synchronizeDaily(), 24 * 60 * 60_000).unref();

app.listen(port, () => console.log(`Personal Finance Dashboard listening on port ${port}`));
