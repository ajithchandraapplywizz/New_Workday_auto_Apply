import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchDashboardApplications } from '../services/api';

/**
 * ApplicationsListSection — Professional Workday Applications Directory
 *
 * Supported Status Tabs:
 * - Ready for Review (102)
 * - Needs Answers (51)
 * - Submitted (9)
 * - Failed (10)
 * - All Applications (172)
 *
 * Features:
 * - Lists ALL jobs (not just a few)
 * - Clickable job links directly to the Workday posting
 * - Proof screenshot view buttons and lightbox preview
 * - Search by AWL ID, company, or role
 * - Pagination controls (15, 25, 50 per page)
 */
export default function ApplicationsListSection({
  role = 'developer',
  from = null,
  to = null,
  timeframeLabel = 'Selected period',
  submittedAllTime = null,
  failedAllTime = null,
}) {
  const [activeTab, setActiveTab] = useState('ready_for_review'); // 'ready_for_review' | 'needs_answers' | 'submitted' | 'failed' | 'all'
  const [listScope, setListScope] = useState('all');              // 'all' | '7d' | 'period'
  const [applications, setApplications] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fetchError, setFetchError] = useState(false);
  const [previewScreenshot, setPreviewScreenshot] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const loadApplications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchDashboardApplications(role, {
        status: activeTab,
        scope: listScope,
        from,
        to,
        limit: 250, // Fetch up to 250 so all ready to review jobs are loaded
      });

      if (res && res.success) {
        setApplications(res.applications || []);
        setTotalCount(res.total || (res.applications || []).length);
        setLastUpdated(new Date().toLocaleTimeString('en-GB'));
        setFetchError(false);
      } else {
        setFetchError(true);
      }
    } catch (err) {
      console.warn('[ApplicationsList] fetch error:', err.message);
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [role, activeTab, listScope, from, to]);

  // Reload when tab or scope changes
  useEffect(() => {
    setPage(1);
    loadApplications();
  }, [loadApplications]);

  // Live 30s auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      loadApplications();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadApplications]);

  // Search filter
  const filteredApps = useMemo(() => {
    if (!search.trim()) return applications;
    const q = search.trim().toLowerCase();
    return applications.filter(
      (app) =>
        (app.applywizz_id || '').toLowerCase().includes(q) ||
        (app.company || '').toLowerCase().includes(q) ||
        (app.role || '').toLowerCase().includes(q)
    );
  }, [applications, search]);

  // Pagination
  const totalPages = Math.ceil(filteredApps.length / pageSize) || 1;
  const pagedApps = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredApps.slice(start, start + pageSize);
  }, [filteredApps, page, pageSize]);

  const getStatusBadge = (status) => {
    const st = String(status || '').toLowerCase();
    if (st === 'submitted' || st === 'completed') {
      return { bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)', label: 'SUBMITTED' };
    }
    if (st === 'failed') {
      return { bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)', label: 'FAILED' };
    }
    if (st === 'ready_for_review' || st === 'ready_to_review') {
      return { bg: 'rgba(6, 95, 70, 0.25)', color: '#6ee7b7', border: '1px solid #10b981', label: 'READY TO REVIEW' };
    }
    if (st === 'needs_answers') {
      return { bg: 'rgba(124, 45, 18, 0.25)', color: '#fed7aa', border: '1px solid #f97316', label: 'NEEDS ANSWERS' };
    }
    if (st === 'running' || st === 'applying') {
      return { bg: 'rgba(2, 132, 199, 0.25)', color: '#38bdf8', border: '1px solid #0284c7', label: 'RUNNING' };
    }
    return { bg: 'rgba(100, 116, 139, 0.15)', color: '#94a3b8', border: '1px solid rgba(100, 116, 139, 0.3)', label: st.toUpperCase() || 'QUEUED' };
  };

  return (
    <div className="video-card-section" style={{ marginTop: '1.75rem', marginBottom: '2rem' }}>
      {/* Top Header & Tab Controls */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
        borderBottom: '1px solid #334155',
        paddingBottom: '12px',
        marginBottom: '14px',
      }}>
        {/* Status Tabs */}
        <div className="apps-status-tabs-strip">
          {[
            { id: 'ready_for_review', label: 'READY FOR REVIEW' },
            { id: 'needs_answers', label: 'NEEDS ANSWERS' },
            { id: 'submitted', label: 'SUBMITTED' },
            { id: 'failed', label: 'FAILED' },
            { id: 'all', label: 'ALL APPLICATIONS' },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  fontWeight: '700',
                  cursor: 'pointer',
                  border: isActive ? '1px solid #38bdf8' : '1px solid #334155',
                  background: isActive ? '#0284c7' : '#1e293b',
                  color: isActive ? '#ffffff' : '#94a3b8',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Scope Toggle & Search Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', width: '100%' }}>
          <input
            type="text"
            placeholder="Search AWL ID, company, role..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="client-search-input"
          />

          <div style={{
            display: 'inline-flex',
            background: '#0f172a',
            padding: '2px',
            borderRadius: '6px',
            border: '1px solid #334155',
          }}>
            {[
              { id: 'all', label: 'All time' },
              { id: '7d', label: 'Last 7 days' },
              { id: 'period', label: 'This period' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setListScope(opt.id)}
                style={{
                  background: listScope === opt.id ? '#0284c7' : 'transparent',
                  color: listScope === opt.id ? '#ffffff' : '#94a3b8',
                  border: 'none',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  fontSize: '0.76rem',
                  fontWeight: listScope === opt.id ? '700' : '500',
                  cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => loadApplications()}
            style={{
              background: '#1e293b',
              color: '#38bdf8',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '5px 10px',
              fontSize: '0.78rem',
              cursor: 'pointer',
              fontWeight: '600',
            }}
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Applications Data Table */}
      <div className="client-apps-table-desktop-view video-table-container" style={{ overflowX: 'auto', background: '#0f172a', borderRadius: '8px', border: '1px solid #1e293b' }}>
        <table className="video-data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: '#1e293b88', borderBottom: '1px solid #334155', color: '#94a3b8' }}>
              <th style={{ width: '120px', padding: '12px 14px' }}>STATUS</th>
              <th style={{ width: '130px', padding: '12px 14px' }}>CLIENT ID</th>
              <th style={{ padding: '12px 14px' }}>COMPANY</th>
              <th style={{ padding: '12px 14px' }}>ROLE TITLE</th>
              <th style={{ width: '160px', padding: '12px 14px' }}>STATUS TIME</th>
              <th style={{ width: '130px', textAlign: 'center', padding: '12px 14px' }}>SCREENSHOT</th>
            </tr>
          </thead>
          <tbody>
            {loading && applications.length === 0 ? (
              <tr>
                <td colSpan="6" style={{ textAlign: 'center', padding: '2.5rem', color: '#94a3b8' }}>
                  Loading applications...
                </td>
              </tr>
            ) : pagedApps.length > 0 ? (
              pagedApps.map((app) => {
                const badge = getStatusBadge(app.status);
                const proofUrl = app.screenshot_link || app.screenshot_url || app.application_submitted_screenshot_url;

                return (
                  <tr key={app.id || app.distribution_id} style={{ borderBottom: '1px solid #1e293b' }}>
                    {/* Status Badge */}
                    <td style={{ padding: '12px 14px' }}>
                      <span
                        className="video-status-tag"
                        style={{
                          background: badge.bg,
                          color: badge.color,
                          border: badge.border,
                          padding: '3px 8px',
                          borderRadius: '999px',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          display: 'inline-block',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {badge.label}
                      </span>
                    </td>

                    {/* Client ID */}
                    <td style={{ padding: '12px 14px' }}>
                      <span className="app-id-tag" style={{ fontWeight: 700, color: '#38bdf8' }}>
                        {app.applywizz_id || '—'}
                      </span>
                    </td>

                    {/* Company */}
                    <td style={{ padding: '12px 14px' }}>
                      <strong style={{ color: '#f1f5f9' }}>{app.company || 'Workday Tenant'}</strong>
                    </td>

                    {/* Role Title with external link */}
                    <td style={{ padding: '12px 14px' }}>
                      {app.job_url ? (
                        <a
                          href={app.job_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: '#38bdf8',
                            textDecoration: 'none',
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                          title="Open Workday Job Link"
                        >
                          {app.role || app.role_title || 'Workday Application'} ↗
                        </a>
                      ) : (
                        <span style={{ color: '#cbd5e1' }}>{app.role || app.role_title || 'Workday Application'}</span>
                      )}
                    </td>

                    {/* Status Event Time */}
                    <td style={{ padding: '12px 14px', fontSize: '0.78rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {app.status_time ? new Date(app.status_time).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>

                    {/* Proof Screenshot Button */}
                    <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                      {proofUrl ? (
                        <button
                          type="button"
                          onClick={() => setPreviewScreenshot(proofUrl)}
                          style={{
                            background: '#065f46',
                            color: '#6ee7b7',
                            border: '1px solid #10b981',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '0.75rem',
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
                        <span style={{ color: '#475569', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan="6" style={{ textAlign: 'center', padding: '2.5rem', color: '#64748b' }}>
                  No applications found in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile Card-Based View for Applications */}
      <div className="client-apps-cards-mobile-view" style={{ marginTop: '0.75rem' }}>
        {loading && applications.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8', background: '#0f172a', borderRadius: '8px' }}>
            Loading applications...
          </div>
        ) : pagedApps.length > 0 ? (
          pagedApps.map((app, idx) => {
            const badge = getStatusBadge(app.status);
            const proofUrl = app.screenshot_url || app.application_submitted_screenshot_url || app.screenshot_path;
            const timeStr = app.status_time ? new Date(app.status_time).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

            return (
              <div key={app.id || idx} className="m-app-card" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
                <div className="m-app-card-header">
                  <div>
                    <div className="m-app-company" style={{ color: '#f8fafc' }}>{app.company || 'Unknown Company'}</div>
                    <div className="m-app-role" style={{ color: '#94a3b8' }}>{app.role || 'Workday Position'}</div>
                  </div>
                  <span
                    style={{
                      background: badge.bg,
                      color: badge.color,
                      border: badge.border,
                      padding: '3px 8px',
                      borderRadius: '4px',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {badge.label}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', marginTop: '4px' }}>
                  <span style={{ color: '#64748b' }}>Client:</span>
                  <span style={{ color: '#38bdf8', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                    {app.applywizz_id || '—'}
                  </span>
                </div>

                {app.job_url && (
                  <a
                    href={app.job_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.76rem', color: '#38bdf8', textDecoration: 'underline', wordBreak: 'break-all' }}
                  >
                    🔗 Workday Job Link ↗
                  </a>
                )}

                <div className="m-app-footer" style={{ borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
                  <span className="m-app-time" style={{ color: '#64748b' }}>{timeStr}</span>
                  {proofUrl ? (
                    <button
                      type="button"
                      onClick={() => setPreviewScreenshot(proofUrl)}
                      style={{
                        background: '#065f46',
                        color: '#6ee7b7',
                        border: '1px solid #10b981',
                        borderRadius: '4px',
                        padding: '4px 10px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      📷 Proof
                    </button>
                  ) : (
                    <span style={{ fontSize: '0.75rem', color: '#475569' }}>No proof</span>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b', background: '#0f172a', borderRadius: '8px' }}>
            No applications found in this view.
          </div>
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
          Showing page <strong>{page}</strong> of <strong>{totalPages}</strong> ({filteredApps.length} applications total)
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

      {/* Lightbox Modal for Proof Screenshot */}
      {previewScreenshot && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.88)',
            backdropFilter: 'blur(4px)',
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setPreviewScreenshot(null)}
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
                Application Submission Confirmation Proof
              </span>
              <button
                type="button"
                onClick={() => setPreviewScreenshot(null)}
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
              src={previewScreenshot}
              alt="Submitted Proof Confirmation"
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
