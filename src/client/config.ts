import type { ClientConfig } from './service.tsx'

/** rc.2 does not forward Host bundle config into the browser entry. */
export function normalizeClientConfig(config?: Partial<ClientConfig>): ClientConfig {
  const profileId = config?.profileId?.trim()
  return { profileId: profileId === undefined || profileId === '' ? 'web' : profileId }
}
