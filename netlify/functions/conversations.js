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
      
      case 'PUT':
        const conversationId = queryStringParameters?.id;
        return await updateConversation(client, conversationId, data);
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
  try {
    console.log('Getting conversations for user:', userId);
    
    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'User ID required' }) };
    }

    const result = await client.query(`
      SELECT c.*, 
             CASE 
               WHEN c.participant_1_id = $1 THEN u2.name 
               ELSE u1.name 
             END as other_user_name,
             CASE 
               WHEN c.participant_1_id = $1 THEN u2.profile_photo_url 
               ELSE u1.profile_photo_url 
             END as other_user_photo,
             CASE 
               WHEN c.participant_1_id = $1 THEN c.participant_2_id 
               ELSE c.participant_1_id 
             END as other_user_id,
             m.message_text as last_message,
             m.sent_at as last_message_time,
             m.sender_id as last_message_sender_id,
             j.title as job_title
      FROM conversations c
      JOIN users u1 ON c.participant_1_id = u1.id
      JOIN users u2 ON c.participant_2_id = u2.id
      LEFT JOIN messages m ON c.last_message_id = m.id
      LEFT JOIN jobs j ON c.job_id = j.id
      WHERE c.participant_1_id = $1 OR c.participant_2_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    `, [userId]);

    // Add compatibility fields and format data
    const conversations = result.rows.map(conv => {
      const isUnread = conv.last_message_sender_id && 
                      conv.last_message_sender_id !== parseInt(userId) && 
                      !conv.read_at;
      
      return {
        ...conv,
        name: conv.other_user_name,
        otherUserId: conv.other_user_id,
        otherUserPhoto: conv.other_user_photo,
        lastMessage: conv.last_message || 'Start a conversation',
        time: conv.last_message_time ? 
              new Date(conv.last_message_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 
              'Now',
        unread: isUnread,
        jobTitle: conv.job_title,
        messages: [] // Will be loaded separately when conversation is opened
      };
    });

    console.log('Found conversations:', conversations.length);
    return { statusCode: 200, headers, body: JSON.stringify(conversations) };
  } catch (error) {
    console.error('Get conversations error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to get conversations: ' + error.message }) };
  }
}

async function createConversation(client, conversationData) {
  try {
    console.log('Creating conversation:', conversationData);
    
    const { 
      participant_1_id, 
      participant_2_id, 
      job_id, 
      initial_message,
      contact_fee_paid,
      contact_fee_amount,
      payment_transaction_id
    } = conversationData;

    if (!participant_1_id || !participant_2_id) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Both participant IDs are required' }) 
      };
    }

    if (participant_1_id === participant_2_id) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Cannot create conversation with yourself' }) 
      };
    }

    // Check if conversation already exists between these users
    const existingConv = await client.query(
      `SELECT * FROM conversations 
       WHERE (participant_1_id = $1 AND participant_2_id = $2) 
       OR (participant_1_id = $2 AND participant_2_id = $1)`,
      [participant_1_id, participant_2_id]
    );

    let conversation;
    if (existingConv.rows.length > 0) {
      conversation = existingConv.rows[0];
      console.log('Using existing conversation:', conversation.id);
    } else {
      // Create new conversation
      const convResult = await client.query(
        `INSERT INTO conversations (
          participant_1_id, 
          participant_2_id, 
          job_id, 
          contact_fee_paid, 
          contact_fee_amount, 
          payment_transaction_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) RETURNING *`,
        [
          participant_1_id, 
          participant_2_id, 
          job_id || null, 
          contact_fee_paid || false,
          contact_fee_amount || 0,
          payment_transaction_id || null
        ]
      );
      conversation = convResult.rows[0];
      console.log('Created new conversation:', conversation.id);
    }

    // Add initial message if provided
    if (initial_message && initial_message.trim()) {
      const messageResult = await client.query(
        `INSERT INTO messages (conversation_id, sender_id, message_text, sent_at) 
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *`,
        [conversation.id, participant_1_id, initial_message]
      );

      // Update conversation's last message
      await client.query(
        `UPDATE conversations 
         SET last_message_id = $1, last_message_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [messageResult.rows[0].id, conversation.id]
      );

      console.log('Added initial message to conversation');
    }

    // Get other participant info for response
    const otherParticipantId = conversation.participant_1_id === participant_1_id ? 
                               conversation.participant_2_id : 
                               conversation.participant_1_id;
    
    const otherUserResult = await client.query(
      'SELECT name, profile_photo_url FROM users WHERE id = $1', 
      [otherParticipantId]
    );
    
    // Add compatibility fields
    conversation.other_user_name = otherUserResult.rows[0]?.name || 'Unknown User';
    conversation.other_user_photo = otherUserResult.rows[0]?.profile_photo_url;
    conversation.name = conversation.other_user_name;
    conversation.lastMessage = initial_message || 'Start a conversation';
    conversation.time = 'Now';
    conversation.unread = false;

    return { statusCode: 200, headers, body: JSON.stringify(conversation) };
  } catch (error) {
    console.error('Create conversation error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create conversation: ' + error.message }) };
  }
}

async function updateConversation(client, conversationId, updateData) {
  try {
    const { is_archived, contact_fee_paid } = updateData;
    
    const result = await client.query(
      `UPDATE conversations 
       SET is_archived = COALESCE($1, is_archived),
           contact_fee_paid = COALESCE($2, contact_fee_paid),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [is_archived, contact_fee_paid, conversationId]
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Conversation not found' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result.rows[0]) };
  } catch (error) {
    console.error('Update conversation error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update conversation: ' + error.message }) };
  }
}
