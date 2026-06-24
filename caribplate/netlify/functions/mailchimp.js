const https = require('https');
const crypto = require('crypto');

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { resolve({ statusCode: res.statusCode, json: {} }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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

  const apiKey     = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  const server     = process.env.MAILCHIMP_SERVER;

  if (!apiKey || !audienceId || !server) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Mailchimp not configured' })
    };
  }

  const { email, firstName, lastName, tags } = JSON.parse(event.body || '{}');

  if (!email) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Email required' })
    };
  }

  const authHeader = 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64');
  const activeTags = tags || ['app-user'];
  const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

  const mergeFields = {
    FNAME: firstName || '',
    LNAME: lastName || ''
  };

  // Step 1: Try to add as new member
  const memberData = JSON.stringify({
    email_address: email,
    status: 'subscribed',
    merge_fields: mergeFields,
    tags: activeTags
  });

  const postOptions = {
    hostname: `${server}.api.mailchimp.com`,
    path: `/3.0/lists/${audienceId}/members`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Content-Length': Buffer.byteLength(memberData)
    }
  };

  try {
    const postResult = await makeRequest(postOptions, memberData);

    // New member — added successfully
    if (postResult.statusCode === 200) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: true })
      };
    }

    // Existing member — update their details and cycle the tag (remove then re-add)
    if (postResult.statusCode === 400 && postResult.json.title === 'Member Exists') {

      // Step 2: Update merge fields
      const updateData = JSON.stringify({ merge_fields: mergeFields });
      const patchOptions = {
        hostname: `${server}.api.mailchimp.com`,
        path: `/3.0/lists/${audienceId}/members/${emailHash}`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Content-Length': Buffer.byteLength(updateData)
        }
      };
      await makeRequest(patchOptions, updateData);

      // Step 3: REMOVE the tags first
      const removeData = JSON.stringify({
        tags: activeTags.map(tag => ({ name: tag, status: 'inactive' }))
      });
      const removeTagOptions = {
        hostname: `${server}.api.mailchimp.com`,
        path: `/3.0/lists/${audienceId}/members/${emailHash}/tags`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Content-Length': Buffer.byteLength(removeData)
        }
      };
      await makeRequest(removeTagOptions, removeData);

      // Step 4: Wait briefly then RE-ADD the tags to trigger the automation
      await new Promise(res => setTimeout(res, 1000));

      const addData = JSON.stringify({
        tags: activeTags.map(tag => ({ name: tag, status: 'active' }))
      });
      const addTagOptions = {
        hostname: `${server}.api.mailchimp.com`,
        path: `/3.0/lists/${audienceId}/members/${emailHash}/tags`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Content-Length': Buffer.byteLength(addData)
        }
      };
      await makeRequest(addTagOptions, addData);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: true })
      };
    }

    // Any other error
    return {
      statusCode: postResult.statusCode,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: postResult.json.detail || postResult.json.title || 'Mailchimp error' })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
