import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvironment } from "../src/environment.js";

test("loads application configuration from the supplied dotenv file", () => {
  const environment = loadEnvironment(".env.test", true);

  assert.equal(environment.APP_BASE_URL, "http://dashboard.test");
  assert.equal(environment.DATABASE_URL, "postgres://test:test@127.0.0.1:5432/finance_test");
  assert.equal(environment.FINANCIAL_OWNER_EMAIL, "owner-test@example.com");
});
