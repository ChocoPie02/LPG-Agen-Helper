import path from 'path';
import { createServer } from 'node:http';
import logger from '../utils/logger.js';
import {
  addDays,
  buildDailyTargets,
  compareDateKeys,
  delay,
  getErrorMessage,
  getSecondsUntilNextDay,
  getSecondsUntilNextTimeOfDay,
  getSecondsUntilWorkStart,
  getTodayKey,
  isTodayOrYesterday,
  isValidNik,
  isWithinWorkHours,
  loadCsvRecords,
  parseNik,
  parseStockDateLabel,
  parseWorkTime,
  pickRandom,
  prompt,
  promptChoice,
  randomInt,
  readLines,
  rememberRecentValue,
  safeNumber,
  shuffle,
  shuffleAvoidingRecent,
  upsertEnvValue,
  ensureFile,
} from '../utils/helper.js';
import { StateStore } from './state.js';
import { CaptchaService } from './captcha.js';
import { LpgAgenClient } from './client.js';

const MODE_HABISKAN = 'Habiskan Kuota';
const MODE_HARIAN = 'Mode Harian';
const MODE_STANDBY = 'Mode Standby';
const MODE_LISTEN = 'Mode Listen';

const MODE_ALIAS = {
  habiskan: MODE_HABISKAN,
  habiskankuota: MODE_HABISKAN,
  harian: MODE_HARIAN,
  modestandby: MODE_STANDBY,
  standby: MODE_STANDBY,
  listen: MODE_LISTEN,
  modelisten: MODE_LISTEN,
};

