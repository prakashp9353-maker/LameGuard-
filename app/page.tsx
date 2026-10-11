'use client'

import { FormEvent, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Eye, EyeOff, Leaf } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { hasTabAuthentication, markTabAuthenticated } from '@/lib/supabase/tab-session'

function authErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Unable to sign in. Please try again.'
  if (error.message.toLowerCase().includes('not configured')) return error.message
  if (/email not confirmed|confirm your email/i.test(error.message)) {
    return 'Your email is not confirmed yet. Use the confirmation link sent to your inbox.'
  }
  if (/invalid login credentials/i.test(error.message)) {
    return 'Invalid email or password.'
  }
  return 'Supabase is unavailable right now. Check your connection and try again.'
}

export default function SignInPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authenticating, setAuthenticating] = useState(false)

  useEffect(() => {
    let active = true
    const query = new URLSearchParams(window.location.search)
    if (query.get('authError') === 'confirmation') {
      setError('The confirmation link is invalid or expired. Sign in after confirming your email or request a new link.')
    } else if (query.get('authError') === 'unavailable') {
      setError('Supabase is unavailable. Check your configuration and try again.')
    }
    if (query.has('authError')) return () => { active = false }

    async function redirectIfSignedIn() {
      try {
        if (!hasTabAuthentication()) return
        const { data: { user }, error: authError } = await createClient().auth.getUser()
        if (!active || authError || !user) return
        const requestedPath = query.get('next')
        const destination =
          requestedPath?.startsWith('/') && !requestedPath.startsWith('//')
            ? requestedPath
            : '/dashboard'
        window.location.replace(destination)
      } catch (cause) {
        if (active) setError(authErrorMessage(cause))
      }
    }
    void redirectIfSignedIn()
    return () => { active = false }
  }, [])

  async function signIn(event: FormEvent) {
    event.preventDefault()
    setAuthenticating(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) throw signInError
      const requestedPath = new URLSearchParams(window.location.search).get('next')
      const destination =
        requestedPath?.startsWith('/') && !requestedPath.startsWith('//')
          ? requestedPath
          : '/dashboard'
      if (!data.user) throw new Error('Supabase did not return a signed-in user.')
      markTabAuthenticated()
      window.location.assign(destination)
    } catch (cause) {
      setError(authErrorMessage(cause))
      setAuthenticating(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand"><span className="brand-mark"><Leaf size={16} /></span><span>LameGuard <b>AI</b></span></div>
        <div className="auth-heading">
          <p className="eyebrow">Secure workspace</p>
          <h1 id="auth-title">Sign in to LameGuard</h1>
        </div>
        <form onSubmit={signIn} className="auth-form">
          <label htmlFor="email">Email address<input id="email" name="email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@farm.com" autoComplete="email" required /></label>
          <label htmlFor="password">Password<span className="password-input-wrap"><input id="password" name="password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" required /><button className="password-visibility" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
          <div className="auth-options"><Link href="/forgot-password">Forgot password?</Link></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="hero-button auth-submit" disabled={authenticating}>{authenticating ? 'Signing in...' : 'Sign in'} <ArrowUpRight size={16} /></button>
        </form>
        <p className="auth-footer">Don&apos;t have an account? <Link href="/sign-up">Sign up</Link></p>
      </section>
    </main>
  )
}
