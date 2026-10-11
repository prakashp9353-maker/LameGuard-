'use client'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Eye, EyeOff, Leaf } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setSaving(true)
    try {
      const { data: { user }, error: userError } = await createClient().auth.getUser()
      if (userError) throw userError
      if (!user) throw new Error('This password reset link is invalid or expired. Request a new one.')
      const { error: updateError } = await createClient().auth.updateUser({ password })
      if (updateError) throw updateError
      setMessage('Your password has been updated. You can now sign in with it.')
      setPassword('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update your password.')
    } finally {
      setSaving(false)
    }
  }

  return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Leaf size={16} /></span><span>LameGuard <b>AI</b></span></div><div className="auth-heading"><p className="eyebrow">Account recovery</p><h1>Choose a new password</h1><p>Set a new password for your LameGuard account.</p></div><form onSubmit={submit} className="auth-form"><label htmlFor="new-password">New password<span className="password-input-wrap"><input id="new-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" minLength={6} required /><button className="password-visibility" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="auth-message" role="status">{message}</p>}{!message && <button className="hero-button auth-submit" disabled={saving}>{saving ? 'Updating...' : 'Update password'} <ArrowUpRight size={16} /></button>}</form><p className="auth-footer"><Link href="/">Return to sign in</Link></p></section></main>
}
