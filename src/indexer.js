const { ethers } = require('ethers');
const { getDb } = require('./database');
const { applyJobCompletionEffects } = require('./escrowEffects');

const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || '';
const BASE_RPC_URL   = process.env.BASE_RPC_URL || '';
const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS || 15_000);

const ESCROW_ABI = [
  'event JobFunded(bytes32 indexed jobId, address indexed employer, uint256 amount, address[] recipients, uint256[] shares)',
  'event JobCompleted(bytes32 indexed jobId)',
  'event JobClaimed(bytes32 indexed jobId, address indexed triggeredBy, uint256 fee, uint256 distributed)',
  'event JobRefunded(bytes32 indexed jobId, address indexed employer, uint256 amount)',
  'event DisputeRaised(bytes32 indexed jobId, address indexed raisedBy)',
  'event DeadlineExtended(bytes32 indexed jobId, uint256 newDeadline)',
  'event FeeUpdated(address feeRecipient, uint256 feeBps)',
  'function getJob(bytes32 jobId) view returns (tuple(address employer, uint256 amount, uint8 status, bool disputed, uint256 fundedAt, uint256 timeoutDeadline))',
  'function getPayout(bytes32 jobId) view returns (address[] recipients, uint256[] shares)',
];

const STATUS = { EMPTY: 0, FUNDED: 1, COMPLETED: 2, CLAIMED: 3, REFUNDED: 4 };
const STATUS_TO_ESCROW_STATUS = { 0: 'none', 1: 'funded', 2: 'completed', 3: 'claimed', 4: 'refunded' };

let provider;
let contract;
let polling = false;

function isoNow() {
  return new Date().toISOString();
}

function onchainJobId(jobUuid) {
  return ethers.keccak256(ethers.toUtf8Bytes(jobUuid));
}

async function findJobRowByOnchainId(db, onchainId) {
  return db.get('SELECT * FROM jobs WHERE onchain_job_id = ?', onchainId);
}

async function resolveJobRowByOnchainId(db, onchainId) {
  let row = await findJobRowByOnchainId(db, onchainId);
  if (row) return row;

  const candidates = await db.all(`SELECT id FROM jobs WHERE onchain_job_id = '' OR onchain_job_id IS NULL`);
  for (const c of candidates) {
    if (onchainJobId(c.id) === onchainId) {
      await db.run('UPDATE jobs SET onchain_job_id = ? WHERE id = ?', onchainId, c.id);
      return db.get('SELECT * FROM jobs WHERE id = ?', c.id);
    }
  }
  return null;
}

async function handleJobFunded(db, log, args) {
  const onchainId = args.jobId;
  const row = await resolveJobRowByOnchainId(db, onchainId);
  if (!row) {
    console.warn(`[indexer] JobFunded for unknown job ${onchainId} — no matching DB row, skipping`);
    return;
  }
  const block = await provider.getBlock(log.blockNumber);
  await db.run(`
    UPDATE jobs SET
      onchain_job_id = ?,
      escrow_funded = TRUE,
      escrow_status = 'funded',
      fund_tx_hash = ?,
      funded_at = ?,
      payout_recipients = ?,
      payout_shares = ?,
      updated_date = ?
    WHERE id = ?
  `,
    onchainId,
    log.transactionHash,
    new Date(block.timestamp * 1000).toISOString(),
    JSON.stringify(args.recipients),
    JSON.stringify(args.shares.map(s => Number(s))),
    isoNow(),
    row.id
  );
  console.log(`[indexer] JobFunded → job ${row.id} (tx ${log.transactionHash})`);
}

async function handleJobCompleted(db, log, args) {
  const row = await resolveJobRowByOnchainId(db, args.jobId);
  if (!row) return;
  const block = await provider.getBlock(log.blockNumber);
  await db.run(`
    UPDATE jobs SET
      escrow_status = 'completed',
      complete_tx_hash = ?,
      completed_at = ?,
      status = CASE WHEN status != 'completed' THEN 'completed' ELSE status END,
      updated_date = ?
    WHERE id = ?
  `, log.transactionHash, new Date(block.timestamp * 1000).toISOString(), isoNow(), row.id);
  console.log(`[indexer] JobCompleted → job ${row.id}`);

  try {
    const updatedRow = await db.get('SELECT * FROM jobs WHERE id = ?', row.id);
    await applyJobCompletionEffects(db, updatedRow);
  } catch (err) {
    console.error(`[indexer] applyJobCompletionEffects failed for job ${row.id}:`, err.message);
  }
}

