// 7. netlify/functions/messages.js - Message management
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://domestic_workers:5IQHgxXFQ4dEJXdIzMH27g@oasis-eagle-7263.jxf.gcp-europe-west1.cockroachlabs.cloud:26257/domestic_workers_app?sslmode=verify-full',
  ssl: { rejectUnauthorized: false }
});

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const client = await pool.connect();

  try {
    const { httpMethod, queryStringParameters, body } = event;
    const data = body ? JSON.parse(body) : {};

    switch (httpMethod) {
      case 'GET':
        const conversationId = queryStringParameters?.conversation_id;
        return await getMessages(client, conversationId);
      
      case 'POST':
        return await sendMessage(client, data);
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint not found' }) };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  } finally {
    client.release();
  }
};

async function getMessages(client, conversationId) {
  const result = await client.query(`
    SELECT m.*, u.name as sender_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.conversation_id = $1
    ORDER BY m.sent_at ASC
  `, [conversationId]);

  // Add compatibility fields
  const messages = result.rows.map(msg => ({
    ...msg,
    sender: msg.sender_id,
    text: msg.message_text,
    time: 'Just now'
  }));

  return { statusCode: 200, headers, body: JSON.stringify(messages) };
}

async function sendMessage(client, messageData) {
  const { conversation_id, sender_id, message_text } = messageData;

  const result = await client.query(
    `INSERT INTO messages (conversation_id, sender_id, message_text) 
     VALUES ($1, $2, $3) RETURNING *`,
    [conversation_id, sender_id, message_text]
  );

  // Update conversation's last message
  await client.query(
    `UPDATE conversations SET last_message_id = $1, last_message_at = CURRENT_TIMESTAMP 
     WHERE id = $2`,
    [result.rows[0].id, conversation_id]
  );

  return { statusCode: 201, headers, body: JSON.stringify(result.rows[0]) };
}