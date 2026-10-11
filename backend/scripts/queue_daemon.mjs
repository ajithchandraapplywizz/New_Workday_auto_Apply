/**
 * queue_daemon.mjs — 9-Worker Pipeline Autonomous Webhook Engine & Controller
 * ===========================================================================
 * Event-driven webhook controller with instant (<500ms) browser abortion.
 *
 * Pipeline Architecture:
 *   - Strictly 9 Canonical Workers in worker_status:
 *       • Scanning (3): scanning_worker_1, scanning_worker_2, scanning_worker_3
 *       • Resolving (3): resolving_worker_1, resolving_worker_2, resolving_worker_3
 *       • Submitting (3): submitting_worker_1, submitting_worker_2, submitting_worker_3
 *   - Global Control: public.bot_control table ('primary' row) tracks pipeline state,
 *     stop signals, active worker counts, and trigger requests.
 *   - Stage 1 (Scanning): 3 scanning workers visit unique links, extract schemas,
 *     scrape questions with field types & options, and save blueprint -> scanned_jobs.
 *   - Stage 2 (Resolving): 3 resolving workers match candidate facts, resumes, and
 *     QA bank into structured 4-tier answers -> job_distributions (status: 'ready_for_review').
 *   - CA Review Pause: Career Associates review answers and inspect proof in UI.
 *   - Stage 3 (Submissions): 3 submitting workers execute Playwright form filling on Workday,
 *     commit inputs with Enter/blur, verify DOM, submit, capture authentic confirmation
 *     screenshot, and update status to 'submitted'.
 */

import http from 'node:http';
import '../lib/polyfills.mjs';
import {
  loadLocalEnvOnce,
  isSupabaseConfigured,
  updateDaemonCaState,
  updateWorkerStatus,
  getWorkerStatuses,
  ensureCanonicalWorkers,
  getBotControl,
  updateBotControl,
} from '../lib/supabaseClient.mjs';
import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';
import { setGlobalStop, isGlobalStopRequested, abortAllActiveBrowsers } from '../lib/browserLifecycle.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();

