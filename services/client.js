import axios from 'axios';
import FormData from 'form-data';
import logger from '../utils/logger.js';
import {
  createProxyAgent,
  decodeJwtExpiry,
  delayMs,
  formatCoordinate,
  safeNumber,
} from '../utils/helper.js';

class SessionExpiredError extends Error {
  constructor(message = 'Sesi login sudah tidak valid.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export class LpgAgenClient {
  constructor({ config, captchaService, proxy = null, onSessionChanged = null }) {
    this.config = config;
    this.captchaService = captchaService;
    this.proxy = proxy;
    this.onSessionChanged = onSessionChanged;
    this.accessToken = null;
    this.accessTokenExpiresAt = null;
    this.requestTimestamps = [];
    this.agent = createProxyAgent(proxy);
  }

  getMaxRequestsPerMinute() {
    const configuredLimit = Math.floor(safeNumber(this.config.MAX_REQUESTS_PER_MINUTE, 45));
    return Math.max(configuredLimit, 0);
  }

  pruneRequestTimestamps(now = Date.now()) {
    const oneMinuteAgo = now - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((timestamp) => timestamp > oneMinuteAgo);
  }

  async waitForRateLimitSlot() {
    const maxRequestsPerMinute = this.getMaxRequestsPerMinute();
    if (maxRequestsPerMinute <= 0) {
      return;
    }

    while (true) {
      const now = Date.now();
      this.pruneRequestTimestamps(now);

      if (this.requestTimestamps.length < maxRequestsPerMinute) {
        this.requestTimestamps.push(now);
        return;
      }

      const waitMs = Math.max(60_000 - (now - this.requestTimestamps[0]), 200);
      logger.info(`Rate limit aktif (${maxRequestsPerMinute} request/menit). Menunggu ${Math.ceil(waitMs / 1000)} detik.`);
      await delayMs(waitMs);
    }
  }

  getQuantityForCustomerType(typeName) {
    if (typeName === 'Rumah Tangga') {
      return Math.max(safeNumber(this.config.QUANTITY_RUMAH_TANGGA, 1), 1);
    }

    if (typeName === 'Usaha Mikro') {
      return Math.max(safeNumber(this.config.QUANTITY_USAHA_MIKRO, 2), 1);
    }

    return 0;
  }

  setProxy(proxy = null) {
    this.proxy = proxy;
    this.agent = createProxyAgent(proxy);
  }

  buildHeaders(extraHeaders = {}) {
    return {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      origin: 'https://subsiditepatlpg.mypertamina.id',
      referer: 'https://subsiditepatlpg.mypertamina.id/',
      'user-agent': this.config.USER_AGENT,
      ...extraHeaders,
    };
  }

  async rawRequest({ method, url, headers = {}, data, params, maxRetries }) {
    const retries = Number(maxRetries ?? this.config.MAX_RETRIES ?? 3);

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await this.waitForRateLimitSlot();
        return await axios({
          method,
          url,
          data,
          params,
          headers: this.buildHeaders(headers),
          timeout: Number(this.config.REQUEST_TIMEOUT_MS || 45000),
          httpsAgent: this.agent || undefined,
          httpAgent: this.agent || undefined,
          validateStatus: () => true,
        });
      } catch (error) {
        if (attempt >= retries) {
          throw error;
        }

        logger.warn(`Request gagal, retry ${attempt}/${retries}`, error.message);
        await delayMs(attempt * 1000);
      }
    }

