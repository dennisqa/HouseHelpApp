// 6. netlify/functions/conversations.js - Conversation management
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
        const userId = queryStringParameters?.user_id;
        return await getConversations(client, userId);
      
      case 'POST':
        return await createConversation(client, data);
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint not found' }) };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  } finally {
    client.release();
  }
};

async function getConversations(client, userId) {
  const result = await client.query(`
    SELECT c.*, 
           CASE 
             WHEN c.participant_1_id = $1 THEN u2.name 
             ELSE u1.name 
           END as other_user_name,
           CASE 
             WHEN c.participant_1_id = $1 THEN c.participant_2_id 
             ELSE c.participant_1_id 
           END as other_user_id,
           m.message_text as last_message,
           m.sent_at as last_message_time
    FROM conversations c
    JOIN users u1 ON c.participant_1_id = u1.id
    JOIN users u2 ON c.participant_2_id = u2.id
    LEFT JOIN messages m ON c.last_message_id = m.id
    WHERE c.participant_1_id = $1 OR c.participant_2_id = $1
    ORDER BY c.last_message_at DESC NULLS LAST
  `, [userId]);

  // Add compatibility fields
  const conversations = result.rows.map(conv => ({
    ...conv,
    name: conv.other_user_name,
    otherUserId: conv.other_user_id,
    lastMessage: conv.last_message || 'Start a conversation',
    time: 'Just now',
    unread: false,
    messages: [] // Will be loaded separately
  }));

  return { statusCode: 200, headers, body: JSON.stringify(conversations) };
}

async function createConversation(client, conversationData) {
  const { participant_1_id, participant_2_id, job_id, initial_message } = conversationData;

  // Check if conversation already exists
  const existingConv = await client.query(
    `SELECT * FROM conversations 
     WHERE (participant_1_id = $1 AND participant_2_id = $2) 
     OR (participant_1_id = $2 AND participant_2_id = $1)`,
    [participant_1_id, participant_2_id]
  );

  let conversation;
  if (existingConv.rows.length > 0) {
    conversation = existingConv.rows[0];
  } else {
    // Create new conversation
    const convResult = await client.query(
      `INSERT INTO conversations (participant_1_id, participant_2_id, job_id) 
       VALUES ($1, $2, $3) RETURNING *`,
      [participant_1_id, participant_2_id, job_id]
    );
    conversation = convResult.rows[0];
  }

  // Add initial message if provided
  if (initial_message) {
    const messageResult = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, message_text) 
       VALUES ($1, $2, $3) RETURNING *`,
      [conversation.id, participant_1_id, initial_message]
    );

    // Update conversation's last message
    await client.query(
      `UPDATE conversations SET last_message_id = $1, last_message_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [messageResult.rows[0].id, conversation.id]
    );
  }

  return { statusCode: 200, headers, body: JSON.stringify(conversation) };
}