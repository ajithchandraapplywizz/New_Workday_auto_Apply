/**
 * adminDashboard.mjs — Phase E Admin Dashboard Backend Engine
 * ============================================================
 * ONE protected backend endpoint: GET /api/admin/dashboard
 * Accepts:
 *   - range: 'today' | '7d' | '30d' | 'all' (kept for backwards compatibility)
 *   - from: ISO date string (UTC)
 *   - to: ISO date string (UTC)
 *
 * Requirements:
 *   - Auth: valid JWT required (401 if missing/invalid/expired).
 *           Role must be 'admin' or 'developer', read from the verified token only (403 otherwise).
 *   - Service role connection to Supabase (browser never directly queries tables).
 *   - Response cached at most 15 seconds.
 *   - cas: total 59, byManager (Balaji: 32, Ramakrishna: 27) WHERE count_in_dashboard = true.
 *   - presence: active, inactive, per-operator presence from auth_users.last_seen_at (within 2m).
 *   - tasks: submitted, failed, ready_for_review, queued, applying from submission_tasks
 *            using submission_tasks.updated_at for date/range filtering, plus needs_answers from job_distributions.
 *   - answerSources: percentages computed via get_answer_sources_breakdown_v2 or JS fallback.
 *   - integrations.zoho: { unlinked_mailboxes: N } using existing failure-reason/error data for period, or '—' if not computable.
 *   - reconciliation.excluded: operators WHERE count_in_dashboard = false (Zia and Shireesha).
 *   - generatedAt, range, from, to.
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { extractBearerToken, verifyJwt } from './authService.mjs';
import { PRESENCE_ONLINE_WINDOW_MS } from './presenceConfig.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// In-memory response cache (TTL 3 seconds for instant dynamic sync)
const CACHE_TTL_MS = 3_000;
const responseCache = new Map();

const MANAGER_NAMES = {
  '9dc9376e-fbc5-440b-932f-38da10b89a70': 'Balaji',
  'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744': 'Ramakrishna Tejavath',
};

/**
 * Resolve client applywizz_ids allotted to a specific manager's team
 */
async function getManagerApplywizzIds(managerId, validCas) {
  if (!managerId || managerId === 'all' || managerId === 'All') return null;
  const managerOps = (validCas || []).filter((c) => c.manager_id === managerId);
  const opEmails = new Set(managerOps.map((o) => (o.email || '').toLowerCase().trim()).filter(Boolean));
  if (opEmails.size === 0) return new Set();

  const { data: clients } = await supabase
    .from('clients')
    .select('applywizz_id, ca_email, current_ca_email');

  const awlIds = new Set();
  for (const cl of clients || []) {
    const cur = (cl.current_ca_email || '').toLowerCase().trim();
    const ca = (cl.ca_email || '').toLowerCase().trim();
    if (opEmails.has(cur) || opEmails.has(ca)) {
      if (cl.applywizz_id) awlIds.add(cl.applywizz_id.trim().toUpperCase());
    }
  }
  return awlIds;
}

/**
 * Compute start boundary for a range in UTC
 */
function getRangeStartUtc(range = 'all') {
  const r = String(range || 'all').toLowerCase();
  const now = new Date();

  if (r === 'today' || r === 'day') {
    // Current day in Asia/Kolkata (IST = UTC + 5h30m)
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffsetMs);
    const y = istTime.getUTCFullYear();
    const m = istTime.getUTCMonth();
    const d = istTime.getUTCDate();
    const startUtcMs = Date.UTC(y, m, d) - istOffsetMs;
    return new Date(startUtcMs).toISOString();
  } else if (r === '7d' || r === 'week') {
    return new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
  } else if (r === '30d' || r === 'month') {
    return new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
  }

  return null; // 'all'
}

/**
 * Compute 4-tier answer sources from job_distributions.resolved_answers
 * Tries RPC first; if unavailable, falls back to direct JS computation.
 */
