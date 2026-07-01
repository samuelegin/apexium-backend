const { v4: uuidv4 } = require('uuid');

const JOB_COMPLETE_XP = 500;

function isoNow() {
  return new Date().toISOString();
}

async function applyJobCompletionEffects(db, job) {
  const jobberEmail = job.selected_applicant_email;
  if (!jobberEmail) return;

  const alreadyAwarded = await db.get(
    `SELECT id FROM xp_logs WHERE source = 'job_completed' AND reference_id = ?`,
    job.id
  );
  if (alreadyAwarded) return;

  const kpis = await db.all('SELECT weight, completion_percent FROM kpis WHERE job_id = ?', job.id);
  const jobPiScore = kpis.reduce((sum, k) => sum + (k.completion_percent * k.weight / 100), 0);

  const prevCompleted = await db.all(`
    SELECT id FROM jobs
    WHERE selected_applicant_email = ? AND status = 'completed' AND id != ?
  `, jobberEmail, job.id);

  let totalPi = jobPiScore;
  for (const prev of prevCompleted) {
    const prevKpis = await db.all('SELECT weight, completion_percent FROM kpis WHERE job_id = ?', prev.id);
    totalPi += prevKpis.reduce((sum, k) => sum + (k.completion_percent * k.weight / 100), 0);
  }

  const jobCount = prevCompleted.length + 1;
  const newAverage = Math.round((totalPi / jobCount) * 10) / 10;

  await db.run(`
    UPDATE users
    SET average_pi_score = ?,
        total_jobs_completed = total_jobs_completed + 1,
        updated_date = ?
    WHERE email = ?
  `, newAverage, isoNow(), jobberEmail);

  const xpId = uuidv4();
  await db.run(`INSERT INTO xp_logs (id, user_email, source, xp_amount, label, reference_id, created_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    xpId, jobberEmail, 'job_completed', JOB_COMPLETE_XP, `Job completed: ${job.title || job.id}`, job.id, isoNow());
  await db.run('UPDATE users SET xp_total = xp_total + ? WHERE email = ?', JOB_COMPLETE_XP, jobberEmail);

  console.log(`[PI] Job ${job.id} completed — jobber ${jobberEmail} new avg PI: ${newAverage} (${jobCount} jobs)`);
}

module.exports = { applyJobCompletionEffects };