import React, { useState, useEffect, useMemo } from 'react';
import { fetchClientApplications, resolveSupabaseStorageUrl } from '../services/api';

/**
 * SharedClientTable — Active Clients Directory & Dedicated Client Applications View
 */
export default function SharedClientTable({
  clients = [],
  loading = false,
  selectedClient: propSelectedClient = undefined,
  onSelectClient,
  onRefresh,
  onClientViewChange,
  role = 'admin',
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sortField, setSortField] = useState('total');
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Selected client for dedicated application dashboard view (controlled or internal)
  const [internalSelectedClient, setInternalSelectedClient] = useState(null);
  const selectedClient = propSelectedClient !== undefined ? propSelectedClient : internalSelectedClient;
  const setSelectedClient = onSelectClient || setInternalSelectedClient;

  // Fully resolve client details from clients list even if parent only passed applywizz_id
  const activeClient = useMemo(() => {
    if (!selectedClient) return null;
    const found = clients.find(
      (c) => c.applywizz_id?.toLowerCase() === selectedClient.applywizz_id?.toLowerCase()
    );
    const base = found ? { ...selectedClient, ...found } : selectedClient;
    if (role === 'admin' && base.status_badge === 'Needs Answers') {
      let fallbackBadge = 'Active';
      if (base.submitted > 0) fallbackBadge = 'Submitted';
      else if (base.failed > 0) fallbackBadge = 'Failed';
      else if (base.ready_to_review > 0) fallbackBadge = 'Ready to Review';
      return { ...base, status_badge: fallbackBadge };
    }
    return base;
  }, [selectedClient, clients, role]);

  const [clientApps, setClientApps] = useState([]);
  const [clientAppsLoading, setClientAppsLoading] = useState(false);
  const [clientAppsError, setClientAppsError] = useState(null);

  // In Admin view: never show applications that are in 'needs_answers' status
  const visibleClientApps = useMemo(() => {
    if (role === 'admin') {
      return clientApps.filter((app) => (app.status || '').toLowerCase() !== 'needs_answers');
    }
    return clientApps;
  }, [clientApps, role]);

  // Lightbox for proof screenshot inspection
  const [previewImage, setPreviewImage] = useState(null);

  // Synchronize dedicated client view state with parent dashboards
  useEffect(() => {
    if (typeof onClientViewChange === 'function') {
      onClientViewChange(selectedClient);
    }
  }, [selectedClient, onClientViewChange]);

  // Load applications whenever activeClient changes
  useEffect(() => {
    const cid = activeClient?.applywizz_id || selectedClient?.applywizz_id;
    if (cid) {
      let isMounted = true;
      setClientAppsLoading(true);
      setClientAppsError(null);
      fetchClientApplications({ awlId: cid })
        .then((res) => {
          if (!isMounted) return;
          if (res && res.success) {
            setClientApps(res.applications || []);
          } else {
            setClientAppsError(res?.error || 'Failed to load applications for this client');
          }
        })
        .catch((err) => {
          if (!isMounted) return;
          setClientAppsError(err.message || 'Error loading applications');
        })
        .finally(() => {
          if (isMounted) setClientAppsLoading(false);
        });
      return () => {
        isMounted = false;
      };
    } else {
      setClientApps([]);
    }
  }, [activeClient?.applywizz_id, selectedClient?.applywizz_id]);

  // URL Hash synchronization for seamless back/forward navigation
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#client/')) {
        const rawId = decodeURIComponent(hash.replace('#client/', ''));
        const found = clients.find(
          (c) => c.applywizz_id?.toLowerCase() === rawId.toLowerCase()
        );
        if (found) {
          handleSelectClient(found, false);
        } else if (rawId) {
          handleSelectClient({ applywizz_id: rawId, client_name: rawId, status_badge: 'Active' }, false);
        }
      } else if (!hash) {
        setSelectedClient(null);
        if (typeof onClientViewChange === 'function') {
          onClientViewChange(null);
        }
      }
    };

    handleHash();
    window.addEventListener('hashchange', handleHash);
    window.addEventListener('popstate', handleHash);
    return () => {
      window.removeEventListener('hashchange', handleHash);
      window.removeEventListener('popstate', handleHash);
    };
  }, [clients]);

  // Handle client selection (switches to dedicated view)
  const handleSelectClient = (client, pushHash = true) => {
    setSelectedClient(client);
    if (typeof onClientViewChange === 'function') {
      onClientViewChange(client);
    }

    if (pushHash && client?.applywizz_id) {
      window.location.hash = `#client/${encodeURIComponent(client.applywizz_id)}`;
    }
  };

  // Handle navigation back to client directory
  const handleBackToDirectory = () => {
    setSelectedClient(null);
    if (typeof onClientViewChange === 'function') {
      onClientViewChange(null);
    }
    setClientApps([]);
    if (typeof window !== 'undefined') {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } else {
        window.location.hash = '';
      }
    }
  };

  // Pre-process clients: in admin view, clients with only needs_answers show as Active / Submitted / etc.
  const processedClients = useMemo(() => {
    return clients.map((c) => {
      if (role === 'admin' && c.status_badge === 'Needs Answers') {
        let fallbackBadge = 'Active';
        if (c.submitted > 0) fallbackBadge = 'Submitted';
        else if (c.failed > 0) fallbackBadge = 'Failed';
        else if (c.ready_to_review > 0) fallbackBadge = 'Ready to Review';
        return { ...c, status_badge: fallbackBadge };
      }
      return c;
    });
  }, [clients, role]);

  // Filter clients
  const filteredClients = useMemo(() => {
    let result = [...processedClients];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (c) =>
          c.applywizz_id?.toLowerCase().includes(q) ||
          c.client_name?.toLowerCase().includes(q)
      );
    }

    if (statusFilter !== 'All') {
      result = result.filter((c) => c.status_badge === statusFilter);
    }

    result.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      if (sortField === 'total' && role === 'admin') {
        aVal = Math.max(0, (a.total || 0) - (a.needs_answers || 0));
        bVal = Math.max(0, (b.total || 0) - (b.needs_answers || 0));
      }

      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = (bVal || '').toLowerCase();
        return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      aVal = Number(aVal || 0);
      bVal = Number(bVal || 0);
      return sortAsc ? aVal - bVal : bVal - aVal;
    });

    return result;
  }, [processedClients, search, statusFilter, sortField, sortAsc, role]);

  // Pagination
  const totalPages = Math.ceil(filteredClients.length / pageSize) || 1;
  const pagedClients = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredClients.slice(start, start + pageSize);
  }, [filteredClients, page, pageSize]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const getBadgeStyle = (badge) => {
    switch (badge) {
      case 'Running':
      case 'running':
        return { bg: '#0284c7', color: '#ffffff', border: '#38bdf8' };
      case 'Queued':
      case 'queued':
        return { bg: '#854d0e', color: '#fef08a', border: '#ca8a04' };
      case 'Ready to Review':
      case 'ready_for_review':
        return { bg: '#065f46', color: '#6ee7b7', border: '#10b981' };
      case 'Needs Answers':
      case 'needs_answers':
        return { bg: '#7c2d12', color: '#fed7aa', border: '#f97316' };
      case 'Submitted':
      case 'submitted':
      case 'completed':
        return { bg: '#1e3a8a', color: '#93c5fd', border: '#3b82f6' };
      case 'Failed':
      case 'failed':
        return { bg: '#7f1d1d', color: '#fca5a5', border: '#ef4444' };
      case 'Active':
      case 'active':
        return { bg: '#14532d', color: '#86efac', border: '#22c55e' };
      default:
        return { bg: '#1e293b', color: '#94a3b8', border: '#334155' };
    }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW 1: DEDICATED CLIENT APPLICATIONS DASHBOARD (REDIRECT VIEW)
  // ═════════════════════════════════════════════════════════════════════════
  if (activeClient) {
    const badgeStyle = getBadgeStyle(activeClient.status_badge);

    return (
      <div className="client-applications-dedicated-view" style={{ marginTop: '1.25rem' }}>
        {/* Navigation Bar */}
        <div style={{ marginBottom: '1.25rem' }}>
          <button
            type="button"
            onClick={handleBackToDirectory}
            style={{
              background: '#1e293b',
              color: '#38bdf8',
              border: '1px solid #334155',
              borderRadius: '6px',
              padding: '8px 16px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#0284c7';
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#1e293b';
              e.currentTarget.style.color = '#38bdf8';
            }}
          >
            ← Back to Clients Directory
          </button>
        </div>

        {/* Client Banner & Header */}
        <div style={{
          background: '#0f172a',
          border: '1px solid #1e293b',
          borderRadius: '10px',
          padding: '1.25rem 1.5rem',
          marginBottom: '1.25rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: '1.4rem', color: '#f8fafc', fontWeight: 800 }}>
                {activeClient.client_name}
              </h2>
              <span style={{
                background: '#1e293b',
                color: '#38bdf8',
                border: '1px solid #0284c7',
                padding: '3px 10px',
                borderRadius: '6px',
                fontSize: '0.82rem',
                fontWeight: 700,
                letterSpacing: '0.04em',
              }}>
                {activeClient.applywizz_id}
              </span>
              <span style={{
                background: badgeStyle.bg,
                color: badgeStyle.color,
                border: `1px solid ${badgeStyle.border}`,
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 700,
              }}>
                {activeClient.status_badge}
              </span>
            </div>
            <p style={{ margin: '6px 0 0 0', fontSize: '0.82rem', color: '#64748b' }}>
              Detailed Workday applications breakdown and submission confirmation proof.
            </p>
          </div>
        </div>

        {/* Client Stats Summary Cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}>
          <div className="video-kpi-box" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
            <span className="vkpi-label">TOTAL APPLICATIONS</span>
            <span className="vkpi-val" style={{ color: '#f8fafc' }}>
              {role === 'admin'
                ? Math.max(0, (activeClient.total || 0) - (activeClient.needs_answers || 0))
                : activeClient.total}
            </span>
          </div>

          <div className="video-kpi-box" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
            <span className="vkpi-label">SUBMITTED (SUCCESS)</span>
            <span className="vkpi-val" style={{ color: '#10b981' }}>
              {activeClient.submitted}
            </span>
          </div>

          <div className="video-kpi-box" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
            <span className="vkpi-label">FAILED</span>
            <span className="vkpi-val" style={{ color: '#ef4444' }}>
              {activeClient.failed}
            </span>
          </div>

          <div className="video-kpi-box" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
            <span className="vkpi-label">READY TO REVIEW</span>
            <span className="vkpi-val" style={{ color: '#10b981' }}>
              {activeClient.ready_to_review}
            </span>
          </div>

          {role !== 'admin' && (
            <div className="video-kpi-box" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
              <span className="vkpi-label">NEEDS ANSWERS</span>
              <span className="vkpi-val" style={{ color: '#f97316' }}>
                {activeClient.needs_answers}
              </span>
            </div>
          )}
        </div>

        {/* Applications List Section */}
        <div style={{
          background: '#0f172a',
          border: '1px solid #1e293b',
          borderRadius: '10px',
          padding: '1.25rem 1.5rem',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
            borderBottom: '1px solid #1e293b',
            paddingBottom: '0.75rem',
          }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#f8fafc', fontWeight: 800 }}>
              APPLICATIONS ({visibleClientApps.length})
            </h3>
            <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
              Review status, external job links, and proof screenshots
            </span>
          </div>

          {clientAppsLoading && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#38bdf8' }}>
              Loading applications for {selectedClient.client_name}...
            </div>
          )}

          {clientAppsError && (
            <div style={{
              padding: '12px 16px',
              borderRadius: '6px',
              background: '#7f1d1d33',
              border: '1px solid #ef4444',
              color: '#fca5a5',
              fontSize: '0.85rem',
              marginBottom: '1rem',
            }}>
              ⚠️ {clientAppsError}
            </div>
          )}

          {!clientAppsLoading && visibleClientApps.length === 0 && !clientAppsError && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
              No applications currently tracked for this client.
            </div>
          )}

          {/* Applications Table View with SCREENSHOT column */}
          {!clientAppsLoading && visibleClientApps.length > 0 && (
            <div className="client-apps-table-desktop-view video-table-container" style={{ overflowX: 'auto', width: '100%', marginTop: '0.5rem' }}>
              <table className="video-data-table" style={{ width: '100%', minWidth: '940px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ width: '13%' }}>STATUS</th>
                    <th style={{ width: '14%' }}>CLIENT ID</th>
                    <th style={{ width: '20%' }}>COMPANY</th>
                    <th style={{ width: '25%' }}>ROLE TITLE</th>
                    <th style={{ width: '15%' }}>STATUS TIME</th>
                    <th style={{ width: '13%' }}>SCREENSHOT</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleClientApps.map((app, idx) => {
                    const appBadgeStyle = getBadgeStyle(app.status);
                    const rawShot = app.screenshot_url || app.application_submitted_screenshot_url || app.screenshot_path;
                    const shotUrl = rawShot ? resolveSupabaseStorageUrl(rawShot) : null;
                    const formattedTime = app.updated_at
                      ? new Date(app.updated_at).toLocaleString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—';

                    return (
                      <tr key={app.id || app.distribution_id || idx}>
                        {/* 1. STATUS */}
                        <td>
                          <span
                            style={{
                              background: appBadgeStyle.bg,
                              color: appBadgeStyle.color,
                              border: `1px solid ${appBadgeStyle.border}`,
                              padding: '3px 8px',
                              borderRadius: '4px',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                              display: 'inline-block',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {(app.status ? app.status.replace(/_/g, ' ') : 'PENDING').toUpperCase()}
                          </span>
                        </td>

                        {/* 2. CLIENT ID */}
                        <td>
                          <span
                            style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontWeight: 800,
                              color: '#0f172a',
                              fontSize: '0.82rem',
                            }}
                          >
                            {app.applywizz_id || selectedClient.applywizz_id}
                          </span>
                        </td>

                        {/* 3. COMPANY (Black Text, High Contrast) */}
                        <td style={{ fontWeight: 800, color: '#000000', fontSize: '0.88rem' }}>
                          {app.company || 'Workday Tenant'}
                        </td>

                        {/* 4. ROLE TITLE (Clickable external link) */}
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            {app.job_url ? (
                              <a
                                href={app.job_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  color: '#0284c7',
                                  textDecoration: 'none',
                                  fontWeight: 700,
                                  fontSize: '0.86rem',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                }}
                                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                                title="Open Workday Job Link"
                              >
                                <span>{app.role_title || 'Workday Application'}</span>
                                <span style={{ fontSize: '0.72rem', opacity: 0.8 }}>↗</span>
                              </a>
                            ) : (
                              <span style={{ color: '#0f172a', fontWeight: 600, fontSize: '0.84rem' }}>
                                {app.role_title || 'Workday Application'}
                              </span>
                            )}
                            {app.error_message && (
                              <span style={{ fontSize: '0.72rem', color: '#dc2626', fontWeight: 600 }}>
                                ⚠️ {app.error_message}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* 5. STATUS TIME */}
                        <td style={{ fontSize: '0.82rem', color: '#1e293b', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {formattedTime}
                        </td>

                        {/* 6. SCREENSHOT (Button to view screenshot proof) */}
                        <td>
                          {shotUrl ? (
                            <button
                              type="button"
                              onClick={() => setPreviewImage(shotUrl)}
                              style={{
                                background: 'rgba(16, 185, 129, 0.15)',
                                color: '#34d399',
                                border: '1px solid rgba(16, 185, 129, 0.4)',
                                padding: '4px 10px',
                                borderRadius: '4px',
                                fontSize: '0.78rem',
                                fontWeight: 700,
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                                transition: 'all 0.15s ease',
                                whiteSpace: 'nowrap',
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = '#059669';
                                e.currentTarget.style.color = '#ffffff';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'rgba(16, 185, 129, 0.15)';
                                e.currentTarget.style.color = '#34d399';
                              }}
                              title="Click to view full screenshot proof"
                            >
                              📷 View Proof
                            </button>
                          ) : (
                            <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Mobile Card-Based View for Dedicated Client Applications */}
          {!clientAppsLoading && visibleClientApps.length > 0 && (
            <div className="client-apps-cards-mobile-view">
              {visibleClientApps.map((app, idx) => {
                const appBadgeStyle = getBadgeStyle(app.status);
                const rawShot = app.screenshot_url || app.application_submitted_screenshot_url || app.screenshot_path;
                const shotUrl = rawShot ? resolveSupabaseStorageUrl(rawShot) : null;
                const formattedTime = app.updated_at
                  ? new Date(app.updated_at).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '—';

                return (
                  <div key={app.id || idx} className="m-app-card">
                    <div className="m-app-card-header">
                      <div>
                        <div className="m-app-company">{app.company || 'Unknown Company'}</div>
                        <div className="m-app-role">{app.role || 'Workday Application'}</div>
                      </div>
                      <span
                        style={{
                          background: appBadgeStyle.bg,
                          color: appBadgeStyle.color,
                          border: `1px solid ${appBadgeStyle.border}`,
                          padding: '3px 8px',
                          borderRadius: '999px',
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {app.status || 'Active'}
                      </span>
                    </div>

                    {app.job_url && (
                      <a
                        href={app.job_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '0.76rem', color: '#0284c7', textDecoration: 'underline', wordBreak: 'break-all' }}
                      >
                        🔗 View Workday Job Link ↗
                      </a>
                    )}

                    {app.error_message && (
                      <div style={{ fontSize: '0.72rem', color: '#dc2626', fontWeight: 600 }}>
                        ⚠️ {app.error_message}
                      </div>
                    )}

                    <div className="m-app-footer">
                      <span className="m-app-time">{formattedTime}</span>
                      {shotUrl ? (
                        <button
                          type="button"
                          onClick={() => setPreviewImage(shotUrl)}
                          style={{
                            background: 'rgba(16, 185, 129, 0.15)',
                            color: '#059669',
                            border: '1px solid rgba(16, 185, 129, 0.4)',
                            padding: '5px 12px',
                            borderRadius: '4px',
                            fontSize: '0.74rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                        >
                          📷 View Proof
                        </button>
                      ) : (
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No proof</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Fullscreen Screenshot Modal */}
        {previewImage && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.88)',
              backdropFilter: 'blur(4px)',
              zIndex: 2000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
            }}
            onClick={() => setPreviewImage(null)}
          >
            <div
              style={{
                position: 'relative',
                maxWidth: '92vw',
                maxHeight: '92vh',
                background: '#0f172a',
                borderRadius: '8px',
                padding: '12px',
                border: '1px solid #334155',
                display: 'flex',
                flexDirection: 'column',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ color: '#38bdf8', fontWeight: 700, fontSize: '0.85rem' }}>
                  Submitted Confirmation Proof Screenshot
                </span>
                <button
                  type="button"
                  onClick={() => setPreviewImage(null)}
                  style={{
                    background: '#1e293b',
                    color: '#ffffff',
                    border: '1px solid #475569',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  ✕ Close
                </button>
              </div>
              <img
                src={previewImage}
                alt="Submission Proof Screenshot"
                style={{
                  maxWidth: '100%',
                  maxHeight: '82vh',
                  objectFit: 'contain',
                  borderRadius: '4px',
                }}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW 2: ACTIVE CLIENTS DIRECTORY TABLE VIEW
  // ═════════════════════════════════════════════════════════════════════════
  const statusFilterOptions = role === 'admin'
    ? ['All', 'Ready to Review', 'Submitted', 'Failed', 'Active']
    : ['All', 'Ready to Review', 'Needs Answers', 'Submitted', 'Failed', 'Active'];

  return (
    <div className="shared-client-table-wrapper" style={{ marginTop: '1.25rem' }}>
      {/* Table Header Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '1rem',
          background: '#0f172a',
          padding: '14px 18px',
          borderRadius: '8px',
          border: '1px solid #1e293b',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#f8fafc', fontWeight: 800 }}>
            ACTIVE CLIENTS DIRECTORY ({filteredClients.length})
          </h3>
          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
            Click any client or "View Apps" to see all applications and proof screenshots
          </span>
        </div>

        {/* Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', width: '100%', maxWidth: '640px' }}>
          <input
            type="text"
            placeholder="Search by AWL ID or Client Name..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="client-search-input"
          />

          {/* Status filter badges */}
          <div className="client-filter-strip">
            {statusFilterOptions.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => {
                  setStatusFilter(st);
                  setPage(1);
                }}
                style={{
                  background: statusFilter === st ? '#0284c7' : '#1e293b',
                  color: statusFilter === st ? '#ffffff' : '#94a3b8',
                  border: statusFilter === st ? '1px solid #38bdf8' : '1px solid #334155',
                  borderRadius: '999px',
                  padding: '3px 10px',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Desktop / Tablet Clients Table View */}
      <div className="client-table-desktop-view">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', color: '#cbd5e1' }}>
          <thead>
            <tr style={{ background: '#1e293b88', borderBottom: '1px solid #334155', color: '#94a3b8', textAlign: 'left' }}>
              <th
                onClick={() => handleSort('applywizz_id')}
                style={{ padding: '12px 14px', cursor: 'pointer', userSelect: 'none' }}
              >
                AWL ID {sortField === 'applywizz_id' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th
                onClick={() => handleSort('client_name')}
                style={{ padding: '12px 14px', cursor: 'pointer', userSelect: 'none' }}
              >
                Client Name {sortField === 'client_name' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th
                onClick={() => handleSort('submitted')}
                style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                Submitted {sortField === 'submitted' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th
                onClick={() => handleSort('failed')}
                style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                Failed {sortField === 'failed' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              {role !== 'admin' && (
                <th
                  onClick={() => handleSort('queued')}
                  style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                >
                  Queued {sortField === 'queued' ? (sortAsc ? '▲' : '▼') : ''}
                </th>
              )}
              <th
                onClick={() => handleSort('running')}
                style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                Running {sortField === 'running' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th
                onClick={() => handleSort('ready_to_review')}
                style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                Review {sortField === 'ready_to_review' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              {role !== 'admin' && (
                <th
                  onClick={() => handleSort('needs_answers')}
                  style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                >
                  Needs Ans {sortField === 'needs_answers' ? (sortAsc ? '▲' : '▼') : ''}
                </th>
              )}
              <th
                onClick={() => handleSort('total')}
                style={{ padding: '12px 10px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                Total {sortField === 'total' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th style={{ padding: '12px 14px', textAlign: 'center' }}>Status Badge</th>
              <th style={{ padding: '12px 14px', textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {pagedClients.length === 0 ? (
              <tr>
                <td colSpan={role === 'admin' ? 9 : 11} style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>
                  {loading ? 'Loading active clients...' : 'No matching clients found.'}
                </td>
              </tr>
            ) : (
              pagedClients.map((client) => {
                const badgeStyle = getBadgeStyle(client.status_badge);
                return (
                  <tr
                    key={client.applywizz_id}
                    onClick={() => handleSelectClient(client)}
                    style={{
                      borderBottom: '1px solid #1e293b',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#1e293b55')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '12px 14px', fontWeight: 700, color: '#38bdf8' }}>
                      {client.applywizz_id}
                    </td>
                    <td style={{ padding: '12px 14px', color: '#f8fafc', fontWeight: 500 }}>
                      {client.client_name}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: client.submitted > 0 ? '#10b981' : '#64748b', fontWeight: client.submitted > 0 ? 700 : 400 }}>
                      {client.submitted}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: client.failed > 0 ? '#ef4444' : '#64748b', fontWeight: client.failed > 0 ? 700 : 400 }}>
                      {client.failed}
                    </td>
                    {role !== 'admin' && (
                      <td style={{ padding: '12px 10px', textAlign: 'center', color: client.queued > 0 ? '#eab308' : '#64748b', fontWeight: client.queued > 0 ? 700 : 400 }}>
                        {client.queued}
                      </td>
                    )}
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: client.running > 0 ? '#0284c7' : '#64748b', fontWeight: client.running > 0 ? 700 : 400 }}>
                      {client.running}
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: client.ready_to_review > 0 ? '#10b981' : '#64748b', fontWeight: client.ready_to_review > 0 ? 700 : 400 }}>
                      {client.ready_to_review}
                    </td>
                    {role !== 'admin' && (
                      <td style={{ padding: '12px 10px', textAlign: 'center', color: client.needs_answers > 0 ? '#f97316' : '#64748b', fontWeight: client.needs_answers > 0 ? 700 : 400 }}>
                        {client.needs_answers}
                      </td>
                    )}
                    <td style={{ padding: '12px 10px', textAlign: 'center', color: '#f8fafc', fontWeight: 700 }}>
                      {role === 'admin'
                        ? Math.max(0, (client.total || 0) - (client.needs_answers || 0))
                        : client.total}
                    </td>
                    <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                      <span
                        style={{
                          background: badgeStyle.bg,
                          color: badgeStyle.color,
                          border: `1px solid ${badgeStyle.border}`,
                          padding: '3px 9px',
                          borderRadius: '999px',
                          fontSize: '0.74rem',
                          fontWeight: 600,
                          display: 'inline-block',
                        }}
                      >
                        {client.status_badge}
                      </span>
                    </td>
                    <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectClient(client);
                        }}
                        style={{
                          background: '#0284c7',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: '4px',
                          padding: '5px 12px',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          boxShadow: '0 2px 4px rgba(2, 132, 199, 0.25)',
                        }}
                      >
                        View Apps →
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile Card-Based View for Active Clients */}
      <div className="client-cards-mobile-view">
        {pagedClients.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: '#64748b', background: '#0f172a', borderRadius: '8px' }}>
            {loading ? 'Loading active clients...' : 'No matching clients found.'}
          </div>
        ) : (
          pagedClients.map((client) => {
            const badgeStyle = getBadgeStyle(client.status_badge);
            return (
              <div
                key={client.applywizz_id}
                className="m-client-card"
                onClick={() => handleSelectClient(client)}
              >
                <div className="m-client-card-top">
                  <div>
                    <span className="m-client-id">{client.applywizz_id}</span>
                    <h4 className="m-client-name">{client.client_name}</h4>
                  </div>
                  <span
                    style={{
                      background: badgeStyle.bg,
                      color: badgeStyle.color,
                      border: `1px solid ${badgeStyle.border}`,
                      padding: '3px 8px',
                      borderRadius: '999px',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                    }}
                  >
                    {client.status_badge}
                  </span>
                </div>

                <div className="m-client-metrics-strip">
                  <div className="m-metric-item">
                    <span className="m-metric-lbl">SUBMITTED</span>
                    <span className="m-metric-val green">{client.submitted}</span>
                  </div>
                  <div className="m-metric-item">
                    <span className="m-metric-lbl">FAILED</span>
                    <span className="m-metric-val red">{client.failed}</span>
                  </div>
                  <div className="m-metric-item">
                    <span className="m-metric-lbl">REVIEW</span>
                    <span className="m-metric-val mint">{client.ready_to_review}</span>
                  </div>
                  <div className="m-metric-item">
                    <span className="m-metric-lbl">RUNNING</span>
                    <span className="m-metric-val blue">{client.running}</span>
                  </div>
                  {role !== 'admin' && (
                    <div className="m-metric-item">
                      <span className="m-metric-lbl">QUEUED</span>
                      <span className="m-metric-val yellow">{client.queued}</span>
                    </div>
                  )}
                  <div className="m-metric-item">
                    <span className="m-metric-lbl">TOTAL</span>
                    <span className="m-metric-val" style={{ color: '#ffffff' }}>{client.total}</span>
                  </div>
                </div>

                <button
                  type="button"
                  className="m-client-view-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectClient(client);
                  }}
                >
                  View Applications &rarr;
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          marginTop: '1rem',
          padding: '8px 12px',
          background: '#0f172a',
          borderRadius: '6px',
        }}
      >
        <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
          Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> ({filteredClients.length} clients total)
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            style={{
              background: '#0a0d14',
              color: '#94a3b8',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '0.8rem',
            }}
          >
            <option value={15}>15 per page</option>
            <option value={25}>25 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
          </select>

          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{
              background: page <= 1 ? '#1e293b' : '#0284c7',
              color: page <= 1 ? '#64748b' : '#ffffff',
              border: 'none',
              borderRadius: '4px',
              padding: '5px 12px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: page <= 1 ? 'not-allowed' : 'pointer',
            }}
          >
            Previous
          </button>

          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            style={{
              background: page >= totalPages ? '#1e293b' : '#0284c7',
              color: page >= totalPages ? '#64748b' : '#ffffff',
              border: 'none',
              borderRadius: '4px',
              padding: '5px 12px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: page >= totalPages ? 'not-allowed' : 'pointer',
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
