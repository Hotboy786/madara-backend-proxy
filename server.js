const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('qs');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const scheduledOrders = new Map();
const activityLog = [];
const deliveredLog = [];
const deliveryHistory = new Map();
const legTimers = new Map();
const MAX_LOG_ENTRIES = 2000;
const MAX_LEGS_PER_SCHEDULE = 250;
const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2147483647;

app.get('/', (req, res) => {
  res.send('Madara Proxy Server is Running');
});

function addActivity(entry) {
  activityLog.unshift({ timestamp: Date.now(), ...entry });
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.length = MAX_LOG_ENTRIES;
}

function safeUrl(value, label) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    return parsed.toString();
  } catch {
    const error = new Error(`${label} must be a valid HTTP or HTTPS URL`);
    error.statusCode = 400;
    throw error;
  }
}

async function postSmmApi(targetUrl, apiKey, params) {
  const response = await axios({
    method: 'POST',
    url: targetUrl,
    data: qs.stringify({ key: apiKey, ...params }),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Madara-Panel-Proxy/1.0'
    },
    timeout: 15000
  });

  const data = response.data;
  if (data && typeof data === 'object' && data.error) {
    const error = new Error(String(data.error));
    error.statusCode = 400;
    throw error;
  }
  return data;
}

async function getProviderBalance(targetUrl, apiKey) {
  let data;
  try {
    data = await postSmmApi(targetUrl, apiKey, { action: 'balance' });
  } catch (error) {
    const wrapped = new Error(`Could not verify provider balance: ${error.response?.data?.error || error.message}`);
    wrapped.statusCode = error.statusCode || error.response?.status || 502;
    throw wrapped;
  }

  if (!data || typeof data !== 'object' || data.balance === undefined) {
    const error = new Error('Provider returned an unexpected balance response');
    error.statusCode = 502;
    throw error;
  }

  const balance = Number.parseFloat(data.balance);
  if (!Number.isFinite(balance)) {
    const error = new Error('Provider returned an invalid balance value');
    error.statusCode = 502;
    throw error;
  }
  if (balance <= 0) {
    const error = new Error('Panel balance is zero. Add funds to your SMM panel before creating paid orders.');
    error.statusCode = 402;
    throw error;
  }
  return { balance, currency: data.currency || '' };
}

function publicOrder(order) {
  const doneLegs = order.legs.filter((leg) => ['completed', 'failed'].includes(leg.status)).length;
  const byCategory = {};
  for (const leg of order.legs) {
    const category = leg.category || 'other';
    byCategory[category] = (byCategory[category] || 0) + Number(leg.quantity || 0);
  }
  const nextLeg = order.legs
    .filter((leg) => leg.status === 'waiting')
    .sort((a, b) => a.dueAt - b.dueAt)[0];

  return {
    id: order.id,
    name: order.name,
    link: order.link,
    status: order.status,
    totalLegs: order.legs.length,
    doneLegs,
    byCategory,
    nextFireAt: nextLeg ? new Date(nextLeg.dueAt).toISOString() : null,
    lastError: order.lastError || null,
    createdAt: order.createdAt
  };
}

function clearLegTimer(orderId, legId) {
  const timerKey = `${orderId}:${legId}`;
  const timer = legTimers.get(timerKey);
  if (timer) clearTimeout(timer);
  legTimers.delete(timerKey);
}

function armScheduledLeg(order, leg) {
  if (order.status !== 'running' || leg.status !== 'waiting') return;
  const timerKey = `${order.id}:${leg.id}`;
  clearLegTimer(order.id, leg.id);
  const remaining = Math.max(0, leg.dueAt - Date.now());

  // JavaScript timers cannot safely represent a single delay longer than
  // approximately 24.8 days, so re-arm long waits in bounded increments.
  const delay = Math.min(remaining, MAX_TIMEOUT_MS);
  const timer = setTimeout(() => {
    legTimers.delete(timerKey);
    if (order.status !== 'running' || leg.status !== 'waiting') return;
    if (leg.dueAt > Date.now()) {
      armScheduledLeg(order, leg);
      return;
    }
    executeScheduledLeg(order, leg).catch((error) => {
      console.error('Scheduled leg failure:', error.message);
    });
  }, delay);
  legTimers.set(timerKey, timer);
}

