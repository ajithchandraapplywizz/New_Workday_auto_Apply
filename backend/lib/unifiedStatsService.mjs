/**
 * unifiedStatsService.mjs — Phase 3 Stats Backend
 * ===============================================
 * Server-side computation of all dashboard stats from submission_tasks and job_distributions.
 * - Active clients list cached ~2 minutes from https://applywizz-ca-management.vercel.app/api/active-clients
 * - Primary stats: Active Clients, Submitted, Failed, Queued, Running, Ready to Review, Needs Answers
 * - Per-client rows keyed by AWL ID with client names from clients table
 * - Per-client detail endpoint for applications that reached ready_for_review or later
 * - Protected by staff token (admin, developer, dev)
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { authenticateStaffRole } from './authService.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// Cache for Active Clients API (2 minutes TTL)
let activeClientsCache = null;
let activeClientsCacheExpiresAt = 0;
const ACTIVE_CLIENTS_TTL_MS = 2 * 60 * 1000;

// Stats in-memory cache (15 seconds TTL)
let statsCache = null;
let statsCacheExpiresAt = 0;
const STATS_TTL_MS = 15 * 1000;

/**
 * Fetch list of active AWL IDs from external API with 2-minute cache
 */
export async function fetchActiveClientsList() {
  const now = Date.now();
  if (activeClientsCache && activeClientsCacheExpiresAt > now) {
    return activeClientsCache;
  }

  try {
    const res = await fetch('https://applywizz-ca-management.vercel.app/api/active-clients', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const json = await res.json();
      let ids = [];
      if (Array.isArray(json)) {
        ids = json.map((x) => (typeof x === 'string' ? x : x.applywizz_id || x.id)).filter(Boolean);
      } else if (json && Array.isArray(json.applywizz_ids)) {
        ids = json.applywizz_ids.filter(Boolean);
      }

      if (ids.length > 0) {
        // Normalize uppercase
        const normalized = [...new Set(ids.map((id) => String(id).toUpperCase().trim()))];
        activeClientsCache = normalized;
        activeClientsCacheExpiresAt = now + ACTIVE_CLIENTS_TTL_MS;
        return normalized;
      }
    }
  } catch (err) {
    console.warn('[STATS] Failed to fetch active-clients API, falling back to cache or DB:', err.message);
  }

  // Fallback if cached value exists
  if (activeClientsCache && activeClientsCache.length > 0) {
    return activeClientsCache;
  }

  // Fallback to clients table
  try {
    const { data: dbClients } = await supabase
      .from('clients')
      .select('applywizz_id')
      .not('applywizz_id', 'is', null);

    const dbIds = [...new Set((dbClients || []).map((c) => String(c.applywizz_id).toUpperCase().trim()))];
    if (dbIds.length > 0) {
      activeClientsCache = dbIds;
      activeClientsCacheExpiresAt = now + ACTIVE_CLIENTS_TTL_MS;
      return dbIds;
    }
  } catch {}

  return [];
}

/**
 * Computes all dashboard statistics server-side from submission_tasks and job_distributions
 */
