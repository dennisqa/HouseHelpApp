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
        const jobType = queryStringParameters?.job_type;
        const serviceCategory = queryStringParameters?.service_category; // NEW FILTER
        return await getJobs(client, employerId, jobType, serviceCategory);
      
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

async function getJobs(client, employerId, jobType, serviceCategory) {
  try {
    console.log('Getting jobs with filters - employerId:', employerId, 'jobType:', jobType, 'serviceCategory:', serviceCategory);
    
    // NOW INCLUDING SERVICE_CATEGORY IN SELECT
    let query = `
      SELECT j.*, u.name as employer_name, u.email as employer_email, 
             u.phone as employer_phone, u.profile_photo_url as employer_photo
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      WHERE j.status = 'active'
    `;
    let params = [];
    let paramIndex = 1;

    if (employerId) {
      query += ` AND j.employer_id = $${paramIndex}`;
      params.push(employerId);
      paramIndex++;
    }

    if (jobType) {
      query += ` AND j.job_type = $${paramIndex}`;
      params.push(jobType);
      paramIndex++;
    }

    // NEW SERVICE CATEGORY FILTER
    if (serviceCategory) {
      query += ` AND j.service_category = $${paramIndex}`;
      params.push(serviceCategory);
      paramIndex++;
    }

    query += ' ORDER BY j.posted_date DESC';

    const result = await client.query(query, params);
    
    // Add compatibility fields and format data
    const jobs = result.rows.map(job => ({
      ...job,
      employerId: job.employer_id,
      employer: job.employer_name,
      schedule: job.work_schedule,
      salary: job.salary_range,
      skills: job.skills_required,
      posted: new Date(job.posted_date).toLocaleDateString(),
      // Format job type for display
      jobTypeDisplay: job.job_type === 'permanent' ? 'Permanent Position' : 
                     job.job_type === 'daily' ? 'Daily/Casual Work' : 'Not specified'
    }));

    console.log('Found jobs:', jobs.length);
    return { statusCode: 200, headers, body: JSON.stringify(jobs) };
  } catch (error) {
    console.error('Get jobs error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to get jobs: ' + error.message }) };
  }
}

async function createJob(client, jobData) {
  try {
    console.log('Creating job:', jobData);
    
    const { 
      employer_id, title, description, skills_required, 
      work_schedule, location, salary_range, job_type,
      service_category, commission_amount, payment_status // NEW FIELD
    } = jobData;

    if (!employer_id || !title || !description || !skills_required || 
        !work_schedule || !location || !salary_range) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'All job fields are required' }) 
      };
    }

    if (job_type && !['permanent', 'daily'].includes(job_type)) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Invalid job type. Must be "permanent" or "daily"' }) 
      };
    }

    // NEW VALIDATION FOR SERVICE CATEGORY
    if (!service_category || service_category.trim() === '') {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Service category is required' }) 
      };
    }

    // Verify employer exists
    const employerCheck = await client.query(
      'SELECT id FROM users WHERE id = $1 AND user_type = $2', 
      [employer_id, 'employer']
    );
    
    if (employerCheck.rows.length === 0) {
      return { 
        statusCode: 404, 
        headers, 
        body: JSON.stringify({ error: 'Employer not found' }) 
      };
    }

    // NOW INCLUDING SERVICE_CATEGORY IN INSERT
    const result = await client.query(
      `INSERT INTO jobs (
        employer_id, title, description, skills_required, work_schedule, 
        location, salary_range, job_type, service_category, status, posted_date,
        commission_amount, payment_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', CURRENT_TIMESTAMP, $10, $11) 
      RETURNING *`,
      [
        employer_id, title, description, skills_required, work_schedule, 
        location, salary_range, job_type || null, service_category, // NEW FIELD
        commission_amount || 300.00, payment_status || 'pending'
      ]
    );

    const job = result.rows[0];
    
    // Add compatibility fields
    job.employerId = job.employer_id;
    job.schedule = job.work_schedule;
    job.salary = job.salary_range;
    job.skills = job.skills_required;
    job.posted = new Date(job.posted_date).toLocaleDateString();
    job.jobTypeDisplay = job.job_type === 'permanent' ? 'Permanent Position' : 
                        job.job_type === 'daily' ? 'Daily/Casual Work' : 'Not specified';

    console.log('Job created successfully');
    return { statusCode: 201, headers, body: JSON.stringify(job) };
  } catch (error) {
    console.error('Create job error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create job: ' + error.message }) };
  }
}

async function updateJob(client, jobId, jobData) {
  try {
    console.log('Updating job:', jobId, jobData);
    
    const { title, description, skills_required, work_schedule, location, salary_range, job_type, service_category } = jobData;

    if (!jobId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Job ID required' }) };
    }

    if (job_type && !['permanent', 'daily'].includes(job_type)) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Invalid job type. Must be "permanent" or "daily"' }) 
      };
    }

    let updateFields = [];
    let values = [];
    let paramIndex = 1;

    if (title) {
      updateFields.push(`title = $${paramIndex}`);
      values.push(title);
      paramIndex++;
    }
    if (description) {
      updateFields.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }
    if (skills_required) {
      updateFields.push(`skills_required = $${paramIndex}`);
      values.push(skills_required);
      paramIndex++;
    }
    if (work_schedule) {
      updateFields.push(`work_schedule = $${paramIndex}`);
      values.push(work_schedule);
      paramIndex++;
    }
    if (location) {
      updateFields.push(`location = $${paramIndex}`);
      values.push(location);
      paramIndex++;
    }
    if (salary_range) {
      updateFields.push(`salary_range = $${paramIndex}`);
      values.push(salary_range);
      paramIndex++;
    }
    if (job_type) {
      updateFields.push(`job_type = $${paramIndex}`);
      values.push(job_type);
      paramIndex++;
    }
    // NEW SERVICE CATEGORY UPDATE
    if (service_category) {
      updateFields.push(`service_category = $${paramIndex}`);
      values.push(service_category);
      paramIndex++;
    }

    if (updateFields.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No fields to update' }) };
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(jobId);

    const query = `UPDATE jobs SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
    }

    const updatedJob = result.rows[0];
    
    // Add compatibility fields
    updatedJob.employerId = updatedJob.employer_id;
    updatedJob.schedule = updatedJob.work_schedule;
    updatedJob.salary = updatedJob.salary_range;
    updatedJob.skills = updatedJob.skills_required;
    updatedJob.posted = new Date(updatedJob.posted_date).toLocaleDateString();

    console.log('Job updated successfully');
    return { statusCode: 200, headers, body: JSON.stringify(updatedJob) };
  } catch (error) {
    console.error('Update job error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update job: ' + error.message }) };
  }
}

async function deleteJob(client, jobId) {
  try {
    console.log('Deleting job:', jobId);
    
    if (!jobId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Job ID required' }) };
    }

    // Soft delete by updating status instead of hard delete to preserve data integrity
    const result = await client.query(
      'UPDATE jobs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', 
      ['deleted', jobId]
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
    }

    console.log('Job deleted successfully');
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'Job deleted successfully' }) };
  } catch (error) {
    console.error('Delete job error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to delete job: ' + error.message }) };
  }
}
