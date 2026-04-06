import 'dotenv/config';
import banner from './utils/banner.js';
import logger from './utils/logger.js';
import { LpgAgenApp } from './services/app.js';

async function main() {
  try {
    console.log(banner.trim());
    const app = new LpgAgenApp(process.cwd());
    await app.run();
  } catch (error) {
    logger.error('Aplikasi berhenti dengan error.', error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}

main();
