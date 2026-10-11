'use client'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Leaf } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { markTabAuthenticated } from '@/lib/supabase/tab-session'

export default function SignUpPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setSubmitting(true)
    try {
      const { data, error: signUpError } = await createClient().auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      })
      if (signUpError) throw signUpError
      if (data.session) {
        markTabAuthenticated()
        window.location.assign('/dashboard')
        return
      }
      setMessage('Account request received. Check your email to confirm your address before signing in.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create your account. Check your Supabase configuration and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Leaf size={16} /></span><span>LameGuard <b>AI</b></span></div><div className="auth-heading"><p className="eyebrow">Get started</p><h1>Create your account</h1><p>Set up a secure workspace for your private prediction history.</p></div><form onSubmit={submit} className="auth-form"><label htmlFor="signup-email">Email address<input id="signup-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@farm.com" autoComplete="email" required /></label><label htmlFor="signup-password">Password<input id="signup-password" type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Create a password" autoComplete="new-password" minLength={6} required /></label>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="auth-message" role="status">{message}</p>}<button className="hero-button auth-submit" disabled={submitting}>{submitting ? 'Creating account...' : 'Create account'} <ArrowUpRight size={16} /></button></form><p className="auth-footer">Already have an account? <Link href="/">Sign in</Link></p></section></main>
}