async function handleJobClaimed(db, log, args) {
  const row = await resolveJobRowByOnchainId(db, args.jobId);
  if (!row) return;
  const block = await provider.getBlock(log.blockNumber);
  const feeAmount = Number(ethers.formatUnits(args.fee, 6));
  const gross = args.fee + args.distributed;
  const feeBpsAtClaim = gross > 0n ? Number((args.fee * 10000n) / gross) : 0;
  await db.run(`
    UPDATE jobs SET
      escrow_status = 'claimed',
      claim_tx_hash = ?,
      claimed_at = ?,
      fee_amount = ?,
      fee_bps_at_claim = ?,
      updated_date = ?
    WHERE id = ?
  `, log.transactionHash, new Date(block.timestamp * 1000).toISOString(), feeAmount, feeBpsAtClaim, isoNow(), row.id);
  console.log(`[indexer] JobClaimed → job ${row.id} (fee ${feeAmount} USDC @ ${feeBpsAtClaim}bps, triggered by ${args.triggeredBy})`);
}

async function handleJobRefunded(db, log, args) {
  const row = await resolveJobRowByOnchainId(db, args.jobId);
  if (!row) return;
  await db.run(`
    UPDATE jobs SET
      escrow_status = 'refunded',
      resolve_tx_hash = ?,
      updated_date = ?
    WHERE id = ?
  `, log.transactionHash, isoNow(), row.id);
  console.log(`[indexer] JobRefunded → job ${row.id}`);
}

async function handleDisputeRaised(db, log, args) {
  const row = await resolveJobRowByOnchainId(db, args.jobId);
  if (!row) return;
  await db.run(`
    UPDATE jobs SET
      escrow_disputed = TRUE,
      dispute_tx_hash = ?,
      updated_date = ?
    WHERE id = ?
  `, log.transactionHash, isoNow(), row.id);
  console.log(`[indexer] DisputeRaised → job ${row.id} (raised by ${args.raisedBy})`);
}

async function handleDeadlineExtended(db, log, args) {
  const row = await resolveJobRowByOnchainId(db, args.jobId);
  if (!row) return;
  await db.run(`
    UPDATE jobs SET
      timeout_deadline = ?,
      updated_date = ?
    WHERE id = ?
  `, new Date(Number(args.newDeadline) * 1000).toISOString(), isoNow(), row.id);
  console.log(`[indexer] DeadlineExtended → job ${row.id}`);
}

async function handleFeeUpdated(db, log, args) {
  await db.run(`
    INSERT INTO xp_logs (id, user_email, source, xp_amount, label, reference_id, created_date)
    VALUES (gen_random_uuid()::text, 'system', 'fee_updated', 0, ?, ?, ?)
  `, `Platform fee changed to ${Number(args.feeBps) / 100}%`, log.transactionHash, isoNow())
    .catch(() => {});
  console.log(`[indexer] FeeUpdated → ${Number(args.feeBps) / 100}% (recipient ${args.feeRecipient})`);
}

const HANDLERS = {
  JobFunded: handleJobFunded,
  JobCompleted: handleJobCompleted,
  JobClaimed: handleJobClaimed,
  JobRefunded: handleJobRefunded,
  DisputeRaised: handleDisputeRaised,
  DeadlineExtended: handleDeadlineExtended,
  FeeUpdated: handleFeeUpdated,
};

async function processReceipt(db, receipt) {
  if (!contract) {
    console.warn('[indexer] processReceipt called before startIndexer() — contract not initialized, skipping');
    return { processed: 0 };
  }
  let processed = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) continue;
    let parsed;
    try {
      parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    const handler = HANDLERS[parsed.name];
    if (!handler) continue;
    try {
      await handler(db, { blockNumber: log.blockNumber, transactionHash: log.transactionHash }, parsed.args);
      processed++;
    } catch (err) {
      console.error(`[indexer] failed handling ${parsed.name} at tx ${log.transactionHash}:`, err.message);
    }
  }
  return { processed };
}

async function processTxHash(db, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return { processed: 0 };
  return processReceipt(db, receipt);
}

