const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('qs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('Madara Proxy Server is Running');
});

// Universal Proxy Handler
async function handleProxyRequest(req, res) {
  try {
    const targetUrl = req.body.baseUrl || req.body.url || req.body.apiUrl || req.body.api_url;
    const apiKey = req.body.apiKey || req.body.key || req.body.api_key || req.body.params?.key;
    
    let action = req.body.action || req.body.params?.action;
    if (!action && req.path.includes('schedule')) action = 'add';

    const extraData = {
      ...(req.body.params || {}),
      ...(req.body.data || {})
    };

    delete extraData.key;
    delete extraData.apiKey;
    delete extraData.api_key;
    delete extraData.action;
    delete extraData.baseUrl;
    delete extraData.url;

    // FIX: If frontend queries internal orders/logs without a targetUrl, return empty arrays immediately
    if (!targetUrl) {
      return res.json([]);
    }

    if (!apiKey) {
      return res.json([]);
    }

    const payload = {
      key: apiKey,
      ...(action ? { action } : {}),
      ...extraData
    };

    const response = await axios({
      method: 'POST',
      url: targetUrl,
      data: qs.stringify(payload),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 15000
    });

    let resData = response.data;
    if (typeof resData === 'object' && resData !== null) {
      if (resData.orders === undefined && Array.isArray(resData)) resData = { orders: resData };
    }

    return res.json(resData);

  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    
    // Always return array-friendly fallbacks on error
    return res.status(200).json([]);
  }
}

// Map all endpoints to universal handler
app.all('/proxy', handleProxyRequest);
app.all('/schedule-order', handleProxyRequest);
app.all('/orders', handleProxyRequest);
app.all('/status', handleProxyRequest);
app.all('/list', handleProxyRequest);
app.all('/api', handleProxyRequest);
app.all('*', handleProxyRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Madara Proxy running on port ${PORT}`);
});