if (!isSupabaseConfigured()) {
  console.error('[DAEMON FATAL] Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Configuration
const args = process.argv.slice(2);
const HEADLESS = !args.includes('--headful') && !args.includes('--headed');
const TEST_MODE = args.includes('--test');
const PORT = process.env.DAEMON_PORT || process.env.PORT || 3001;

if (TEST_MODE) {
  console.log('[DAEMON] ⚠️  TEST MODE: Only 1 cluster / 1 client will be processed per Stage 1 run.');
}

let isPoolRunning = false;
let isPoolPaused = false;
let currentStage = 'idle';

const ALL_9_WORKERS = PIPELINE_CONFIG.allWorkerIds || [
  'scanning_worker_1', 'scanning_worker_2', 'scanning_worker_3',
  'resolving_worker_1', 'resolving_worker_2', 'resolving_worker_3',
  'submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3',
];

/**
 * Reset all 9 workers in worker_status to idle
 */
async function resetAllWorkersIdle() {
  for (const wId of ALL_9_WORKERS) {
    const meta = PIPELINE_CONFIG.workerNames[wId] || wId;
    let stage = 'idle';
    if (wId.includes('scan')) stage = 'scanning';
    else if (wId.includes('resolve')) stage = 'resolving';
    else if (wId.includes('submit')) stage = 'submitting';

    await updateWorkerStatus(wId, {
      state: 'idle',
      current_application_id: null,
      stage,
      bot_name: meta,
    }).catch(() => { });
  }
}

/**
 * Synchronize global bot_control table state
 */
async function syncBotControlState(patch = {}) {
  await updateBotControl({
    stage: currentStage,
    is_running: isPoolRunning,
    is_paused: isPoolPaused,
    stop_requested: isGlobalStopRequested(),
    active_worker_count: isPoolRunning ? 3 : 0,
    ...patch,
  }).catch(() => { });
}

/**
 * Instantly stop all 9 workers and abort open browsers in <500ms
 */
export async function stopAutonomousPool() {
  console.log(`\n🛑 [DAEMON] STOP SIGNAL RECEIVED: Immediately halting 9-worker pipeline...`);
  isPoolRunning = false;
  isPoolPaused = true;
  currentStage = 'idle';

  setGlobalStop(true);

  // Terminate any active Playwright browser windows in <500ms
  await abortAllActiveBrowsers().catch(() => { });

  // Set all 9 workers to idle in worker_status
  await resetAllWorkersIdle().catch(() => { });

  // Update bot_control state
  await syncBotControlState({
    stage: 'idle',
    is_running: false,
    is_paused: true,
    stop_requested: true,
    active_worker_count: 0,
    current_action: 'Stopped by user',
  });

  await updateDaemonCaState('_daemon_', {
    caName: 'Autonomous 9-Worker Pipeline',
    state: 'idle',
    syncedDate: new Date().toISOString().slice(0, 10),
    workersAssigned: 9,
  }).catch(() => { });

  console.log(`✅ [DAEMON] Stop complete. All 9 workers set to idle and active browsers closed.`);
  return { success: true, message: 'All 9 workers stopped and reset to idle.' };
}

/**
 * Execute Stage 1: Scanning (scanning_worker_1, scanning_worker_2, scanning_worker_3)
 */
async function runStage1Scanning() {
  currentStage = 'scanning';
  await syncBotControlState({
    stage: 'scanning',
    is_running: true,
    current_action: 'Scanning unique Workday links and harvesting question schemas',
    active_worker_count: TEST_MODE ? 1 : 3,
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 1: Scanning unique job links with 3 scanning workers (scanning_worker_1..3)...`);

  const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
  await runClusterBatchRunner({
    topLinks: TEST_MODE ? 1 : 50,
    workers: TEST_MODE ? 1 : 3,
    headless: HEADLESS,
    confirmSubmit: false,
    limitPerLink: TEST_MODE ? 1 : null,
    defaultPassword: process.env.WORKDAY_PASSWORD || 'Applywizz@2026789',
  });

  // Ensure scanning workers reset to idle
  for (const wId of PIPELINE_CONFIG.scanWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'scanning' }).catch(() => { });
  }
}

/**
 * Execute Stage 2: Resolving Answers (resolving_worker_1, resolving_worker_2, resolving_worker_3)
 */
async function runStage2Resolving() {
  currentStage = 'resolving';
  await syncBotControlState({
    stage: 'resolving',
    is_running: true,
    current_action: 'Pre-resolving candidate answers across 4 tiers into job_distributions',
    active_worker_count: 3,
  });

  console.log(`\n⚡ [DAEMON] Starting Stage 2: Resolving candidate answers with 3 resolving workers (resolving_worker_1..3)...`);

  const { runResolvingWorkerPool } = await import('../lib/resolvingWorkerPool.mjs');
  await runResolvingWorkerPool();

  // Ensure resolving workers reset to idle
  for (const wId of PIPELINE_CONFIG.resolveWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'resolving' }).catch(() => { });
  }
}

/**
 * Execute Stage 3: Submissions (submitting_worker_1, submitting_worker_2, submitting_worker_3)
 */
async function runStage3Submissions() {
  currentStage = 'submitting';
  console.log(`\n🚀 [DAEMON] Checking for CA-approved applications in job_distributions...`);

  // Strictly submit ONLY applications that a Career Associate has explicitly approved
  const { data: approvedRows } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, job_url, status')
    .in('status', ['approved_for_submission', 'queued'])
    .limit(20);

  if (!approvedRows || approvedRows.length === 0) {
    console.log(`ℹ️ [DAEMON] 0 applications with status 'approved_for_submission'. No batch submissions will run.`);
    return;
  }

  await syncBotControlState({
    stage: 'submitting',
    is_running: true,
    current_action: `Submitting ${approvedRows.length} CA-approved application(s)`,
    active_worker_count: Math.min(approvedRows.length, 3),
  });

  console.log(`\n🚀 [DAEMON] Submitting ${approvedRows.length} CA-approved application(s)...`);
  const { executeSingleTargetedSubmission } = await import('../lib/workerPool.mjs');
  for (let i = 0; i < approvedRows.length; i++) {
    const app = approvedRows[i];
    const workerId = `submitting_worker_${(i % 3) + 1}`;
    await executeSingleTargetedSubmission({
      distributionId: app.id,
      applywizzId: app.applywizz_id,
      jobUrl: app.job_url,
      workerId,
      headless: HEADLESS,
    }).catch(console.error);
  }

  // Reset submitting workers back to idle
  for (const wId of PIPELINE_CONFIG.submitWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'submitting' }).catch(() => { });
  }
}

/**
 * Run the Sequential Pipeline: Stage 1 -> Stage 2 -> wait for CA review -> Stage 3
 */
export async function runSequentialPipeline() {
  if (isPoolRunning) {
    console.log(`[DAEMON] Pipeline is already running.`);
    return { success: true, message: 'Pipeline already running.' };
  }

  isPoolRunning = true;
  isPoolPaused = false;
  setGlobalStop(false);

  try {
    // ── STAGE 1: SCANNING (scanning_worker_1..3) ───────────────────────
    await runStage1Scanning();

    if (isGlobalStopRequested() || isPoolPaused) {
      console.log(`🛑 [DAEMON] Pipeline stopped during/after Stage 1.`);
      return { success: true, stopped: true };
    }

    // ── STAGE 2: RESOLVING (resolving_worker_1..3) ─────────────────────
    await runStage2Resolving();

    if (isGlobalStopRequested() || isPoolPaused) {
      console.log(`🛑 [DAEMON] Pipeline stopped during/after Stage 2.`);
      return { success: true, stopped: true };
    }

    currentStage = 'ready_for_review';
    await syncBotControlState({
      stage: 'ready_for_review',
      is_running: false,
      current_action: 'Awaiting Career Associate review in the Dashboard',
      active_worker_count: 0,
    });

    console.log(`\n✅ [DAEMON] Stages 1 & 2 complete! Job schemas harvested and answers pre-resolved.`);
    console.log(`   Waiting for Career Associate review in the Dashboard before submitting.\n`);
  } catch (err) {
    console.error(`❌ [DAEMON] Pipeline error:`, err?.message || err);
  } finally {
    isPoolRunning = false;
    currentStage = 'idle';
    await resetAllWorkersIdle().catch(() => { });
    await syncBotControlState({
      stage: 'idle',
      is_running: false,
      current_action: 'Idle',
      active_worker_count: 0,
    });
  }
}

/**
 * Webhook HTTP Server
 */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // 1. Health check
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', isRunning: isPoolRunning, stage: currentStage, workers: 9 }));
    return;
  }

  // 2. Status
  if (pathname === '/api/bot/status') {
    const botControl = await getBotControl().catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      isRunning: isPoolRunning,
      stage: currentStage,
      isPaused: isPoolPaused,
      workers: 9,
      stages: {
        scanning: 3,
        resolving: 3,
        submitting: 3,
      },
      botControl,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Helper to parse JSON body
  let body = {};
  if (req.method === 'POST') {
    try {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const rawText = Buffer.concat(buffers).toString();
      if (rawText) body = JSON.parse(rawText);
    } catch { }
  }

  // 3. Stop Webhook
  if (pathname === '/api/bot/stop' || (pathname === '/api/bot/webhook' && body.action === 'stop')) {
    await stopAutonomousPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'All 9 workers stopped instantly. Active browser contexts aborted.',
      isRunning: false,
    }));
    return;
  }

  // 4. Start / Trigger Pipeline Webhook
  if (pathname === '/api/bot/trigger' || pathname === '/api/bot/start' || (pathname === '/api/bot/webhook' && (body.action === 'start' || body.action === 'start_pipeline'))) {
    if (isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Pipeline is already active.',
        isRunning: true,
        stage: currentStage,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON WEBHOOK] Start signal received! Launching sequential 9-worker pipeline...`);
    isPoolRunning = true;
    currentStage = 'scanning';
    syncBotControlState({ stage: 'scanning', is_running: true, stop_requested: false }).catch(() => { });
    // Run asynchronously so webhook response is instant (<100ms)
    runSequentialPipeline().catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Sequential 9-Worker Pipeline triggered! Scanning (3) -> Resolving (3).',
      isRunning: true,
      stage: 'scanning',
    }));
    return;
  }

  // 4b. CA Targeted Click Endpoint: POST /api/submissions/:taskId/submit (or /api/bot/submissions/:taskId/submit)
  const submitTaskMatch = pathname.match(/^\/api\/(?:bot\/)?submissions\/([a-zA-Z0-9_-]+)\/submit\/?$/);
  if (req.method === 'POST' && submitTaskMatch) {
    const taskId = submitTaskMatch[1];
    const ca = body.ca || body.caEmail || body.reviewed_by || req.headers['x-ca-email'] || 'Career Associate';
    console.log(`\n⚡ [DAEMON] CA Click received for task #${taskId} by CA '${ca}'`);
    const { queueSubmissionTask } = await import('../lib/submissionTaskService.mjs');
    const result = await queueSubmissionTask({ taskId, ca });
    if (result?.success) {
      setImmediate(() => dispatchQueuedSubmissions().catch(() => { }));
    }
    res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 5a. Targeted Single-Item Submission Webhook (Disabled behind guard — must use POST /api/submissions/:taskId/submit)
  if (pathname === '/api/bot/submit-single' || (pathname === '/api/bot/submit' && (body.distributionId || body.applywizzId))) {
    console.warn(`[GUARD] Legacy submission webhook attempted for ${body.distributionId || body.applywizzId} on ${pathname}. Blocked.`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Legacy submission webhook is disabled. Submissions must be queued via POST /api/submissions/:taskId/submit.',
    }));
    return;
  }

  if (false && (pathname === '/api/bot/submit-single' || (pathname === '/api/bot/submit' && (body.distributionId || body.applywizzId)))) {
    const { distributionId, applywizzId, jobUrl } = body;
    console.log(`\n⚡ [DAEMON WEBHOOK] Targeted submit received for ${applywizzId || distributionId} at ${jobUrl || 'URL'}`);

    const nowIso = new Date().toISOString();
    const cleanId = (applywizzId || '').toUpperCase().trim();

    // Check availability across the 3 submitting workers (submitting_worker_1, 2, 3)
    const submitWorkerIds = PIPELINE_CONFIG.submitWorkerIds || ['submitting_worker_1', 'submitting_worker_2', 'submitting_worker_3'];
    let chosenWorkerId = null;

    try {
      const { data: activeWorkers } = await supabase.from('worker_status').select('*').in('worker_id', submitWorkerIds);
      const idleWorker = submitWorkerIds.find((wid) => {
        const row = (activeWorkers || []).find((w) => w.worker_id === wid);
        return !row || row.state === 'idle';
      });
      if (idleWorker) {
        chosenWorkerId = idleWorker;
      }
    } catch (wErr) {
      chosenWorkerId = submitWorkerIds[0];
    }

    if (chosenWorkerId) {
      // 1. Immediately mark worker as in_flight so UI & database reflect state in <50ms
      await updateWorkerStatus(chosenWorkerId, {
        state: 'in_flight',
        stage: 'submitting',
        current_application_id: distributionId || `${cleanId}:${jobUrl}`,
        bot_name: `Submitting Worker ${chosenWorkerId.slice(-1)}`,
        updated_at: nowIso,
      }).catch(() => { });

      // 2. Mark job_distributions as 'applying'
      const applyUpdate = {
        status: 'applying',
        worker_id: chosenWorkerId,
        reviewed_by: 'Career Associate',
        reviewed_at: nowIso,
        updated_at: nowIso,
      };
      if (distributionId) {
        await supabase.from('job_distributions').update(applyUpdate).eq('id', distributionId).catch(() => { });
      } else if (cleanId && jobUrl) {
        await supabase.from('job_distributions').update(applyUpdate).eq('applywizz_id', cleanId).eq('job_url', jobUrl).catch(() => { });
      }

      // 3. Upsert into submission_tasks table with status 'applying'
      if (distributionId) {
        await supabase.from('submission_tasks').upsert({
          distribution_id: distributionId,
          applywizz_id: cleanId,
          job_url: jobUrl,
          status: 'applying',
          worker_id: chosenWorkerId,
          reviewed_by: 'Career Associate',
          started_at: nowIso,
          updated_at: nowIso,
        }, { onConflict: 'distribution_id' }).catch(() => { });
      }

      const { executeSingleTargetedSubmission } = await import('../lib/workerPool.mjs');
      // Dispatch in background
      executeSingleTargetedSubmission({
        distributionId,
        applywizzId: cleanId,
        jobUrl,
        workerId: chosenWorkerId,
        headless: HEADLESS,
      }).catch((err) => {
        console.error(`❌ [TARGETED SUBMISSION ERROR]:`, err?.message);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: 'applying',
        message: `Assigned to ${chosenWorkerId}. Workday submission in progress.`,
        workerId: chosenWorkerId,
        distributionId,
      }));
      return;
    } else {
      // All 3 submitting workers are currently in_flight -> Queue this application!
      console.log(`\n⏳ [DAEMON WEBHOOK] All 3 submitting workers are busy. Queuing application for ${cleanId}...`);

      if (distributionId) {
        await supabase.from('job_distributions').update({
          status: 'queued',
          reviewed_by: 'Career Associate',
          reviewed_at: nowIso,
          updated_at: nowIso,
        }).eq('id', distributionId).catch(() => { });

        await supabase.from('submission_tasks').upsert({
          distribution_id: distributionId,
          applywizz_id: cleanId,
          job_url: jobUrl,
          status: 'queued',
          reviewed_by: 'Career Associate',
          created_at: nowIso,
          updated_at: nowIso,
        }, { onConflict: 'distribution_id' }).catch(() => { });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: 'queued',
        message: 'All 3 submitting workers are busy. Application successfully queued and will auto-submit as soon as a worker is free.',
        distributionId,
      }));
      return;
    }
  }

  // 5b. Batch Submit Approved Applications Webhook (Stage 3 Pool)
  if (pathname === '/api/bot/submit' || (pathname === '/api/bot/webhook' && (body.action === 'submit_approved' || body.action === 'stage_submit'))) {
    if (isPoolRunning) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Pipeline is busy with another stage.',
        isRunning: true,
        stage: currentStage,
      }));
      return;
    }

    console.log(`\n⚡ [DAEMON WEBHOOK] Submit signal received! Launching Stage 3 Submissions with 3 submitting workers...`);
    isPoolRunning = true;
    setGlobalStop(false);
    runStage3Submissions().finally(() => {
      isPoolRunning = false;
      currentStage = 'idle';
      resetAllWorkersIdle().catch(() => { });
      syncBotControlState({
        stage: 'idle',
        is_running: false,
        active_worker_count: 0,
      });
    }).catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Stage 3 Submissions triggered for approved applications across 3 submitting workers.',
      isRunning: true,
      stage: 'submitting',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// ── Autonomous 6-Worker Parallel Submission Dispatcher ──
