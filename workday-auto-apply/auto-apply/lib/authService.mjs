/**
 * authService.mjs — Backend Presence & Authentication Service
 * ============================================================
 * Handles presence tracking, JWT issuance and verification,
 * rate-limited heartbeats (<= 1 write / 30s / user), and dynamic
 * online status computation (active if last_seen_at <= 2 minutes).
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'applywizz-presence-jwt-secret-2026';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const lastHeartbeatWriteMap = new Map();

export function signJwt(payload, expiresInSec = 86400 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${b64Header}.${b64Payload}`).digest('base64url');
  return `${b64Header}.${b64Payload}.${signature}`;
}

export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [b64Header, b64Payload, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${b64Header}.${b64Payload}`).digest('base64url');
  if (signature !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function updateLastSeenAt(email, timestampOrNull) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return false;
  try {
    const { error } = await supabase
      .from('auth_users')
      .update({ last_seen_at: timestampOrNull })
      .ilike('email', cleanEmail);
    if (error) {
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

export function computePresence(lastSeenAt) {
  if (!lastSeenAt) return { presence: 'inactive', is_online: false };
  const lastTime = new Date(lastSeenAt).getTime();
  if (!lastTime || isNaN(lastTime)) return { presence: 'inactive', is_online: false };
  const diffMs = Date.now() - lastTime;
  const isOnline = diffMs >= 0 && diffMs <= 2 * 60 * 1000;
  return {
    presence: isOnline ? 'active' : 'inactive',
    is_online: isOnline,
  };
}

export async function handleAuthRequest(req, res, pathname, body = {}) {
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Valid email required' }));
    }

    const nowIso = new Date().toISOString();

    let { data: authUser } = await supabase
      .from('auth_users')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

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
          status: 'active',
          last_sign_in: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select('*')
        .maybeSingle();

      authUser = newAU || { email, name, role };
    }

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

  if (pathname === '/api/auth/setup/confirm' && req.method === 'POST') {
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

  if (pathname === '/api/auth/heartbeat' && req.method === 'POST') {
    const token = extractBearerToken(req) || body.token;
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: JWT required' }));
    }

    const decoded = verifyJwt(token);
    if (!decoded || !decoded.email) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or expired JWT' }));
    }

    const userEmail = decoded.email.toLowerCase().trim();
    const lastWrite = lastHeartbeatWriteMap.get(userEmail) || 0;
    const now = Date.now();

    if (now - lastWrite < 30_000) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        rateLimited: true,
        message: 'Heartbeat acknowledged (cached, DB write throttled to 30s)',
        email: userEmail,
      }));
    }

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

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = extractBearerToken(req) || body.token;
    let userEmail = body.email ? String(body.email).trim().toLowerCase() : null;

    if (token) {
      const decoded = verifyJwt(token);
      if (decoded?.email) userEmail = decoded.email.toLowerCase().trim();
    }

    if (userEmail) {
      await updateLastSeenAt(userEmail, null);
      lastHeartbeatWriteMap.delete(userEmail);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      message: 'Logged out successfully, presence cleared',
    }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
}

export async function handleOperatorsRequest(req, res, queryParams = {}) {
  try {
    const managerId = queryParams.get('manager_id') || queryParams.get('managerId') || '';
    const statusFilter = queryParams.get('status') || '';

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

    const enriched = (opsRes.data || []).map((op) => {
      const em = (op.email || '').toLowerCase().trim();
      const authUser = authMap.get(em);
      const lastSeenAt = authUser?.last_seen_at || null;

      const { presence, is_online } = computePresence(lastSeenAt);

      return {
        ...op,
        last_seen_at: lastSeenAt,
        presence,
        is_online,
        account_status: authUser?.status || op.status,
        status: presence,
      };
    });

    let finalOps = enriched;
    if (statusFilter && statusFilter !== 'All') {
      const s = statusFilter.toLowerCase();
      finalOps = enriched.filter((o) => o.presence === s);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      count: finalOps.length,
      operators: finalOps,
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('[PRESENCE API] Error reading operators:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message, operators: [] }));
  }
}
