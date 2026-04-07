import 'dotenv/config';
import banner from './utils/banner.js';
import logger from './utils/logger.js';
import { getErrorMessage, isDebugErrorsEnabled } from './utils/helper.js';
import { LpgAgenApp } from './services/app.js';

function parseCliArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const keyValue = token.slice(2).split('=');
    const key = keyValue[0];
    const valueFromEqual = keyValue.length > 1 ? keyValue.slice(1).join('=') : undefined;
    const valueFromNext = valueFromEqual === undefined ? argv[index + 1] : undefined;
    const value = valueFromEqual ?? (valueFromNext && !valueFromNext.startsWith('--') ? valueFromNext : 'true');

    if (valueFromEqual === undefined && valueFromNext && !valueFromNext.startsWith('--')) {
      index += 1;
    }

    if (key === 'mode') {
      args.mode = value;
    } else if (key === 'days' || key === 'totalDays') {
      args.days = Number(value);
    } else if (key === 'check-time' || key === 'checkTime') {
      args.checkTime = value;
    }
  }

  return args;
}

async function main() {
  try {
    console.log(banner.trim());
    const app = new LpgAgenApp(process.cwd());
    const cliArgs = parseCliArgs(process.argv.slice(2));
    await app.run(cliArgs);
  } catch (error) {
    logger.error('Aplikasi berhenti dengan error.', isDebugErrorsEnabled() ? error : getErrorMessage(error));
    process.exitCode = 1;
  }
}

main();
