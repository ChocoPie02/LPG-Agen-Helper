import chalk from 'chalk';

const PREFIX = '[ LPG Agen Helper ]';

function stringify(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '';
  }

  if (value instanceof Error) {
    return value.stack || value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function log(level, message, value = '') {
  const now = new Date().toLocaleString('id-ID');
  const colors = {
    info: chalk.cyanBright,
    warn: chalk.yellow,
    error: chalk.red,
    success: chalk.greenBright,
    debug: chalk.magenta,
  };

  const color = colors[level] || chalk.white;
  const line = [
    chalk.cyanBright(PREFIX),
    chalk.gray(`[ ${now} ]`),
    color(`[ ${level.toUpperCase()} ]`),
    message,
    stringify(value),
  ]
    .filter(Boolean)
    .join(' ');

  console.log(line);
}

const logger = {
  info: (message, value = '') => log('info', message, value),
  warn: (message, value = '') => log('warn', message, value),
  error: (message, value = '') => log('error', message, value),
  success: (message, value = '') => log('success', message, value),
  debug: (message, value = '') => log('debug', message, value),
};

export default logger;
