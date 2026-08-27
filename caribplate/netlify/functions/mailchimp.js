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

// Permanent label tags. These mirror the trigger tag but are NEVER removed by
// any automation, so every contact keeps a visible, segmentable label even
// after the journey strips its trigger tag at the end. Mailchimp creates these
// tags automatically the first time they're used — no manual setup needed.
const LABEL_MAP = {
  'meal-plan-free': 'free-lead',
  'meal-plan-paid': 'paid-customer'
};

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

  const { email, firstName, lastName, country, hearAboutUs, tags } = JSON.parse(event.body || '{}');

  if (!email) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Email required' })
    };
  }

  const authHeader = 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64');

  // Trigger tags start the automations and get cycled (removed then re-added)
  // so repeat sign-ups can re-enter the journey.
  const triggerTags = Array.isArray(tags) && tags.length ? tags : [];

  // Permanent labels ride alongside the trigger and are never cycled.
  const labelTags = triggerTags.map(t => LABEL_MAP[t]).filter(Boolean);

  const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

  const mergeFields = {
    FNAME: firstName || '',
    LNAME: lastName || '',
    MMERGE3: hearAboutUs || '',
    COUNTRY: country || ''
  };

  // Step 1: Try to add as new member (trigger tag AND permanent label together)
  const memberData = JSON.stringify({
    email_address: email,
    status: 'subscribed',
    merge_fields: mergeFields,
    tags: [...triggerTags, ...labelTags]
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

    // Existing member — update details, keep the permanent label, cycle the trigger
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
      const patchResult = await makeRequest(patchOptions, updateData);

      // Do NOT swallow this. A rejected update here is why names silently
      // went missing on repeat signups for months.
      if (patchResult.statusCode >= 400) {
        return {
          statusCode: patchResult.statusCode,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            error: patchResult.json.detail || patchResult.json.title || 'Mailchimp rejected the contact update'
          })
        };
      }

      // Step 2b: Make sure the permanent label is present. It's never removed,
      // so the contact stays segmentable even after the automation strips the trigger.
      if (labelTags.length) {
        const labelData = JSON.stringify({
          tags: labelTags.map(tag => ({ name: tag, status: 'active' }))
        });
        const labelOptions = {
          hostname: `${server}.api.mailchimp.com`,
          path: `/3.0/lists/${audienceId}/members/${emailHash}/tags`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'Content-Length': Buffer.byteLength(labelData)
          }
        };
        await makeRequest(labelOptions, labelData);
      }

      // Step 3: REMOVE the trigger tags first (so the automation can re-fire)
      const removeData = JSON.stringify({
        tags: triggerTags.map(tag => ({ name: tag, status: 'inactive' }))
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

      // Step 4: Wait briefly then RE-ADD the trigger tags to re-trigger the automation
      await new Promise(res => setTimeout(res, 1000));

      const addData = JSON.stringify({
        tags: triggerTags.map(tag => ({ name: tag, status: 'active' }))
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
      const addResult = await makeRequest(addTagOptions, addData);

      // Harden: if the re-add failed, the trigger is gone and the automation
      // won't fire. Surface it instead of falsely reporting success.
      if (addResult.statusCode >= 400) {
        return {
          statusCode: addResult.statusCode,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            error: addResult.json.detail || addResult.json.title || 'Mailchimp rejected the tag re-add'
          })
        };
      }

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
