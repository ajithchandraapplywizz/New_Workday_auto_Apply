/**
 * Autonomous 3-Worker Submission Engine (Phase 3)
 * - 3 Dedicated Submitting Workers: submitting_worker_1, submitting_worker_2, submitting_worker_3
 * - Atomic Claim: FOR UPDATE SKIP LOCKED (oldest queued first) via RPC or atomic CAS
 * - Heartbeat: updates worker_leased_at every 30 seconds
 * - Reaper: 10-minute lease expiry marks stuck tasks as 'failed' (never re-queued)
 * - Isolated Context: each task runs in its own fresh Playwright browser context
 */

import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';
import { updateWorkerStatus } from './supabaseClient.mjs';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const SUBMISSION_WORKER_IDS = [
  'submitting_worker_1',
  'submitting_worker_2',
  'submitting_worker_3',
  'submitting_worker_4',
  'submitting_worker_5',
  'submitting_worker_6',
];

/**
 * Atomic Task Claim (FOR UPDATE SKIP LOCKED)
 * Sets applying, worker_id, started_at, worker_leased_at in the exact same statement.
 */
export async function claimNextTask(workerId) {
  if (!workerId) return null;
  const now = new Date().toISOString();

  // 1. Try PostgreSQL RPC (guarantees DB-level FOR UPDATE SKIP LOCKED)
  try {
    const { data: rpcRows, error: rpcErr } = await supabase
      .rpc('claim_next_submission_task', { p_worker_id: workerId });

    if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length > 0) {
      return rpcRows[0];
    }
  } catch { }

  // 2. Direct atomic fallback (CAS: Compare-And-Swap on oldest queued row)
  try {
    const { data: candidates } = await supabase
      .from('submission_tasks')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(5);

    if (!candidates || candidates.length === 0) return null;

    for (const cand of candidates) {
      const { data: claimed, error: claimErr } = await supabase
        .from('submission_tasks')
        .update({
          status: 'applying',
          worker_id: workerId,
          started_at: now,
          worker_leased_at: now,
          updated_at: now,
        })
        .eq('id', cand.id)
        .eq('status', 'queued')
        .select('*');

      if (!claimErr && claimed && claimed.length > 0) {
        return claimed[0];
      }
    }
  } catch (err) {
    console.warn(`[claimNextTask] Error claiming for ${workerId}:`, err.message);
  }

  return null;
}

/**
 * Heartbeat: Updates worker_leased_at while worker is processing.
 */
export async function sendTaskHeartbeat(taskId, workerId) {
  if (!taskId || !workerId) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from('submission_tasks')
      .update({
        worker_leased_at: now,
        updated_at: now,
      })
      .eq('id', taskId)
      .eq('worker_id', workerId)
      .eq('status', 'applying');

    return !error;
  } catch {
    return false;
  }
}

/**
 * Reaper: Marks tasks with expired lease (> timeoutMinutes) as 'failed'.
 * Never auto re-queues, preserving safety against duplicate submissions.
 */
export async function reapExpiredLeases(timeoutMinutes = 10) {
  // 1. Try PostgreSQL RPC
  try {
    const { data: reaped, error: rpcErr } = await supabase
      .rpc('reap_expired_submission_leases', { p_timeout_minutes: timeoutMinutes });

    if (!rpcErr && Array.isArray(reaped) && reaped.length > 0) {
      console.log(`🧹 [REAPER] Reaped ${reaped.length} expired task(s) via RPC.`);
      return reaped;
    }
  } catch { }

  // 2. Fallback direct query
  try {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const { data: expired } = await supabase
      .from('submission_tasks')
      .select('id, worker_id, applywizz_id')
      .eq('status', 'applying')
      .lt('worker_leased_at', cutoff);

    if (!expired || expired.length === 0) return [];

    const reapedRows = [];
    for (const exp of expired) {
      const { data: updated } = await supabase
        .from('submission_tasks')
        .update({
          status: 'failed',
          error_message: `Worker lease expired (> ${timeoutMinutes} minutes). Possible worker process crash. Requires admin inspection.`,
          completed_at: now,
          updated_at: now,
        })
        .eq('id', exp.id)
        .eq('status', 'applying')
        .select('*');

      if (updated && updated.length > 0) {
        reapedRows.push(updated[0]);
      }
    }

    if (reapedRows.length > 0) {
      console.log(`🧹 [REAPER] Reaped ${reapedRows.length} expired task(s):`, reapedRows.map(r => r.id));
    }
    return reapedRows;
  } catch (err) {
    console.error(`[reapExpiredLeases] Error:`, err.message);
    return [];
  }
}

