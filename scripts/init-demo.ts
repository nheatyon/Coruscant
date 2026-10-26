import { createConfig } from '../server/config.js';
import { openDatabase } from '../server/db/database.js';
import { verifySchema } from '../server/db/migrate.js';
import { initialize } from '../server/db/initialize.js';
import { comparisonDates } from '../demo/index.js';
const config = createConfig();
const db = openDatabase(config);
try {
  verifySchema(db);
  const d0 = initialize(db, config);
  const dates = comparisonDates(d0);
  console.log('Demo definitions initialized without workflow records.');
  console.log(`Persisted demonstration origin: ${d0}`);
  console.log(`Baseline reference guide (enter manually): ${dates.baselineDate}`);
  console.log(`Recent reference guide (enter manually): ${dates.recentDate}`);
  console.log('Guide dates are illustrative calendar dates, not actual acquisitions. Existing origin and saved records were preserved.');
}
finally { db.close(); }
