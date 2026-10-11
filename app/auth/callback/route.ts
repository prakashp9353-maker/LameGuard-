import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

function isEmailOtpType(
  value: string | null,
): value is 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email' {
  return ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'].includes(value ?? '')
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const tokenHash = requestUrl.searchParams.get('token_hash')
  const otpType = requestUrl.searchParams.get('type')
  const next = requestUrl.searchParams.get('next') ?? '/dashboard'
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard'

  if (!code && (!tokenHash || !isEmailOtpType(otpType))) {
    return NextResponse.redirect(
      new URL('/?authError=confirmation', request.url),
    )
  }

  try {
    const supabase = await createServerSupabaseClient()
    let authError
    if (code) {
      authError = (await supabase.auth.exchangeCodeForSession(code)).error
    } else if (tokenHash && isEmailOtpType(otpType)) {
      authError = (await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType })).error
    } else {
      return NextResponse.redirect(new URL('/?authError=confirmation', request.url))
    }
    if (authError) {
      return NextResponse.redirect(
        new URL('/?authError=confirmation', request.url),
      )
    }
    return NextResponse.redirect(new URL(safeNext, request.url))
  } catch {
    return NextResponse.redirect(
      new URL('/?authError=unavailable', request.url),
    )
  }
}
