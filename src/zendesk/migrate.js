#!/usr/bin/env node
// Apply src/zendesk/schema.sql to the configured Postgres (idempotent).
//   DATABASE_URL=... node src/zendesk/migrate.js
//   npm run zendesk:migrate
import { migrate, getPool } from "./store.js";

migrate()
  .then(async () => {
    console.log("[zendesk] schema applied");
    await (await getPool()).end();
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
