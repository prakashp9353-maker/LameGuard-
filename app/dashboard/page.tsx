'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  FileImage,
  LayoutDashboard,
  Leaf,
  LogOut,
  Settings,
  ShieldCheck,
  Stethoscope,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { clearTabAuthentication } from '@/lib/supabase/tab-session'

type Prediction = {
  id: string
  media_type: 'image' | 'video'
  predicted_class: 'healthy-cow' | 'limping-cow' | null
  confidence: number | null
  status: 'processing' | 'completed' | 'failed'
  created_at: string
}

type Counts = { total: number; healthy: number; lame: number; completed: number }

function predictionLabel(value: Prediction['predicted_class']) {
  if (value === 'limping-cow') return 'Lameness Detected'
  if (value === 'healthy-cow') return 'Lameness Not Detected'
  return 'Unable to Assess Lameness'
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function DashboardPage() {
  const [email, setEmail] = useState('')
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [counts, setCounts] = useState<Counts>({ total: 0, healthy: 0, lame: 0, completed: 0 })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const supabase = createClient()
        const { data: { user }, error: userError } = await supabase.auth.getUser()
        if (userError) throw userError
        if (!user) {
          window.location.replace('/')
          return
        }
        if (active) setEmail(user.email ?? '')
        const table = supabase.from('lameguard_predictions')
        const [total, healthy, lame, completed, latest] = await Promise.all([
          table.select('id', { count: 'exact', head: true }).eq('user_id', user.id),
          table.select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'completed').eq('predicted_class', 'healthy-cow'),
          table.select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'completed').eq('predicted_class', 'limping-cow'),
          table.select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'completed'),
          table.select('id,media_type,predicted_class,confidence,status,created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10),
        ])
        const queryError = total.error ?? healthy.error ?? lame.error ?? completed.error ?? latest.error
        if (queryError) throw queryError
        if (
          typeof total.count !== 'number' ||
          typeof healthy.count !== 'number' ||
          typeof lame.count !== 'number' ||
          typeof completed.count !== 'number' ||
          !latest.data
        ) {
          throw new Error('Supabase did not return complete prediction counts and history.')
        }
        if (!active) return
        setCounts({
          total: total.count,
          healthy: healthy.count,
          lame: lame.count,
          completed: completed.count,
        })
        setPredictions(latest.data as Prediction[])
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Unable to load your dashboard. Check the Supabase configuration and table policies.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  async function signOut() {
    try {
      const { error: signOutError } = await createClient().auth.signOut()
      if (signOutError) throw signOutError
      clearTabAuthentication()
      window.location.assign('/')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign out. Please try again.')
    }
  }

  if (loading) return <main className="auth-page"><p>Loading your LameGuard workspace...</p></main>

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Leaf size={16} /></span><span>LameGuard <b>AI</b></span></div>
        <nav aria-label="Workspace navigation">
          <p className="nav-label">Workspace</p>
          <Link className="nav-link active" href="/dashboard"><LayoutDashboard size={17} />Overview</Link>
          <Link className="nav-link" href="/dashboard/history"><Clock3 size={17} />Prediction history</Link>
          <Link className="nav-link" href="/dashboard/settings"><Settings size={17} />Settings</Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="user-card"><div className="avatar">{email.slice(0, 2).toUpperCase()}</div><div><p>{email || 'Signed-in user'}</p><span>Authenticated user</span></div></div>
          <button className="nav-link" onClick={signOut}><LogOut size={17} />Sign out</button>
        </div>
      </aside>
      <main className="main-content" id="overview">
        <header className="topbar"><div><p className="eyebrow">Private workspace</p><h1>Your prediction overview</h1></div><Link className="hero-button" href="/dashboard/predict">New prediction <ArrowUpRight size={16} /></Link></header>
        <section className="hero"><div><h2 style={{ marginTop: 0 }}>Detect lameness<br /><em>before it becomes a problem.</em></h2><Link className="hero-button" href="/dashboard/predict">Start a prediction <ArrowUpRight size={16} /></Link></div></section>
        <div className="section-heading"><div><p className="eyebrow">Your workspace</p><h3>Prediction overview</h3></div></div>
        {error && <p className="form-error dashboard-error" role="alert">{error}</p>}
        {!error && <section className="stats-grid">
          <Stat label="Total predictions" value={counts.total} detail="Saved records" icon={Activity} />
          <Stat label="Lameness Not Detected" value={counts.healthy} detail="Completed results" icon={CheckCircle2} />
          <Stat label="Lameness Detected" value={counts.lame} detail="Completed results" icon={Stethoscope} />
          <Stat label="Completed analyses" value={counts.completed} detail="Successful inference" icon={ShieldCheck} />
        </section>}
        <section className="panel activity-panel" id="history">
          <div className="panel-head"><div><h3>Recent prediction history</h3><p>Only records belonging to your authenticated account.</p></div><Link href="/dashboard/history">View all</Link></div>
          {error ? <p className="muted-message">Prediction history could not be loaded.</p> : loading ? <p>Loading prediction history...</p> : predictions.length === 0 ? <div className="empty-state"><FileImage size={28} /><h3>No predictions yet</h3><p>Complete a real model analysis to create your first saved record.</p><Link className="hero-button" href="/dashboard/predict">Upload an image <ArrowUpRight size={16} /></Link></div> : (
            <div className="table-wrap"><table><thead><tr><th>Created</th><th>Result</th><th>Confidence</th><th>Status</th></tr></thead><tbody>{predictions.map(prediction => <tr key={prediction.id}><td>{formatDate(prediction.created_at)}</td><td>{predictionLabel(prediction.predicted_class)}</td><td>{prediction.status !== 'completed' || prediction.confidence == null ? '—' : `${(prediction.confidence * 100).toFixed(1)}%`}</td><td>{prediction.status}</td></tr>)}</tbody></table></div>
          )}
        </section>
        <footer><span>© 2026 LameGuard AI</span><span>Model results are informational and require veterinary review.</span></footer>
      </main>
    </div>
  )
}

function Stat({ label, value, detail, icon: Icon }: { label: string; value: number | string; detail: string; icon: typeof Activity }) {
  return <div className="stat-card"><div className="stat-icon green"><Icon size={18} /></div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div>
}
