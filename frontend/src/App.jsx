import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import Header from './components/Header';
import MicrosoftAuthModal from './components/MicrosoftAuthModal';
import DeveloperDashboard from './pages/DeveloperDashboard';
import AdminDashboard from './pages/AdminDashboard';
import LoginPage from './pages/LoginPage';
import './App.css';

function MainLayout() {
  const { user, isAuthModalOpen, setIsAuthModalOpen, isVerifyingSession, authError } = useAuth();

  const allowedRoles = ['admin', 'dev', 'developer'];
  const isStaff = user && allowedRoles.includes(user.role?.toLowerCase());

  // Show verifying state while session is being verified to prevent any flash of dashboard
  if (isVerifyingSession && user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0d14', color: '#94a3b8' }}>
        <span>Verifying authorization...</span>
      </div>
    );
  }

  // If not logged in or not authorized staff, render LoginPage with Access Denied and NEVER render dashboard
  if (!user || !isStaff) {
    return <LoginPage accessDenied={Boolean(user && !isStaff) || Boolean(authError)} />;
  }

  const isDev = user?.role === 'dev' || user?.role === 'developer';

  return (
    <div className="video-app-wrapper">
      {/* Top Header */}
      <Header />

      {/* Microsoft Authenticator Sign In / Sign Up Modal */}
      <MicrosoftAuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

      {/* Main Role-Specific View */}
      <main className="video-main-content">
        {isDev ? <DeveloperDashboard /> : <AdminDashboard />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainLayout />
    </AuthProvider>
  );
}

