/**
 * The acting identity behind a config/reference-data mutation, taken from the verified access
 * token. Shared by every Operations-Head-owned config service (settings, org reference data)
 * so audit attribution is uniform. Structurally compatible with AccessTokenClaims.
 */
export interface ConfigActor {
  user_id: string;
  role: string;
  acted_as_role?: string | null;
}
