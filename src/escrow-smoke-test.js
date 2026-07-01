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
  'function fundJob(bytes32 jobId, uint256 amount, address[] recipients, uint256[] shares)',
  'function confirmComplete(bytes32 jobId)',
  'function claim(bytes32 jobId)',
  'function getJob(bytes32 jobId) view returns (tuple(address employer, uint256 amount, uint8 status, bool disputed, uint256 fundedAt, uint256 timeoutDeadline))',
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

  // fund
  const fundTx = await escrow.fundJob(jobId, amount, recipients, shares);
  const fundReceipt = await waitForReceipt(wallet.provider, fundTx, 'fundJob');
  await processReceipt(db, fundReceipt); // decodes JobFunded straight from this receipt — no log scanning

  let row = await db.get('SELECT * FROM jobs WHERE id = ?', jobUuid);
  if (row.escrow_status === 'funded' && row.fund_tx_hash === fundTx.hash) {
    ok('indexer recorded JobFunded (escrow_status=funded, fund_tx_hash set)');
  } else {
    fail(`expected escrow_status=funded after fundJob, got "${row.escrow_status}" (fund_tx_hash=${row.fund_tx_hash})`);
  }
  const storedRecipients = JSON.parse(row.payout_recipients || '[]');
  const storedShares = JSON.parse(row.payout_shares || '[]');
  const recipientsMatch = JSON.stringify(storedRecipients.map(a => a.toLowerCase())) === JSON.stringify(recipients.map(a => a.toLowerCase()));
  const sharesMatch = JSON.stringify(storedShares) === JSON.stringify(shares);
  if (recipientsMatch && sharesMatch) {
    ok('payout_recipients/payout_shares match what was sent to fundJob');
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
  const needed = ethers.parseUnits('15', decimals);
  const usdcBalance = await usdc.balanceOf(wallet.address);
  if (usdcBalance < needed) {
    console.error(`Wallet has ${ethers.formatUnits(usdcBalance, decimals)} ${symbol}, needs at least 15.`);
    console.error(`Get test USDC from https://faucet.circle.com (select Base Sepolia) for address ${wallet.address}, then re-run.`);
    process.exit(1);
  }

  startIndexer();

  try {
    await runScenario(db, {
      wallet, escrow, usdc, decimals,
      label: 'Scenario A — solo job',
      amountDisplay: '5',
      recipients: [ethers.Wallet.createRandom().address],
      shares: [100],
    });

    await runScenario(db, {
      wallet, escrow, usdc, decimals,
      label: 'Scenario B — 3-member pod, 34/33/33',
      amountDisplay: '10',
      recipients: [
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
      ],
      shares: [34, 33, 33],
    });

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