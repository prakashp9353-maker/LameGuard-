import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) return NextResponse.next({ request })

  let response = NextResponse.next({ request })
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        )
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        )
      },
    },
  })

  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>
  try {
    authResult = await supabase.auth.getUser()
  } catch {
    const signInUrl = new URL('/', request.url)
    signInUrl.searchParams.set('authError', 'unavailable')
    signInUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
    const redirect = NextResponse.redirect(signInUrl)
    response.cookies.getAll().forEach(cookie => redirect.cookies.set(cookie))
    return redirect
  }

  if (!authResult.error && !authResult.data.user) {
    const signInUrl = new URL('/', request.url)
    signInUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
    const redirect = NextResponse.redirect(signInUrl)
    response.cookies.getAll().forEach(cookie => redirect.cookies.set(cookie))
    return redirect
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*'],
}
