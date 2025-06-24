const { Pool } = require('pg');
const bcrypt = require('bcrypt');

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
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let client;
  try {
    client = await pool.connect();
    console.log('Database connected successfully');
    
    const { httpMethod, queryStringParameters, body, path } = event;
    const data = body ? JSON.parse(body) : {};
    const action = queryStringParameters?.action;
    
    console.log('HTTP Method:', httpMethod);
    console.log('Action:', action);
    console.log('Query Params:', queryStringParameters);

    switch (httpMethod) {
      case 'POST':
        if (action === 'register') {
          return await registerUser(client, data);
        } else if (action === 'login') {
          return await loginUser(client, data);
        }
        break;
      
      case 'GET':
        if (action === 'workers') {
          return await getWorkers(client);
        }
        break;
      
      case 'PUT':
        const userId = queryStringParameters?.id;
        if (queryStringParameters?.type === 'worker') {
          return await updateWorkerProfile(client, userId, data);
        } else {
          return await updateUser(client, userId, data);
        }
    }

    return { 
      statusCode: 404, 
      headers, 
      body: JSON.stringify({ error: 'Endpoint not found', method: httpMethod, action: action }) 
    };

  } catch (error) {
    console.error('Function Error:', error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: error.message, stack: error.stack }) 
    };
  } finally {
    if (client) {
      client.release();
    }
  }
};

async function registerUser(client, userData) {
  try {
    console.log('Registering user:', userData);
    
    const { 
      name, email, phone, location, password, about, 
      user_type, skills, experience, availability, 
      service_area, hourly_rate 
    } = userData;

    // Validation
    if (!name || !email || !phone || !location || !password || !user_type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Check if user exists
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'User with this email already exists' })
      };
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const userResult = await client.query(
      `INSERT INTO users (name, email, phone, location, password, about, user_type, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, email, phone, location, hashedPassword, about, user_type, true]
    );

    const newUser = userResult.rows[0];

    // Create worker profile if needed
    if (user_type === 'worker') {
      await client.query(
        `INSERT INTO worker_profiles (user_id, skills, experience, availability, service_area, hourly_rate) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newUser.id, skills, experience, availability, service_area || location, hourly_rate]
      );
    }

    delete newUser.password;
    console.log('User registered successfully:', newUser);
    return { statusCode: 201, headers, body: JSON.stringify(newUser) };
  } catch (error) {
    console.error('Registration error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Registration failed: ' + error.message })
    };
  }
}

async function loginUser(client, credentials) {
  try {
    console.log('Login attempt for:', credentials.email);
    
    const { email, password } = credentials;

    if (!email || !password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Email and password required' })
      };
    }

    const userResult = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    // Get worker profile if applicable
    if (user.user_type === 'worker') {
      const workerResult = await client.query('SELECT * FROM worker_profiles WHERE user_id = $1', [user.id]);
      if (workerResult.rows.length > 0) {
        user.worker_profile = workerResult.rows[0];
        // Add fields to user object for compatibility
        user.skills = workerResult.rows[0].skills;
        user.experience = workerResult.rows[0].experience;
        user.availability = workerResult.rows[0].availability;
        user.serviceArea = workerResult.rows[0].service_area;
        user.hourlyRate = workerResult.rows[0].hourly_rate;
        user.rating = workerResult.rows[0].rating;
      }
    }

    // Add type field for compatibility
    user.type = user.user_type;
    user.isActive = user.is_active;

    delete user.password;
    console.log('User logged in successfully:', user.email);
    return { statusCode: 200, headers, body: JSON.stringify(user) };
  } catch (error) {
    console.error('Login error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Login failed: ' + error.message })
    };
  }
}

async function getWorkers(client) {
  try {
    console.log('Fetching workers...');
    
    const result = await client.query(`
      SELECT u.*, wp.skills, wp.experience, wp.availability, 
             wp.service_area, wp.hourly_rate, wp.rating
      FROM users u
      JOIN worker_profiles wp ON u.id = wp.user_id
      WHERE u.user_type = 'worker' AND u.is_active = true
      ORDER BY wp.rating DESC, u.created_at DESC
    `);

    // Add compatibility fields
    const workers = result.rows.map(worker => ({
      ...worker,
      type: worker.user_type,
      isActive: worker.is_active,
      serviceArea: worker.service_area
    }));

    console.log('Found workers:', workers.length);
    return { statusCode: 200, headers, body: JSON.stringify(workers) };
  } catch (error) {
    console.error('Get workers error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch workers: ' + error.message })
    };
  }
}

async function updateWorkerProfile(client, userId, profileData) {
  try {
    console.log('Updating worker profile for user:', userId);
    
    const { skills, experience, availability, serviceArea, hourlyRate } = profileData;

    const result = await client.query(
      `UPDATE worker_profiles SET skills = $1, experience = $2, availability = $3, 
       service_area = $4, hourly_rate = $5, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $6 RETURNING *`,
      [skills, experience, availability, serviceArea, hourlyRate, userId]
    );

    // Update user is_active status
    await client.query(
      'UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [true, userId]
    );

    console.log('Worker profile updated successfully');
    return { statusCode: 200, headers, body: JSON.stringify(result.rows[0]) };
  } catch (error) {
    console.error('Update worker profile error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update profile: ' + error.message })
    };
  }
}

async function updateUser(client, userId, updateData) {
  try {
    const { name, phone, location, about } = updateData;

    const result = await client.query(
      `UPDATE users SET name = $1, phone = $2, location = $3, about = $4, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $5 RETURNING *`,
      [name, phone, location, about, userId]
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'User not found' }) };
    }

    delete result.rows[0].password;
    return { statusCode: 200, headers, body: JSON.stringify(result.rows[0]) };
  } catch (error) {
    console.error('Update user error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update user: ' + error.message })
    };
  }
}
