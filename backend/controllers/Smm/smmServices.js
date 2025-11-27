const axios = require('axios');
const FormData = require('form-data');

class SmmApiService {
  /**
   * @param {string} apiUrl
   * @param {string} apiKey
   * @param {{ defaultEncoding?: 'form'|'multipart'|'json', timeout?: number, defaultHeaders?: Record<string,string> }} [options]
   */
  constructor(apiUrl, apiKey, options = {}) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.defaultEncoding = options.defaultEncoding || 'form'; // 'form' | 'multipart' | 'json'
    this.timeout = typeof options.timeout === 'number' ? options.timeout : 15000;
    this.defaultHeaders = options.defaultHeaders || { Accept: 'application/json' };
  }

  buildFormBody(obj) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') params.append(k, JSON.stringify(v));
      else params.append(k, String(v));
    }
    return params;
  }

  buildMultipartBody(obj) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === undefined || v === null) continue;
      if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'value')) {
        fd.append(k, v.value, v.options || {});
      } else if (typeof v === 'object') {
        fd.append(k, JSON.stringify(v));
      } else {
        fd.append(k, String(v));
      }
    }
    return fd;
  }

  /**
   * @param {object} payload - API params
   * @param {{ encoding?: 'form'|'multipart'|'json', headers?: Record<string,string>, timeout?: number|false }} [opts]
   */
  async connect(payload, opts = {}) {
    try {
      const { encoding = this.defaultEncoding, headers = {}, timeout } = opts;
      const { _encoding, ...rest } = payload || {};
      const dataObj = { key: this.apiKey, ...rest };

      let data;
      let reqHeaders = { ...this.defaultHeaders, ...headers };
      if (encoding === 'multipart') {
        data = this.buildMultipartBody(dataObj);
        reqHeaders = { ...reqHeaders, ...data.getHeaders() };
      } else if (encoding === 'json') {
        data = dataObj;
        reqHeaders = { ...reqHeaders, 'Content-Type': 'application/json' };
      } else {
        data = this.buildFormBody(dataObj);
        reqHeaders = { ...reqHeaders, 'Content-Type': 'application/x-www-form-urlencoded' };
      }

      const axiosConfig = {
        headers: reqHeaders,
        timeout: 60000, // Default 60s cho tất cả API calls
      };

      // Override timeout nếu opts có chỉ định cụ thể
      if (typeof timeout === 'number') {
        axiosConfig.timeout = timeout;
      }

      const response = await axios.post(this.apiUrl, data, axiosConfig);
      return response.data;
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      if (data && typeof data === 'object') {
        return data;
      }
      const errorMsg = (data && typeof data === 'string') ? data : (err?.message || 'Unknown error');
      return { status, error: errorMsg };
    }
  }

  async order(data, opts) {
    return this.connect({ action: 'add', ...data }, opts);
  }

  async status(orderId, opts) {
    return this.connect({ action: 'status', order: orderId }, opts);
  }

  async multiStatus(orderIds, opts) {
    return this.connect({ action: 'status', orders: orderIds.join(',') }, opts);
  }

  async services(opts) {
    return this.connect({ action: 'services' }, opts);
  }
  
  async webcon(opts) {
    return this.connect({ action: 'webcon' }, opts);
  }

  async refill(orderId, opts) {
    return this.connect({ action: 'refill', order: orderId }, opts);
  }

  async multiRefill(orderIds, opts) {
    return this.connect({ action: 'refill', orders: orderIds.join(',') }, opts);
  }

  async refillStatus(refillId, opts) {
    return this.connect({ action: 'refill_status', refill: refillId }, opts);
  }

  async multiRefillStatus(refillIds, opts) {
    return this.connect({ action: 'refill_status', refills: refillIds.join(',') }, opts);
  }

  async cancel2(orderIds, opts) {
    return this.connect({ action: 'cancel', order: orderIds }, opts);
  }

  async cancel(orderIds, opts) {
    return this.connect({ action: 'cancel', orders: orderIds.join(',') }, opts);
  }

  async balance(opts) {
    // 👇 Chỉ balance mới có timeout riêng (ví dụ 10 giây)
    return this.connect({ action: 'balance' }, { ...opts, timeout: 15000 });
  }
}

module.exports = SmmApiService;