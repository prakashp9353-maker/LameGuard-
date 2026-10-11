'use client'

import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { clearTabAuthentication, hasTabAuthentication } from '@/lib/supabase/tab-session'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [authorized, setAuthorized] = useState(false)

  useEffect(() => {
    let active = true

    async function verifyTabSession() {
      if (!hasTabAuthentication()) {
        const next = `${pathname}${window.location.search}`
        window.location.replace(`/?next=${encodeURIComponent(next)}`)
        return
      }

      try {
        const { data, error } = await createClient().auth.getUser()
        if (error) throw error
        if (!data.user) {
          clearTabAuthentication()
          window.location.replace(`/?next=${encodeURIComponent(pathname)}`)
          return
        }
        if (active) setAuthorized(true)
      } catch {
        clearTabAuthentication()
        window.location.replace(`/?authError=unavailable&next=${encodeURIComponent(pathname)}`)
      }
    }

    void verifyTabSession()
    return () => { active = false }
  }, [pathname])

  if (!authorized) {
    return <main className="auth-page"><p>Verifying your LameGuard session...</p></main>
  }

  return children
}
