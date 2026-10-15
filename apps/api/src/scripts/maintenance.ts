// One-off maintenance run (the API also runs this hourly).
import { loadConfig } from '../config';
import { createDb } from '../db';
import { runMaintenance } from '../lib/maintenance';

const config = loadConfig();
const db = createDb(config.DATABASE_ADMIN_URL, 1);
const result = await runMaintenance(db);
console.log(result ?? 'another node is running maintenance');
await db.destroy();
