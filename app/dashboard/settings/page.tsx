'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, Leaf, LogOut } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { clearTabAuthentication } from '@/lib/supabase/tab-session'

export default function SettingsPage() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    async function loadAccount() {
      try {
        const { data, error: authError } = await createClient().auth.getUser()
        if (!active) return
        if (authError) setError(authError.message)
        else if (!data.user) window.location.replace('/')
        else setEmail(data.user.email ?? '')
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load account details.')
      }
    }
    void loadAccount()
    return () => { active = false }
  }, [])
  async function signOut() {
    const { error: signOutError } = await createClient().auth.signOut()
    if (signOutError) throw signOutError
    clearTabAuthentication()
    window.location.assign('/')
  }
  return <main className="page-frame"><Link href="/dashboard" className="back-link"><ArrowLeft size={16} /> Back to dashboard</Link><div className="page-heading"><p className="eyebrow">Workspace</p><h1>Settings</h1><p>Manage your account and connection details.</p></div><section className="surface-card settings-card"><div className="settings-brand"><span className="brand-mark"><Leaf size={16} /></span><div><strong>Account</strong><p>Your authenticated Supabase account</p></div></div>{error && <p className="form-error" role="alert">{error}</p>}<label className="field-label" htmlFor="account-email">Email address<input id="account-email" value={email} readOnly /></label><div className="settings-divider" /><div className="settings-row"><div><strong>Prediction service</strong><p>{process.env.NEXT_PUBLIC_API_BASE_URL ? 'Configured FastAPI endpoint' : 'Not configured in this environment'}</p></div><span className="status-pill"><Check size={14} /> Configuration</span></div>{message && <p className="success-message">{message}</p>}<button className="secondary-button" onClick={() => void signOut().then(() => setMessage('Signed out.')).catch(cause => setError(cause instanceof Error ? cause.message : 'Unable to sign out.'))}><LogOut size={16} /> Sign out</button></section></main>
}
