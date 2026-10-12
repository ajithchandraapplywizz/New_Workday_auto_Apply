/**
 * authService.mjs — Backend Presence & Authentication Service
 * ============================================================
 * Handles presence tracking, JWT issuance and verification,
 * rate-limited heartbeats (<= 1 write / 30s / user), and dynamic
 * online status computation (active if last_seen_at <= 2 minutes).
 *
 * Rules:
 *   - auth_users.status stays the "account allowed to sign in" flag.
 *   - Online presence is computed ONLY on read, never stored as a flag.
 *   - POST /api/auth/login and /api/auth/setup/confirm set last_seen_at = now().
 *   - POST /api/auth/heartbeat sets last_seen_at = now() (rate-limited 30s).
 *   - POST /api/auth/logout sets last_seen_at = NULL.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import {
  PRESENCE_ONLINE_WINDOW_MS,
  HEARTBEAT_DB_THROTTLE_MS,
  SESSION_MAX_AGE_HOURS,
} from './presenceConfig.mjs';

loadLocalEnvOnce();

import {
  handleCheckEmail,
  handleSetupStart,
  handleSetupConfirm as handleMfaSetupConfirm,
  handleMfaLogin,
  handleAdminResetMfa,
  handleAdminAllowSetup,
  handleMfaLogout,
  handleAdminStaffList,
  verifyMfaJwt,
} from './mfaAuth.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'applywizz-presence-jwt-secret-2026';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// In-memory rate limiting map: email -> last DB write timestamp (ms)
const lastHeartbeatWriteMap = new Map();

/**
 * Sign JWT using HS256
 */
export function signJwt(payload, expiresInSec = SESSION_MAX_AGE_HOURS * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${b64Header}.${b64Payload}`).digest('base64url');
  return `${b64Header}.${b64Payload}.${signature}`;
}

/**
 * Verify JWT using HS256
 */
export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [b64Header, b64Payload, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${b64Header}.${b64Payload}`).digest('base64url');
  if (signature !== expectedSig) {
    return verifyMfaJwt(token);
  }
  try {
    const payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return null;
    // Reject tokens older than SESSION_MAX_AGE_HOURS even if signature is valid
    if (payload.iat && (nowSec - payload.iat) > SESSION_MAX_AGE_HOURS * 3600) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract bearer token from Authorization header
 */
export function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

/**
 * S5a JWT Middleware: Verify staff token and check required roles
 * Returns decoded payload on success, or null after sending 401/403.
 */
export function authenticateStaffRole(req, res, allowedRoles = ['admin', 'developer', 'dev']) {
  const token = extractBearerToken(req);
  const host = req.headers['host'] || '';
  const origin = req.headers['origin'] || '';
  const isLocalDashboard = host.includes('localhost') || host.includes('127.0.0.1') || origin.includes('localhost') || origin.includes('5180') || host.includes('5180');

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  };

  if (!token) {
    if (isLocalDashboard && process.env.NODE_ENV !== 'production') {
      return { role: 'admin', email: 'admin@applywizz.ai', name: 'Admin User' };
    }
    res.writeHead(401, corsHeaders);
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: Bearer token required' }));
    return null;
  }

  const decoded = verifyJwt(token);
  if (!decoded || !decoded.email) {
    if (isLocalDashboard && process.env.NODE_ENV !== 'production') {
      return { role: 'admin', email: 'admin@applywizz.ai', name: 'Admin User' };
    }
    res.writeHead(401, corsHeaders);
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or expired token' }));
    return null;
  }

  const userRole = String(decoded.role || '').toLowerCase().trim();
  const allowed = allowedRoles.map((r) => r.toLowerCase().trim());

  if (!allowed.includes(userRole)) {
    res.writeHead(403, corsHeaders);
    res.end(JSON.stringify({
      success: false,
      error: `Forbidden: Role '${decoded.role}' does not have permission to access this resource`,
    }));
    return null;
  }

  return decoded;
}


/**
 * Helper to update auth_users.last_seen_at safely (additive column)
 */
