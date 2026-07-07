require('dotenv').config();
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');
const { initDb, getDb } = require('../src/database');
const { startIndexer, processReceipt, onchainJobId } = require('../src/indexer');

const RPC_URL = process.env.BASE_RPC_URL;
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;

const ESCROW_ABI = [
  'function usdc() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function fundJob(bytes32 jobId, uint256 amount)',
  'function setPayout(bytes32 jobId, address[] recipients, uint256[] shares)',
  'function confirmComplete(bytes32 jobId)',
  'function claim(bytes32 jobId)',
  'function getJob(bytes32 jobId) view returns (tuple(address employer, uint256 amount, uint8 status, bool disputed, uint256 fundedAt, uint256 timeoutDeadline, uint256 feeBpsAtFund, address feeRecipientAtFund))',
  'function getPayout(bytes32 jobId) view returns (address[] recipients, uint256[] shares)',
];

const USDC_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

async function waitForReceipt(provider, tx, label) {
  console.log(`  → ${label} (tx ${tx.hash})`);
  const receipt = await tx.wait(2);
  if (receipt.status !== 1) throw new Error(`${label} reverted on-chain`);
  return receipt;
}

async function createTestJobRow(db, { title, employerEmail, jobberEmail, amountDisplay }) {
  const id = randomUUID();
  await db.run(`
    INSERT INTO jobs (id, title, description, category, employer_email, status, payment_amount, selected_applicant_email, escrow_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, title, 'smoke-test job — safe to delete', 'other', employerEmail, 'in_progress', amountDisplay, jobberEmail, 'none');
  return id;
}

async function runScenario(db, { wallet, escrow, usdc, decimals, label, amountDisplay, recipients, shares }) {
  console.log(`\n── ${label} ──────────────────────────────────`);

  const jobUuid = await createTestJobRow(db, {
    title: `[smoke-test] ${label}`,
    employerEmail: 'smoke-test-employer@apexium.test',
    jobberEmail: 'smoke-test-jobber@apexium.test',
    amountDisplay,
  });
  const jobId = onchainJobId(jobUuid);
  console.log(`  job row ${jobUuid} → onchain id ${jobId}`);

  const amount = ethers.parseUnits(String(amountDisplay), decimals);

  // approve
  const approveTx = await usdc.approve(escrow.target, amount);
  await waitForReceipt(wallet.provider, approveTx, 'approve escrow');

  // fund — no recipient needed yet
  const fundTx = await escrow.fundJob(jobId, amount);
  const fundReceipt = await waitForReceipt(wallet.provider, fundTx, 'fundJob');
  await processReceipt(db, fundReceipt); // decodes JobFunded straight from this receipt — no log scanning

  let row = await db.get('SELECT * FROM jobs WHERE id = ?', jobUuid);
  if (row.escrow_status === 'funded' && row.fund_tx_hash === fundTx.hash) {
    ok('indexer recorded JobFunded (escrow_status=funded, fund_tx_hash set)');
  } else {
    fail(`expected escrow_status=funded after fundJob, got "${row.escrow_status}" (fund_tx_hash=${row.fund_tx_hash})`);
  }
  const preAssignRecipients = JSON.parse(row.payout_recipients || '[]');
  if (preAssignRecipients.length === 0) {
    ok('payout_recipients correctly empty — nobody assigned yet');
  } else {
    fail(`expected no payout assigned right after fundJob, found ${JSON.stringify(preAssignRecipients)}`);
  }

  // separate call: assign who actually gets paid
  const payoutTx = await escrow.setPayout(jobId, recipients, shares);
  const payoutReceipt = await waitForReceipt(wallet.provider, payoutTx, 'setPayout');
  await processReceipt(db, payoutReceipt);

  row = await db.get('SELECT * FROM jobs WHERE id = ?', jobUuid);
  const storedRecipients = JSON.parse(row.payout_recipients || '[]');
  const storedShares = JSON.parse(row.payout_shares || '[]');
  const recipientsMatch = JSON.stringify(storedRecipients.map(a => a.toLowerCase())) === JSON.stringify(recipients.map(a => a.toLowerCase()));
  const sharesMatch = JSON.stringify(storedShares) === JSON.stringify(shares);
  if (recipientsMatch && sharesMatch) {
    ok('payout_recipients/payout_shares match what was sent to setPayout');
  } else {
    fail(`payout split mismatch — stored recipients=${JSON.stringify(storedRecipients)} shares=${JSON.stringify(storedShares)}`);
  }

  const completeTx = await escrow.confirmComplete(jobId);
  const completeReceipt = await waitForReceipt(wallet.provider, completeTx, 'confirmComplete');
  await processReceipt(db, completeReceipt);

  row = await db.get('SELECT * FROM jobs WHERE id = ?', jobUuid);
  if (row.escrow_status === 'completed' && row.complete_tx_hash === completeTx.hash) {
    ok('indexer recorded JobCompleted (escrow_status=completed)');
  } else {
    fail(`expected escrow_status=completed, got "${row.escrow_status}"`);
  }

  const xpLog = await db.get(`SELECT * FROM xp_logs WHERE source = 'job_completed' AND reference_id = ?`, jobUuid);
  if (xpLog) {
    ok(`applyJobCompletionEffects fired (XP logged for ${xpLog.user_email})`);
  } else {
    fail('expected an xp_logs row from applyJobCompletionEffects, found none');
  }

  const balancesBefore = await Promise.all(recipients.map(r => usdc.balanceOf(r)));
  const claimTx = await escrow.claim(jobId);
  const claimReceipt = await waitForReceipt(wallet.provider, claimTx, 'claim');
  await processReceipt(db, claimReceipt);

  row = await db.get('SELECT * FROM jobs WHERE id = ?', jobUuid);
  if (row.escrow_status === 'claimed' && row.claim_tx_hash === claimTx.hash) {
    ok('indexer recorded JobClaimed (escrow_status=claimed)');
  } else {
    fail(`expected escrow_status=claimed, got "${row.escrow_status}"`);
  }

  const balancesAfter = await Promise.all(recipients.map(r => usdc.balanceOf(r)));
  const feeBps = await escrow.feeBps();
  const expectedFee = (amount * feeBps) / 10000n;
  const expectedNet = amount - expectedFee;
  let distributedSum = 0n;
  let splitCorrect = true;
  for (let i = 0; i < recipients.length; i++) {
    const got = balancesAfter[i] - balancesBefore[i];
    distributedSum += got;
    const expectedShare = i === recipients.length - 1
      ? expectedNet - (distributedSum - got)
      : (expectedNet * BigInt(shares[i])) / 100n;
    if (got !== expectedShare) {
      splitCorrect = false;
      fail(`recipient ${recipients[i]} got ${got} USDC-units, expected ${expectedShare}`);
    }
  }
  if (distributedSum !== expectedNet) {
    splitCorrect = false;
    fail(`sum distributed (${distributedSum}) != expected net (${expectedNet}) — rounding leak`);
  }
  if (splitCorrect) {
    ok(`payout split correct, no rounding leak (fee ${expectedFee} / net ${expectedNet} across ${recipients.length} recipient(s))`);
  }

  console.log(`  job row: ${jobUuid}  (left in DB for inspection — delete manually when done)`);
}

async function runLockedPayoutScenario(db, { wallet, escrow, usdc, decimals }) {
  console.log(`\n── Scenario C — payout is locked after the first assignment ──`);
  const amountDisplay = '2';
  const jobUuid = await createTestJobRow(db, {
    title: '[smoke-test] Scenario C — payout lock',
    employerEmail: 'smoke-test-employer@apexium.test',
    jobberEmail: 'smoke-test-jobber@apexium.test',
    amountDisplay,
  });
  const jobId = onchainJobId(jobUuid);
  const amount = ethers.parseUnits(amountDisplay, decimals);
  const firstPick  = ethers.Wallet.createRandom().address;
  const otherWallet = ethers.Wallet.createRandom().address;

  await waitForReceipt(wallet.provider, await usdc.approve(escrow.target, amount), 'approve escrow');
  const fundReceipt = await waitForReceipt(wallet.provider, await escrow.fundJob(jobId, amount), 'fundJob');
  await processReceipt(db, fundReceipt);

  const setReceipt = await waitForReceipt(wallet.provider, await escrow.setPayout(jobId, [firstPick], [100]), 'setPayout');
  await processReceipt(db, setReceipt);

  // Attempting to change the pick after it's assigned must revert on-chain —
  // this is the safety fix: an employer can't select someone, let them do
  // the work, then swap the payout to a different wallet right before
  // confirming completion.
  let reassignReverted = false;
  try {
    await escrow.setPayout(jobId, [otherWallet], [100]);
  } catch (err) {
    reassignReverted = /PayoutAlreadySet/.test(err.message ?? '') || /revert/i.test(err.message ?? '');
  }
  if (reassignReverted) {
    ok('second setPayout call correctly reverted — payout is locked after first assignment');
  } else {
    fail('expected the second setPayout call to revert with PayoutAlreadySet, but it did not throw');
  }

  const row = await db.get('SELECT * FROM jobs WHERE id = ?', jobUuid);
  const storedRecipients = JSON.parse(row.payout_recipients || '[]').map(a => a.toLowerCase());
  if (storedRecipients.length === 1 && storedRecipients[0] === firstPick.toLowerCase()) {
    ok('DB still shows the original pick — the failed reassignment attempt left no trace');
  } else {
    fail(`expected payout_recipients to still be [${firstPick}], got ${JSON.stringify(storedRecipients)}`);
  }

  const completeReceipt = await waitForReceipt(wallet.provider, await escrow.confirmComplete(jobId), 'confirmComplete');
  await processReceipt(db, completeReceipt);

  const balBefore = await usdc.balanceOf(firstPick);
  const claimReceipt = await waitForReceipt(wallet.provider, await escrow.claim(jobId), 'claim');
  await processReceipt(db, claimReceipt);
  const balAfter = await usdc.balanceOf(firstPick);

  if (balAfter > balBefore) {
    ok(`claim paid the original, locked-in pick (${firstPick}) as expected`);
  } else {
    fail(`original pick's balance didn't increase — payout lock did not hold through to claim()`);
  }
}

async function main() {
  for (const v of ['DATABASE_URL', 'BASE_RPC_URL', 'ESCROW_ADDRESS', 'TEST_PRIVATE_KEY']) {
    if (!process.env[v]) {
      console.error(`Missing required env var: ${v}`);
      process.exit(1);
    }
  }

  await initDb();
  const db = getDb();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);
  const usdcAddress = await escrow.usdc();
  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, wallet);
  const decimals = await usdc.decimals();

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Escrow: ${ESCROW_ADDRESS}`);
  console.log(`USDC: ${usdcAddress} (${decimals} decimals)`);

  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance === 0n) {
    console.error('Wallet has 0 ETH — fund it from the Base Sepolia faucet before running this.');
    process.exit(1);
  }

  const symbol = await usdc.symbol().catch(() => 'USDC');
  const needed = ethers.parseUnits('6', decimals);
  const usdcBalance = await usdc.balanceOf(wallet.address);
  if (usdcBalance < needed) {
    console.error(`Wallet has ${ethers.formatUnits(usdcBalance, decimals)} ${symbol}, needs at least 6.`);
    console.error(`Get test USDC from https://faucet.circle.com (select Base Sepolia) for address ${wallet.address}, then re-run.`);
    process.exit(1);
  }

  startIndexer();

  try {
    await runScenario(db, {
      wallet, escrow, usdc, decimals,
      label: 'Scenario A — solo job',
      amountDisplay: '2',
      recipients: [ethers.Wallet.createRandom().address],
      shares: [100],
    });

    await runScenario(db, {
      wallet, escrow, usdc, decimals,
      label: 'Scenario B — 3-member pod, 34/33/33',
      amountDisplay: '2',
      recipients: [
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
      ],
      shares: [34, 33, 33],
    });

    await runLockedPayoutScenario(db, { wallet, escrow, usdc, decimals });

    console.log('\nDone.');
  } catch (err) {
    fail(`scenario threw: ${err.message}`);
  } finally {
    process.exit(process.exitCode || 0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});