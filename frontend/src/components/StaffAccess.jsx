import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchStaffAccessList,
  authAdminAllowSetup,
  authAdminResetMfa,
} from '../services/api';

export default function StaffAccess() {
  const [staffList, setStaffList] = useState([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffSearch, setStaffSearch] = useState('');
  const [staffFeedback, setStaffFeedback] = useState(null);
  const [staffActionInProgress, setStaffActionInProgress] = useState(null);

  const loadStaffList = useCallback(async () => {
    setStaffLoading(true);
    try {
      const token = localStorage.getItem('applywizz_auth_token') || '';
      const res = await fetchStaffAccessList(token);
      if (res && res.success && Array.isArray(res.staff)) {
        setStaffList(res.staff);
      }
    } catch (err) {
      console.error('Error fetching staff access list:', err);
      setStaffFeedback({
        type: 'error',
        text: `Failed to load staff list: ${err.message}`,
      });
    } finally {
      setStaffLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStaffList();
  }, [loadStaffList]);

  const handleAllowSetup = async (email) => {
    setStaffActionInProgress(email);
    setStaffFeedback(null);
    try {
      const token = localStorage.getItem('applywizz_auth_token') || '';
      await authAdminAllowSetup({ targetEmail: email, token });
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
      await authAdminResetMfa({ targetEmail: email, token });
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
    <div className="tab-body-fade">
      <div className="video-card-section" style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <span className="vcs-title">STAFF AUTHENTICATOR & ACCESS CONTROL</span>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginTop: '0.25rem' }}>
              Manage Microsoft Authenticator enrollment, grant setup permissions for new staff, and reset lost authenticators.
            </p>
          </div>
          <button
            type="button"
            onClick={loadStaffList}
            disabled={staffLoading}
            style={{
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              color: '#60a5fa',
              padding: '6px 14px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
            }}
          >
            {staffLoading ? 'Refreshing...' : '↻ Refresh List'}
          </button>
        </div>

        {staffFeedback && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem 1rem',
              borderRadius: '6px',
              background: staffFeedback.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              border: `1px solid ${staffFeedback.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              color: staffFeedback.type === 'success' ? '#34d399' : '#f87171',
              fontSize: '0.875rem',
            }}
          >
            {staffFeedback.text}
          </div>
        )}
      </div>

      <div className="video-filter-bar" style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        <input
          type="text"
          value={staffSearch}
          onChange={(e) => setStaffSearch(e.target.value)}
          placeholder="Search staff by name, email, or role..."
          className="video-input-search"
          style={{ maxWidth: '400px' }}
        />
        <span style={{ alignSelf: 'center', fontSize: '0.85rem', color: '#94a3b8' }}>
          Showing {filteredStaff.length} of {staffList.length} staff accounts
        </span>
      </div>

      <div className="video-table-container">
        <table className="video-data-table">
          <thead>
            <tr>
              <th>STAFF MEMBER</th>
              <th>ROLE</th>
              <th>ENROLLED</th>
              <th>SETUP ALLOWED</th>
              <th>LAST SEEN</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredStaff.length > 0 ? (
              filteredStaff.map((member) => {
                const isEnrolled = Boolean(member.mfa_enrolled);
                const isSetupAllowed = Boolean(member.setup_allowed);
                const isWorking = staffActionInProgress === member.email;

                return (
                  <tr key={member.id || member.email}>
                    <td>
                      <div>
                        <strong>{member.name || 'Staff User'}</strong>
                        <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>{member.email}</div>
                      </div>
                    </td>
                    <td>
                      <span
                        style={{
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          fontSize: '0.75rem',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          background:
                            member.role === 'admin'
                              ? 'rgba(239, 68, 68, 0.2)'
                              : member.role === 'developer'
                              ? 'rgba(168, 85, 247, 0.2)'
                              : member.role === 'manager'
                              ? 'rgba(59, 130, 246, 0.2)'
                              : 'rgba(100, 116, 139, 0.2)',
                          color:
                            member.role === 'admin'
                              ? '#f87171'
                              : member.role === 'developer'
                              ? '#c084fc'
                              : member.role === 'manager'
                              ? '#60a5fa'
                              : '#cbd5e1',
                        }}
                      >
                        {member.role || 'staff'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`video-status-tag ${isEnrolled ? 'active' : 'inactive'}`}
                        style={{
                          background: isEnrolled ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: isEnrolled ? '#34d399' : '#f87171',
                          border: `1px solid ${isEnrolled ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                        }}
                      >
                        {isEnrolled ? 'YES' : 'NO'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`video-status-tag ${isSetupAllowed ? 'active' : 'inactive'}`}
                        style={{
                          background: isSetupAllowed ? 'rgba(59, 130, 246, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                          color: isSetupAllowed ? '#60a5fa' : '#94a3b8',
                          border: `1px solid ${isSetupAllowed ? 'rgba(59, 130, 246, 0.3)' : 'rgba(100, 116, 139, 0.3)'}`,
                        }}
                      >
                        {isSetupAllowed ? 'YES' : 'NO'}
                      </span>
                    </td>
                    <td style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                      {member.last_seen_at ? new Date(member.last_seen_at).toLocaleTimeString() : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => handleAllowSetup(member.email)}
                          disabled={isWorking}
                          style={{
                            padding: '5px 10px',
                            borderRadius: '5px',
                            border: '1px solid #3b82f6',
                            background: 'rgba(59, 130, 246, 0.15)',
                            color: '#60a5fa',
                            fontWeight: 600,
                            fontSize: '0.75rem',
                            cursor: isWorking ? 'wait' : 'pointer',
                          }}
                        >
                          Allow setup
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResetMfa(member.email)}
                          disabled={isWorking}
                          style={{
                            padding: '5px 10px',
                            borderRadius: '5px',
                            border: '1px solid #ef4444',
                            background: 'rgba(239, 68, 68, 0.15)',
                            color: '#f87171',
                            fontWeight: 600,
                            fontSize: '0.75rem',
                            cursor: isWorking ? 'wait' : 'pointer',
                          }}
                        >
                          Reset authenticator
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                  {staffLoading ? 'Loading staff access list...' : 'No staff accounts found.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