export async function getUnifiedDashboardStats({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && statsCache && statsCacheExpiresAt > now) {
    return statsCache;
  }

  // 1. Fetch active AWL IDs list
  const activeAwlIds = await fetchActiveClientsList();

  // 2. Fetch clients directory for names
  const { data: dbClients, error: clientsErr } = await supabase
    .from('clients')
    .select('applywizz_id, client_name, first_name, last_name');

  if (clientsErr) {
    console.warn('[STATS] Error fetching clients table:', clientsErr.message);
  }

  const clientNameMap = new Map();
  for (const c of dbClients || []) {
    if (!c.applywizz_id) continue;
    const cleanId = String(c.applywizz_id).toUpperCase().trim();
    const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
    const name = c.client_name?.trim() || fullName || cleanId;
    clientNameMap.set(cleanId, name);
  }

  // 3. Fetch job_distributions
  const { data: jobDists, error: jdErr } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, job_url, company, role_title, status, created_at, updated_at, application_submitted_screenshot_url, error_message');

  if (jdErr) throw jdErr;

  // 4. Fetch submission_tasks
  const { data: subTasks, error: stErr } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, job_url, company, role_title, status, created_at, started_at, completed_at, updated_at, application_submitted_screenshot_url, screenshot_path, error_message');

  if (stErr) throw stErr;

  // Index submission tasks by distribution_id
  const taskMap = new Map();
  for (const st of subTasks || []) {
    if (st.distribution_id) {
      taskMap.set(st.distribution_id, st);
    }
  }

  // Global Primary Stats
  let submittedCount = 0;
  let failedCount = 0;
  let queuedCount = 0;
  let runningCount = 0;       // status === 'applying'
  let readyToReviewCount = 0; // status === 'ready_for_review'
  let needsAnswersCount = 0;  // status === 'needs_answers'
  let otherCount = 0;

  // Per-client statistics map
  const clientStatsMap = new Map();

  // Initialize all active clients in clientStatsMap
  for (const awlId of activeAwlIds) {
    clientStatsMap.set(awlId, {
      applywizz_id: awlId,
      client_name: clientNameMap.get(awlId) || awlId,
      submitted: 0,
      failed: 0,
      queued: 0,
      running: 0,
      ready_to_review: 0,
      needs_answers: 0,
      total: 0,
    });
  }

  // Process all job distributions
  for (const jd of jobDists || []) {
    const task = taskMap.get(jd.id);
    const effectiveStatus = String((task ? task.status : jd.status) || 'unknown').toLowerCase().trim();
    const cleanAwlId = String(jd.applywizz_id || '').toUpperCase().trim();

    // Ensure client row exists if not in initial active set
    if (cleanAwlId && !clientStatsMap.has(cleanAwlId)) {
      clientStatsMap.set(cleanAwlId, {
        applywizz_id: cleanAwlId,
        client_name: clientNameMap.get(cleanAwlId) || cleanAwlId,
        submitted: 0,
        failed: 0,
        queued: 0,
        running: 0,
        ready_to_review: 0,
        needs_answers: 0,
        total: 0,
      });
    }

    const cStats = cleanAwlId ? clientStatsMap.get(cleanAwlId) : null;

    if (effectiveStatus === 'submitted') {
      submittedCount++;
      if (cStats) { cStats.submitted++; cStats.total++; }
    } else if (effectiveStatus === 'failed') {
      failedCount++;
      if (cStats) { cStats.failed++; cStats.total++; }
    } else if (effectiveStatus === 'queued') {
      queuedCount++;
      if (cStats) { cStats.queued++; cStats.total++; }
    } else if (effectiveStatus === 'applying') {
      runningCount++;
      if (cStats) { cStats.running++; cStats.total++; }
    } else if (effectiveStatus === 'ready_for_review') {
      readyToReviewCount++;
      if (cStats) { cStats.ready_to_review++; cStats.total++; }
    } else if (effectiveStatus === 'needs_answers') {
      needsAnswersCount++;
      if (cStats) { cStats.needs_answers++; cStats.total++; }
    } else {
      otherCount++;
      if (cStats) { cStats.total++; }
    }
  }

  // Transform client rows array and compute status badge
  const clientRows = Array.from(clientStatsMap.values()).map((row) => {
    let status_badge = 'Idle';
    if (row.running > 0) {
      status_badge = 'Running';
    } else if (row.queued > 0) {
      status_badge = 'Queued';
    } else if (row.ready_to_review > 0) {
      status_badge = 'Ready to Review';
    } else if (row.needs_answers > 0) {
      status_badge = 'Needs Answers';
    } else if (row.submitted > 0) {
      status_badge = 'Submitted';
    } else if (row.failed > 0) {
      status_badge = 'Failed';
    } else if (activeAwlIds.includes(row.applywizz_id)) {
      status_badge = 'Active';
    }

    return {
      ...row,
      status_badge,
    };
  });

  // Sort clients: clients with activity first, then by AWL ID
  clientRows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.applywizz_id.localeCompare(b.applywizz_id);
  });

  const primaryStatsObj = {
    active_clients: activeAwlIds.length,
    submitted: submittedCount,
    failed: failedCount,
    queued: queuedCount,
    running: runningCount,
    ready_to_review: readyToReviewCount,
    needs_answers: needsAnswersCount,
    total_applications: (jobDists || []).length,
  };

  const payload = {
    success: true,
    primary_stats: primaryStatsObj,
    stats: primaryStatsObj,
    clients: clientRows,
    clients_count: clientRows.length,
    generated_at: new Date().toISOString(),
  };

  statsCache = payload;
  statsCacheExpiresAt = now + STATS_TTL_MS;
  return payload;
}

