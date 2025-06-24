// 5. netlify/functions/applications.js - Application management
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
      case 'POST':
        return await createApplication(client, data);
      
      case 'GET':
        const workerId = queryStringParameters?.worker_id;
        return await getWorkerApplications(client, workerId);
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint not found' }) };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  } finally {
    client.release();
  }
};

async function createApplication(client, applicationData) {
  const { job_id, worker_id, employer_id, cover_letter } = applicationData;

  // Check if already applied
  const existingApp = await client.query(
    'SELECT id FROM applications WHERE job_id = $1 AND worker_id = $2',
    [job_id, worker_id]
  );

  if (existingApp.rows.length > 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Already applied to this job' })
    };
  }

  const result = await client.query(
    `INSERT INTO applications (job_id, worker_id, employer_id, cover_letter, status) 
     VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
    [job_id, worker_id, employer_id, cover_letter]
  );

  return { statusCode: 201, headers, body: JSON.stringify(result.rows[0]) };
}

async function getWorkerApplications(client, workerId) {
  const result = await client.query(`
    SELECT a.*, j.title as job_title, j.location as job_location, 
           j.salary_range, u.name as employer_name
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
    JOIN users u ON a.employer_id = u.id
    WHERE a.worker_id = $1
    ORDER BY a.applied_at DESC
  `, [workerId]);

  // Add compatibility fields
  const applications = result.rows.map(app => ({
    ...app,
    jobId: app.job_id,
    workerId: app.worker_id,
    employerId: app.employer_id,
    jobTitle: app.job_title,
    employerName: app.employer_name,
    appliedAt: app.applied_at
  }));

  return { statusCode: 200, headers, body: JSON.stringify(applications) };
}
