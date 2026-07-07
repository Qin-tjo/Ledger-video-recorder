import type { LedgerApi } from '../../preload'

declare global {
  interface Window {
    ledger: LedgerApi
  }
}

export {}