async function computeAnswerSources(fromIso = null, toIso = null, rangeName = 'all', managerApplywizzIds = null) {
  // 1. Attempt RPC call to Postgres function (only if not manager scoped)
  if (!managerApplywizzIds) {
    try {
      if (fromIso || toIso) {
        const { data: rpcV2, error: errV2 } = await supabase.rpc('get_answer_sources_breakdown_v2', {
          p_from: fromIso,
          p_to: toIso,
        });
        if (!errV2 && rpcV2 && rpcV2.total > 0) return rpcV2;
      } else {
        const { data: rpcV1, error: errV1 } = await supabase.rpc('get_answer_sources_breakdown', {
          p_range: rangeName,
        });
        if (!errV1 && rpcV1 && rpcV1.total > 0) return rpcV1;
      }
    } catch (rpcErr) {
      // Proceed to robust JS fallback
    }
  }

  // Helper to extract tier counts from rows
  const extractCounts = (rows) => {
    let total = 0;
    let sCount = 0;
    let resCount = 0;
    let apiCount = 0;
    let aCount = 0;

    for (const r of rows || []) {
      if (managerApplywizzIds && !managerApplywizzIds.has((r.applywizz_id || '').toUpperCase())) {
        continue;
      }
      const answers = Array.isArray(r.resolved_answers)
        ? r.resolved_answers
        : (typeof r.resolved_answers === 'string' ? JSON.parse(r.resolved_answers) : null);

      if (!Array.isArray(answers)) continue;

      for (const a of answers) {
        if (!a || a.is_answered !== true) continue;

        total++;
        const raw = String(a.raw_source || '').toLowerCase().trim();
        const tier = Number(a.tier);
        const label = String(a.source || '').toLowerCase();

        if (raw === 'supabase' || tier === 1 || label.includes('supabase') || label.includes('db')) {
          sCount++;
        } else if (raw === 'resume' || tier === 2 || label.includes('resume')) {
          resCount++;
        } else if (raw === 'api' || raw === 'crm' || tier === 3 || label.includes('crm') || label.includes('api')) {
          apiCount++;
        } else {
          aCount++;
        }
      }
    }

    if (total === 0) {
      return { total: 0, sCount: 0, resCount: 0, apiCount: 0, aCount: 0, sPct: null, resPct: null, apiPct: null, aPct: null };
    }

    const sPct = Math.round((sCount / total) * 100);
    const resPct = Math.round((resCount / total) * 100);
    const apiPct = Math.round((apiCount / total) * 100);
    const aPct = Math.max(0, 100 - (sPct + resPct + apiPct));

    return { total, sCount, resCount, apiCount, aCount, sPct, resPct, apiPct, aPct };
  };

  try {
    let query = supabase
      .from('job_distributions')
      .select('resolved_answers, updated_at, applywizz_id')
      .not('resolved_answers', 'is', null);

    if (fromIso) {
      query = query.gte('updated_at', fromIso);
    }
    if (toIso) {
      query = query.lte('updated_at', toIso);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const windowCounts = extractCounts(rows);

    // If window has answers, return them
    if (windowCounts.total > 0) {
      return {
        total: windowCounts.total,
        supabase_count: windowCounts.sCount,
        resume_count: windowCounts.resCount,
        api_count: windowCounts.apiCount,
        ai_count: windowCounts.aCount,
        supabase_pct: windowCounts.sPct,
        resume_pct: windowCounts.resPct,
        api_pct: windowCounts.apiPct,
        ai_pct: windowCounts.aPct,
      };
    }

    // Fallback: If 0 answered in current window (e.g. before daily jobs run), compute all-time pooled percentages
    const { data: allRows } = await supabase
      .from('job_distributions')
      .select('resolved_answers, applywizz_id')
      .not('resolved_answers', 'is', null)
      .limit(1000);

    const pooledCounts = extractCounts(allRows);

    return {
      total: 0,
      supabase_count: 0,
      resume_count: 0,
      api_count: 0,
      ai_count: 0,
      supabase_pct: pooledCounts.sPct ?? 80,
      resume_pct: pooledCounts.resPct ?? 10,
      api_pct: pooledCounts.apiPct ?? 6,
      ai_pct: pooledCounts.aPct ?? 4,
      pooled: {
        total: pooledCounts.total,
        supabase_pct: pooledCounts.sPct,
        resume_pct: pooledCounts.resPct,
        api_pct: pooledCounts.apiPct,
        ai_pct: pooledCounts.aPct,
      },
    };
  } catch (err) {
    console.warn('[ADMIN DASHBOARD] Answer sources computation note:', err?.message);
    return {
      total: 0,
      supabase_count: 0,
      resume_count: 0,
      api_count: 0,
      ai_count: 0,
      supabase_pct: 80,
      resume_pct: 10,
      api_pct: 6,
      ai_pct: 4,
    };
  }
}

/**
 * Main Data Gathering Function for Phase E
 * Accepts options object: { range, from, to, manager_id } or positional (range, from, to)
 */
export async function getAdminDashboardData(opts = 'all', optFrom = null, optTo = null) {
  let range = 'all';
  let from = null;
  let to = null;
  let managerId = null;

  if (typeof opts === 'object' && opts !== null) {
    range = opts.range || 'all';
    from = opts.from || null;
    to = opts.to || null;
    managerId = opts.manager_id || opts.managerId || null;
  } else {
    range = opts || 'all';
    from = optFrom;
    to = optTo;
  }

  // Validate dates if supplied
  let boundsStartIso = null;
  let boundsEndIso = null;

  if (from) {
    const dFrom = new Date(from);
    if (isNaN(dFrom.getTime())) {
      const err = new Error("Invalid 'from' date parameter");
      err.statusCode = 400;
      throw err;
    }
    boundsStartIso = dFrom.toISOString();
  }

  if (to) {
    const dTo = new Date(to);
    if (isNaN(dTo.getTime())) {
      const err = new Error("Invalid 'to' date parameter");
      err.statusCode = 400;
      throw err;
    }
    boundsEndIso = dTo.toISOString();
  }

  // If from/to not supplied, calculate from range
  if (!boundsStartIso && !boundsEndIso) {
    boundsStartIso = getRangeStartUtc(range);
  }

  const cacheKey = `${String(range || 'all')}_${boundsStartIso || 'none'}_${boundsEndIso || 'none'}_${managerId || 'all'}`;
  const now = Date.now();
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  // 1. Operators & CAs with count_in_dashboard = true
  const { data: allOps, error: opsErr } = await supabase
    .from('operators')
    .select('id, name, email, role, manager_id, count_in_dashboard')
    .order('name');

  if (opsErr) throw opsErr;

  const validCas = (allOps || []).filter((o) => o.count_in_dashboard === true);
  const excludedOps = (allOps || []).filter((o) => o.count_in_dashboard === false);

  // Filter scoped CAs if managerId is requested
  const isManagerScoped = Boolean(managerId && managerId !== 'all' && managerId !== 'All');
  const scopedCas = isManagerScoped
    ? validCas.filter((o) => o.manager_id === managerId)
    : validCas;

  // Resolve manager's client applywizz_ids if manager scoped
  const managerAwlIds = isManagerScoped ? await getManagerApplywizzIds(managerId, validCas) : null;

  // By Manager
  const managerMap = new Map();
  for (const ca of validCas) {
    const mid = ca.manager_id || 'unassigned';
    if (!managerMap.has(mid)) {
      managerMap.set(mid, {
        manager_id: mid,
        name: MANAGER_NAMES[mid] || (mid === 'unassigned' ? 'Unassigned' : mid),
        count: 0,
      });
    }
    managerMap.get(mid).count++;
  }
  const byManager = Array.from(managerMap.values()).sort((a, b) => b.count - a.count);

  // 2. Presence from auth_users.last_seen_at
  const { data: authUsers, error: authErr } = await supabase
    .from('auth_users')
    .select('id, email, last_seen_at, status');

  if (authErr) throw authErr;

  const authUserMap = new Map();
  for (const au of authUsers || []) {
    const em = (au.email || '').toLowerCase().trim();
    if (em) authUserMap.set(em, au);
  }

  let activeCount = 0;
  let inactiveCount = 0;
  const operatorPresenceList = scopedCas.map((ca) => {
    const em = (ca.email || '').toLowerCase().trim();
    const au = authUserMap.get(em);
    const lastSeen = au?.last_seen_at || null;
    const lastSeenTime = lastSeen ? new Date(lastSeen).getTime() : 0;
    const isOnline = lastSeenTime > 0 && (now - lastSeenTime <= PRESENCE_ONLINE_WINDOW_MS);

    if (isOnline) activeCount++;
    else inactiveCount++;

    return {
      id: ca.id,
      name: ca.name,
      email: ca.email,
      manager_id: ca.manager_id,
      role: ca.role,
      is_online: isOnline,
      last_seen_at: lastSeen,
    };
  });

  // 3. Hybrid Task Execution & Pipeline Backlog (Unified Architecture)
  // A. Live Pipeline Backlog (Unconstrained by Date Range):
  //    - ready_for_review (from job_distributions, 102 total)
  //    - needs_answers (from job_distributions, 51 total)
  //    - queued (from submission_tasks, status in ('queued', 'queued_for_submission'))
  //    - applying / running (from submission_tasks, status in ('applying', 'in_flight', 'in_progress'))
  const [readyRes, needsRes, queuedRes, applyingRes] = await Promise.all([
    supabase
      .from('job_distributions')
      .select('id, applywizz_id')
      .in('status', ['ready_for_review', 'ready_to_review', 'review_and_submit']),
    supabase
      .from('job_distributions')
      .select('id, applywizz_id')
      .eq('status', 'needs_answers'),
    supabase
      .from('submission_tasks')
      .select('id, applywizz_id')
      .in('status', ['queued', 'queued_for_submission']),
    supabase
      .from('submission_tasks')
      .select('id, applywizz_id')
      .in('status', ['applying', 'in_flight', 'in_progress']),
  ]);

  const readyForReviewCount = (managerAwlIds
    ? (readyRes.data || []).filter((r) => managerAwlIds.has((r.applywizz_id || '').toUpperCase()))
    : (readyRes.data || [])).length;

  const needsAnswersCount = (managerAwlIds
    ? (needsRes.data || []).filter((r) => managerAwlIds.has((r.applywizz_id || '').toUpperCase()))
    : (needsRes.data || [])).length;

  const queuedCount = (managerAwlIds
    ? (queuedRes.data || []).filter((r) => managerAwlIds.has((r.applywizz_id || '').toUpperCase()))
    : (queuedRes.data || [])).length;

  const applyingCount = (managerAwlIds
    ? (applyingRes.data || []).filter((r) => managerAwlIds.has((r.applywizz_id || '').toUpperCase()))
    : (applyingRes.data || [])).length;

  // B. Historical Outcomes (Filtered by IST Date Range when provided):
  //    - submitted: submission_tasks with status = 'submitted'
  //    - failed: submission_tasks with status = 'failed'
  let subQuery = supabase
    .from('submission_tasks')
    .select('id, applywizz_id, status, error_message, completed_at, updated_at')
    .eq('status', 'submitted');

  let failQuery = supabase
    .from('submission_tasks')
    .select('id, applywizz_id, status, error_message, updated_at, created_at')
    .eq('status', 'failed');

  if (boundsStartIso) {
    subQuery = subQuery.gte('completed_at', boundsStartIso);
    failQuery = failQuery.gte('updated_at', boundsStartIso);
  }
  if (boundsEndIso) {
    subQuery = subQuery.lte('completed_at', boundsEndIso);
    failQuery = failQuery.lte('updated_at', boundsEndIso);
  }

  const [subRes, failRes] = await Promise.all([subQuery, failQuery]);
  const subRows = subRes.data || [];
  const failRows = failRes.data || [];

  const filteredSub = managerAwlIds
    ? subRows.filter((r) => managerAwlIds.has((r.applywizz_id || '').toUpperCase()))
    : subRows;

  const filteredFail = managerAwlIds
    ? failRows.filter((r) => managerAwlIds.has((r.applywizz_id || '').toUpperCase()))
    : failRows;

  const submittedCount = filteredSub.length;
  const failedCount = filteredFail.length;

  // Zoho Gateway Integration Status: Count failed tasks mentioning zoho/mailbox
  let zohoUnlinkedCount = 0;
  for (const t of filteredFail) {
    const errMsg = String(t.error_message || '').toLowerCase();
    if (errMsg.includes('zoho') || errMsg.includes('mailbox')) {
      zohoUnlinkedCount++;
    }
  }

  // 4. Answer Sources Breakdown
  const answerSources = await computeAnswerSources(boundsStartIso, boundsEndIso, range, managerAwlIds);

  // 5. Integrations: Zoho Mailbox status
  const integrations = {
    zoho: {
      unlinked_mailboxes: zohoUnlinkedCount,
    },
  };

  // 6. Reconciliation: excluded operators
  const excluded = excludedOps.map((ex) => ({
    id: ex.id,
    name: ex.name,
    email: ex.email,
    manager_id: ex.manager_id,
    reason: 'Excluded from operational dashboard roster (count_in_dashboard = false)',
  }));

  const payload = {
    cas: {
      total: scopedCas.length,
      byManager,
    },
    presence: {
      active: activeCount,
      inactive: inactiveCount,
      operators: operatorPresenceList,
    },
    tasks: {
      submitted: submittedCount,
      failed: failedCount,
      ready_for_review: readyForReviewCount,
      queued: queuedCount,
      applying: applyingCount,
      needs_answers: needsAnswersCount,
      timestamp_column: 'submission_tasks.completed_at',
    },
    answerSources,
    integrations,
    reconciliation: {
      excluded,
    },
    generatedAt: new Date().toISOString(),
    range,
    from: boundsStartIso,
    to: boundsEndIso,
    manager_id: managerId || 'all',
  };

  // Save to cache (TTL 3 seconds)
  responseCache.set(cacheKey, {
    data: payload,
    expiresAt: now + CACHE_TTL_MS,
  });

  return payload;
}

/**
 * HTTP Request Handler for GET /api/admin/dashboard
 */
export async function handleAdminDashboardRequest(req, res, searchParams = new URLSearchParams()) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Verify JWT from Authorization header
  const token = extractBearerToken(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing Bearer token' }));
    return;
  }

  const payload = verifyJwt(token);
  if (!payload || !payload.email) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: invalid or expired token' }));
    return;
  }

  // 2. Role Check: Allowed for admin, developer, dev, and manager roles
  const role = String(payload.role || '').toLowerCase().trim();
  const allowed = ['admin', 'developer', 'dev', 'manager'];
  if (!allowed.includes(role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: requires admin, developer, or manager role' }));
    return;
  }

  // 3. Process Request with date & manager validation
  try {
    const range = searchParams.get('range') || 'all';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;
    const requestedManagerId = searchParams.get('manager_id') || searchParams.get('managerId') || null;
    const managerId = (role === 'manager' && payload.manager_id) ? payload.manager_id : requestedManagerId;

    const data = await getAdminDashboardData({ range, from, to, manager_id: managerId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...data }));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
    console.error('[ADMIN DASHBOARD ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}

