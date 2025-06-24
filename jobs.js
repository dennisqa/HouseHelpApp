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
        const employerId = queryStringParameters?.employer_id;
        return await getJobs(client, employerId);
      
      case 'POST':
        return await createJob(client, data);
      
      case 'PUT':
        const jobId = queryStringParameters?.id;
        return await updateJob(client, jobId, data);
      
      case 'DELETE':
        const deleteJobId = queryStringParameters?.id;
        return await deleteJob(client, deleteJobId);
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint not found' }) };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  } finally {
    client.release();
  }
};

async function getJobs(client, employerId) {
  let query = `
    SELECT j.*, u.name as employer_name, u.email as employer_email, u.phone as employer_phone
    FROM jobs j
    JOIN users u ON j.employer_id = u.id
    WHERE j.status = 'active'
  `;
  let params = [];

  if (employerId) {
    query += ' AND j.employer_id = $1';
    params.push(employerId);
  }

  query += ' ORDER BY j.posted_date DESC';

  const result = await client.query(query, params);
  
  // Add compatibility fields
  const jobs = result.rows.map(job => ({
    ...job,
    employerId: job.employer_id,
    employer: job.employer_name,
    schedule: job.work_schedule,
    salary: job.salary_range,
    posted: 'Just now' // You can format this properly
  }));

  return { statusCode: 200, headers, body: JSON.stringify(jobs) };
}

async function createJob(client, jobData) {
  const { 
    employer_id, title, description, skills_required, 
    work_schedule, location, salary_range 
  } = jobData;

  const result = await client.query(
    `INSERT INTO jobs (employer_id, title, description, skills_required, work_schedule, location, salary_range, status) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING *`,
    [employer_id, title, description, skills_required, work_schedule, location, salary_range]
  );

  const job = result.rows[0];
  // Add compatibility fields
  job.employerId = job.employer_id;
  job.schedule = job.work_schedule;
  job.salary = job.salary_range;
  job.skills = job.skills_required;
  job.posted = 'Just now';

  return { statusCode: 201, headers, body: JSON.stringify(job) };
}

async function updateJob(client, jobId, jobData) {
  const { title, description, skills_required, work_schedule, location, salary_range } = jobData;

  const result = await client.query(
    `UPDATE jobs SET title = $1, description = $2, skills_required = $3, 
     work_schedule = $4, location = $5, salary_range = $6, updated_at = CURRENT_TIMESTAMP 
     WHERE id = $7 RETURNING *`,
    [title, description, skills_required, work_schedule, location, salary_range, jobId]
  );

  if (result.rows.length === 0) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify(result.rows[0]) };
}

async function deleteJob(client, jobId) {
  const result = await client.query('DELETE FROM jobs WHERE id = $1 RETURNING *', [jobId]);

  if (result.rows.length === 0) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ message: 'Job deleted successfully' }) };
}