async function reconcileJobRow(db, row) {
  const onchainId = row.onchain_job_id || onchainJobId(row.id);
  const job = await contract.getJob(onchainId);
  const chainStatus = Number(job.status);
  const dbEscrowStatus = row.escrow_status || 'none';
  const expectedEscrowStatus = STATUS_TO_ESCROW_STATUS[chainStatus];
  const disputedChanged = Boolean(job.disputed) !== Boolean(row.escrow_disputed);
  const newDeadlineIso = new Date(Number(job.timeoutDeadline) * 1000).toISOString();
  const deadlineChanged = row.timeout_deadline !== newDeadlineIso && Number(job.timeoutDeadline) > 0;

  if (expectedEscrowStatus === dbEscrowStatus && !disputedChanged && !deadlineChanged) {
    return { changed: false };
  }

  console.log(`[indexer] reconcile: job ${row.id} DB says "${dbEscrowStatus}", chain says "${expectedEscrowStatus}" — updating`);

  if (chainStatus === STATUS.FUNDED && dbEscrowStatus === 'none') {
    const payout = await contract.getPayout(onchainId);
    await db.run(`
      UPDATE jobs SET
        onchain_job_id = ?, escrow_funded = TRUE, escrow_status = 'funded',
        funded_at = ?, payout_recipients = ?, payout_shares = ?,
        escrow_disputed = ?, timeout_deadline = ?, updated_date = ?
      WHERE id = ?
    `, onchainId, new Date(Number(job.fundedAt) * 1000).toISOString(),
       JSON.stringify(payout.recipients), JSON.stringify(payout.shares.map(s => Number(s))),
       Boolean(job.disputed), newDeadlineIso, isoNow(), row.id);
  } else if (chainStatus === STATUS.COMPLETED && dbEscrowStatus !== 'completed') {
    await db.run(`
      UPDATE jobs SET escrow_status = 'completed', status = CASE WHEN status != 'completed' THEN 'completed' ELSE status END,
        escrow_disputed = ?, timeout_deadline = ?, updated_date = ?
      WHERE id = ?
    `, Boolean(job.disputed), newDeadlineIso, isoNow(), row.id);
    const updatedRow = await db.get('SELECT * FROM jobs WHERE id = ?', row.id);
    await applyJobCompletionEffects(db, updatedRow).catch(err =>
      console.error(`[indexer] applyJobCompletionEffects failed for job ${row.id}:`, err.message));
  } else if (chainStatus === STATUS.CLAIMED && dbEscrowStatus !== 'claimed') {
    console.warn(`[indexer] job ${row.id} was claimed without a matching /notify call — exact fee/distributed amounts can't be recovered from state (job.amount is zeroed post-claim). Marking claimed with null fee figures; check Basescan for exact numbers if needed.`);
    await db.run(`
      UPDATE jobs SET escrow_status = 'claimed', claimed_at = ?, updated_date = ?
      WHERE id = ?
    `, isoNow(), isoNow(), row.id);
  } else if (chainStatus === STATUS.REFUNDED && dbEscrowStatus !== 'refunded') {
    await db.run(`UPDATE jobs SET escrow_status = 'refunded', updated_date = ? WHERE id = ?`, isoNow(), row.id);
  } else if (disputedChanged || deadlineChanged) {
    await db.run(`
      UPDATE jobs SET escrow_disputed = ?, timeout_deadline = ?, updated_date = ? WHERE id = ?
    `, Boolean(job.disputed), newDeadlineIso, isoNow(), row.id);
  }

  return { changed: true };
}

async function reconcileActiveJobs(db) {
  const rows = await db.all(`
    SELECT * FROM jobs
    WHERE escrow_status IN ('funded', 'completed')
       OR (status = 'in_progress' AND (escrow_status IS NULL OR escrow_status = 'none')
           AND updated_date::timestamptz > NOW() - INTERVAL '7 days')
  `);

  let changedCount = 0;
  for (const row of rows) {
    try {
      const result = await reconcileJobRow(db, row);
      if (result.changed) changedCount++;
    } catch (err) {
      console.error(`[indexer] reconcile failed for job ${row.id}:`, err.message);
    }
  }
  if (rows.length > 0) {
    console.log(`[indexer] reconciled ${rows.length} active job(s), ${changedCount} updated`);
  }
  return { checked: rows.length, changed: changedCount };
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    await reconcileActiveJobs(getDb());
  } catch (err) {
    console.error('[indexer] reconcile error:', err.message);
  } finally {
    polling = false;
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

function startIndexer() {
  if (!ESCROW_ADDRESS || !BASE_RPC_URL) {
    console.warn('[indexer] ESCROW_ADDRESS or BASE_RPC_URL not set — indexer disabled');
    return;
  }
  provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  contract = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, provider);
  console.log(`[indexer] starting — watching ${ESCROW_ADDRESS} on ${BASE_RPC_URL} (receipt-decode + state-reconcile, no log scanning)`);
  pollLoop();
}

module.exports = { startIndexer, onchainJobId, processReceipt, processTxHash, reconcileActiveJobs };