/**
 * Worker Processor for a claimed task:
 * - Reads job URL and client strictly from claimed row
 * - Runs with isolated Playwright browser context
 * - Emits periodic heartbeats
 */
export async function processClaimedTask({ task, workerId, headless = true, runnerFn = null }) {
  if (!task || !workerId) return { success: false, error: 'Invalid task or workerId' };

  console.log(`\n🚀 [${workerId}] Processing task #${task.id} (${task.applywizz_id} @ ${task.company || 'Company'})...`);

  // Update worker_status table
  await updateWorkerStatus(workerId, {
    state: 'in_flight',
    stage: 'submitting',
    current_application_id: task.id,
    bot_name: `Submitting Worker ${workerId.slice(-1)}`,
    updated_at: new Date().toISOString(),
  }).catch(() => { });

  // Start 30-second heartbeat interval
  const heartbeatTimer = setInterval(() => {
    sendTaskHeartbeat(task.id, workerId).catch(() => { });
  }, 30_000);

  let result = null;
  try {
    if (runnerFn) {
      // Custom or test runner function
      result = await runnerFn(task, workerId);
    } else {
      // Default Playwright runner via workerPool
      const { executeWorkerTask } = await import('./workerPool.mjs');
      result = await executeWorkerTask({
        task: {
          id: task.distribution_id,
          applywizzId: task.applywizz_id,
          jobUrl: task.job_url,
          company: task.company,
          roleTitle: task.role_title,
          status: 'approved_for_submission',
        },
        workerId,
        taskIndex: 1,
        totalTasks: 1,
        options: {
          headless: Boolean(headless),
          confirmSubmit: true,
          dryRun: false,
        },
      });
    }
    const now = new Date().toISOString();
    const isSuccess = result?.status === 'submitted' || result?.status === 'success';
    const finalShot = result?.screenshotUrl || result?.reviewScreenshotUrl || null;

    if (isSuccess) {
      try {
        await supabase
          .from('submission_tasks')
          .update({
            status: 'submitted',
            completed_at: now,
            application_submitted_screenshot_url: finalShot,
            screenshot_path: finalShot,
            updated_at: now,
          })
          .eq('id', task.id);
      } catch (stUpErr) {
        console.warn(`[${workerId}] Warning updating submission_tasks to submitted:`, stUpErr?.message);
      }

      if (task.distribution_id) {
        try {
          await supabase
            .from('job_distributions')
            .update({
              status: 'submitted',
              application_submitted_screenshot_url: finalShot,
              updated_at: now,
            })
            .eq('id', task.distribution_id);
        } catch (jdUpErr) {
          console.warn(`[${workerId}] Warning updating job_distributions to submitted:`, jdUpErr?.message);
        }
      }
    } else {
      const errMsg = result?.error || result?.reason || `Submission ended with status: ${result?.status || 'failed'}`;
      try {
        await supabase
          .from('submission_tasks')
          .update({
            status: 'failed',
            error_message: errMsg,
            completed_at: now,
            application_submitted_screenshot_url: finalShot,
            screenshot_path: finalShot,
            updated_at: now,
          })
          .eq('id', task.id);
      } catch (stFailErr) {
        console.warn(`[${workerId}] Warning updating submission_tasks to failed:`, stFailErr?.message);
      }

      if (task.distribution_id) {
        try {
          await supabase
            .from('job_distributions')
            .update({
              status: 'failed',
              error_message: errMsg,
              application_submitted_screenshot_url: finalShot,
              updated_at: now,
            })
            .eq('id', task.distribution_id);
        } catch (jdFailErr) {
          console.warn(`[${workerId}] Warning updating job_distributions to failed:`, jdFailErr?.message);
        }
      }
    }
  } catch (err) {
    result = {
      status: 'failed',
      error: err?.message || 'Execution error',
    };
    const now = new Date().toISOString();
    try {
      await supabase
        .from('submission_tasks')
        .update({
          status: 'failed',
          error_message: err?.message || 'Execution error',
          completed_at: now,
          updated_at: now,
        })
        .eq('id', task.id);
    } catch { }

    if (task.distribution_id) {
      try {
        await supabase
          .from('job_distributions')
          .update({
            status: 'failed',
            error_message: err?.message || 'Execution error',
            updated_at: now,
          })
          .eq('id', task.distribution_id);
      } catch { }
    }
  } finally {
    clearInterval(heartbeatTimer);
    // Release worker back to idle
    await updateWorkerStatus(workerId, {
      state: 'idle',
      stage: 'submitting',
      current_application_id: null,
      bot_name: `Submitting Worker ${workerId.slice(-1)}`,
      updated_at: new Date().toISOString(),
    }).catch(() => { });
  }

  return result;
}