const activeSubmittingWorkers = new Set();

export async function dispatchQueuedSubmissions() {
  if (isGlobalStopRequested() || isPoolPaused) return;
  try {
    const { SUBMISSION_WORKER_IDS, claimNextTask, processClaimedTask } = await import('../lib/submissionWorkerPool.mjs');

    for (const workerId of SUBMISSION_WORKER_IDS) {
      if (activeSubmittingWorkers.has(workerId)) continue;
      if (isGlobalStopRequested() || isPoolPaused) break;

      const claimedTask = await claimNextTask(workerId);
      if (claimedTask) {
        activeSubmittingWorkers.add(workerId);
        console.log(`\n🚀 [6-WORKER DISPATCHER] ${workerId} atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

        // Process asynchronously so all 6 workers run in parallel!
        processClaimedTask({
          task: claimedTask,
          workerId,
          headless: HEADLESS,
        })
          .then((res) => {
            console.log(`✅ [6-WORKER DISPATCHER] ${workerId} finished task #${claimedTask.id} with status: ${res?.status || 'done'}`);
          })
          .catch((err) => {
            console.error(`❌ [6-WORKER DISPATCHER] ${workerId} error on task #${claimedTask.id}:`, err?.message || err);
          })
          .finally(() => {
            activeSubmittingWorkers.delete(workerId);
            // Immediately attempt next task for this newly free worker
            setImmediate(() => dispatchQueuedSubmissions().catch(() => { }));
          });
      }
    }
  } catch (err) {
    console.warn(`[6-WORKER DISPATCHER] Error in cycle:`, err?.message);
  }
}

