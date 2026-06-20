const https = require('https');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Supabase not configured' })
    };
  }

  const { email, firstName, planData, country, mealType, calorieTarget } = JSON.parse(event.body || '{}');
  if (!email || !planData) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Email and plan data required' })
    };
  }

  const record = JSON.stringify({
    email: email,
    first_name: firstName || '',
    plan_data: planData,
    country: country || '',
    meal_type: mealType || '',
    calorie_target: calorieTarget || null
  });

  const url = new URL(supabaseUrl + '/rest/v1/meal_plans');

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(record)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201 || res.statusCode === 200) {
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ success: true })
          });
        } else {
          resolve({
            statusCode: res.statusCode,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: data || 'Supabase error' })
          });
        }
      });
    });
    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: err.message })
      });
    });
    req.write(record);
    req.end();
  });
};