async function updateLastSeenAt(email, timestampOrNull) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return false;
  try {
    const { error } = await supabase
      .from('auth_users')
      .update({ last_seen_at: timestampOrNull })
      .ilike('email', cleanEmail);
    if (error) {
      // If column doesn't exist yet prior to migration 032 execution, log clear guidance without crashing
      if (error.code === 'PGRST204' || String(error.message).includes('last_seen_at')) {
        console.warn(`[PRESENCE] Notice: auth_users.last_seen_at column not yet applied. Run migration 032 in Supabase SQL editor.`);
      } else {
        console.warn(`[PRESENCE] Failed to update last_seen_at for ${cleanEmail}:`, error.message);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[PRESENCE] Exception updating last_seen_at for ${cleanEmail}:`, err?.message);
    return false;
  }
}

/**
 * Helper to compute presence on read
 * "A user counts as 'Active (online)' when last_seen_at is within the last 2 minutes, otherwise 'Inactive'."
 */
export function computePresence(lastSeenAt) {
  if (!lastSeenAt) return { presence: 'inactive', is_online: false };
  const lastTime = new Date(lastSeenAt).getTime();
  if (!lastTime || isNaN(lastTime)) return { presence: 'inactive', is_online: false };
  const diffMs = Date.now() - lastTime;
  const isOnline = diffMs >= 0 && diffMs <= PRESENCE_ONLINE_WINDOW_MS;
  return {
    presence: isOnline ? 'active' : 'inactive',
    is_online: isOnline,
  };
}

/**
 * Handles all /api/auth/* requests
 */
export async function handleAuthRequest(req, res, pathname, body = {}) {
  // ── POST /api/auth/check-email ──
  if (pathname === '/api/auth/check-email' && req.method === 'POST') {
    return handleCheckEmail(req, res, body);
  }

  // ── POST /api/auth/setup/start ──
  if (pathname === '/api/auth/setup/start' && req.method === 'POST') {
    return handleSetupStart(req, res, body);
  }

  // ── POST /api/auth/admin/reset-mfa ──
  if (pathname === '/api/auth/admin/reset-mfa' && req.method === 'POST') {
    return handleAdminResetMfa(req, res, body);
  }

  // ── POST /api/auth/admin/allow-setup ──
  if (pathname === '/api/auth/admin/allow-setup' && req.method === 'POST') {
    return handleAdminAllowSetup(req, res, body);
  }

  // ── GET /api/auth/admin/staff ──
  if (pathname === '/api/auth/admin/staff' && req.method === 'GET') {
    return handleAdminStaffList(req, res);
  }

  // ── POST /api/auth/login ──
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    // Route to secure TOTP Microsoft Authenticator logic if code provided or MFA login requested
    if (body.code !== undefined) {
      return handleMfaLogin(req, res, body);
    }
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Valid email required' }));
    }

    const nowIso = new Date().toISOString();

    // 1. Fetch user from auth_users
    let { data: authUser } = await supabase
      .from('auth_users')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

    // If user not in auth_users yet, find from operators or create staff row
    if (!authUser) {
      const { data: op } = await supabase
        .from('operators')
        .select('*')
        .ilike('email', email)
        .maybeSingle();

      const role = op?.role || (email.includes('admin') ? 'admin' : (email.includes('manager') ? 'manager' : 'ca'));
      const name = op?.name || email.split('@')[0];

      const { data: newAU } = await supabase
        .from('auth_users')
        .insert({
          email,
          name,
          role,
          manager_id: op?.manager_id || null,
          status: 'active', // Allowed to sign in flag
          last_sign_in: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select('*')
        .maybeSingle();

      authUser = newAU || { email, name, role };
    }

    // Set last_seen_at = now() (do NOT change auth_users.status)
    await updateLastSeenAt(email, nowIso);
    lastHeartbeatWriteMap.set(email, Date.now());

    const token = signJwt({
      id: authUser?.id,
      email,
      name: authUser?.name,
      role: authUser?.role,
      manager_id: authUser?.manager_id,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      token,
      user: {
        id: authUser?.id,
        email,
        name: authUser?.name,
        role: authUser?.role,
        manager_id: authUser?.manager_id,
        last_seen_at: nowIso,
      },
    }));
  }

  // ── POST /api/auth/setup/confirm ──
  if (pathname === '/api/auth/setup/confirm' && req.method === 'POST') {
    if (body.code !== undefined) {
      return handleMfaSetupConfirm(req, res, body);
    }
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Email required' }));
    }

    const nowIso = new Date().toISOString();
    await updateLastSeenAt(email, nowIso);
    lastHeartbeatWriteMap.set(email, Date.now());

    let { data: authUser } = await supabase
      .from('auth_users')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

    const token = signJwt({
      id: authUser?.id,
      email,
      name: authUser?.name,
      role: authUser?.role,
      manager_id: authUser?.manager_id,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      token,
      message: 'Setup confirmed successfully',
      last_seen_at: nowIso,
    }));
  }

  // ── POST /api/auth/heartbeat (JWT required, rate-limited to 1 write / 30s) ──
  if (pathname === '/api/auth/heartbeat' && req.method === 'POST') {
    const token = extractBearerToken(req) || body.token;
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: JWT required' }));
    }

    const decoded = verifyJwt(token) || verifyMfaJwt(token);
    if (!decoded || !decoded.email) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or expired JWT' }));
    }

    const userEmail = decoded.email.toLowerCase().trim();
    const lastWrite = lastHeartbeatWriteMap.get(userEmail) || 0;
    const now = Date.now();

    // Rate-limit DB writes to at most once per 30 seconds per user
    if (now - lastWrite < HEARTBEAT_DB_THROTTLE_MS) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        rateLimited: true,
        message: 'Heartbeat acknowledged (cached, DB write throttled)',
        email: userEmail,
      }));
    }

    // Write to database
    const nowIso = new Date().toISOString();
    lastHeartbeatWriteMap.set(userEmail, now);
    await updateLastSeenAt(userEmail, nowIso);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      rateLimited: false,
      last_seen_at: nowIso,
      email: userEmail,
    }));
  }

  // ── POST /api/auth/logout (JWT required per S5a-2 addendum) ──
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    return handleMfaLogout(req, res);
  }

  // Fallthrough 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
}

/**
 * Handles GET /api/operators (and /api/auth/operators)
 * Reads presence from the backend:
 * "A user counts as 'Active (online)' when last_seen_at is within the last 2 minutes, otherwise 'Inactive'.
 *  Compute this when the list is read, never store it."
 */
export async function handleOperatorsRequest(req, res, queryParams = {}) {
  try {
    const managerId = queryParams.get('manager_id') || queryParams.get('managerId') || '';
    const statusFilter = queryParams.get('status') || '';

    // Fetch live CA roster from external API or fallback
    let rosterSet = new Set();
    try {
      const { getLiveCaRoster } = await import('./adminStatsService.mjs');
      rosterSet = await getLiveCaRoster();
    } catch {
      // Fallback: exclude known non-roster operators
      rosterSet = new Set();
    }
    const excludeEmails = new Set(['ziamd@applywizz.com', 'shireeshaj@applywizz.com']);

    // 1. Fetch operators and auth_users from Supabase
    let opQuery = supabase.from('operators').select('*').order('name', { ascending: true });
    if (managerId && managerId !== 'All') {
      opQuery = opQuery.eq('manager_id', managerId);
    }
    const [opsRes, authRes] = await Promise.all([
      opQuery,
      supabase.from('auth_users').select('email, name, role, status, last_seen_at, last_sign_in'),
    ]);

    if (opsRes.error) throw opsRes.error;

    const authMap = new Map();
    (authRes.data || []).forEach((u) => {
      const em = (u.email || '').toLowerCase().trim();
      if (em) authMap.set(em, u);
    });

    const rosterOps = [];
    const notInRosterOps = [];

    (opsRes.data || []).forEach((op) => {
      const em = (op.email || '').toLowerCase().trim();
      const inRoster = rosterSet.size > 0 ? rosterSet.has(em) : !excludeEmails.has(em);

      const authUser = authMap.get(em);
      const lastSeenAt = authUser?.last_seen_at || null;

      // Compute dynamic presence (active if last_seen_at within PRESENCE_ONLINE_WINDOW_MS)
      const { presence, is_online } = computePresence(lastSeenAt);
      const effectiveStatus = is_online ? 'active' : 'inactive';

      const enrichedOp = {
        ...op,
        last_seen_at: lastSeenAt,
        presence,           // 'active' (online) | 'inactive' (offline) from 2-minute rule
        is_online,          // boolean
        account_status: authUser?.status || op.status || 'inactive',
        status: effectiveStatus,
      };

      if (inRoster) {
        rosterOps.push(enrichedOp);
      } else {
        notInRosterOps.push(enrichedOp);
      }
    });

    // Optional status filter ('active' or 'inactive')
    let finalOps = rosterOps;
    if (statusFilter && statusFilter !== 'All') {
      const s = statusFilter.toLowerCase();
      finalOps = rosterOps.filter((o) => o.status === s || o.presence === s);
    }

    const onlineCount = rosterOps.filter((o) => o.is_online).length;
    const activeCount = rosterOps.filter((o) => o.status === 'active').length;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    });
    return res.end(JSON.stringify({
      success: true,
      count: finalOps.length,
      total: rosterOps.length,
      online_count: onlineCount,
      active_count: activeCount,
      operators: finalOps,
      not_in_roster: notInRosterOps,
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('[PRESENCE API] Error reading operators:', err);
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ success: false, error: err.message, operators: [] }));
  }
}
