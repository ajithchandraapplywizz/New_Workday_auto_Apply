import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchCAEmails,
  fetchOperators,
  fetchManagers,
  reconcileOperatorsWithAPI,
  fetchDynamicKPIMetrics,
  fetchApplicationsDynamic,
  syncGlobalCompanyData,
  fetchStaffAccessList,
  authAdminAllowSetup,
  authAdminResetMfa,
  fetchAdminDashboardStats,
  getISTDateBounds,
  supabase,
} from '../services/api';
import CAClientDetailsModal from '../components/CAClientDetailsModal';
import OperatorDetailsPage from './OperatorDetailsPage';
import ApplicationSlideDrawer from '../components/ApplicationSlideDrawer';
import StaffAccess from '../components/StaffAccess';

export default function AdminDashboard() {
  const { date, timeframe } = useAuth();

  const [activeTab, setActiveTab] = useState('Overview');
  const [operatorSearch, setOperatorSearch] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('All'); // 'All' | 'active' | 'inactive'
  const [managerFilter, setManagerFilter] = useState('All');
  const [appStatusFilter, setAppStatusFilter] = useState('All');
  const [appManagerFilter, setAppManagerFilter] = useState('All');
  const [appCaFilter, setAppCaFilter] = useState('All');
  const [selectedOperatorForModal, setSelectedOperatorForModal] = useState(null);
  const [selectedOperatorDetails, setSelectedOperatorDetails] = useState(null);
  const [selectedAppForDrawer, setSelectedAppForDrawer] = useState(null);

  // Staff access MFA states
  const [staffList, setStaffList] = useState([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffSearch, setStaffSearch] = useState('');
  const [staffFeedback, setStaffFeedback] = useState(null);
  const [staffActionInProgress, setStaffActionInProgress] = useState(null);

  // Real dynamic states
  const [reconciliation, setReconciliation] = useState({
    apiCount: 0,
    dbCount: 0,
    matchedCount: 0,
    hasMismatch: false,
    missingInDb: [],
    missingInApi: [],
  });
  const [managers, setManagers] = useState([]);
  const [operators, setOperators] = useState([]);
  const [applications, setApplications] = useState([]);
  const [kpis, setKpis] = useState({
    total: 0,
    submitted: 0,
    applying: 0,
    failed: 0,
    queued: 0,
    answerSources: { total: 0, supabasePct: 0, aiPct: 0, resumePct: 0 },
  });
  const [loading, setLoading] = useState(false);
  const [isSyncingCompany, setIsSyncingCompany] = useState(false);
  const [syncToast, setSyncToast] = useState(null);

  // Phase E: Dashboard payload state
  const [dashboardData, setDashboardData] = useState(null);

  // Tabs as specified in Master Prompt section 5 & S5a-2 requirement 6
  const tabs = ['Overview', 'Managers', 'Operators', 'Staff access', 'Guide'];

  // Phase E: Load dynamic admin data strictly via protected GET /api/admin/dashboard driven by existing date & timeframe filter
  const loadData = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const bounds = getISTDateBounds(date, timeframe);
      const res = await fetchAdminDashboardStats({
        range: timeframe,
        from: bounds?.startIso,
        to: bounds?.endIso,
      });
      if (res && res.success) {
        setDashboardData(res);
        if (res.presence?.operators) {
          setOperators(res.presence.operators);
        }
        if (res.cas?.byManager) {
          setManagers(res.cas.byManager.map((m) => ({ id: m.manager_id, name: m.name })));
        }
      }
    } catch (err) {
      console.error('Error loading Admin dashboard data:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [date, timeframe]);

  useEffect(() => {
    loadData(false);

    // Dynamic 30s interval for live updates per Phase E requirement
    const pollInterval = setInterval(() => {
      loadData(true);
    }, 30000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [loadData]);

  // Global Sync for all CAs across Balaji & Ramakrishna
  const handleGlobalSync = async () => {
    setIsSyncingCompany(true);
    setSyncToast(null);
    try {
      const res = await syncGlobalCompanyData({ dateStr: date });
      if (res.success) {
        setSyncToast({
          type: 'success',
          text: `✓ ${res.message || 'Global Sync Complete: Allotted CAs and clients synchronized.'}`,
        });
        await loadData(false);
      } else {
        setSyncToast({
          type: 'error',
          text: `Sync Error: ${res.error || 'Failed to sync company data.'}`,
        });
      }
    } catch (err) {
      setSyncToast({ type: 'error', text: `Sync failed: ${err.message}` });
    } finally {
      setIsSyncingCompany(false);
    }
  };

  // Helper: Live operator status reading ONLY backend-computed presence
  const getOperatorEffectiveStatus = (op) => {
    if (!op) return 'inactive';
    // Single source of truth: strictly backend op.presence ('active' | 'inactive')
    if (op.presence) {
      return String(op.presence).toLowerCase() === 'active' ? 'active' : 'inactive';
    }
    if (typeof op.is_online === 'boolean') {
      return op.is_online ? 'active' : 'inactive';
    }
    // Guarded legacy calculation bypassed per P1 rules:
    // (Old browser fallback to account_status/status removed)
    return 'inactive';
  };

  // Dynamic counts for Active / Inactive operators
  const activeOpsCount = useMemo(() => {
    return operators.filter((o) => getOperatorEffectiveStatus(o) === 'active').length;
  }, [operators]);

  const inactiveOpsCount = useMemo(() => {
    return operators.filter((o) => getOperatorEffectiveStatus(o) !== 'active').length;
  }, [operators]);

  // Clients / Applications flagged with zoho_mail_not_connected
  const zohoNotConnectedCount = useMemo(() => {
    return applications.filter((a) =>
      a.failure_reason === 'zoho_mail_not_connected' ||
      (a.failure_reason && a.failure_reason.includes('zoho_mail_not_connected')) ||
      a.error_message === 'zoho_mail_not_connected' ||
      (a.error_message && a.error_message.includes('zoho_mail_not_connected'))
    ).length;
  }, [applications]);

  // Clickable Active / Inactive operators tile navigation
  const handleOperatorFilterClick = (status) => {
    setOperatorFilter(status);
    setActiveTab('Operators');
  };

  // Filtered Operators
  const filteredOperators = useMemo(() => {
    return operators.filter((op) => {
      const matchesSearch =
        !operatorSearch ||
        op.name?.toLowerCase().includes(operatorSearch.toLowerCase()) ||
        op.email?.toLowerCase().includes(operatorSearch.toLowerCase());

      const eff = getOperatorEffectiveStatus(op);
      const isOpActive = eff === 'active';
      const matchesStatus =
        operatorFilter === 'All' ||
        (operatorFilter === 'active' && isOpActive) ||
        (operatorFilter === 'inactive' && !isOpActive);

      const matchesManager =
        managerFilter === 'All' ||
        op.manager_id === managerFilter;

      return matchesSearch && matchesStatus && matchesManager;
    });
  }, [operators, operatorSearch, operatorFilter, managerFilter]);

  // Filtered Applications for Applications Tab
  const filteredApplications = useMemo(() => {
    return applications.filter((app) => {
      const matchesStatus =
        appStatusFilter === 'All' ||
        app.status?.toLowerCase() === appStatusFilter.toLowerCase();

      const matchesManager =
        appManagerFilter === 'All' ||
        app.manager_id === appManagerFilter;

      const matchesCa =
        appCaFilter === 'All' ||
        app.ca_id === appCaFilter;

      return matchesStatus && matchesManager && matchesCa;
    });
  }, [applications, appStatusFilter, appManagerFilter, appCaFilter]);

  // Page redirection handler for operator details
  const handleOpenOperatorDetails = (op, mgrName) => {
    const fullOp = {
      ...op,
      manager_name: mgrName || managers.find((m) => m.id === op.manager_id)?.name || 'Assigned Manager',
    };
    setSelectedOperatorDetails(fullOp);
    window.history.pushState(
      { page: 'operator-details', email: op.email },
      '',
      `#operator-details?email=${encodeURIComponent(op.email)}`
    );
  };

  const handleBackFromDetails = () => {
    setSelectedOperatorDetails(null);
    if (window.location.hash.startsWith('#operator-details')) {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  };

  // Synchronize with URL hash for browser Back/Forward navigation and direct links
  useEffect(() => {
    const checkHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#operator-details')) {
        const params = new URLSearchParams(hash.replace('#operator-details?', ''));
        const email = params.get('email');
        if (email && operators.length > 0) {
          const found = operators.find((o) => o.email.toLowerCase() === email.toLowerCase());
          if (found) {
            const mgr = managers.find((m) => m.id === found.manager_id);
            setSelectedOperatorDetails({ ...found, manager_name: mgr?.name });
          }
        }
      } else {
        setSelectedOperatorDetails(null);
      }
    };

    checkHash();
    window.addEventListener('hashchange', checkHash);
    return () => window.removeEventListener('hashchange', checkHash);
  }, [operators, managers]);

  // S5a-2: Staff Access List Fetching
  const loadStaffList = React.useCallback(async () => {
    setStaffLoading(true);
    try {
      const token = localStorage.getItem('applywizz_auth_token') || '';
      const res = await fetchStaffAccessList(token);
      if (res && res.success && Array.isArray(res.staff)) {
        setStaffList(res.staff);
      }
    } catch (err) {
      console.error('Error fetching staff access list:', err);
    } finally {
      setStaffLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'Staff access') {
      loadStaffList();
    }
  }, [activeTab, loadStaffList]);

  const handleAllowSetup = async (email) => {
    setStaffActionInProgress(email);
    setStaffFeedback(null);
    try {
      const token = localStorage.getItem('applywizz_auth_token') || '';
      const res = await authAdminAllowSetup({ targetEmail: email, token });
      setStaffFeedback({
        type: 'success',
        text: `Setup successfully enabled for ${email}`,
      });
      await loadStaffList();
    } catch (err) {
      setStaffFeedback({
        type: 'error',
        text: `Failed to allow setup for ${email}: ${err.message}`,
      });
    } finally {
      setStaffActionInProgress(null);
    }
  };

  const handleResetMfa = async (email) => {
    if (!window.confirm(`Are you sure you want to reset authenticator for ${email}? They will need to scan a new QR code upon their next login.`)) {
      return;
    }
    setStaffActionInProgress(email);
    setStaffFeedback(null);
    try {
      const token = localStorage.getItem('applywizz_auth_token') || '';
      const res = await authAdminResetMfa({ targetEmail: email, token });
      setStaffFeedback({
        type: 'success',
        text: `Authenticator successfully reset for ${email}. Setup window opened for 24h.`,
      });
      await loadStaffList();
    } catch (err) {
      setStaffFeedback({
        type: 'error',
        text: `Failed to reset authenticator for ${email}: ${err.message}`,
      });
    } finally {
      setStaffActionInProgress(null);
    }
  };

  const filteredStaff = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    if (!q) return staffList;
    return staffList.filter((s) =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.email || '').toLowerCase().includes(q) ||
      (s.role || '').toLowerCase().includes(q)
    );
  }, [staffList, staffSearch]);

  return (
    <div className="dashboard-container">
      {selectedOperatorDetails ? (
        <OperatorDetailsPage
          operator={selectedOperatorDetails}
          onBack={handleBackFromDetails}
          dateStr={date}
          sourceDashboard="admin"
        />
      ) : (
        <>
          {/* Top Header / Sub Tab Bar with Global Sync */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div className="sub-tab-bar" style={{ marginBottom: 0 }}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`sub-tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={isSyncingCompany}
          onClick={handleGlobalSync}
          style={{
            background: isSyncingCompany ? '#0369a1' : '#0284c7',
            color: '#ffffff',
            border: '1px solid #38bdf8',
            borderRadius: '6px',
            padding: '7px 16px',
            fontSize: '0.85rem',
            fontWeight: '700',
            cursor: isSyncingCompany ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: '0 2px 6px rgba(2, 132, 199, 0.3)',
            transition: 'all 0.2s ease',
          }}
          title="Sync Allotted Clients and Work History for All CAs across Balaji & Ramakrishna"
        >
          <span style={{ fontSize: '1.05rem', animation: isSyncingCompany ? 'spin 1s linear infinite' : 'none' }}>🔄</span>
          {isSyncingCompany ? 'Syncing All CAs & Managers...' : 'Global Sync All CAs & Managers'}
        </button>
      </div>

      {syncToast && (
        <div style={{
          padding: '10px 16px',
          marginBottom: '1rem',
          borderRadius: '6px',
          fontSize: '0.85rem',
          fontWeight: '600',
          background: syncToast.type === 'success' ? '#064e3b' : '#7f1d1d',
          color: syncToast.type === 'success' ? '#6ee7b7' : '#fca5a5',
          border: `1px solid ${syncToast.type === 'success' ? '#059669' : '#dc2626'}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>{syncToast.text}</span>
          <button
            type="button"
            onClick={() => setSyncToast(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      )}

      {loading && <div className="loading-indicator">Synchronizing live company data from Supabase...</div>}

      {/* 1. OVERVIEW TAB */}
      {activeTab === 'Overview' && (
        <div className="tab-body-fade">
          {/* 59-CA Reconciliation Banner */}
          <div className="video-run-status-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="vrs-text">
              <strong>59-CA Live Reconciliation:</strong> {reconciliation.apiCount} CAs in live roster API &bull;{' '}
              {reconciliation.dbCount} in operators DB &bull;{' '}
              {reconciliation.hasMismatch ? (
                <span style={{ color: '#ef4444', fontWeight: 'bold' }}>
                  ⚠ Mismatch Detected ({reconciliation.missingInDb.length} missing in DB, {reconciliation.missingInApi.length} missing in API)
                </span>
              ) : (
                <span style={{ color: '#10b981', fontWeight: 'bold' }}>
                  ✓ 100% In Sync ({reconciliation.matchedCount} matched)
                </span>
              )}
            </span>
            <button
              type="button"
              disabled={isSyncingCompany}
              onClick={handleGlobalSync}
              style={{
                background: 'transparent',
                border: '1px solid #38bdf8',
                color: '#38bdf8',
                borderRadius: '4px',
                padding: '3px 10px',
                fontSize: '0.75rem',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              {isSyncingCompany ? 'Syncing...' : '🔄 Re-Sync All CAs'}
            </button>
          </div>

          {/* Phase E: Active Filter Info from Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.82rem', color: '#94a3b8', fontWeight: 600 }}>
                ACTIVE PERIOD: <strong style={{ color: '#38bdf8' }}>{String(timeframe || 'day').toUpperCase()}</strong> ({date})
              </span>
            </div>
            {dashboardData?.generatedAt && (
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                Synced: {new Date(dashboardData.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Grid of Dynamic Metric Tiles */}
          <div className="video-admin-kpi-grid">
            {/* Total Operators Tile (Clickable) */}
            <div
              className="video-kpi-box"
              style={{ cursor: 'pointer' }}
              onClick={() => handleOperatorFilterClick('All')}
              title="Click to view All Operators"
            >
              <span className="vkpi-label">TOTAL OPERATORS</span>
              <span className="vkpi-val">{dashboardData?.cas?.total ?? '—'}</span>
            </div>

            {/* Active Operators Tile (Clickable) */}
            <div
              className="video-kpi-box"
              style={{ cursor: 'pointer' }}
              onClick={() => handleOperatorFilterClick('active')}
              title="Click to view Active Operators (Logged In on Website)"
            >
              <span className="vkpi-label">ACTIVE OPERATORS</span>
              <span className="vkpi-val" style={{ color: '#10b981' }}>{dashboardData?.presence?.active ?? '—'}</span>
            </div>

            {/* Inactive Operators Tile (Clickable) */}
            <div
              className="video-kpi-box"
              style={{ cursor: 'pointer' }}
              onClick={() => handleOperatorFilterClick('inactive')}
              title="Click to view Inactive Operators"
            >
              <span className="vkpi-label">INACTIVE OPERATORS</span>
              <span className="vkpi-val" style={{ color: '#94a3b8' }}>{dashboardData?.presence?.inactive ?? '—'}</span>
            </div>

            {/* Submitted */}
            <div className="video-kpi-box">
              <span className="vkpi-label">SUBMITTED</span>
              <span className="vkpi-val" style={{ color: '#10b981' }}>{dashboardData?.tasks?.submitted ?? '—'}</span>
            </div>

            {/* Ready For Review */}
            <div className="video-kpi-box">
              <span className="vkpi-label">READY FOR REVIEW</span>
              <span className="vkpi-val" style={{ color: '#38bdf8' }}>{dashboardData?.tasks?.ready_for_review ?? '—'}</span>
            </div>

            {/* Running / Applying (Live) */}
            <div className="video-kpi-box">
              <span className="vkpi-label">RUNNING</span>
              <span className="vkpi-val">{dashboardData?.tasks?.applying ?? '—'}</span>
            </div>

            {/* Queued */}
            <div className="video-kpi-box">
              <span className="vkpi-label">QUEUED</span>
              <span className="vkpi-val">{dashboardData?.tasks?.queued ?? '—'}</span>
            </div>

            {/* Failed */}
            <div className="video-kpi-box">
              <span className="vkpi-label">FAILED</span>
              <span className="vkpi-val" style={{ color: '#ef4444' }}>{dashboardData?.tasks?.failed ?? '—'}</span>
            </div>

            {/* Needs Answers (Phase E New Tile) */}
            <div className="video-kpi-box">
              <span className="vkpi-label">NEEDS ANSWERS</span>
              <span className="vkpi-val" style={{ color: '#f59e0b' }}>{dashboardData?.tasks?.needs_answers ?? '—'}</span>
            </div>

            {/* Zoho Gateway Integration Status */}
            <div
              className="video-kpi-box"
              style={{ borderLeft: dashboardData?.integrations?.zoho?.unlinked_mailboxes != null ? (dashboardData.integrations.zoho.unlinked_mailboxes > 0 ? '3px solid #f59e0b' : '3px solid #10b981') : '3px solid #64748b' }}
              title={dashboardData?.integrations?.zoho?.unlinked_mailboxes != null ? `Unlinked client mailboxes for the selected period: ${dashboardData.integrations.zoho.unlinked_mailboxes}` : "Zoho Mail Gateway status not verified"}
            >
              <span className="vkpi-label">ZOHO MAILBOXES</span>
              <span className="vkpi-val" style={{ color: dashboardData?.integrations?.zoho?.unlinked_mailboxes != null ? (dashboardData.integrations.zoho.unlinked_mailboxes > 0 ? '#f59e0b' : '#10b981') : '#94a3b8', fontSize: '1.05rem', fontWeight: 'bold' }}>
                {dashboardData?.integrations?.zoho?.unlinked_mailboxes != null ? `Unlinked: ${dashboardData.integrations.zoho.unlinked_mailboxes}` : '—'}
              </span>
            </div>

            {/* Supabase Answer % (Tier 1) */}
            <div className="video-kpi-box highlighted">
              <span className="vkpi-label">SUPABASE %</span>
              <span className="vkpi-val">{dashboardData?.answerSources?.supabase_pct != null ? `${dashboardData.answerSources.supabase_pct}%` : '—'}</span>
            </div>

            {/* Resume Answer % (Tier 2) */}
            <div className="video-kpi-box">
              <span className="vkpi-label">RESUME %</span>
              <span className="vkpi-val">{dashboardData?.answerSources?.resume_pct != null ? `${dashboardData.answerSources.resume_pct}%` : '—'}</span>
            </div>

            {/* CRM API Answer % (Tier 3) */}
            <div className="video-kpi-box">
              <span className="vkpi-label">CRM API %</span>
              <span className="vkpi-val">{dashboardData?.answerSources?.api_pct != null ? `${dashboardData.answerSources.api_pct}%` : '—'}</span>
            </div>

            {/* AI Answer % (Tier 4) */}
            <div className="video-kpi-box">
              <span className="vkpi-label">AI %</span>
              <span className="vkpi-val">{dashboardData?.answerSources?.ai_pct != null ? `${dashboardData.answerSources.ai_pct}%` : '—'}</span>
            </div>
          </div>

          {/* Company Wide Operational Health Summary */}
          <div className="video-card-section" style={{ marginTop: '1.5rem' }}>
            <span className="vcs-title">COMPANY-WIDE APPLICATION AUDIT ({String(timeframe || 'day').toUpperCase()})</span>
            <div className="vcs-content-line">
              Total CAs: <strong>{dashboardData?.cas?.total ?? '—'}</strong> &bull; Total Answers Evaluated:{' '}
              <strong>{dashboardData?.answerSources?.total ?? '—'}</strong> &bull; Period: <strong>{String(timeframe || 'day').toUpperCase()} ({date})</strong>
            </div>
          </div>
        </div>
      )}

      {/* 2. MANAGERS TAB */}
      {activeTab === 'Managers' && (
        <div className="tab-body-fade">
          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>MANAGER NAME</th>
                  <th>EMAIL</th>
                  <th>OPERATOR COUNT</th>
                  <th>ACTIVE OPS</th>
                  <th>INACTIVE OPS</th>
                  <th>APPLICATIONS ({timeframe.toUpperCase()})</th>
                </tr>
              </thead>
              <tbody>
                {(dashboardData?.cas?.byManager && dashboardData.cas.byManager.length > 0
                  ? dashboardData.cas.byManager
                  : managers
                ).map((mgr) => {
                  const mid = mgr.manager_id || mgr.id;
                  const mName = mgr.name;
                  const mEmail = mgr.email || (mName.toLowerCase().includes('balaji') ? 'balaji@applywizz.com' : 'ramakrishna@applywizz.com');
                  const opCount = typeof mgr.count === 'number' ? mgr.count : operators.filter((o) => o.manager_id === mid).length;
                  const mgrOps = (dashboardData?.presence?.operators || operators).filter((o) => o.manager_id === mid);
                  const activeCount = mgrOps.filter((o) => (typeof o.is_online === 'boolean' ? o.is_online : getOperatorEffectiveStatus(o) === 'active')).length;
                  const inactiveCount = opCount - activeCount;

                  return (
                    <tr key={mid}>
                      <td>
                        <strong>{mName}</strong>
                      </td>
                      <td>{mEmail}</td>
                      <td>
                        <strong>{opCount}</strong>
                      </td>
                      <td>
                        <span style={{ color: activeCount > 0 ? '#10b981' : '#94a3b8', fontWeight: 'bold' }}>
                          {activeCount}
                        </span>
                      </td>
                      <td>
                        <span style={{ color: '#94a3b8' }}>{inactiveCount}</span>
                      </td>
                      <td>
                        <strong>{opCount}</strong>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Phase E: Reconciliation List of Excluded Operators (count_in_dashboard = false) */}
          <div className="video-card-section" style={{ marginTop: '1.5rem' }}>
            <span className="vcs-title">RECONCILIATION — EXCLUDED FROM OPERATIONAL ROSTER</span>
            <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: '0.25rem 0 0.75rem 0' }}>
              The following operators exist in the database with count_in_dashboard = false and are excluded from the 59-operator operational roster:
            </p>
            <div className="video-table-container">
              <table className="video-data-table">
                <thead>
                  <tr>
                    <th>NAME</th>
                    <th>EMAIL</th>
                    <th>ASSIGNED MANAGER</th>
                    <th>REASON</th>
                  </tr>
                </thead>
                <tbody>
                  {(dashboardData?.reconciliation?.excluded || []).length > 0 ? (
                    dashboardData.reconciliation.excluded.map((ex) => (
                      <tr key={ex.id || ex.email}>
                        <td>
                          <strong>{ex.name}</strong>
                        </td>
                        <td>{ex.email}</td>
                        <td>
                          {ex.manager_id === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744' ? 'Ramakrishna Tejavath' : (ex.manager_id === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? 'Balaji' : 'Unassigned')}
                        </td>
                        <td style={{ color: '#f59e0b', fontSize: '0.85rem' }}>
                          {ex.reason}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', color: '#64748b' }}>
                        No operators currently excluded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 3. OPERATORS TAB — Company-wide all 59 CAs */}
      {activeTab === 'Operators' && (
        <div className="tab-body-fade">
          <div className="video-filter-bar" style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            <input
              type="text"
              value={operatorSearch}
              onChange={(e) => setOperatorSearch(e.target.value)}
              placeholder="Search by name or email..."
              className="video-input-search"
            />
            <select
              value={operatorFilter}
              onChange={(e) => setOperatorFilter(e.target.value)}
              className="video-select-filter"
            >
              <option value="All">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="inactive">Inactive Only</option>
            </select>
            <select
              value={managerFilter}
              onChange={(e) => setManagerFilter(e.target.value)}
              className="video-select-filter"
            >
              <option value="All">All Managers</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span style={{ alignSelf: 'center', fontSize: '0.85rem', color: '#94a3b8' }}>
              Showing {filteredOperators.length} of {operators.length} operators
            </span>
          </div>

          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>EMAIL</th>
                  <th>ROLE</th>
                  <th>STATUS</th>
                  <th>ASSIGNED MANAGER</th>
                </tr>
              </thead>
              <tbody>
                {filteredOperators.length > 0 ? (
                  filteredOperators.map((op) => {
                    const mgr = managers.find((m) => m.id === op.manager_id);
                    return (
                      <tr key={op.id}>
                        <td><strong>{op.name}</strong></td>
                        <td>{op.email}</td>
                        <td>{op.role || 'CA'}</td>
                        <td>
                          {(() => {
                            const eff = getOperatorEffectiveStatus(op);
                            if (eff === 'active') {
                              return (
                                <span className="video-status-tag active" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                                  ACTIVE
                                </span>
                              );
                            }
                            if (eff === 'logged_out') {
                              return (
                                <span className="video-status-tag inactive" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                                  LOGGED OUT
                                </span>
                              );
                            }
                            return (
                              <span className="video-status-tag inactive" style={{ background: 'rgba(100, 116, 139, 0.15)', color: '#94a3b8', border: '1px solid rgba(100, 116, 139, 0.3)' }}>
                                INACTIVE
                              </span>
                            );
                          })()}
                        </td>
                        <td>{mgr?.name || 'Assigned Manager'}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                      No operators found matching the criteria.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. STAFF ACCESS TAB */}
      {activeTab === 'Staff access' && <StaffAccess />}

      {/* 5. GUIDE TAB */}
      {activeTab === 'Guide' && (
        <div className="tab-body-fade">
          <div className="video-card-section">
            <span className="vcs-title">ADMINISTRATOR OPERATING MANUAL</span>
            <p style={{ color: '#cbd5e1', lineHeight: '1.6', marginTop: '0.5rem' }}>
              The Admin Dashboard provides leadership oversight over CA staffing rosters, team allocations under Balaji and Ramakrishna, answer source provenance percentages, and end-to-end company submission rates.
            </p>
            <ul style={{ color: '#94a3b8', marginTop: '0.75rem', paddingLeft: '1.25rem', lineHeight: '1.6' }}>
              <li><strong>59-CA Live Reconciliation:</strong> Automatically diffs the live roster API against the Supabase operators table to surface any un-synced additions or departures.</li>
              <li><strong>Answer Source Breakdown:</strong> Tracks the percentage of form questions answered via Supabase QA cache vs AI inference vs resume parsing.</li>
              <li><strong>Managers Tab:</strong> Team allocations and throughput counts per manager without data crossover.</li>
              <li><strong>Operators Tab:</strong> Complete directory of all 59 active and inactive Career Associates.</li>
            </ul>
          </div>
        </div>
      )}
        </>
      )}

      {/* CA Allotted Clients & History Details Modal */}
      <CAClientDetailsModal
        isOpen={Boolean(selectedOperatorForModal)}
        onClose={() => setSelectedOperatorForModal(null)}
        operator={selectedOperatorForModal}
        dateStr={date}
      />

      {/* Interactive Application Slide Drawer */}
      <ApplicationSlideDrawer
        isOpen={Boolean(selectedAppForDrawer)}
        onClose={() => setSelectedAppForDrawer(null)}
        application={selectedAppForDrawer}
        onStatusUpdated={() => loadData(true)}
        readOnly
      />
    </div>
  );
}
