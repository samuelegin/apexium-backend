const express = require('express');
const { ethers } = require('ethers');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { processReceipt, onchainJobId } = require('../indexer');

const router = express.Router();

const BASE_RPC_URL = process.env.BASE_RPC_URL || '';
let notifyProvider = null;
function getProvider() {
  if (!BASE_RPC_URL) return null;
  if (!notifyProvider) notifyProvider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  return notifyProvider;
}

const VALID_TYPES = new Set(['fund', 'payout', 'complete', 'claim', 'dispute', 'extend']);

router.post('/notify', authMiddleware, async (req, res) => {
  const { jobId, txHash, type } = req.body || {};
  if (!jobId || !txHash) return res.status(400).json({ message: 'jobId and txHash are required' });
  if (type && !VALID_TYPES.has(type)) return res.status(400).json({ message: `invalid type: ${type}` });
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ message: 'txHash is not a valid tx hash' });

  const db = getDb();
  const job = await db.get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) return res.status(404).json({ message: 'job not found' });

  const provider = getProvider();
  if (!provider) {
    return res.status(503).json({ message: 'BASE_RPC_URL not configured — cannot verify transaction' });
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return res.status(202).json({ status: 'pending', message: 'transaction not yet mined' });
    }
    if (receipt.status !== 1) {
      return res.status(200).json({ status: 'failed', message: 'transaction reverted on-chain' });
    }
  } catch (err) {
    console.error('[escrow/notify] receipt lookup failed:', err.message);
    return res.status(502).json({ message: 'failed to verify transaction against RPC' });
  }

  if (type === 'fund' && (!job.onchain_job_id || job.onchain_job_id === '')) {
    await db.run('UPDATE jobs SET onchain_job_id = ? WHERE id = ?', onchainJobId(job.id), job.id);
  }

  try {
    await processReceipt(db, receipt);
  } catch (err) {
    console.error('[escrow/notify] processReceipt failed:', err.message);
  }

  const updated = await db.get('SELECT * FROM jobs WHERE id = ?', jobId);
  res.json({ status: 'confirmed', job: updated });
});

function normalizeShares(podMembers, proposedShares) {
  const memberEmails = new Set(podMembers.map(m => m.email));
  if (proposedShares.length !== podMembers.length) {
    throw badRequest('proposed shares must cover every pod member, no more, no less');
  }
  let total = 0;
  const seen = new Set();
  for (const s of proposedShares) {
    if (!memberEmails.has(s.email)) throw badRequest(`${s.email} is not a member of this pod`);
    if (seen.has(s.email)) throw badRequest(`duplicate entry for ${s.email}`);
    seen.add(s.email);
    if (!Number.isInteger(s.share) || s.share <= 0) throw badRequest(`share for ${s.email} must be a positive integer`);
    total += s.share;
  }
  if (total !== 100) throw badRequest(`shares must sum to exactly 100 (got ${total})`);
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

router.post('/pod-shares', authMiddleware, async (req, res) => {
  const { applicationId, shares } = req.body || {};
  if (!applicationId || !Array.isArray(shares)) {
    return res.status(400).json({ message: 'applicationId and shares[] are required' });
  }

  const db = getDb();
  const application = await db.get('SELECT * FROM applications WHERE id = ?', applicationId);
  if (!application) return res.status(404).json({ message: 'application not found' });
  if (!application.is_pod) return res.status(400).json({ message: 'application is not a pod' });

  const job = await db.get('SELECT * FROM jobs WHERE id = ?', application.job_id);
  if (!job) return res.status(404).json({ message: 'job not found' });
  if (job.employer_email !== req.user.email) {
    return res.status(403).json({ message: 'only the employer can propose the pod payout split' });
  }
  // v4: escrow_status is 'funded' the moment a job is posted+funded, well
  // before any talent is picked — that's expected, not a lock. But setPayout()
  // is now single-assignment on-chain (locked permanently after the first
  // call, precisely so an employer can't swap the payout after the fact) —
  // so once payout_recipients is actually populated, further DB-side
  // proposals would be misleading and must be blocked too.
  let alreadyLockedOnChain = false;
  try { alreadyLockedOnChain = JSON.parse(job.payout_recipients || '[]').length > 0; } catch { /* ignore */ }
  if (alreadyLockedOnChain || ['completed', 'claimed', 'refunded'].includes(job.escrow_status)) {
    return res.status(400).json({ message: 'payout is already locked on-chain and cannot be re-proposed' });
  }

  let podMembers;
  try { podMembers = JSON.parse(application.pod_members || '[]'); } catch { podMembers = []; }
  if (podMembers.length === 0) return res.status(400).json({ message: 'pod has no members on file' });

  try {
    normalizeShares(podMembers, shares);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ message: err.message });
  }

  const shareByEmail = Object.fromEntries(shares.map(s => [s.email, s.share]));
  const updatedMembers = podMembers.map((m, i) => ({
    ...m,
    share: shareByEmail[m.email],
    approved: i === 0, 
  }));

  await db.run(
    'UPDATE applications SET pod_members = ?, updated_date = ? WHERE id = ?',
    JSON.stringify(updatedMembers), new Date().toISOString(), applicationId
  );

  const updated = await db.get('SELECT * FROM applications WHERE id = ?', applicationId);
  res.json({ ...updated, pod_members: updatedMembers });
});

router.post('/pod-shares/approve', authMiddleware, async (req, res) => {
  const { applicationId } = req.body || {};
  if (!applicationId) return res.status(400).json({ message: 'applicationId is required' });

  const db = getDb();
  const application = await db.get('SELECT * FROM applications WHERE id = ?', applicationId);
  if (!application) return res.status(404).json({ message: 'application not found' });
  if (!application.is_pod) return res.status(400).json({ message: 'application is not a pod' });

  let podMembers;
  try { podMembers = JSON.parse(application.pod_members || '[]'); } catch { podMembers = []; }

  const idx = podMembers.findIndex(m => m.email === req.user.email);
  if (idx === -1) return res.status(403).json({ message: 'you are not a member of this pod' });
  if (podMembers[idx].share === undefined) {
    return res.status(400).json({ message: 'no payout split has been proposed yet' });
  }

  podMembers[idx] = { ...podMembers[idx], approved: true };

  await db.run(
    'UPDATE applications SET pod_members = ?, updated_date = ? WHERE id = ?',
    JSON.stringify(podMembers), new Date().toISOString(), applicationId
  );

  const allApproved = podMembers.every(m => m.approved === true);
  res.json({ pod_members: podMembers, all_approved: allApproved });
});

module.exports = router;