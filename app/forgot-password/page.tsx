'use client'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Leaf } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setSending(true)
    try {
      const { error: resetError } = await createClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      })
      if (resetError) throw resetError
      setMessage('If an account exists for that email, you will receive reset instructions shortly.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to send a password reset email. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Leaf size={16} /></span><span>LameGuard <b>AI</b></span></div><div className="auth-heading"><p className="eyebrow">Account recovery</p><h1>Reset your password</h1><p>Enter your email and Supabase will send secure recovery instructions.</p></div><form onSubmit={submit} className="auth-form"><label htmlFor="reset-email">Email address<input id="reset-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@farm.com" autoComplete="email" required /></label>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="auth-message" role="status">{message}</p>}<button className="hero-button auth-submit" disabled={sending}>{sending ? 'Sending...' : 'Send reset link'} <ArrowUpRight size={16} /></button></form><p className="auth-footer">Remember your password? <Link href="/">Sign in</Link></p></section></main>
}
