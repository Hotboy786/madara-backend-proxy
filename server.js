const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('qs');
const db = require('./db');

const app = express();
if (process.env.TEST_MODE === 'true') console.log('TEST_MODE enabled: provider order submissions blocked');

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const MAX_LEGS_PER_SCHEDULE = 250;
const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2147483647;

app.get('/', (req, res) => {
  res.send('Madara Proxy Server is Running');
});

function addActivity(entry) { db.log(entry).catch(err => console.error('Activity log error:',err.message)); }

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
  if (process.env.TEST_MODE === 'true' && String(params?.action || '').toLowerCase() === 'add') {
    const error = new Error('TEST_MODE: provider order submissions are disabled');
    error.statusCode = 403;
    throw error;
  }
  if (process.env.TEST_MODE === 'true') {
    throw Object.assign(new Error('TEST_MODE: external provider requests disabled'), { statusCode: 403 });
  }
  const parsedTarget = new URL(targetUrl);
  // Organic SMM uses a custom endpoint. Start with its documented JSON format.
  // If a read-only action times out, try form encoding as a safe compatibility fallback.
  // Never retry "add" automatically because a timed-out order may already have been accepted.
  const usesOrganicEndpoint = /\/functions\/v1\/public-api\/?$/i.test(parsedTarget.pathname);
  const requestData = { key: apiKey, ...params };
  const action = String(params.action || '').toLowerCase();
  const canFallbackEncoding = usesOrganicEndpoint && ['balance', 'services', 'status'].includes(action);
  const jsonTimeoutMs = canFallbackEncoding ? 12000 : 30000;

  let response;
  try {
    response = await axios({
      method: 'POST',
      url: targetUrl,
      data: usesOrganicEndpoint ? requestData : qs.stringify(requestData),
      headers: {
        'Content-Type': usesOrganicEndpoint ? 'application/json' : 'application/x-www-form-urlencoded',
        'User-Agent': 'Madara-Panel-Proxy/1.0'
      },
      timeout: usesOrganicEndpoint ? jsonTimeoutMs : 15000
    });
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(error.message || '');
    if (!canFallbackEncoding || !isTimeout) throw error;

    console.warn(`Organic SMM ${action} JSON request timed out; retrying once as form-urlencoded (read-only action)`);
    try {
      response = await axios({
        method: 'POST',
        url: targetUrl,
        data: qs.stringify(requestData),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Madara-Panel-Proxy/1.0'
        },
        timeout: 15000
      });
    } catch (fallbackError) {
      const fallbackTimedOut = fallbackError.code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(fallbackError.message || '');
      if (fallbackTimedOut) fallbackError.totalTimeoutMs = jsonTimeoutMs + 15000;
      throw fallbackError;
    }
  }

  const data = response.data;
  const providerStatus = data && typeof data.status === 'string' ? data.status.toLowerCase() : '';
  if (data && typeof data === 'object' && (data.error || providerStatus === 'error')) {
    const error = new Error(String(data.error || data.message || data.msg || 'Provider API returned an error'));
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
  const doneLegs = order.legs.filter((leg) => ['completed', 'failed', 'uncertain'].includes(leg.status)).length;
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

let pollBusy = false;
async function pollDueLegs() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    // A database claim ensures only one worker processes each leg.
    for(let i=0;i<10;i++) {
      const leg=await db.claim();
      if(!leg) break;
      try {
        const data=await postSmmApi(leg.baseUrl,leg.apiKey,{
          action:'add',service:leg.serviceId,link:leg.link,quantity:leg.quantity
        });
        if(!data || data.order===undefined || data.order===null) {
          await db.finish(leg,{status:'uncertain',error:'Provider response missing order ID; verify manually'});
        } else {
          await db.finish(leg,{status:'completed',providerOrderId:String(data.order)});
        }
      } catch(error) {
        // Timeout/network failure may happen AFTER provider acceptance.
        const uncertain=error.code==='ECONNABORTED'||!error.response;
        await db.finish(leg,{status:uncertain?'uncertain':'failed',error:error.message});
      }
    }
  } catch(e) { console.error('Scheduler poll failed:',e.message); }
  finally { pollBusy=false; }
}