async function executeScheduledLeg(order, leg) {
  if (order.status !== 'running' || leg.status !== 'waiting') return;
  leg.status = 'processing';

  try {
    const data = await postSmmApi(leg.baseUrl, leg.apiKey, {
      action: 'add',
      service: leg.serviceId,
      link: leg.link,
      quantity: leg.quantity
    });

    const providerOrderId = data && data.order !== undefined ? String(data.order) : null;
    leg.status = 'completed';
    leg.providerOrderId = providerOrderId;
    leg.finishedAt = Date.now();

    const delivery = {
      timestamp: leg.finishedAt,
      link: leg.link,
      category: leg.category || 'other',
      amount: Number(leg.quantity),
      serviceLabel: leg.serviceLabel || leg.category || 'Service',
      orderId: order.id,
      providerOrderId
    };
    deliveredLog.unshift(delivery);
    if (deliveredLog.length > MAX_LOG_ENTRIES) deliveredLog.length = MAX_LOG_ENTRIES;

    if (!deliveryHistory.has(leg.link)) deliveryHistory.set(leg.link, []);
    deliveryHistory.get(leg.link).push(delivery);
    const history = deliveryHistory.get(leg.link);
    if (history.length > MAX_LOG_ENTRIES) history.splice(0, history.length - MAX_LOG_ENTRIES);

    addActivity({
      type: 'leg_completed',
      orderId: order.id,
      link: leg.link,
      category: leg.category || 'other',
      quantity: leg.quantity,
      providerOrderId
    });
  } catch (error) {
    leg.status = 'failed';
    leg.error = error.response?.data?.error || error.message;
    leg.finishedAt = Date.now();
    order.lastError = leg.error;
    addActivity({
      type: 'leg_failed',
      orderId: order.id,
      link: leg.link,
      category: leg.category || 'other',
      quantity: leg.quantity,
      error: leg.error
    });
  }

  const remaining = order.legs.some((item) => ['waiting', 'processing'].includes(item.status));
  if (!remaining) {
    order.status = order.legs.some((item) => item.status === 'failed') ? 'failed' : 'completed';
    order.finishedAt = Date.now();
    addActivity({ type: 'schedule_finished', orderId: order.id, status: order.status });
  }
}

