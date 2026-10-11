'use client'

const TAB_SESSION_KEY = 'lameguard:authenticated-tab'

export function markTabAuthenticated() {
  window.sessionStorage.setItem(TAB_SESSION_KEY, 'true')
}

export function clearTabAuthentication() {
  window.sessionStorage.removeItem(TAB_SESSION_KEY)
}

export function hasTabAuthentication() {
  return window.sessionStorage.getItem(TAB_SESSION_KEY) === 'true'
}