export class LpgAgenApp {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.envPath = path.join(baseDir, '.env');
    this.dataPath = path.join(baseDir, 'data.csv');
    this.proxyPath = path.join(baseDir, 'proxy.txt');
    this.stateStore = new StateStore(baseDir);
    this.currentJob = null;
    this.currentJobPromise = null;
    this.recentNikHistory = [];
    this.config = this.loadConfig();
    this.captchaService = new CaptchaService({ config: this.config, envPath: this.envPath });
    this.client = new LpgAgenClient({
      config: this.config,
      captchaService: this.captchaService,
      onSessionChanged: (session) => {
        this.stateStore.patch({ session }).catch((error) => {
          logger.warn('Gagal menyimpan session ke state.json.', error.message);
        });
      },
    });
  }

  loadConfig() {
    return {
      API_BASE_URL: process.env.API_BASE_URL || 'https://api-map.my-pertamina.id',
      LOGIN_BASIC_AUTH: process.env.LOGIN_BASIC_AUTH || 'dGVsa29tOmRhMWMyNWQ4LTM3YzgtNDFiMS1hZmUyLTQyZGQ0ODI1YmZlYQ==',
      LOGIN_PAGE_URL: process.env.LOGIN_PAGE_URL || 'https://subsiditepatlpg.mypertamina.id/merchant-login',
      LOGIN_SITE_KEY: process.env.LOGIN_SITE_KEY || '6LcKckkrAAAAAOl-bcybJNUrsUQk0oX0GTvVwHyz',
      LOGIN_USERNAME: process.env.LOGIN_USERNAME || '',
      LOGIN_PIN: process.env.LOGIN_PIN || '',
      LOGIN_FCM_TOKEN: process.env.LOGIN_FCM_TOKEN || '',
      CAPTCHA_PROVIDER: process.env.CAPTCHA_PROVIDER || '',
      CAPTCHA_2CAPTCHA_KEY: process.env.CAPTCHA_2CAPTCHA_KEY || '',
      CAPTCHA_ANTI_KEY: process.env.CAPTCHA_ANTI_KEY || '',
      CAPTCHA_ACTION: process.env.CAPTCHA_ACTION || 'login',
      CAPTCHA_MIN_SCORE: process.env.CAPTCHA_MIN_SCORE || '0.3',
      CAPTCHA_POLLING_MS: process.env.CAPTCHA_POLLING_MS || '5000',
      USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      WORK_START: parseWorkTime(process.env.WORK_START, '07:00'),
      WORK_END: parseWorkTime(process.env.WORK_END, '18:00'),
      TIMEZONE: process.env.TIMEZONE || 'Asia/Jakarta',
      REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS || '45000',
      MAX_RETRIES: process.env.MAX_RETRIES || '3',
      MAX_REQUESTS_PER_MINUTE: process.env.MAX_REQUESTS_PER_MINUTE || '45',
      BETWEEN_TRANSACTION_SECONDS_MIN: process.env.BETWEEN_TRANSACTION_SECONDS_MIN || '15',
      BETWEEN_TRANSACTION_SECONDS_MAX: process.env.BETWEEN_TRANSACTION_SECONDS_MAX || '45',
      STANDBY_POLL_MINUTES: process.env.STANDBY_POLL_MINUTES || '15',
      STANDBY_CHECK_TIME: parseWorkTime(process.env.STANDBY_CHECK_TIME, '07:00'),
      MAX_CUSTOMER_ATTEMPTS: process.env.MAX_CUSTOMER_ATTEMPTS || '30',
      LISTEN_PORT: process.env.LISTEN_PORT || '8843',
      QUANTITY_RUMAH_TANGGA: process.env.QUANTITY_RUMAH_TANGGA || '1',
      QUANTITY_USAHA_MIKRO: process.env.QUANTITY_USAHA_MIKRO || '2',
      HABISKAN_STRATEGY: process.env.HABISKAN_STRATEGY || 'precheck',
      RECENT_NIK_WINDOW: process.env.RECENT_NIK_WINDOW || '10',
    };
  }

  async refreshConfigFromEnv() {
    const fresh = this.loadConfig();
    Object.assign(this.config, fresh);
  }

  async ensureBootstrapFiles() {
    await ensureFile(this.envPath, '');
    await ensureFile(this.dataPath, 'nik\n');
    await ensureFile(this.proxyPath, '');
  }

  async ensureCredentials() {
    const required = [
      ['LOGIN_USERNAME', 'Masukkan username login: '],
      ['LOGIN_PIN', 'Masukkan PIN login: '],
    ];

    for (const [key, label] of required) {
      if (!this.config[key]) {
        const value = await prompt(label);
        if (!value) {
          throw new Error(`${key} wajib diisi.`);
        }
        this.config[key] = value;
        await upsertEnvValue(this.envPath, key, value);
      }
    }
  }

  async prepareRuntime() {
    await this.ensureBootstrapFiles();
    await this.ensureCredentials();
    await this.captchaService.ensureConfigured();
    await this.refreshConfigFromEnv();

    const state = await this.stateStore.load();
    if (state?.session?.accessToken) {
      this.client.setSession(state.session);
      logger.info('Session bearer dari state.json dimuat, akan dicoba sebelum captcha.');
    }

    const proxies = await readLines(this.proxyPath);
    if (proxies.length > 0) {
      const proxy = pickRandom(proxies);
      this.client.setProxy(proxy);
      logger.info('Menggunakan proxy aktif.', proxy);
    } else {
      logger.warn('proxy.txt kosong. Request akan berjalan tanpa proxy.');
    }
  }

  async loadNikRecords() {
    const records = await loadCsvRecords(this.dataPath);
    const valid = records
      .map((record) => ({ ...record, nik: parseNik(record.nik) }))
      .filter((record) => isValidNik(record.nik));

    if (valid.length === 0) {
      throw new Error('Tidak ada NIK valid 16 digit di data.csv.');
    }

    return valid;
  }

  async run(runOptions = {}) {
    await this.prepareRuntime();

    const state = await this.stateStore.load();
    if (
      state?.activeMode === MODE_STANDBY
      || (state?.activeMode && state?.plan?.remainingStock > 0)
    ) {
      logger.info(`Menemukan state aktif: ${state.activeMode}. Resume otomatis.`);
      await this.resumePlan(state);
      return;
    }

    const forcedMode = this.resolveModeFromArg(runOptions.mode);
    if (forcedMode) {
      logger.info(`Mode dipilih dari argument: ${forcedMode}`);
      await this.executeModeByName(forcedMode, runOptions);
      return;
    }



    const mode = await promptChoice('Pilih mode awal:', [MODE_HABISKAN, MODE_HARIAN, MODE_STANDBY, MODE_LISTEN]);
    await this.executeModeByName(mode, runOptions);
  }

  resolveModeFromArg(modeArg) {
    if (!modeArg) {
      return null;
    }

    const normalized = String(modeArg).toLowerCase().replace(/\s+/gu, '');
    return MODE_ALIAS[normalized] || null;
  }

  async executeModeByName(mode, options = {}) {    await this.executeModeByName(mode, runOptions);
  }
  resolveModeFromArg(modeArg) {
    if (!modeArg) {
      return null;
    }

    const normalized = String(modeArg).toLowerCase().replace(/\s+/gu, '');
    return MODE_ALIAS[normalized] || null;
  }

  async executeModeByName(mode, options = {}) {

    if (mode === MODE_HABISKAN) {
      await this.startHabiskanMode();
      return;
    }

    if (mode === MODE_HARIAN) {
      await this.startHarianMode({ totalDays: options.days ?? options.totalDays });
      return;
    }

    if (mode === MODE_LISTEN) {
      await this.startListenMode();
      return;
    }

    await this.startStandbyMode({
      totalDays: options.days ?? options.totalDays,
      checkTime: options.checkTime,
    });
  }

  async resumePlan(state) {
    if (state.activeMode === MODE_HABISKAN) {
      await this.executeHabiskanPlan(state.plan);
      return;
    }

    if (state.activeMode === MODE_HARIAN) {
      await this.executeDailyPlan(state.plan);
      return;
    }

    if (state.activeMode === MODE_STANDBY) {
      await this.monitorStandby(state.plan);
    }
  }

  async getFreshProductSnapshot() {
    const profileResponse = await this.client.getProfile();
    const productResponse = await this.client.getProductUser();

    if (profileResponse?.data?.isAvailableTransaction === false) {
      throw new Error('Merchant sedang tidak bisa transaksi. Stok sudah kosong');
    }

    const snapshot = {
      profile: profileResponse.data,
      product: productResponse.data,
      fetchedAt: new Date().toISOString(),
    };

    await this.stateStore.patch({ lastProductSnapshot: snapshot });
    return snapshot;
  }

  async startHabiskanMode() {
    const snapshot = await this.getFreshProductSnapshot();
    const stockAvailable = safeNumber(snapshot.product?.stockAvailable, 0);
    if (stockAvailable <= 0) {
      throw new Error('Stock available sedang kosong.');
    }

    const plan = {
      mode: MODE_HABISKAN,
      remainingStock: stockAvailable,
      startedAt: new Date().toISOString(),
      lastRunAt: null,
      completedUnits: 0,
    };

    await this.stateStore.patch({ activeMode: MODE_HABISKAN, plan });
    await this.executeHabiskanPlan(plan);
  }

  async executeHabiskanPlan(plan) {
    while (plan.remainingStock > 0) {
      const stock = await this.sellUntilTarget({ unitsTarget: plan.remainingStock, mode: MODE_HABISKAN });
      plan.remainingStock = Math.max(stock.remainingStock, 0);
      plan.completedUnits = safeNumber(plan.completedUnits, 0) + stock.completedUnits;
      plan.lastRunAt = new Date().toISOString();
      await this.stateStore.patch({ activeMode: MODE_HABISKAN, plan });

      if (plan.remainingStock <= 0) {
        break;
      }

      logger.warn('Belum habis, refresh stok lagi sebelum lanjut.');
      const snapshot = await this.getFreshProductSnapshot();
      plan.remainingStock = safeNumber(snapshot.product?.stockAvailable, plan.remainingStock);
    }

    logger.success('Mode Habiskan Kuota selesai.');
    await this.stateStore.resetPlan();
  }

  async startHarianMode(options = {}) {
    const snapshot = await this.getFreshProductSnapshot();
    const stockAvailable = safeNumber(snapshot.product?.stockAvailable, 0);
    if (stockAvailable <= 0) {
      throw new Error('Stock available sedang kosong.');
    }

    const rawDays = options.totalDays ?? await prompt('Habiskan stok dalam berapa hari? ');
    const totalDays = Math.max(Number(rawDays) || 1, 1);
    const today = getTodayKey(this.config.TIMEZONE);
    const targets = buildDailyTargets(stockAvailable, totalDays);
    const plan = {
      mode: MODE_HARIAN,
      totalDays,
      targets,
      originalStock: stockAvailable,
      remainingStock: stockAvailable,
      startDate: today,
      createdAt: new Date().toISOString(),
      completedUnits: 0,
      completedByDate: {},
    };

    await this.stateStore.patch({ activeMode: MODE_HARIAN, plan });
    await this.executeDailyPlan(plan);
  }

   async startStandbyMode(options = {}) {
    const rawDays = options.totalDays ?? await prompt('Jika stok baru terdeteksi, habiskan dalam berapa hari? ');
    const totalDays = Math.max(Number(rawDays) || 1, 1);
    const rawCheckTime = options.checkTime ?? await prompt(`Jam cek standby harian (HH:mm) [default ${this.config.STANDBY_CHECK_TIME}]: `);
    const checkTime = parseWorkTime(rawCheckTime || this.config.STANDBY_CHECK_TIME, this.config.STANDBY_CHECK_TIME);
    const plan = {
      mode: MODE_STANDBY,
      totalDays,
      checkTime,
      waitingForStock: true,
      originalStock: 0,
      remainingStock: 0,
      startDate: null,
      stockDate: null,
      targets: [],
      completedUnits: 0,
      completedByDate: {},
      createdAt: new Date().toISOString(),
    };

    await this.stateStore.patch({ activeMode: MODE_STANDBY, plan });
    await this.monitorStandby(plan);
  }

  async monitorStandby(plan) {
    while (true) {
      try {
        const waitSeconds = getSecondsUntilNextTimeOfDay(plan.checkTime || this.config.STANDBY_CHECK_TIME, this.config.TIMEZONE);
        logger.info(`Mode standby menunggu jadwal cek harian ${plan.checkTime || this.config.STANDBY_CHECK_TIME}.`);
        await delay(waitSeconds);

        const snapshot = await this.getFreshProductSnapshot();
        const stockAvailable = safeNumber(snapshot.product?.stockAvailable, 0);
        const stockDate = parseStockDateLabel(snapshot.product?.stockDate, this.config.TIMEZONE);

        if (plan.waitingForStock) {
          if (stockAvailable > 0 && isTodayOrYesterday(stockDate, this.config.TIMEZONE)) {
            const today = getTodayKey(this.config.TIMEZONE);
            const distributionStart = today;
            plan.waitingForStock = false;
            plan.originalStock = stockAvailable;
            plan.remainingStock = stockAvailable;
            plan.stockDate = stockDate;
            plan.startDate = distributionStart;
            plan.targets = buildDailyTargets(stockAvailable, plan.totalDays);
            plan.completedUnits = 0;
            logger.success(`Stok baru terdeteksi. Distribusi mulai ${distributionStart}.`);
            await this.stateStore.patch({ activeMode: MODE_STANDBY, plan });
          } else {
            if (stockAvailable <= 0) {
              logger.info('Mode standby aktif: stockAvailable masih kosong, lanjut monitoring.');
            } else {
              logger.info('Mode standby menunggu stockDate hari ini/kemarin.');
            }
            continue;
          }
        }

        await this.executeDailyPlan(plan, MODE_STANDBY);

        if (plan.remainingStock <= 0) {
          logger.success('Rencana standby selesai. Kembali ke mode menunggu.');
          plan.waitingForStock = true;
          plan.originalStock = 0;
          plan.remainingStock = 0;
          plan.startDate = null;
          plan.stockDate = null;
          plan.targets = [];
          plan.completedByDate = {};
          plan.completedUnits = 0;
          await this.stateStore.patch({ activeMode: MODE_STANDBY, plan });
        }
      } catch (error) {
        logger.error('Standby mode error, loop akan lanjut retry.', error?.message || String(error));
      }
    }
  }

  async startListenMode() {
    const port = Number(this.config.LISTEN_PORT || 8843);
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          this.sendJson(res, 200, { success: true, message: 'listen mode aktif', code: 200 });
          return;
        }

        if (req.method === 'GET' && req.url === '/status') {
          const state = await this.stateStore.load();
          this.sendJson(res, 200, {
            success: true,
            code: 200,
            data: {
              currentJob: this.currentJob,
              activeMode: state?.activeMode || null,
              plan: state?.plan || null,
            },
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/execute') {
          if (this.currentJobPromise) {
            this.sendJson(res, 409, {
              success: false,
              code: 409,
              message: 'Masih ada job berjalan. Tunggu job selesai dulu.',
              data: { currentJob: this.currentJob },
            });
            return;
          }

          const body = await this.readRequestBody(req);
          const validation = this.validateExecutePayload(body);
          if (!validation.ok) {
            this.sendJson(res, 400, { success: false, code: 400, message: validation.message });
            return;
          }

          const job = {
            id: `job-${Date.now()}`,
            mode: validation.mode,
            status: 'running',
            requestedAt: new Date().toISOString(),
          };
          this.currentJob = job;

          this.currentJobPromise = this.executeModeFromPayload(validation).then(() => {
            this.currentJob = {
              ...job,
              status: 'completed',
              completedAt: new Date().toISOString(),
            };
          }).catch((error) => {
            this.currentJob = {
              ...job,
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: error.message,
            };
          }).finally(() => {
            this.currentJobPromise = null;
          });

          this.sendJson(res, 202, {
            success: true,
            code: 202,
            message: 'Job diterima dan dieksekusi.',
            data: { job: this.currentJob },
          });
          return;
        }

        this.sendJson(res, 404, { success: false, code: 404, message: 'Endpoint tidak ditemukan.' });
      } catch (error) {
        this.sendJson(res, 500, {
          success: false,
          code: 500,
          message: 'Terjadi error pada listen server.',
          error: error.message,
        });
      }
    });

    server.listen(port, () => {
      logger.success(`Mode listen aktif di port ${port}.`);
    });
  }

  async executeModeFromPayload(payload) {
    if (payload.mode === 'habiskan') {
      await this.startHabiskanMode();
      return;
    }

    if (payload.mode === 'harian') {
      await this.startHarianMode({ totalDays: payload.totalDays });
      return;
    }

    await this.startStandbyMode({ totalDays: payload.totalDays, checkTime: payload.checkTime });
  }

  validateExecutePayload(body) {
    const mode = String(body?.mode || '').toLowerCase();
    const allowed = ['habiskan', 'harian', 'standby'];
    if (!allowed.includes(mode)) {
      return { ok: false, message: 'mode wajib: habiskan | harian | standby' };
    }

    if (mode === 'harian' || mode === 'standby') {
      const totalDays = Number(body?.totalDays);
      if (!Number.isInteger(totalDays) || totalDays <= 0) {
        return { ok: false, message: 'totalDays wajib integer > 0 untuk mode harian/standby.' };
      }
    }

    if (mode === 'standby' && body?.checkTime) {
      try {
        parseWorkTime(body.checkTime, this.config.STANDBY_CHECK_TIME);
      } catch {
        return { ok: false, message: 'checkTime harus format HH:mm.' };
      }
    }

    return {
      ok: true,
      mode,
      totalDays: Number(body?.totalDays || 0),
      checkTime: body?.checkTime || this.config.STANDBY_CHECK_TIME,
    };
  }

  async readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  }

  sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(payload));
  }

  async executeDailyPlan(plan, forcedMode = MODE_HARIAN) {
    while (plan.remainingStock > 0) {
      const today = getTodayKey(this.config.TIMEZONE);
      if (compareDateKeys(today, plan.startDate) < 0) {
        logger.info(`Belum masuk tanggal distribusi ${plan.startDate}. Menunggu.`);
        await delay(getSecondsUntilNextDay(this.config.TIMEZONE));
        continue;
      }

      const dayIndex = Math.min(this.getDayIndex(plan, today), plan.targets.length - 1);
      const todayTarget = Math.max(safeNumber(plan.targets[dayIndex], 0), 0);
      const alreadyDoneToday = safeNumber(plan.completedByDate?.[today], 0);
      const remainingTargetToday = Math.max(todayTarget - alreadyDoneToday, 0);

      if (remainingTargetToday <= 0) {
        logger.info(`Target hari ${today} sudah tercapai.`);
        await delay(getSecondsUntilNextDay(this.config.TIMEZONE));
        continue;
      }

      if (!isWithinWorkHours(this.config.WORK_START, this.config.WORK_END, this.config.TIMEZONE)) {
        const waitSeconds = getSecondsUntilWorkStart(this.config.WORK_START, this.config.TIMEZONE);
        if (waitSeconds > 0) {
          logger.info(`Di luar jam kerja. Menunggu ${waitSeconds} detik sampai ${this.config.WORK_START}.`);
          await delay(waitSeconds);
          continue;
        }

        logger.info('Jam kerja hari ini sudah selesai. Menunggu hari berikutnya.');
        await delay(getSecondsUntilNextDay(this.config.TIMEZONE));
        continue;
      }

      const outcome = await this.sellUntilTarget({ unitsTarget: remainingTargetToday, mode: forcedMode });
      plan.remainingStock = Math.max(plan.remainingStock - outcome.unitsSold, 0);
      plan.completedUnits += outcome.unitsSold;
      plan.completedByDate = {
        ...plan.completedByDate,
        [today]: alreadyDoneToday + outcome.unitsSold,
      };
      await this.stateStore.patch({ activeMode: forcedMode, plan });

      if (outcome.unitsSold <= 0) {
        logger.warn('Tidak ada transaksi berhasil pada slot ini. Tunggu sebentar sebelum mencoba lagi.');
        await delay(randomInt(60, 180));
        continue;
      }

      if (plan.remainingStock <= 0) {
        break;
      }
    }

    if (forcedMode === MODE_HARIAN && plan.remainingStock <= 0) {
      logger.success('Mode Harian selesai.');
      await this.stateStore.resetPlan();
    }
  }

  getDayIndex(plan, todayKey) {
    const start = plan.startDate;
    let dayIndex = 0;
    let cursor = start;

    while (compareDateKeys(cursor, todayKey) < 0) {
      cursor = addDays(cursor, 1);
      dayIndex += 1;
    }

    return dayIndex;
  }

  getRecentNikWindow(recordsLength = 0) {
    const configured = Math.max(safeNumber(this.config.RECENT_NIK_WINDOW, 10), 0);
    if (recordsLength <= 1) {
      return 0;
    }
    return Math.min(configured, recordsLength - 1);
  }

  getOrderedCandidateList(records) {
    return shuffleAvoidingRecent(
      records,
      this.recentNikHistory,
      (record) => record.nik,
      this.getRecentNikWindow(records.length)
    );
  }

  rememberNikUsage(nik) {
    this.recentNikHistory = rememberRecentValue(
      this.recentNikHistory,
      nik,
      Math.max(safeNumber(this.config.RECENT_NIK_WINDOW, 10), 1)
    );
  }

  getWaitSecondsBetweenTransactions() {
    const minimum = safeNumber(this.config.BETWEEN_TRANSACTION_SECONDS_MIN, 15);
    const maximum = safeNumber(this.config.BETWEEN_TRANSACTION_SECONDS_MAX, 45);
    return randomInt(Math.min(minimum, maximum), Math.max(minimum, maximum));
  }

  getHabiskanStrategy() {
    const normalized = String(this.config.HABISKAN_STRATEGY || 'precheck').trim().toLowerCase();
    return normalized === 'direct' ? 'direct' : 'precheck';
  }

  async executeResolvedCandidate(candidate, mode) {
    const transaction = await this.client.createTransaction(candidate.payload);
    return {
      ok: true,
      nik: candidate.nik,
      quantity: candidate.quantity,
      category: candidate.category,
      transactionId: transaction?.data?.transactionId,
      transactionIdUnique: transaction?.data?.transactionIdUnique,
      detail: candidate.detail,
    };
  }

  async sellWithDirectStrategy({ records, unitsTarget, mode, maxAttempts }) {
    let remainingTarget = Math.max(Number(unitsTarget) || 0, 0);
    let unitsSold = 0;
    let completedUnits = 0;
    let attempts = 0;

    while (remainingTarget > 0 && attempts < maxAttempts) {
      attempts += 1;
      const candidateList = this.getOrderedCandidateList(records);
      let soldInThisAttempt = false;

      for (const record of candidateList) {
        this.rememberNikUsage(record.nik);

        try {
          const result = await this.client.executeTransactionForRecord(record, remainingTarget);
          if (!result.ok) {
            logger.debug(`NIK ${record.nik} dilewati.`, result.reason);
            continue;
          }

          unitsSold += result.quantity;
          completedUnits += result.quantity;
          remainingTarget -= result.quantity;
          logger.success(`Transaksi berhasil ${result.category} untuk NIK ${result.nik}.`, {
            quantity: result.quantity,
            transactionId: result.transactionId,
            transactionIdUnique: result.transactionIdUnique,
            mode,
          });

          soldInThisAttempt = true;
          break;
        } catch (error) {
          logger.warn(`Gagal proses NIK ${record.nik}.`, getErrorMessage(error));
        }
      }

      if (!soldInThisAttempt) {
        break;
      }

      if (remainingTarget > 0) {
        const waitSeconds = this.getWaitSecondsBetweenTransactions();
        logger.info(`Menunggu ${waitSeconds} detik sebelum transaksi berikutnya.`);
        await delay(waitSeconds);
      }
    }

    return {
      unitsSold,
      completedUnits,
      remainingStock: Math.max(remainingTarget, 0),
      attempts,
    };
  }

  async sellWithHabiskanPrecheck({ records, unitsTarget, mode, maxAttempts }) {
    let remainingTarget = Math.max(Number(unitsTarget) || 0, 0);
    let unitsSold = 0;
    let completedUnits = 0;
    let attempts = 0;

    while (remainingTarget > 0 && attempts < maxAttempts) {
      attempts += 1;
      const candidateList = this.getOrderedCandidateList(records);
      const resolvedCandidates = [];
      let plannedRemaining = remainingTarget;

      for (const record of candidateList) {
        this.rememberNikUsage(record.nik);

        try {
          const candidate = await this.client.resolveSellableCustomer(record, plannedRemaining);
          if (!candidate.ok) {
            logger.debug(`NIK ${record.nik} dilewati.`, candidate.reason);
            continue;
          }

          resolvedCandidates.push(candidate);
          plannedRemaining -= candidate.quantity;
          if (plannedRemaining <= 0) {
            break;
          }
        } catch (error) {
          logger.warn(`Gagal pre-check NIK ${record.nik}.`, getErrorMessage(error));
        }
      }

      if (resolvedCandidates.length === 0) {
        break;
      }

      logger.info(`Mode Habiskan pre-check menemukan ${resolvedCandidates.length} kandidat transaksi.`);
      let soldInThisAttempt = false;

      for (const candidate of resolvedCandidates) {
        try {
          const result = await this.executeResolvedCandidate(candidate, mode);
          unitsSold += result.quantity;
          completedUnits += result.quantity;
          remainingTarget -= result.quantity;
          logger.success(`Transaksi berhasil ${result.category} untuk NIK ${result.nik}.`, {
            quantity: result.quantity,
            transactionId: result.transactionId,
            transactionIdUnique: result.transactionIdUnique,
            mode,
          });

          soldInThisAttempt = true;
          if (remainingTarget <= 0) {
            break;
          }

          const waitSeconds = this.getWaitSecondsBetweenTransactions();
          logger.info(`Menunggu ${waitSeconds} detik sebelum transaksi berikutnya.`);
          await delay(waitSeconds);
        } catch (error) {
          logger.warn(`Gagal eksekusi transaksi NIK ${candidate.nik}.`, getErrorMessage(error));
        }
      }

      if (!soldInThisAttempt) {
        break;
      }
    }

    return {
      unitsSold,
      completedUnits,
      remainingStock: Math.max(remainingTarget, 0),
      attempts,
    };
  }

  async sellUntilTarget({ unitsTarget, mode }) {
    const records = await this.loadNikRecords();
    const maxAttempts = Math.max(Number(this.config.MAX_CUSTOMER_ATTEMPTS || 30), 1);

    if (mode === MODE_HABISKAN && this.getHabiskanStrategy() === 'precheck') {
      return this.sellWithHabiskanPrecheck({ records, unitsTarget, mode, maxAttempts });
    }

    return this.sellWithDirectStrategy({ records, unitsTarget, mode, maxAttempts });
  }
}
