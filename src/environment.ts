import { config } from "dotenv";

export function loadEnvironment(path = ".env", override = false) {
  config({ path, override });

  return {
    APP_BASE_URL: process.env.APP_BASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    EMAIL_FROM: process.env.EMAIL_FROM,
    FINANCIAL_OWNER_CPF: process.env.FINANCIAL_OWNER_CPF,
    FINANCIAL_OWNER_EMAIL: process.env.FINANCIAL_OWNER_EMAIL,
    NODE_ENV: process.env.NODE_ENV,
    PLUGGY_BASE_URL: process.env.PLUGGY_BASE_URL,
    PLUGGY_CLIENT_ID: process.env.PLUGGY_CLIENT_ID,
    PLUGGY_CLIENT_SECRET: process.env.PLUGGY_CLIENT_SECRET,
    PORT: process.env.PORT,
    SESSION_SECRET: process.env.SESSION_SECRET,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
  };
}

const loadedEnvironment = loadEnvironment();

export const environment = {
  ...loadedEnvironment,
  get NODE_ENV() {
    return process.env.NODE_ENV;
  },
};
