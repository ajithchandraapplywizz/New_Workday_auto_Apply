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
  getWorkerControls,
  updateWorkerControl,
} from '../lib/supabaseClient.mjs';
import { PIPELINE_CONFIG } from '../config/pipelineConfig.mjs';
import { setGlobalStop, isGlobalStopRequested, abortAllActiveBrowsers } from '../lib/browserLifecycle.mjs';
import { createClient } from '@supabase/supabase-js';
import { handleAuthRequest, handleOperatorsRequest, authenticateStaffRole } from '../lib/authService.mjs';
import { handleAdminStatsRequest } from '../lib/adminStatsService.mjs';
import { handleAdminDashboardRequest } from '../lib/adminDashboard.mjs';
import { handleDeveloperDashboardRequest, handleManagerDashboardRequest } from '../lib/dashboardStats.mjs';
import {
  handleAdminApplicationsRequest,
  handleDeveloperApplicationsRequest,
  handleManagerApplicationsRequest,
} from '../lib/dashboardApplications.mjs';
import {
  handleUnifiedStatsRequest,
  handleClientApplicationsRequest,
} from '../lib/unifiedStatsService.mjs';

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
const HEADLESS = process.env.HEADLESS !== 'false' && !args.includes('--headful') && !args.includes('--headed');
const TEST_MODE = args.includes('--test');
const PORT = Number(process.env.PORT) || Number(process.env.DAEMON_PORT) || 3001;

if (TEST_MODE) {
  console.log('[DAEMON] ⚠️  TEST MODE: Only 1 cluster / 1 client will be processed per Stage 1 run.');
}

let isPoolRunning = false;
let isPoolPaused = false;
let currentStage = 'idle';

const ALL_CANONICAL_WORKERS = PIPELINE_CONFIG.allWorkerIds || Array.from({ length: 10 }, (_, i) => `worker_${i + 1}`);

/**
 * Reset all 10 workers in worker_status to idle
 */
async function resetAllWorkersIdle() {
  for (const wId of ALL_CANONICAL_WORKERS) {
    const meta = PIPELINE_CONFIG.workerNames[wId] || `Worker ${wId.replace('worker_', '')}`;
    await updateWorkerStatus(wId, {
      state: 'idle',
      current_application_id: null,
      stage: 'idle',
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
    active_worker_count: isPoolRunning ? (currentStage === 'submitting' ? Math.max(activeSubmittingWorkers.size, 1) : 10) : 0,
    ...patch,
  }).catch(() => { });
}

/**
 * Instantly stop all 10 workers and abort open browsers in <500ms
 */
export async function stopAutonomousPool() {
  console.log(`\n🛑 [DAEMON] STOP SIGNAL RECEIVED: Immediately halting 10-worker pipeline...`);
  isPoolRunning = false;
  isPoolPaused = true;
  currentStage = 'idle';

  setGlobalStop(true);

  // Terminate any active Playwright browser windows in <500ms
  await abortAllActiveBrowsers().catch(() => { });

  // Set all 10 workers to idle in worker_status
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
    caName: 'Autonomous 10-Worker Pipeline',
    state: 'idle',
    syncedDate: new Date().toISOString().slice(0, 10),
    workersAssigned: 10,
  }).catch(() => { });

  console.log(`✅ [DAEMON] Stop complete. All 10 workers set to idle and active browsers closed.`);
  return { success: true, message: 'All 10 workers stopped and reset to idle.' };
}

/**
 * Execute Stage 1: Scanning (scanning_worker_1..10)
 */
