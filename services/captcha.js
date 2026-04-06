import antiCaptcha from '@antiadmin/anticaptchaofficial';
import { Solver } from '@2captcha/captcha-solver';
import logger from '../utils/logger.js';
import { prompt, promptChoice, upsertEnvValue } from '../utils/helper.js';

const PROVIDERS = ['2captcha', 'anti-captcha'];

export class CaptchaService {
  constructor({ config, envPath }) {
    this.config = config;
    this.envPath = envPath;
  }

  async ensureConfigured() {
    if (!this.config.CAPTCHA_PROVIDER) {
      const selected = await promptChoice('Pilih provider captcha:', PROVIDERS);
      this.config.CAPTCHA_PROVIDER = selected;
      await upsertEnvValue(this.envPath, 'CAPTCHA_PROVIDER', selected);
    }

    if (!PROVIDERS.includes(this.config.CAPTCHA_PROVIDER)) {
      throw new Error(`Provider captcha tidak didukung: ${this.config.CAPTCHA_PROVIDER}`);
    }

    const keyName = this.config.CAPTCHA_PROVIDER === '2captcha' ? 'CAPTCHA_2CAPTCHA_KEY' : 'CAPTCHA_ANTI_KEY';
    if (!this.config[keyName]) {
      const key = await prompt(`Masukkan API key untuk ${this.config.CAPTCHA_PROVIDER}: `);
      if (!key) {
        throw new Error('API key captcha wajib diisi.');
      }
      this.config[keyName] = key;
      await upsertEnvValue(this.envPath, keyName, key);
    }
  }

  async solveRecaptchaToken() {
    await this.ensureConfigured();
    logger.info(`Meminta token captcha via ${this.config.CAPTCHA_PROVIDER}...`);

    if (this.config.CAPTCHA_PROVIDER === '2captcha') {
      return this.solveWith2Captcha();
    }

    return this.solveWithAntiCaptcha();
  }

  async solveWith2Captcha() {
    const solver = new Solver(this.config.CAPTCHA_2CAPTCHA_KEY, Number(this.config.CAPTCHA_POLLING_MS || 5000));
    const response = await solver.recaptcha({
      pageurl: this.config.LOGIN_PAGE_URL,
      googlekey: this.config.LOGIN_SITE_KEY,
      version: 'v3',
      enterprise: 1,
      action: this.config.CAPTCHA_ACTION,
      min_score: String(this.config.CAPTCHA_MIN_SCORE || '0.3'),
      userAgent: this.config.USER_AGENT,
    });

    return response?.data || response?.token || response?.code || response?.request;
  }

  async solveWithAntiCaptcha() {
    antiCaptcha.shutUp();
    antiCaptcha.setAPIKey(this.config.CAPTCHA_ANTI_KEY);
    const token = await antiCaptcha.solveRecaptchaV3Enterprise(
      this.config.LOGIN_PAGE_URL,
      this.config.LOGIN_SITE_KEY,
      Number(this.config.CAPTCHA_MIN_SCORE || 0.3),
      this.config.CAPTCHA_ACTION || ''
    );

    return token;
  }
}
