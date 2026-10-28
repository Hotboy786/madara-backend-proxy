const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('qs');
const dns = require('node:dns').promises;
const net = require('node:net');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/', (_req, res) => {
  res.status(200).send('Madara Proxy Server is Running');
});

function isPublicIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;

  // Reject private, loopback, link-local, carrier-grade NAT, multicast,
  // documentation, benchmarking, and other non-public/reserved ranges.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function isPublicIP(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) {
    const normalized = ip.toLowerCase();
    // Only allow globally routable IPv6 unicast addresses; reject local,
    // link-local, multicast, and IPv4-mapped addresses.
    return normalized.startsWith('2') || normalized.startsWith('3');
  }
  return false;
}

async function validateTargetUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error('A valid target URL is required'), { statusCode: 400 });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Target URL must use HTTP or HTTPS'), { statusCode: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('Credentials are not allowed in the target URL'), { statusCode: 400 });
  }
  if (!parsed.hostname || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local')) {
    throw Object.assign(new Error('Target host is not allowed'), { statusCode: 400 });
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (!isPublicIP(hostname)) {
      throw Object.assign(new Error('Private or reserved target IP addresses are not allowed'), { statusCode: 403 });
    }
  } else {
    let records;
    try {
      records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw Object.assign(new Error('Target hostname could not be resolved'), { statusCode: 400 });
    }
    if (!records.length || records.some((record) => !isPublicIP(record.address))) {
      throw Object.assign(new Error('Target hostname resolves to a private or reserved IP address'), { statusCode: 403 });
    }
  }

  parsed.hash = '';
  return parsed.toString();
}

// Optional shared-secret protection. Set PROXY_TOKEN in the hosting environment
// and send it as the X-Proxy-Token header from trusted clients.
app.use((req, res, next) => {
  const expectedToken = process.env.PROXY_TOKEN;
  if (!expectedToken || req.path === '/') return next();

  const suppliedToken = req.get('x-proxy-token');
  if (!suppliedToken || suppliedToken.length !== expectedToken.length ||
      !require('node:crypto').timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(expectedToken))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Universal Proxy Handler
async function handleProxyRequest(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const data = body.data && typeof body.data === 'object' ? body.data : {};

    const rawTargetUrl = body.baseUrl || body.url || body.apiUrl || body.api_url ||
      params.baseUrl || params.apiUrl || params.api_url;
    const apiKey = body.apiKey || body.key || body.api_key ||
      params.key || params.apiKey || params.api_key || data.key || data.apiKey || data.api_key;

    const action = body.action || params.action || data.action;
    const extraData = { ...params, ...data };

    for (const key of [
      'key', 'apiKey', 'api_key', 'action', 'baseUrl', 'url', 'apiUrl', 'api_url'
    ]) {
      delete extraData[key];
    }

    if (!rawTargetUrl) {
      if (req.path.includes('orders') || req.path.includes('schedule') || req.path.includes('log')) {
        return res.json([]);
      }
      return res.status(400).json({ error: 'Target URL is required' });
    }
    if (typeof rawTargetUrl !== 'string' || rawTargetUrl.length > 2048) {
      return res.status(400).json({ error: 'Target URL must be a string no longer than 2048 characters' });
    }
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'API Key is required' });
    }

    const targetUrl = await validateTargetUrl(rawTargetUrl.trim());
    const payload = { key: apiKey, ...(action ? { action } : {}), ...extraData };

    const response = await axios({
      method: 'POST',
      url: targetUrl,
      data: qs.stringify(payload),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'MadaraProxy/1.0'
      },
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 1 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300
    });

    let responseData = response.data;
    if (Array.isArray(responseData)) responseData = { orders: responseData };
    return res.status(200).json(responseData);
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode :
      (error.response?.status >= 400 && error.response?.status < 500 ? 502 : 502);

    // Do not leak upstream response bodies or internal network details to clients.
    console.error('Proxy request failed:', error.code || error.message);
    return res.status(status).json({
      error: error.statusCode ? error.message : 'Upstream request failed',
      ...(error.code === 'ECONNABORTED' ? { code: 'UPSTREAM_TIMEOUT' } : {})
    });
  }
}

// Map supported endpoints to the universal handler.
app.all('/proxy', handleProxyRequest);
app.all('/schedule-order', handleProxyRequest);
app.all('/orders', handleProxyRequest);
app.all('/status', handleProxyRequest);
app.all('/list', handleProxyRequest);
app.all('/api', handleProxyRequest);
app.all('*', handleProxyRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Madara Proxy running on port ' + PORT);
});