async function createSchedule(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || 'Untitled schedule').trim().slice(0, 120);
    const defaultLink = String(body.link || '').trim();
    const defaultBaseUrl = body.baseUrl ? safeUrl(body.baseUrl, 'Panel API URL') : '';
    const defaultApiKey = String(body.apiKey || body.key || '').trim();
    const inputLegs = body.legs;

    if (!defaultLink) {
      return res.status(400).json({ error: 'Target link is required' });
    }
    safeUrl(defaultLink, 'Target link');

    if (!Array.isArray(inputLegs) || inputLegs.length === 0) {
      return res.status(400).json({ error: 'At least one scheduled service leg is required' });
    }
    if (inputLegs.length > MAX_LEGS_PER_SCHEDULE) {
      return res.status(400).json({ error: `A schedule can contain at most ${MAX_LEGS_PER_SCHEDULE} legs` });
    }

    const now = Date.now();
    const legs = inputLegs.map((input, index) => {
      const serviceId = String(input.serviceId ?? input.service ?? '').trim();
      const link = String(input.link || defaultLink).trim();
      const quantity = Number(input.quantity);
      const fireInMs = Number(input.fireInMs ?? 0);
      const baseUrl = safeUrl(input.baseUrl || defaultBaseUrl, `Leg ${index + 1} API URL`);
      const apiKey = String(input.apiKey || defaultApiKey).trim();

      if (!serviceId) {
        const error = new Error(`Leg ${index + 1} is missing a service ID`);
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        const error = new Error(`Leg ${index + 1} quantity must be a positive whole number`);
        error.statusCode = 400;
        throw error;
      }
      safeUrl(link, `Leg ${index + 1} target link`);
      if (!apiKey) {
        const error = new Error(`Leg ${index + 1} is missing an API key`);
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isFinite(fireInMs) || fireInMs < 0 || fireInMs > MAX_SCHEDULE_DELAY_MS) {
        const error = new Error(`Leg ${index + 1} schedule delay must be between 0 and 30 days`);
        error.statusCode = 400;
        throw error;
      }

      return {
        id: index + 1,
        serviceId,
        link,
        quantity,
        category: String(input.category || 'other'),
        serviceLabel: String(input.serviceLabel || input.category || 'Service'),
        baseUrl,
        apiKey,
        dueAt: now + fireInMs,
        status: 'waiting',
        providerOrderId: null,
        error: null
      };
    });

    // Check each unique provider account before queueing paid work. No orders
    // are submitted by this check; it only requests the provider's balance.
    const providerAccounts = new Map();
    for (const leg of legs) {
      const accountKey = JSON.stringify([leg.baseUrl, leg.apiKey]);
      if (!providerAccounts.has(accountKey)) {
        providerAccounts.set(accountKey, { baseUrl: leg.baseUrl, apiKey: leg.apiKey });
      }
    }
    for (const account of providerAccounts.values()) {
      await getProviderBalance(account.baseUrl, account.apiKey);
    }

    const id = `ord_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const order = {
      id,
      name,
      link: defaultLink,
      status: 'running',
      createdAt: now,
      finishedAt: null,
      lastError: null,
      legs
    };
    scheduledOrders.set(id, order);
    addActivity({
      type: 'schedule_created',
      orderId: id,
      name,
      link: defaultLink,
      totalQuantity: legs.reduce((sum, leg) => sum + leg.quantity, 0),
      legCount: legs.length
    });

    for (const leg of legs) armScheduledLeg(order, leg);

    return res.status(201).json({
      ok: true,
      id,
      scheduled: legs.length,
      order: publicOrder(order)
    });
  } catch (error) {
    console.error('Schedule request error:', error.response?.data || error.message);
    return res.status(error.statusCode || error.response?.status || 500).json({
      error: error.message || 'Could not create schedule'
    });
  }
}

function listOrders(req, res) {
  return res.json(Array.from(scheduledOrders.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicOrder));
}

function orderAction(req, res) {
  const order = scheduledOrders.get(String(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (req.params.action === 'pause') {
    if (['completed', 'failed'].includes(order.status)) {
      return res.status(409).json({ error: 'A finished order cannot be paused' });
    }
    order.status = 'paused';
    for (const leg of order.legs) clearLegTimer(order.id, leg.id);
    addActivity({ type: 'schedule_paused', orderId: order.id });
    return res.json({ ok: true, order: publicOrder(order) });
  }

  if (req.params.action === 'resume') {
    if (['completed', 'failed'].includes(order.status)) {
      return res.status(409).json({ error: 'A finished order cannot be resumed' });
    }
    order.status = 'running';
    for (const leg of order.legs) armScheduledLeg(order, leg);
    addActivity({ type: 'schedule_resumed', orderId: order.id });
    return res.json({ ok: true, order: publicOrder(order) });
  }

  return res.status(400).json({ error: 'Unsupported order action' });
}

function deleteOrder(req, res) {
  const id = String(req.params.id);
  const order = scheduledOrders.get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  for (const leg of order.legs) clearLegTimer(order.id, leg.id);
  scheduledOrders.delete(id);
  addActivity({ type: 'schedule_deleted', orderId: id, name: order.name });
  return res.json({ ok: true });
}

// Universal proxy for provider actions such as balance, services, status, and add.
async function handleProxyRequest(req, res) {
  try {
    const targetUrl = req.body.baseUrl || req.body.url || req.body.apiUrl || req.body.api_url || req.body.params?.baseUrl || req.body.params?.apiUrl;
    const apiKey = req.body.apiKey || req.body.key || req.body.api_key || req.body.params?.key || req.body.params?.apiKey;
    const action = req.body.action || req.body.params?.action || req.body.data?.action;

    const extraData = {
      ...(req.body.params || {}),
      ...(req.body.data || {})
    };

    for (const key of ['key', 'apiKey', 'api_key', 'action', 'baseUrl', 'url', 'apiUrl', 'api_url']) {
      delete extraData[key];
    }

    if (!targetUrl) return res.status(400).json({ error: 'Target URL is required' });
    if (!apiKey) return res.status(400).json({ error: 'API Key is required' });

    const data = await postSmmApi(safeUrl(targetUrl, 'Panel API URL'), apiKey, {
      ...(action ? { action } : {}),
      ...extraData
    });

    const isServicesAction = typeof action === 'string' && action.toLowerCase() === 'services';
    if (Array.isArray(data) && !isServicesAction) return res.json({ orders: data });
    return res.json(data);
  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    return res.status(error.statusCode || error.response?.status || 500).json({
      error: error.message || 'Proxy request failed',
      details: error.response?.data || null
    });
  }
}

app.post('/schedule-order', createSchedule);
app.get('/orders', listOrders);
app.delete('/orders/:id', deleteOrder);
app.post('/orders/:id/:action', orderAction);

app.get('/activity-log', (req, res) => res.json(activityLog));
app.get('/delivered-log', (req, res) => res.json(deliveredLog));
app.get('/history', (req, res) => {
  const link = String(req.query.link || '');
  return res.json((deliveryHistory.get(link) || []).slice());
});

// Keep the provider proxy route distinct from schedule management routes.
app.all('/proxy', handleProxyRequest);
app.all('/status', handleProxyRequest);
app.all('/list', handleProxyRequest);
app.all('/api', handleProxyRequest);
app.all('*', handleProxyRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Madara Proxy running on port ${PORT}`);
});