    return null;
  }

  isSessionAlive() {
    if (!this.accessToken) {
      return false;
    }

    if (!this.accessTokenExpiresAt) {
      return true;
    }

    return Date.now() < (this.accessTokenExpiresAt - 30_000);
  }

   setSession(session = null) {
    this.accessToken = session?.accessToken || null;
    this.accessTokenExpiresAt = session?.accessTokenExpiresAt || null;
  }

  emitSessionChanged() {
    if (typeof this.onSessionChanged === 'function') {
      this.onSessionChanged(this.getSession());
    }
  }

  getSession() {
    if (!this.accessToken) {
      return null;
    }

    return {
      accessToken: this.accessToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
    };
  }

  clearSession() {
    this.accessToken = null;
    this.accessTokenExpiresAt = null;
    this.emitSessionChanged();
  }

  async login(force = false) {
    if (!force && this.accessToken) {
      return this.accessToken;
    }

    const captchaToken = await this.captchaService.solveRecaptchaToken();
    if (!captchaToken) {
      throw new Error('Token captcha tidak berhasil didapatkan.');
    }

    const response = await this.rawRequest({
      method: 'post',
      url: `${this.config.API_BASE_URL}/subuser/v1/login`,
      headers: {
        authorization: `Basic ${this.config.LOGIN_BASIC_AUTH}`,
        'content-type': 'application/json',
      },
      data: {
        username: this.config.LOGIN_USERNAME,
        pin: this.config.LOGIN_PIN,
        token: captchaToken,
        fcmToken: this.config.LOGIN_FCM_TOKEN || '',
      },
      maxRetries: 1,
    });

    if (response.status >= 400 || response.data?.success === false) {
      throw new Error(response.data?.message || `Login gagal dengan status ${response.status}`);
    }

    this.accessToken = response.data?.data?.accessToken;
    this.accessTokenExpiresAt = decodeJwtExpiry(this.accessToken);

    if (!this.accessToken) {
      throw new Error('Login berhasil tetapi access token tidak ditemukan.');
    }

    this.emitSessionChanged();
    logger.success('Login berhasil.');
    return this.accessToken;
  }

  async authenticatedRequest({ method, url, headers = {}, data, params, retryOnAuthError = true }) {
    if (!this.accessToken) {
      await this.login();
    }

    const response = await this.rawRequest({
      method,
      url,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...headers,
      },
      data,
      params,
    });

    if ([401, 403].includes(response.status) || response.data?.message?.toLowerCase?.().includes('token')) {
      if (!retryOnAuthError) {
        throw new SessionExpiredError(response.data?.message || 'Token tidak valid.');
      }

      logger.warn('Token kadaluarsa atau tidak valid. Memaksa login ulang...');
      this.clearSession();
      await this.login(true);
      return this.authenticatedRequest({ method, url, headers, data, params, retryOnAuthError: false });
    }

    if (response.status >= 400 || response.data?.success === false) {
      throw new Error(response.data?.message || `Request gagal dengan status ${response.status}`);
    }

    return response.data;
  }

  async getProfile() {
    return this.authenticatedRequest({
      method: 'get',
      url: `${this.config.API_BASE_URL}/general/v1/users/profile`,
    });
  }

  async getProductUser() {
    return this.authenticatedRequest({
      method: 'get',
      url: `${this.config.API_BASE_URL}/general/products/v1/products/user`,
    });
  }

  async checkCustomerExists(nik) {
    return this.authenticatedRequest({
      method: 'get',
      url: `${this.config.API_BASE_URL}/customers/v1/history`,
      params: {
        nik,
        size: 50,
      },
    });
  }

  async verifyNik(nik) {
    return this.authenticatedRequest({
      method: 'get',
      url: `${this.config.API_BASE_URL}/customers/v2/verify-nik`,
      params: {
        nationalityId: nik,
      },
    });
  }

  async checkQuota({ nationalityId, familyIdEncrypted, customerType }) {
    return this.authenticatedRequest({
      method: 'get',
      url: `${this.config.API_BASE_URL}/general/v5/customers/${nationalityId}/quota`,
      params: {
        familyId: customerType === 'Rumah Tangga' ? familyIdEncrypted || '' : '',
        customerType,
      },
    });
  }

  async createTransaction({
    quantity,
    token,
    nationalityId,
    familyIdEncrypted,
    category,
    sourceTypeId,
    name,
    channelInject,
    coordinate,
  }) {
    const form = new FormData();
    form.append('quantity', String(quantity));
    form.append('token', token);
    form.append('nationalityId', nationalityId);
    form.append('familyIdEncrypted', familyIdEncrypted || '');
    form.append('category', category);
    form.append('sourceTypeId', String(sourceTypeId));
    form.append('name', name);
    form.append('channelInject', channelInject || '');
    form.append('coordinate', coordinate || '-,-');

    return this.authenticatedRequest({
      method: 'post',
      url: `${this.config.API_BASE_URL}/general/v3/transactions`,
      headers: form.getHeaders(),
      data: form,
    });
  }

  async resolveSellableCustomer(record, availableStock) {
    const nik = record.nik;
    const existsResponse = await this.checkCustomerExists(nik);
    const matches = Array.isArray(existsResponse?.data) ? existsResponse.data : [];
    if (matches.length === 0) {
      return { ok: false, reason: 'Customer tidak ditemukan di history.', nik };
    }

    const verifyResponse = await this.verifyNik(nik);
    const detail = verifyResponse?.data;
    if (!detail) {
      return { ok: false, reason: 'Detail customer kosong.', nik };
    }

    const normalizedTypes = Array.isArray(detail.customerTypes) ? detail.customerTypes : [];
    const priorities = ['Rumah Tangga', 'Usaha Mikro'];

    for (const typeName of priorities) {
      const customerType = normalizedTypes.find((item) => item?.name === typeName);
      if (!customerType || customerType.isBlocked || !customerType.isQuotaValid) {
        continue;
      }

      const configuredQuantity = this.getQuantityForCustomerType(typeName);
      const stockRemaining = Math.max(safeNumber(availableStock, 0), 0);
      if (stockRemaining <= 0) {
        continue;
      }

      const quotaResponse = await this.checkQuota({
        nationalityId: nik,
        familyIdEncrypted: detail.familyIdEncrypted,
        customerType: typeName,
      });

      const quotaRemaining = safeNumber(quotaResponse?.data?.quotaRemaining?.monthly, 0);
      const quantity = Math.min(configuredQuantity, stockRemaining, quotaRemaining);
      if (quantity <= 0) {
        continue;
      }

      const coordinate = typeName === 'Usaha Mikro'
        ? formatCoordinate(customerType?.merchant?.location)
        : '-,-';
      const sourceTypeId = typeName === 'Rumah Tangga' ? 1 : customerType.sourceTypeId;

      return {
        ok: true,
        nik,
        quantity,
        category: typeName,
        sourceTypeId,
        payload: {
          quantity,
          token: detail.token,
          nationalityId: nik,
          familyIdEncrypted: detail.familyIdEncrypted,
          category: typeName,
          sourceTypeId,
          name: detail.name,
          channelInject: detail.channelInject,
          coordinate,
        },
        detail,
        quota: quotaResponse?.data,
      };
    }

    return { ok: false, reason: 'Kuota tidak tersedia atau tipe customer tidak valid.', nik, detail };
  }

  async executeTransactionForRecord(record, availableStock) {
    const candidate = await this.resolveSellableCustomer(record, availableStock);
    if (!candidate.ok) {
      return candidate;
    }

    const transaction = await this.createTransaction(candidate.payload);
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
}

export { SessionExpiredError };