/**
 * Fetch detailed applications list for a specific client (ready_for_review and later only)
 */
export async function getClientApplications({ awlId } = {}) {
  const cleanAwlId = String(awlId || '').toUpperCase().trim();
  if (!cleanAwlId) {
    return { success: false, error: 'AWL ID required', applications: [] };
  }

  // 1. Fetch job distributions for this client
  const { data: jobDists, error: jdErr } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, job_url, company, role_title, status, created_at, updated_at, application_submitted_screenshot_url, error_message')
    .ilike('applywizz_id', cleanAwlId);

  if (jdErr) throw jdErr;

  // 2. Fetch submission tasks for this client
  const { data: subTasks, error: stErr } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, job_url, company, role_title, status, created_at, started_at, completed_at, updated_at, application_submitted_screenshot_url, screenshot_path, error_message')
    .ilike('applywizz_id', cleanAwlId);

  if (stErr) throw stErr;

  const taskMap = new Map();
  for (const st of subTasks || []) {
    if (st.distribution_id) {
      taskMap.set(st.distribution_id, st);
    }
  }

  // 3. Client Name lookup
  const { data: clientRow } = await supabase
    .from('clients')
    .select('client_name, first_name, last_name')
    .ilike('applywizz_id', cleanAwlId)
    .maybeSingle();

  const clientName = clientRow?.client_name ||
    [clientRow?.first_name, clientRow?.last_name].filter(Boolean).join(' ') ||
    cleanAwlId;

  // Filter applications that reached ready_for_review, needs_answers, or later
  const ELIGIBLE_STATUSES = new Set(['ready_for_review', 'needs_answers', 'queued', 'applying', 'running', 'submitted', 'completed', 'failed']);

  const applications = [];
  for (const jd of jobDists || []) {
    const task = taskMap.get(jd.id);
    const effectiveStatus = String((task ? task.status : jd.status) || 'unknown').toLowerCase().trim();

    if (!ELIGIBLE_STATUSES.has(effectiveStatus)) {
      continue;
    }

    const screenshotUrl = task?.application_submitted_screenshot_url ||
      task?.screenshot_path ||
      jd.application_submitted_screenshot_url ||
      null;

    applications.push({
      id: task?.id || jd.id,
      distribution_id: jd.id,
      applywizz_id: cleanAwlId,
      job_url: task?.job_url || jd.job_url,
      company: task?.company || jd.company,
      role_title: task?.role_title || jd.role_title,
      status: effectiveStatus,
      screenshot_url: screenshotUrl,
      error_message: task?.error_message || jd.error_message || null,
      updated_at: task?.completed_at || task?.updated_at || jd.updated_at || jd.created_at,
      created_at: jd.created_at,
    });
  }

  // Sort newest updated first
  applications.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

  return {
    success: true,
    applywizz_id: cleanAwlId,
    client_name: clientName,
    count: applications.length,
    applications,
  };
}

/**
 * HTTP Handler for Unified Stats Request: GET /api/stats
 */
export async function handleUnifiedStatsRequest(req, res, searchParams = new URLSearchParams()) {
  const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
  if (!authUser) return;

  try {
    const forceRefresh = searchParams.get('refresh') === 'true';
    const stats = await getUnifiedDashboardStats({ forceRefresh });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  } catch (err) {
    console.error('[STATS ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * HTTP Handler for Client Applications Request: GET /api/clients/:awlId/applications
 */
export async function handleClientApplicationsRequest(req, res, awlId) {
  const authUser = authenticateStaffRole(req, res, ['admin', 'developer', 'dev']);
  if (!authUser) return;

  try {
    const result = await getClientApplications({ awlId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[CLIENT APPS ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}
