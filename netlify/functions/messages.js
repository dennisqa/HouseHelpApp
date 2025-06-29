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
      
      case 'PUT':
        const messageId = queryStringParameters?.id;
        return await markMessageAsRead(client, messageId, data);
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
  try {
    console.log('Getting messages for conversation:', conversationId);
    
    if (!conversationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Conversation ID required' }) };
    }

    const result = await client.query(`
      SELECT m.*, u.name as sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      ORDER BY m.sent_at ASC
    `, [conversationId]);

    // Add compatibility fields and format time
    const messages = result.rows.map(msg => ({
      ...msg,
      sender: msg.sender_id,
      text: msg.message_text,
      time: new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderName: msg.sender_name
    }));

    console.log('Found messages:', messages.length);
    return { statusCode: 200, headers, body: JSON.stringify(messages) };
  } catch (error) {
    console.error('Get messages error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to get messages: ' + error.message }) };
  }
}

async function sendMessage(client, messageData) {
  try {
    console.log('Sending message:', messageData);
    
    const { conversation_id, sender_id, message_text } = messageData;

    if (!conversation_id || !sender_id || !message_text) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Conversation ID, sender ID, and message text are required' }) 
      };
    }

    // Verify conversation exists and user is a participant
    const conversationCheck = await client.query(
      `SELECT * FROM conversations 
       WHERE id = $1 AND (participant_1_id = $2 OR participant_2_id = $2)`,
      [conversation_id, sender_id]
    );

    if (conversationCheck.rows.length === 0) {
      return { 
        statusCode: 403, 
        headers, 
        body: JSON.stringify({ error: 'Not authorized to send messages in this conversation' }) 
      };
    }

    // Insert message
    const result = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, message_text, sent_at) 
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *`,
      [conversation_id, sender_id, message_text]
    );

    const newMessage = result.rows[0];

    // Update conversation's last message
    await client.query(
      `UPDATE conversations 
       SET last_message_id = $1, last_message_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [newMessage.id, conversation_id]
    );

    // Get sender info for response
    const senderResult = await client.query('SELECT name FROM users WHERE id = $1', [sender_id]);
    newMessage.sender_name = senderResult.rows[0]?.name || 'Unknown';

    // Add compatibility fields
    newMessage.sender = newMessage.sender_id;
    newMessage.text = newMessage.message_text;
    newMessage.time = new Date(newMessage.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    console.log('Message sent successfully');
    return { statusCode: 201, headers, body: JSON.stringify(newMessage) };
  } catch (error) {
    console.error('Send message error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to send message: ' + error.message }) };
  }
}

async function markMessageAsRead(client, messageId, data) {
  try {
    const { user_id } = data;
    
    // Mark message as read (you might want to implement a separate read_receipts table)
    const result = await client.query(
      `UPDATE messages SET read_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND sender_id != $2 RETURNING *`,
      [messageId, user_id]
    );

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    console.error('Mark message as read error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to mark message as read: ' + error.message }) };
  }
}
