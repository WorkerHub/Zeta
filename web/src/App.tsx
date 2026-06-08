import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AuthProvider, useAuthContext } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import { useLocale } from './hooks/useLocale'

const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'))
const QueryPage = lazy(() => import('./pages/Query'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const AboutPage = lazy(() => import('./pages/About'))
const AdminPage = lazy(() => import('./pages/admin/AdminLayout'))

function RouteLoading() {
  return <div className="flex h-screen items-center justify-center text-zinc-500 text-sm">Loading...</div>
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext()
  const { t } = useLocale()
  if (loading) return <div className="flex h-screen items-center justify-center text-zinc-500 text-sm">{t('common.loading')}</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext()
  const { t } = useLocale()
  if (loading) return <div className="flex h-screen items-center justify-center text-zinc-500 text-sm">{t('common.loading')}</div>
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/query" replace />
  return <>{children}</>
}

export default function App() {
  useTheme()
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/query" element={<PrivateRoute><QueryPage /></PrivateRoute>} />
            <Route path="/profile" element={<PrivateRoute><ProfilePage /></PrivateRoute>} />
            <Route path="/about" element={<PrivateRoute><AboutPage /></PrivateRoute>} />
            <Route path="/admin/*" element={<AdminRoute><AdminPage /></AdminRoute>} />
            <Route path="*" element={<Navigate to="/query" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  )
}