async function createSchedule(req, res) {
  let name = 'Untitled schedule';
  let defaultLink = '';
  let submittedLegCount = 0;

  try {
    const body = req.body || {};
    name = String(body.name || 'Untitled schedule').trim().slice(0, 120);
    defaultLink = String(body.link || '').trim();
    const defaultBaseUrl = body.baseUrl ? safeUrl(body.baseUrl, 'Panel API URL') : '';
    const defaultApiKey = String(body.apiKey || body.key || '').trim();
    const inputLegs = body.legs;
    submittedLegCount = Array.isArray(inputLegs) ? inputLegs.length : 0;

    if (!defaultLink) {
      const error = new Error('Target link is required');
      error.statusCode = 400;
      throw error;
    }
    safeUrl(defaultLink, 'Target link');

    if (!Array.isArray(inputLegs) || inputLegs.length === 0) {
      const error = new Error('At least one scheduled service leg is required');
      error.statusCode = 400;
      throw error;
    }
    if (inputLegs.length > MAX_LEGS_PER_SCHEDULE) {
      const error = new Error(`A schedule can contain at most ${MAX_LEGS_PER_SCHEDULE} legs`);
      error.statusCode = 400;
      throw error;
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
    if (process.env.TEST_MODE !== 'true') {
      for (const account of providerAccounts.values()) {
        await getProviderBalance(account.baseUrl, account.apiKey);
      }
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
    await db.create(order, { type:'schedule_created',orderId:id,name,link:defaultLink,totalQuantity:legs.reduce((sum,leg)=>sum+leg.quantity,0),legCount:legs.length });
    return res.status(201).json({
      ok: true,
      id,
      scheduled: legs.length,
      order: publicOrder(order)
    });
  } catch (error) {
    const body = req.body || {};
    const secrets = [
      body.apiKey,
      body.key,
      ...(Array.isArray(body.legs) ? body.legs.map((leg) => leg && (leg.apiKey || leg.key)) : [])
    ].filter((value) => typeof value === 'string' && value.length > 0);
    let safeError = String(error.message || 'Could not create schedule');
    for (const secret of secrets) safeError = safeError.split(secret).join('[redacted]');

    // Keep rejected attempts visible in server-backed Activity Logs, too.
    // Never include keys or provider response payloads in this log entry.
    addActivity({
      type: 'schedule_rejected',
      name,
      link: defaultLink || null,
      legCount: submittedLegCount,
      error: safeError
    });
    console.error('Schedule request error:', safeError);
    return res.status(error.statusCode || error.response?.status || 500).json({
      error: safeError
    });
  }
}

async function listOrders(req,res) {
  try { res.json((await db.list()).map(publicOrder)); }
  catch(e) { res.status(500).json({error:'Could not load schedules'}); }
}
async function orderAction(req,res) {
  try {
    const id=String(req.params.id), action=req.params.action;
    if(!['pause','resume'].includes(action)) return res.status(400).json({error:'Unsupported order action'});
    const current=await db.get(id);
    if(!current) return res.status(404).json({error:'Order not found'});
    if(['completed','failed'].includes(current.status)) return res.status(409).json({error:'A finished order cannot be changed'});
    await db.changeStatus(id,action);
    return res.json({ok:true,order:publicOrder(await db.get(id))});
  } catch(e) { return res.status(500).json({error:'Could not update schedule'}); }
}
async function deleteOrder(req,res) {
  try {
    const ok=await db.remove(String(req.params.id));
    return ok?res.json({ok:true}):res.status(404).json({error:'Order not found'});
  } catch(e) { return res.status(500).json({error:'Could not delete schedule'}); }
}

// Universal proxy for provider actions such as balance, services, status, and add.
async function handleProxyRequest(req, res) {
  let action = null;
  let timeoutMs = 15000;
  let provider = 'panel';

  try {
    const targetUrl = req.body.baseUrl || req.body.url || req.body.apiUrl || req.body.api_url || req.body.params?.baseUrl || req.body.params?.apiUrl;
    const apiKey = req.body.apiKey || req.body.key || req.body.api_key || req.body.params?.key || req.body.params?.apiKey;
    action = req.body.action || req.body.params?.action || req.body.data?.action || null;

    const extraData = {
      ...(req.body.params || {}),
      ...(req.body.data || {})
    };

    for (const key of ['key', 'apiKey', 'api_key', 'action', 'baseUrl', 'url', 'apiUrl', 'api_url']) {
      delete extraData[key];
    }

    if (!targetUrl) return res.status(400).json({ error: 'Target URL is required' });
    if (!apiKey) return res.status(400).json({ error: 'API Key is required' });

    const validatedTargetUrl = safeUrl(targetUrl, 'Panel API URL');
    const parsedTarget = new URL(validatedTargetUrl);
    const isOrganicEndpoint = /\/functions\/v1\/public-api\/?$/i.test(parsedTarget.pathname);
    provider = isOrganicEndpoint ? 'organic-smm' : 'panel';
    timeoutMs = isOrganicEndpoint ? 30000 : 15000;

    const data = await postSmmApi(validatedTargetUrl, apiKey, {
      ...extraData,
      ...(action ? { action } : {})
    });

    const isServicesAction = typeof action === 'string' && action.toLowerCase() === 'services';
    if (Array.isArray(data) && !isServicesAction) return res.json({ orders: data });
    return res.json(data);
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || Number(error.totalTimeoutMs) > 0 || /timeout of \d+ms exceeded/i.test(error.message || '');
    const reportedTimeoutMs = Number(error.totalTimeoutMs) > 0 ? Number(error.totalTimeoutMs) : timeoutMs;
    const errorMessage = isTimeout
      ? `Provider API did not respond within ${reportedTimeoutMs}ms`
      : (error.message || 'Proxy request failed');

    console.error('Proxy Error:', isTimeout ? `Upstream timeout during action ${action || 'unknown'} (${provider}, ${reportedTimeoutMs}ms)` : (error.response?.data || error.message));
    return res.status(error.statusCode || error.response?.status || (isTimeout ? 504 : 500)).json({
      error: errorMessage,
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : (error.code || 'PROXY_ERROR'),
      action,
      provider,
      timeoutMs: reportedTimeoutMs,
      details: isTimeout ? null : (error.response?.data || null)
    });
  }
}

app.post('/schedule-order', createSchedule);
app.get('/orders', listOrders);
app.delete('/orders/:id', deleteOrder);
app.post('/orders/:id/:action', orderAction);

app.get('/activity-log',async(req,res)=>{try{res.json(await db.activities())}catch(e){res.status(500).json({error:'Database unavailable'})}});
app.get('/delivered-log',async(req,res)=>{try{res.json(await db.deliveries())}catch(e){res.status(500).json({error:'Database unavailable'})}});
app.get('/history',async(req,res)=>{try{res.json(await db.deliveries(String(req.query.link||'')))}catch(e){res.status(500).json({error:'Database unavailable'})}});

// Keep the provider proxy route distinct from schedule management routes.
app.all('/proxy', handleProxyRequest);
app.all('/status', handleProxyRequest);
app.all('/list', handleProxyRequest);
app.all('/api', handleProxyRequest);
app.all('*', handleProxyRequest);

const PORT = process.env.PORT || 10000;
db.init().then(async()=>{
  await db.markInterrupted();
  app.listen(PORT,'0.0.0.0',()=>console.log(`Madara Proxy running on port ${PORT}`));
  setInterval(pollDueLegs,5000);
  pollDueLegs();
}).catch(e=>{console.error('Database initialization failed:',e.message);process.exit(1)});
