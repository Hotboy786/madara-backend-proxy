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
    const targetUrl = req.body.baseUrl || req.body.url || req.body.apiUrl || req.body.api_url || req.body.params?.baseUrl || req.body.params?.apiUrl;
    const apiKey = req.body.apiKey || req.body.key || req.body.api_key || req.body.params?.key || req.body.params?.apiKey;
    
    // Extract exact action requested by frontend (balance, services, add, status, etc.)
    let action = req.body.action || req.body.params?.action || req.body.data?.action;

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
    delete extraData.apiUrl;

    // Return empty arrays for internal UI table queries missing a targetUrl
    if (!targetUrl) {
      if (req.path.includes('orders') || req.path.includes('schedule') || req.path.includes('log')) {
        return res.json([]);
      }
      return res.status(400).json({ error: 'Target URL is required' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key is required' });
    }

    // Build form-urlencoded payload for standard SMM API
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

    // Preserve the standard SMM API response shape for services. The services
    // action returns an array, and the frontend calls array methods such as
    // .slice() on it. Wrapping it in { orders: [...] } causes "list.slice is
    // not a function" when the frontend receives the result.
    const isServicesAction =
      typeof action === 'string' && action.toLowerCase() === 'services';

    if (Array.isArray(resData) && !isServicesAction) {
      resData = { orders: resData };
    }

    return res.json(resData);

  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    
    // Prevent UI map crashes on failure
    if (req.path.includes('orders') || req.path.includes('schedule') || req.path.includes('log')) {
      return res.status(200).json([]);
    }
    
    return res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data || null
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
