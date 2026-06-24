// Shared request headers: the bearer token plus, when a CSM / Operations Head is acting in a ZM's
// scope (backup cascade, Issue 27), the `X-Acting-As-Zone` header the backend resolves into
// `acted_as_role` for authorization + audit. Modules on ZM-scoped surfaces use this so acted-as
// actions are attributed correctly.

const TOKEN_KEY = 'fsm.accessToken';
const ACTING_ZONE_KEY = 'fsm.actingZone';

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const actingZone = sessionStorage.getItem(ACTING_ZONE_KEY);
  if (actingZone) headers['X-Acting-As-Zone'] = actingZone;
  return headers;
}
