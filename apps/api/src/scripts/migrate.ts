import { loadEnvFile } from '../config';
import { migrate } from '../db/migrate';

loadEnvFile();

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is not set');
  process.exit(1);
}

migrate(url)
  .then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date'))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
