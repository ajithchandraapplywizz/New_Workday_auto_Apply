import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { authCheckEmail, authSetupStart } from '../services/api';
import {
  ShieldCheck,
  Mail,
  KeyRound,
  ArrowRight,
  Zap,
  CheckCircle2,
  AlertCircle,
  QrCode,
  Smartphone,
  Layers,
  ArrowLeft,
  Lock,
} from 'lucide-react';
import './LoginPage.css';

export default function LoginPage({ accessDenied }) {
  const { loginWithMfa, confirmMfaSetup, authError, setAuthError } = useAuth();

  // Step state: 'email' (Step 1) | 'code' (Step 2A: enter_code) | 'setup' (Step 2B: setup)
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  // Setup state for Step 2B
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [otpauthUri, setOtpauthUri] = useState('');

  // ── Step 1: Check Email ──
  const handleCheckEmailSubmit = async (e) => {
    if (e) e.preventDefault();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Please enter a valid work email address');
      return;
    }

    setError('');
    setInfoMessage('');
    if (setAuthError) setAuthError('');
    setLoading(true);

    try {
      const res = await authCheckEmail({ email: cleanEmail });

      if (res.state === 'enter_code') {
        // Step 2A: Enrolled staff -> code box ONLY. NO QR, NO setup buttons.
        setStep('code');
        setCode('');
      } else if (res.state === 'setup') {
        // Step 2B: First-time setup allowed -> fetch QR code
        const setupRes = await authSetupStart({ email: cleanEmail });
        setQrDataUrl(setupRes.qrDataUrl || '');
        setOtpauthUri(setupRes.otpauthUri || '');
        setStep('setup');
        setCode('');
      } else if (res.state === 'ask_admin') {
        setInfoMessage('Your account is not enabled for setup yet. Contact your admin.');
      } else if (res.state === 'not_authorised') {
        setError('This email is not authorised for this portal.');
      } else if (res.status === 429) {
        setError('Too many requests. Please wait a moment and try again.');
      } else {
        setError(res.error || 'This email is not authorised for this portal.');
      }
    } catch (err) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) {
        setError('Network error: Unable to connect to the authentication server. Please check your connection.');
      } else {
        setError(err.message || 'Unable to verify email. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2A: Enter 6-digit Code for Enrolled User ──
  const handleLoginSubmit = async (e) => {
    if (e) e.preventDefault();
    const cleanCode = String(code || '').trim();
    if (!cleanCode || cleanCode.length !== 6) {
      setError('Please enter your 6-digit Microsoft Authenticator code');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await loginWithMfa({
        email: email.trim().toLowerCase(),
        code: cleanCode,
      });
    } catch (err) {
      const msg = err.data?.error || err.message || '';
      if (err.status === 423 || msg.toLowerCase().includes('locked')) {
        setError(msg || 'Account is temporarily locked due to repeated failed attempts. Please wait 15 minutes.');
      } else if (msg.toLowerCase().includes('already been used') || err.status === 400) {
        setError('This code has already been used. Please wait for the next 30-second code on your authenticator.');
      } else if (err.status === 401) {
        setError('Invalid authentication code. Please check your Microsoft Authenticator and try again.');
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setError('Network error: Authentication server is unreachable.');
      } else {
        setError(msg || 'Authentication failed. Please verify the code.');
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2B: Confirm First-Time Setup ──
  const handleSetupConfirmSubmit = async (e) => {
    if (e) e.preventDefault();
    const cleanCode = String(code || '').trim();
    if (!cleanCode || cleanCode.length !== 6) {
      setError('Please enter the 6-digit code shown in Microsoft Authenticator');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await confirmMfaSetup({
        email: email.trim().toLowerCase(),
        code: cleanCode,
      });
    } catch (err) {
      const msg = err.message || '';
      if (err.status === 400 || msg.toLowerCase().includes('invalid')) {
        setError('Invalid verification code. Please ensure you enter the latest code from your Authenticator app.');
      } else {
        setError(msg || 'Setup confirmation failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Back to Step 1
  const handleBackToEmail = () => {
    setStep('email');
    setCode('');
    setError('');
    setInfoMessage('');
    setQrDataUrl('');
  };

  return (
    <div className="login-page-root">
      <div className="login-ambient-glow top-left" />
      <div className="login-ambient-glow bottom-right" />

      <div className="login-container">
        {/* Left Hero Pane */}
        <div className="login-hero-pane">
          <div>
            <div className="hero-brand-badge">
              <Zap size={14} />
              <span>ApplyWizz Autonomous Engine</span>
            </div>

            <h1 className="hero-title">
              Workday <span className="hero-gradient-text">Auto-Apply</span> Suite
            </h1>

            <p className="hero-description">
              Enterprise automation portal orchestrating link-clustered fair-share job applications,
              real-time DOM self-healing, and multi-tier candidate answer resolution.
            </p>

            <div className="hero-features-list">
              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <ShieldCheck size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Microsoft Authenticator (TOTP)</h4>
                  <p>Enterprise server-side RFC 6238 time-based two-factor authentication.</p>
                </div>
              </div>

              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <Layers size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Role-Based Access Control</h4>
                  <p>Automatic identity routing for Developer, Admin, Manager, and Career Associates.</p>
                </div>
              </div>

              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <Lock size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Protected Staff Portal</h4>
                  <p>Strict staff authorization with replay protection and encrypted secret storage.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="hero-footer-status">
            <div className="status-indicator">
              <span className="pulse-dot" />
              <span>Pipeline Daemon Active</span>
            </div>
            <span>v2.4 Enterprise Production Build</span>
          </div>
        </div>

        {/* Right Form Pane */}
        <div className="login-form-pane">
          <div className="login-form-header">
            <h2 className="form-title" id="login-heading">
              {step === 'email' && 'Sign In'}
              {step === 'code' && 'Enter Verification Code'}
              {step === 'setup' && 'Set Up Authenticator'}
            </h2>
            <p className="form-subtitle">
              {step === 'email' && 'Enter your official ApplyWizz work email to continue'}
              {step === 'code' && `Enter the 6-digit code for ${email}`}
              {step === 'setup' && `Scan the QR code with Microsoft Authenticator for ${email}`}
            </p>
          </div>

          {/* Error / Alert / Info Messages */}
          {(error || accessDenied || authError) && (
            <div
              className="auth-msg-box error"
              id="login-error-alert"
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                borderColor: 'rgba(239, 68, 68, 0.4)',
                color: '#fca5a5',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 14px',
                borderRadius: '8px',
                marginBottom: '1rem',
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span id="login-error-message">
                {error || authError || 'Access denied: Unauthorized email. Only staff accounts are permitted.'}
              </span>
            </div>
          )}

          {infoMessage && (
            <div
              className="auth-msg-box info"
              id="login-info-alert"
              style={{
                background: 'rgba(56, 189, 248, 0.12)',
                borderColor: 'rgba(56, 189, 248, 0.35)',
                color: '#7dd3fc',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 14px',
                borderRadius: '8px',
                marginBottom: '1rem',
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span id="login-info-message">{infoMessage}</span>
            </div>
          )}

          {/* ═════════════════════════════════════════════════════════════ */}
          {/* STEP 1: EMAIL INPUT                                           */}
          {/* ═════════════════════════════════════════════════════════════ */}
          {step === 'email' && (
            <form onSubmit={handleCheckEmailSubmit} id="login-email-form">
              <div className="form-group">
                <label className="form-label" htmlFor="login-email">
                  WORK EMAIL ADDRESS
                </label>
                <div className="input-with-icon">
                  <Mail size={16} className="input-icon" />
                  <input
                    id="login-email"
                    type="email"
                    className="form-input"
                    placeholder="name@applywizz.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    autoComplete="email"
                    autoFocus
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                id="btn-login-continue"
                className="btn-submit-main"
                disabled={loading || !email.trim()}
              >
                {loading ? (
                  <span>Checking authorization...</span>
                ) : (
                  <>
                    <span>Continue</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>
          )}

          {/* ═════════════════════════════════════════════════════════════ */}
          {/* STEP 2A: CODE BOX ONLY (Enrolled User — NO QR, NO SETUP BTN)  */}
          {/* ═════════════════════════════════════════════════════════════ */}
          {step === 'code' && (
            <form onSubmit={handleLoginSubmit} id="login-code-form">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                  Signing in as <strong style={{ color: '#f8fafc' }}>{email}</strong>
                </span>
                <button
                  type="button"
                  id="btn-change-email"
                  onClick={handleBackToEmail}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: 0,
                  }}
                >
                  <ArrowLeft size={12} />
                  <span>Change email</span>
                </button>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="login-code">
                  MICROSOFT AUTHENTICATOR 6-DIGIT CODE
                </label>
                <div className="input-with-icon">
                  <KeyRound size={16} className="input-icon" />
                  <input
                    id="login-code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    className="form-input code-input"
                    placeholder="------"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    disabled={loading}
                    autoComplete="one-time-code"
                    autoFocus
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                id="btn-login-submit"
                className="btn-submit-main"
                disabled={loading || code.trim().length !== 6}
              >
                {loading ? (
                  <span>Verifying code...</span>
                ) : (
                  <>
                    <span>Verify & Sign In</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>
          )}

          {/* ═════════════════════════════════════════════════════════════ */}
          {/* STEP 2B: FIRST-TIME SETUP (QR Code + 6-Digit Confirm Box)     */}
          {/* ═════════════════════════════════════════════════════════════ */}
          {step === 'setup' && (
            <form onSubmit={handleSetupConfirmSubmit} id="login-setup-form">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                  Setting up for <strong style={{ color: '#f8fafc' }}>{email}</strong>
                </span>
                <button
                  type="button"
                  id="btn-change-email-setup"
                  onClick={handleBackToEmail}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: 0,
                  }}
                >
                  <ArrowLeft size={12} />
                  <span>Change email</span>
                </button>
              </div>

              <div
                id="setup-instructions-card"
                style={{
                  background: 'rgba(30, 41, 59, 0.5)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '12px',
                  padding: '16px',
                  marginBottom: '16px',
                }}
              >
                <div style={{ fontSize: '0.85rem', color: '#cbd5e1', lineHeight: '1.5', marginBottom: '12px' }}>
                  <strong>Setup Instructions:</strong>
                  <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    <li>Open <strong>Microsoft Authenticator</strong> on your phone</li>
                    <li>Tap <strong>+</strong> &rarr; <strong>Work or school account</strong> &rarr; <strong>Scan QR code</strong></li>
                    <li>Scan the QR code below:</li>
                  </ol>
                </div>

                {qrDataUrl && (
                  <div
                    id="mfa-qr-container"
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      background: '#ffffff',
                      padding: '12px',
                      borderRadius: '8px',
                      width: 'fit-content',
                      margin: '0 auto 12px auto',
                    }}
                  >
                    <img
                      id="mfa-qr-image"
                      src={qrDataUrl}
                      alt="Microsoft Authenticator QR Code"
                      style={{ width: '180px', height: '180px', display: 'block' }}
                    />
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="setup-confirm-code">
                  ENTER 6-DIGIT CODE TO CONFIRM SETUP
                </label>
                <div className="input-with-icon">
                  <KeyRound size={16} className="input-icon" />
                  <input
                    id="setup-confirm-code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    className="form-input code-input"
                    placeholder="------"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    disabled={loading}
                    autoComplete="one-time-code"
                    autoFocus
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                id="btn-confirm-setup"
                className="btn-submit-main"
                disabled={loading || code.trim().length !== 6}
              >
                {loading ? (
                  <span>Enrolling & Verifying...</span>
                ) : (
                  <>
                    <span>Confirm & Sign In</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