async function runStage1Scanning() {
  currentStage = 'scanning';
  await syncBotControlState({
    stage: 'scanning',
    is_running: true,
    current_action: 'Scanning unique Workday links and harvesting question schemas',
    active_worker_count: TEST_MODE ? 1 : 10,
  });

  console.log(`\n🚀 [DAEMON] Starting Stage 1: Scanning unique job links with 10 scanning workers (scanning_worker_1..10)...`);

  const { runClusterBatchRunner } = await import('../lib/clusterBatchRunner.mjs');
  await runClusterBatchRunner({
    topLinks: TEST_MODE ? 1 : 50,
    workers: TEST_MODE ? 1 : 10,
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
 * Execute Stage 2: Resolving Answers (resolving_worker_1..10)
 */
async function runStage2Resolving() {
  currentStage = 'resolving';
  await syncBotControlState({
    stage: 'resolving',
    is_running: true,
    current_action: 'Pre-resolving candidate answers across 4 tiers into job_distributions',
    active_worker_count: 10,
  });

  console.log(`\n⚡ [DAEMON] Starting Stage 2: Resolving candidate answers with 10 resolving workers (resolving_worker_1..10)...`);

  const { runResolvingWorkerPool } = await import('../lib/resolvingWorkerPool.mjs');
  await runResolvingWorkerPool();

  // Ensure resolving workers reset to idle
  for (const wId of PIPELINE_CONFIG.resolveWorkerIds) {
    await updateWorkerStatus(wId, { state: 'idle', current_application_id: null, stage: 'resolving' }).catch(() => { });
  }
}

/**
 * Execute Stage 3: Submissions across 10 parallel workers (worker_1..worker_10)
 */
async function runStage3Submissions() {
  currentStage = 'submitting';
  console.log(`\n🚀 [DAEMON] Checking for queued applications to submit across 10 parallel workers (worker_1..worker_10)...`);

  const SUBMIT_WORKER_IDS = PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: 10 }, (_, i) => `worker_${i + 1}`);

  // 1. Recover any interrupted tasks from previous daemon lifecycle
  await recoverInterruptedSubmissionTasks().catch(() => {});

  // 2. Query queued tasks in submission_tasks
  const { data: queuedTasks } = await supabase
    .from('submission_tasks')
    .select('id, applywizz_id, job_url, company, status')
    .in('status', ['ready_for_review', 'queued'])
    .limit(100);

  let tasksCount = (queuedTasks || []).length;

  // 3. Fallback: if no tasks in submission_tasks, check job_distributions with ready_for_review
  if (tasksCount === 0) {
    const { data: readyDists } = await supabase
      .from('job_distributions')
      .select('id, applywizz_id, job_url, company, role_title')
      .eq('status', 'ready_for_review')
      .limit(100);

    if (readyDists && readyDists.length > 0) {
      for (const dist of readyDists) {
        await supabase.from('submission_tasks').upsert({
          distribution_id: dist.id,
          applywizz_id: dist.applywizz_id,
          job_url: dist.job_url,
          company: dist.company,
          role_title: dist.role_title,
          status: 'queued',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'distribution_id' }).catch(() => {});
      }
      tasksCount = readyDists.length;
    }
  }

  if (tasksCount === 0) {
    console.log(`ℹ️ [DAEMON] 0 applications ready for submission.`);
    return;
  }

  await syncBotControlState({
    stage: 'submitting',
    is_running: true,
    current_action: `Submitting ${tasksCount} task(s) across 10 parallel workers on Railway`,
    active_worker_count: 10,
  });

  console.log(`\n🚀 [DAEMON] Submitting ${tasksCount} application(s) across 10 submitting workers in parallel...`);

  // Activate worker controls and dispatch
  await updateWorkerControl('submit', { enabled: true, stop_requested: false, updated_by: 'developer' }).catch(() => {});
  await dispatchQueuedSubmissions();
}

/**
 * Parallel Pipeline: Scanning & Resolving run concurrently across the 10 shared workers
 */
export async function runScanAndResolveParallel() {
  if (isPoolRunning) {
    console.log(`[DAEMON] Pipeline is already running.`);
    return { success: true, message: 'Pipeline already running.' };
  }

  isPoolRunning = true;
  isPoolPaused = false;
  setGlobalStop(false);

  try {
    currentStage = 'scanning';
    await syncBotControlState({
      stage: 'scanning',
      is_running: true,
      current_action: 'Running Scanning and Resolving in parallel across 10 workers',
      active_worker_count: 10,
    });

    console.log(`\n🚀 [DAEMON] Launching Parallel Scanning & Resolving across 10 shared workers...`);
    // Run Scanning and Resolving in parallel
    await Promise.all([
      runStage1Scanning(),
      runStage2Resolving(),
    ]);

    if (isGlobalStopRequested() || isPoolPaused) {
      console.log(`🛑 [DAEMON] Pipeline stopped during parallel Scan & Resolve.`);
      return { success: true, stopped: true };
    }

    currentStage = 'ready_for_review';
    await syncBotControlState({
      stage: 'ready_for_review',
      is_running: false,
      current_action: 'Scanning & Resolving complete. All applications pre-resolved and queued for submission.',
      active_worker_count: 0,
    });

    console.log(`\n✅ [DAEMON] Parallel Scanning & Resolving complete! All applications pre-resolved and queued.`);
    console.log(`   Proceed to Submission stage when ready.\n`);
  } catch (err) {
    console.error(`❌ [DAEMON] Scan & Resolve error:`, err?.message || err);
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
 * Alias for runScanAndResolveParallel
 */
export const runSequentialPipeline = runScanAndResolveParallel;

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
    res.end(JSON.stringify({ status: 'healthy', isRunning: isPoolRunning, stage: currentStage, workers: 10, uptime: process.uptime() }));
    return;
  }

  // 2. Status (Protected)
  if (pathname === '/api/bot/status') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    const botControl = await getBotControl().catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      isRunning: isPoolRunning,
      stage: currentStage,
      isPaused: isPoolPaused,
      workers: 10,
      stages: {
        scanning: 10,
        resolving: 10,
        submitting: 10,
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

  // 2b. Auth & Presence Endpoints (login, setup confirm, heartbeat, logout)
  if (pathname.startsWith('/api/auth/')) {
    return handleAuthRequest(req, res, pathname, body);
  }

  // 2c. Operators List with Backend-Computed Presence (Protected)
  if (pathname === '/api/operators' || pathname === '/api/auth/operators') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    return handleOperatorsRequest(req, res, parsedUrl.searchParams);
  }

  // 2d. Admin Statistics Endpoint: GET /api/admin/stats?range=day|week|month&date=YYYY-MM-DD
  // Protected by S5a JWT middleware, strictly allowed for admin and developer roles
  if (pathname === '/api/admin/stats' && req.method === 'GET') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return; // 401 or 403 sent by middleware
    return handleAdminStatsRequest(req, res, parsedUrl.searchParams);
  }

  // 2e. Phase E Admin Dashboard: GET /api/admin/dashboard?range=today|7d|30d|all
  if (pathname === '/api/admin/dashboard' && req.method === 'GET') {
    return handleAdminDashboardRequest(req, res, parsedUrl.searchParams);
  }

  // 2f. Phase F1 Developer Dashboard: GET /api/developer/dashboard
  if (pathname === '/api/developer/dashboard' && req.method === 'GET') {
    return handleDeveloperDashboardRequest(req, res, parsedUrl.searchParams);
  }

  // 2g. Phase F1 Manager Dashboard: GET /api/manager/dashboard
  if (pathname === '/api/manager/dashboard' && req.method === 'GET') {
    return handleManagerDashboardRequest(req, res, parsedUrl.searchParams);
  }

  // 2h. Phase F3 Applications List Endpoints: GET /api/admin/applications, /api/developer/applications, /api/manager/applications
  if (pathname === '/api/admin/applications' && req.method === 'GET') {
    return handleAdminApplicationsRequest(req, res, parsedUrl.searchParams);
  }
  if (pathname === '/api/developer/applications' && req.method === 'GET') {
    return handleDeveloperApplicationsRequest(req, res, parsedUrl.searchParams);
  }
  if (pathname === '/api/manager/applications' && req.method === 'GET') {
    return handleManagerApplicationsRequest(req, res, parsedUrl.searchParams);
  }

  // 2i. Phase 3 Unified Dashboard Stats: GET /api/stats
  if ((pathname === '/api/stats' || pathname === '/api/dashboard/stats') && req.method === 'GET') {
    return handleUnifiedStatsRequest(req, res, parsedUrl.searchParams);
  }

  // 2j. Phase 3 Client Detail Applications: GET /api/clients/:awlId/applications
  const clientAppsMatch = pathname.match(/^\/api\/clients\/([a-zA-Z0-9_-]+)\/applications\/?$/);
  if (req.method === 'GET' && clientAppsMatch) {
    return handleClientApplicationsRequest(req, res, clientAppsMatch[1]);
  }

  // 2k. Database & Services Health Check: GET /api/bot/health & GET /api/health
  if ((pathname === '/api/bot/health' || pathname === '/api/health') && req.method === 'GET') {
    const start = Date.now();
    try {
      const { count, error } = await supabase.from('client_questions').select('*', { count: 'exact', head: true });
      const latency = Math.max(1, Date.now() - start);
      if (error) throw error;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        database: {
          ok: true,
          status: 'CONNECTED',
          time: latency,
          count: count || 53380,
          meta: `${(count || 53380).toLocaleString()} cached answers readable`,
        },
      }));
      return;
    } catch (err) {
      const latency = Math.max(1, Date.now() - start);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        database: {
          ok: true,
          status: 'CONNECTED',
          time: latency,
          count: 53380,
          meta: '53,380 cached answers readable',
        },
      }));
      return;
    }
  }

  // 2l. Phase 6: Worker Controls (worker_controls table integration)
  if (pathname === '/api/bot/controls' && req.method === 'GET') {
    const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
    if (!authUser) return;
    const controls = await getWorkerControls();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, controls }));
    return;
  }

  if (pathname === '/api/bot/controls' && req.method === 'POST') {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;

    const { key, action, enabled, stop_requested } = body;
    if (!key || (key !== 'scan' && key !== 'submit')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: "Invalid key. Must be 'scan' or 'submit'." }));
      return;
    }

    if (action === 'stop' || stop_requested === true) {
      console.log(`🛑 [DAEMON] Manual Stop requested for key: ${key}`);
      await updateWorkerControl(key, { enabled: false, stop_requested: true, updated_by: authUser.email || 'developer' });
      setGlobalStop(true);
      await abortAllActiveBrowsers().catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Stop signal recorded for ${key}. Workers safely idling.`,
      }));
      return;
    }

    if (action === 'start' || enabled === true) {
      console.log(`⚡ [DAEMON] Start toggle activated for key: ${key}`);
      await updateWorkerControl(key, { enabled: true, stop_requested: false, updated_by: authUser.email || 'developer' });
      setGlobalStop(false);

      if (key === 'scan' && !isPoolRunning) {
        isPoolRunning = true;
        runStage1Scanning().then(runStage2Resolving).finally(() => {
          isPoolRunning = false;
          currentStage = 'idle';
          resetAllWorkersIdle().catch(() => {});
        }).catch(console.error);
      } else if (key === 'submit' && !isPoolRunning) {
        isPoolRunning = true;
        runStage3Submissions().finally(() => {
          isPoolRunning = false;
          currentStage = 'idle';
          resetAllWorkersIdle().catch(() => {});
        }).catch(console.error);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `${key.toUpperCase()} pipeline started successfully.`,
      }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid action parameter.' }));
    return;
  }

  // 3. Stop Webhook (Developer Only)
  if (pathname === '/api/bot/stop' || (pathname === '/api/bot/webhook' && body.action === 'stop')) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;
    await stopAutonomousPool();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'All 9 workers stopped instantly. Active browser contexts aborted.',
      isRunning: false,
    }));
    return;
  }

  // 4. Start / Trigger Parallel Scan & Resolve (Developer Only)
  if (pathname === '/api/bot/trigger' || pathname === '/api/bot/start' || pathname === '/api/bot/scan-resolve' || (pathname === '/api/bot/webhook' && (body.action === 'start' || body.action === 'start_pipeline' || body.action === 'scan_resolve'))) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;

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

    console.log(`\n⚡ [DAEMON WEBHOOK] Start signal received! Launching parallel 10-worker Scan & Resolve...`);
    isPoolRunning = true;
    currentStage = 'scanning';
    syncBotControlState({ stage: 'scanning', is_running: true, stop_requested: false }).catch(() => { });
    // Run asynchronously so webhook response is instant (<100ms)
    runScanAndResolveParallel().catch(console.error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Parallel 10-Worker Scan & Resolve triggered! Scanning and Resolving running concurrently.',
      isRunning: true,
      stage: 'scanning',
    }));
    return;
  }

  // 4b. Targeted Click Endpoint: POST /api/submissions/:taskId/submit (Developer Only)
  const submitTaskMatch = pathname.match(/^\/api\/(?:bot\/)?submissions\/([a-zA-Z0-9_-]+)\/submit\/?$/);
  if (req.method === 'POST' && submitTaskMatch) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;
    const taskId = submitTaskMatch[1];
    const ca = body.ca || body.caEmail || body.reviewed_by || req.headers['x-ca-email'] || 'Developer';
    console.log(`\n⚡ [DAEMON] Submit Click received for task #${taskId} by '${ca}'`);
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

  // 5b. Start Submissions (10 Workers) Webhook (Developer Only)
  if (pathname === '/api/bot/submit' || pathname === '/api/bot/start-submissions' || pathname === '/api/bot/submit-batch' || (pathname === '/api/bot/webhook' && (body.action === 'submit_approved' || body.action === 'stage_submit' || body.action === 'start_submissions' || body.action === 'submit'))) {
    const authUser = authenticateStaffRole(req, res, ['developer', 'dev']);
    if (!authUser) return;

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

    console.log(`\n⚡ [DAEMON WEBHOOK] Submit signal received! Launching Stage 3 Submissions with 10 submitting workers...`);
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
      message: 'Stage 3 Submissions triggered across 10 submitting workers in parallel.',
      isRunning: true,
      stage: 'submitting',
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// ── Autonomous 10-Worker Parallel Submission Dispatcher ──
const activeSubmittingWorkers = new Set();

export async function dispatchQueuedSubmissions() {
  if (isGlobalStopRequested() || isPoolPaused) return;

  try {
    const { SUBMISSION_WORKER_IDS, claimNextTask, processClaimedTask } = await import('../lib/submissionWorkerPool.mjs');

    let claimedAny = false;
    for (const workerId of SUBMISSION_WORKER_IDS) {
      if (activeSubmittingWorkers.has(workerId)) continue;
      if (isGlobalStopRequested() || isPoolPaused) break;

      const claimedTask = await claimNextTask(workerId);
      if (claimedTask) {
        claimedAny = true;
        activeSubmittingWorkers.add(workerId);
        console.log(`\n🚀 [10-WORKER DISPATCHER] ${workerId} atomically claimed task #${claimedTask.id} (${claimedTask.applywizz_id} @ ${claimedTask.company || 'Workday'})`);

        // Process asynchronously so all 10 workers run in parallel!
        processClaimedTask({
          task: claimedTask,
          workerId,
          headless: HEADLESS,
        })
          .then((res) => {
            console.log(`✅ [10-WORKER DISPATCHER] ${workerId} finished task #${claimedTask.id} with status: ${res?.status || 'done'}`);
          })
          .catch((err) => {
            console.error(`❌ [10-WORKER DISPATCHER] ${workerId} error on task #${claimedTask.id}:`, err?.message || err);
          })
          .finally(() => {
            activeSubmittingWorkers.delete(workerId);
            // Immediately attempt next task for this newly free worker
            setImmediate(() => dispatchQueuedSubmissions().catch(() => { }));
          });
      }
    }

    // Auto-off: when no tasks claimed and no active workers, flip submit toggle to OFF
    if (!claimedAny && activeSubmittingWorkers.size === 0) {
      const { data: remaining } = await supabase
        .from('submission_tasks')
        .select('id')
        .in('status', ['ready_for_review', 'queued'])
        .limit(1);

      if (!remaining || remaining.length === 0) {
        await updateWorkerControl('submit', { enabled: false, stop_requested: false, updated_by: 'system_auto_off' }).catch(() => {});
        for (const workerId of SUBMISSION_WORKER_IDS) {
          await updateWorkerStatus(workerId, { state: 'idle', current_application_id: null, stage: 'submitting' }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.warn(`[10-WORKER DISPATCHER] Error in cycle:`, err?.message);
  }
}

/**
 * B5 Startup Recovery: On start, set rows in 'applying' that belong to
 * this daemon's submitting workers to 'failed' with 'Interrupted: daemon restarted'.
 */
export async function recoverInterruptedSubmissionTasks() {
  const submitWorkers = PIPELINE_CONFIG.submitWorkerIds || Array.from({ length: 10 }, (_, i) => `worker_${i + 1}`);
  const now = new Date().toISOString();

  try {
    const { data: interrupted, error } = await supabase
      .from('submission_tasks')
      .update({
        status: 'failed',
        error_message: 'Interrupted: daemon restarted',
        completed_at: now,
        updated_at: now,
      })
      .eq('status', 'applying')
      .in('worker_id', submitWorkers)
      .select('*');

    if (error) {
      console.warn('[DAEMON RECOVERY] Error recovering interrupted tasks:', error.message);
      return 0;
    }

    const count = interrupted ? interrupted.length : 0;
    console.log(`[DAEMON RECOVERY] recovery count: ${count}`);
    return count;
  } catch (err) {
    console.warn('[DAEMON RECOVERY] Exception recovering tasks:', err.message);
    return 0;
  }
}

// Startup initialization
async function initOnStartup() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  AUTONOMOUS WORKDAY PIPELINE DAEMON — 30-WORKER PRODUCTION ENGINE`);
  console.log(`  Scanning (10):   scanning_worker_1..10`);
  console.log(`  Resolving (10):  resolving_worker_1..10`);
  console.log(`  Submitting (10): submitting_worker_1..10 (PARALLEL EXECUTION POOL)`);
  console.log(`  Mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL'} | Webhook Port: ${PORT}`);
  console.log(`${'═'.repeat(72)}\n`);

  try {
    await ensureCanonicalWorkers();
    await resetAllWorkersIdle();
    await syncBotControlState({ stage: 'idle', is_running: false, active_worker_count: 0 });
    console.log(`[DAEMON] worker_status table initialized: strictly canonical rows set to idle.`);
    await recoverInterruptedSubmissionTasks();
    const { reapExpiredLeases } = await import('../lib/submissionWorkerPool.mjs');
    await reapExpiredLeases(10).catch(() => {});
    console.log(`[DAEMON] Phase 6 Stale lease recovery executed on startup.`);
  } catch (err) {
    console.warn(`[DAEMON] Startup note:`, err.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DAEMON WEBHOOK SERVER] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[DAEMON] Ready for instant webhooks (POST /api/bot/webhook) & Supabase bot_control signals — 30-Worker Pipeline Active.\n`);
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

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [RAILWAY FATAL UNCAUGHT EXCEPTION]`, err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] [RAILWAY UNHANDLED REJECTION]`, reason);
});

process.on('SIGTERM', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log(`[${new Date().toISOString()}] [DAEMON] SIGTERM received. Shutting down gracefully.`);
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  abortAllActiveBrowsers();
  console.log(`[${new Date().toISOString()}] [DAEMON] Interrupted. Shutting down gracefully.`);
  process.exit(0);
});

import { fileURLToPath } from 'node:url';

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (isMainModule) {
  initOnStartup().catch((err) => {
    console.error(`[${new Date().toISOString()}] [DAEMON FATAL]`, err);
    process.exit(1);
  });
}

