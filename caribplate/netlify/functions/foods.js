exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const query = event.queryStringParameters && event.queryStringParameters.q
      ? event.queryStringParameters.q
      : '';

    if (!query) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing query parameter q' }) };
    }

    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=20&fields=product_name,brands,nutriments,serving_size,quantity`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'CaribPlate/1.0 (hello@caribplate.app)' }
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
