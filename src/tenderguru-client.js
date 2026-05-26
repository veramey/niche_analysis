const DEFAULT_BASE_URL = 'https://www.tenderguru.ru/api2.3/export';

export class TenderGuruApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'TenderGuruApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class TenderGuruClient {
  constructor({
    apiCode = process.env.TENDERGURU_API_CODE,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!fetchImpl) {
      throw new Error('Global fetch is unavailable. Use Node.js 18+ or pass fetchImpl.');
    }

    this.apiCode = apiCode || '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async searchTenders(params = {}) {
    return this.request('', params);
  }

  async getTenderById(id, params = {}) {
    return this.request('', { ...params, id });
  }

  async getTenderByNumber(tendNum, params = {}) {
    return this.request('', { ...params, tend_num: tendNum });
  }

  async getContragentByInn(inn, params = {}) {
    return this.request(`/contragent/inn/${encodeURIComponent(inn)}`, params);
  }

  async getContragentByOgrn(ogrn, params = {}) {
    return this.request(`/contragent/ogrn/${encodeURIComponent(ogrn)}`, params);
  }

  async getContragentById(id, params = {}) {
    return this.request(`/contragent/id/${encodeURIComponent(id)}`, params);
  }

  async getContragentContacts(inn, params = {}) {
    return this.request(`/contragent/inn/${encodeURIComponent(inn)}/contact`, params);
  }

  async getReference(mode, params = {}) {
    return this.request('', { ...params, mode });
  }

  async getApiCode(refreshCode, { update } = {}) {
    if (!refreshCode) {
      throw new Error('refreshCode is required.');
    }

    const params = {
      refresh_code: refreshCode,
      get_api_code: 'true',
    };

    if (update !== undefined) {
      params.update = update;
    }

    return this.request('', params, { dtype: undefined, includeApiCode: false });
  }

  async request(path = '', params = {}, options = {}) {
    const dtype = Object.prototype.hasOwnProperty.call(options, 'dtype') ? options.dtype : 'json';
    const includeApiCode = options.includeApiCode ?? true;
    const timeoutMs = options.timeoutMs ?? 30000;

    const url = this.buildUrl(path, {
      ...(dtype ? { dtype } : {}),
      ...params,
      ...(includeApiCode && this.apiCode ? { api_code: this.apiCode } : {}),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let body;

    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: dtype === 'json' ? 'application/json, text/plain;q=0.9, */*;q=0.8' : '*/*',
          'User-Agent': 'tenderguru-integration/0.1',
        },
        signal: controller.signal,
      });

      body = await response.text();
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new TenderGuruApiError(`TenderGuru request timed out after ${timeoutMs}ms`, { url });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new TenderGuruApiError(`TenderGuru returned HTTP ${response.status}`, {
        status: response.status,
        url,
        body,
      });
    }

    if (dtype !== 'json') {
      return body;
    }

    try {
      return JSON.parse(body);
    } catch (error) {
      throw new TenderGuruApiError('TenderGuru returned invalid JSON', {
        status: response.status,
        url,
        body,
      });
    }
  }

  buildUrl(path = '', params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }
}
