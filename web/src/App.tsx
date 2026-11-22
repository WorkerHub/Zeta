import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AuthProvider, useAuthContext } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import { ThemeColorProvider, useThemeColor } from './hooks/useThemeColor'
import { useLocale } from './hooks/useLocale'

const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const Setup = lazy(() => import('./pages/Setup'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'))
const QueryPage = lazy(() => import('./pages/Query'))
const AccountLayout = lazy(() => import('./pages/AccountLayout'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const SecurityPage = lazy(() => import('./pages/Security'))
const AboutPage = lazy(() => import('./pages/About'))
const AdminPage = lazy(() => import('./pages/admin/AdminLayout'))

function RouteLoading() {
  const { t } = useLocale()
  return (
    <div className="flex h-screen items-center justify-center bg-ink-50 text-ink-500 text-body">
      {t('common.loading')}
    </div>
  )
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext()
  const { ready } = useThemeColor()
  const { t } = useLocale()
  if (loading || !ready)
    return (
      <div className="flex h-screen items-center justify-center bg-ink-50 text-ink-500 text-body">
        {t('common.loading')}
      </div>
    )
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext()
  const { ready } = useThemeColor()
  const { t } = useLocale()
  if (loading || !ready)
    return (
      <div className="flex h-screen items-center justify-center bg-ink-50 text-ink-500 text-body">
        {t('common.loading')}
      </div>
    )
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/query" replace />
  return <>{children}</>
}

export default function App() {
  useTheme()
  return (
    <AuthProvider>
      <ThemeColorProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/verify-email" element={<VerifyEmail />} />
              <Route
                path="/query"
                element={
                  <PrivateRoute>
                    <QueryPage />
                  </PrivateRoute>
                }
              />
              <Route
                element={
                  <PrivateRoute>
                    <AccountLayout />
                  </PrivateRoute>
                }
              >
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/security" element={<SecurityPage />} />
              </Route>
              <Route path="/profile/security" element={<Navigate to="/security" replace />} />
              <Route path="/account" element={<Navigate to="/profile" replace />} />
              <Route path="/account/profile" element={<Navigate to="/profile" replace />} />
              <Route path="/account/security" element={<Navigate to="/security" replace />} />
              <Route
                path="/about"
                element={
                  <PrivateRoute>
                    <AboutPage />
                  </PrivateRoute>
                }
              />
              <Route
                path="/admin/*"
                element={
                  <AdminRoute>
                    <AdminPage />
                  </AdminRoute>
                }
              />
              <Route path="*" element={<Navigate to="/query" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ThemeColorProvider>
    </AuthProvider>
  )
}
