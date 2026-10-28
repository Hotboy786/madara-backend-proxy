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

    // Handle initial state requests for orders / logs / schedules when no target URL is provided yet
    if (!targetUrl) {
      if (req.path.includes('orders') || req.path.includes('schedule')) {
        return res.json({ orders: [], entries: [], status: "success" });
      }
      return res.status(400).json({ error: 'Target URL is required' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key is required' });
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

    // Ensure array fields exist in response if UI expects them
    let resData = response.data;
    if (typeof resData === 'object' && resData !== null) {
      if (resData.orders === undefined && Array.isArray(resData)) resData = { orders: resData };
    }

    return res.json(resData);

  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    
    // Fallback empty structures on error so frontend map functions don't crash
    return res.status(200).json({
      orders: [],
      entries: [],
      error: error.message
    });
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