// Startup initialization
async function initOnStartup() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  AUTONOMOUS WORKDAY PIPELINE DAEMON — 12-WORKER PARALLEL ENGINE`);
  console.log(`  Scanning (3):   scanning_worker_1, scanning_worker_2, scanning_worker_3`);
  console.log(`  Resolving (3):  resolving_worker_1, resolving_worker_2, resolving_worker_3`);
  console.log(`  Submitting (6): submitting_worker_1..6 (PARALLEL EXECUTION POOL)`);
  console.log(`  Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Webhook Port: ${PORT}`);
  console.log(`${'═'.repeat(72)}\n`);

  try {
    await ensureCanonicalWorkers();
    await resetAllWorkersIdle();
    await syncBotControlState({ stage: 'idle', is_running: false, active_worker_count: 0 });
    console.log(`[DAEMON] worker_status table initialized: strictly canonical rows set to idle.`);
  } catch (err) {
    console.warn(`[DAEMON] Startup note:`, err.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DAEMON WEBHOOK SERVER] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[DAEMON] Ready for instant webhooks (POST /api/bot/webhook) & Supabase bot_control signals — 9-Worker Pipeline Active.\n`);
  });

  // ── Universal Cloud Bridge: Listen to Supabase signals (bot_control + worker_status fallback) ──
  let warnedMissingBotControl = false;
  setInterval(async () => {
    try {
      const bc = await getBotControl();

      if (bc) {
        // 1. Primary Stop Signal
        if (bc.stop_requested && isPoolRunning) {
          console.log(`\n🛑 [DAEMON SUPABASE TRIGGER] Detected 'stop_requested' in bot_control table! Stopping workers...`);
          await stopAutonomousPool();
          return;
        }

        // 2. Primary Start / Trigger Pipeline Signal
        if (!isPoolRunning && (bc.last_action_requested === 'start' || bc.last_action_requested === 'start_pipeline')) {
          console.log(`\n⚡ [DAEMON SUPABASE TRIGGER] Detected 'start' signal in bot_control table! Launching 9-worker pipeline...`);
          await syncBotControlState({ last_action_requested: null, is_running: true });
          runSequentialPipeline().catch(console.error);
          return;
        }
      } else {
        if (!warnedMissingBotControl) {
          warnedMissingBotControl = true;
          console.log(`\n[DAEMON] ℹ️ Supabase 'bot_control' table not detected. Active fallback bridge listening directly on 'worker_status' table.`);
        }
      }

      // Heartbeat: keep bot_control active while scanning or submitting
      if (isPoolRunning) {
        await syncBotControlState({ is_running: true, stage: currentStage }).catch(() => { });
      }

      // ── Resilient Fallback Bridge via worker_status table ──
      // Triggers if frontend writes directly to worker_status before migration 023 is applied
      const statuses = await getWorkerStatuses().catch(() => []);
      if (!isPoolRunning) {
        const hasTrigger = statuses.some((w) =>
          w.worker_id &&
          w.worker_id.includes('scan') &&
          w.state === 'in_flight' &&
          w.current_application_id &&
          w.current_application_id.includes('Stage 1')
        );
        if (hasTrigger) {
          console.log(`\n⚡ [DAEMON WORKER_STATUS TRIGGER] Detected 'in_flight' signal in worker_status table! Launching 9-worker pipeline...`);
          runSequentialPipeline().catch(console.error);
          return;
        }
      }

    } catch {
      // Continue polling silently
    }
  }, 2000);

  // ── Phase 3: 10-Minute Lease Reaper Background Interval (runs every 60s) ──
  setInterval(async () => {
    try {
      const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
      await reapExpiredLeases(10);
    } catch { }
  }, 60_000);

  // ── Autonomous 6-Worker Parallel Submission Dispatcher (runs every 2s) ──
  setInterval(async () => {
    try {
      await dispatchQueuedSubmissions();
    } catch { }
  }, 2000);
}

process.on('SIGTERM', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log('[DAEMON] SIGTERM received. Shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log('[DAEMON] Interrupted. Shutting down.');
  process.exit(0);
});

initOnStartup().catch((err) => {
  console.error('[DAEMON FATAL]', err);
  process.exit(1);
});
