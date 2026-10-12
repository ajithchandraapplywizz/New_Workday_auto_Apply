import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Menu, X, RefreshCw } from 'lucide-react';

export default function Header() {
  const { user, switchRole, logout, date, setDate, timeframe, setTimeframe } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const getSubTitle = () => {
    const role = user?.role?.toLowerCase();
    if (role === 'dev' || role === 'developer') return 'APPLYWIZZ / EXTERNALS';
    if (role === 'admin') return 'APPLYWIZZ / OPS';
    return 'APPLYWIZZ';
  };

  const getMainTitle = () => {
    const role = user?.role?.toLowerCase();
    if (role === 'dev' || role === 'developer') return 'Developer Dashboard';
    if (role === 'admin') return 'Admin Dashboard';
    return 'Workday Dashboard';
  };

  const isDeveloperUser = user?.baseRole === 'dev' || user?.role === 'dev' || user?.role === 'developer' || user?.email === 'ajithchandranimmala@applywizz.ai';

  return (
    <header className="video-header">
      <div className="header-top-row">
        {/* Brand & Title */}
        <div className="header-brand-block">
          <div className="header-logo-container">
            <img src="/logo.png" alt="ApplyWizz" className="header-logo-icon" />
          </div>
          <div className="header-title-container">
            <span className="header-sub-label">{getSubTitle()}</span>
            <h1 className="header-main-title">{getMainTitle()}</h1>
          </div>
        </div>

        {/* Mobile Quick Action Bar (Visible only on mobile/small screens) */}
        <div className="header-mobile-bar">
          <button
            type="button"
            className="header-mobile-refresh-btn"
            onClick={() => window.location.reload()}
            title="Refresh Page"
            aria-label="Refresh Page"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className={`header-mobile-menu-btn ${mobileOpen ? 'active' : ''}`}
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-label="Toggle Controls Menu"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
            <span className="header-mobile-role-tag">{user?.role?.toUpperCase() || 'USER'}</span>
          </button>
        </div>

        {/* Global Controls: Role Switcher (Developer Only), Date, Timeframe, Refresh, User */}
        <div className={`header-controls-block ${mobileOpen ? 'mobile-visible' : ''}`}>
          {/* ONLY Developer can switch roles between Dev and Admin */}
          {isDeveloperUser && (
            <div className="role-pill-group" title="Developer Master Override">
              {[
                { id: 'dev', label: 'Dev' },
                { id: 'admin', label: 'Admin' },
              ].map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`role-pill-item ${user?.role === r.id ? 'active' : ''}`}
                  onClick={() => switchRole(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* Date Picker */}
          <div className="control-date-box">
            <span className="control-label-micro">DATE</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="header-date-input"
            />
          </div>

          {/* Timeframe Stats */}
          <div className="control-stats-box">
            <span className="control-label-micro">STATS</span>
            <div className="stats-pill-group">
              {['day', 'week', 'month'].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`stats-pill-item ${timeframe === t ? 'active' : ''}`}
                  onClick={() => setTimeframe(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Refresh Button (Desktop) */}
          <button
            type="button"
            className="header-refresh-btn desktop-only"
            onClick={() => window.location.reload()}
          >
            Refresh
          </button>

          {/* User & Sign Out */}
          <div className="header-user-badge">
            <div className="header-user-info-text">
              <span className="header-user-email">
                {user?.name || user?.email?.split('@')[0]}
              </span>
              <span className="header-user-meta">
                {user?.email} • <span className="header-user-role-highlight">{user?.role?.toUpperCase()}</span>
              </span>
            </div>
            <button
              type="button"
              className="header-signout-btn"
              onClick={logout}
              title="Sign Out"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

