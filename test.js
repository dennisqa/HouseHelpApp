// netlify/functions/test.js
exports.handler = async (event, context) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };
  
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }
  
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Test function works!',
        method: event.httpMethod,
        path: event.path,
        queryStringParameters: event.queryStringParameters
      })
    };
  };