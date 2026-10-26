import { createConfig } from '../server/config.js';
import { openDatabase } from '../server/db/database.js';
import { migrate } from '../server/db/migrate.js';
const config = createConfig();
const db = openDatabase(config);
try { migrate(db); console.log(`Migrations applied without resetting data: ${config.databasePath}`); }
finally { db.close(); }
