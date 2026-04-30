import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuthContext } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import Login from './pages/Login'
import Register from './pages/Register'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import VerifyEmail from './pages/VerifyEmail'
import QueryPage from './pages/Query'
import ProfilePage from './pages/Profile'
import AdminPage from './pages/admin/AdminLayout'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext()
  if (loading) return <div className="flex h-screen items-center justify-center text-zinc-500 text-sm">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext()
  if (loading) return <div className="flex h-screen items-center justify-center text-zinc-500 text-sm">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/query" replace />
  return <>{children}</>
}

export default function App() {
  useTheme()
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/query" element={<PrivateRoute><QueryPage /></PrivateRoute>} />
          <Route path="/profile" element={<PrivateRoute><ProfilePage /></PrivateRoute>} />
          <Route path="/admin/*" element={<AdminRoute><AdminPage /></AdminRoute>} />
          <Route path="*" element={<Navigate to="/query" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
