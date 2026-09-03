import { createSign } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DeviceTokenService } from './device-token.service';
import {
  LoggingChannelGateway,
  type ChannelDeliveryOutcome,
  type ChannelSendInput,
  type NotificationChannelGateway,
} from './notification-channel.gateway';

/**
 * #337 — the push delivery exit.
 *
 * Everything upstream of this file already worked: the outbox is durable and enqueued in the
 * producing transaction (#338), the in-app row always fires, and `device_tokens` has held one row per
 * user since #76. The only implementation bound to `NOTIFICATION_CHANNEL_GATEWAY` returned
 * `UNAVAILABLE` unconditionally, so nothing had ever left the server and every "the SE is notified"
 * claim in the product was false at the last inch.
 *
 * **This is a seam build.** FCM project credentials are operator provisioning and do not exist yet, so
 * the adapter is written complete and exercised end to end against an injected HTTP stub
 * (`test/fcm-push-delivery.e2e-spec.ts`), while the default binding stays inert. Turning it on is one
 * env var and a service account — no code change, no redeploy of anything but configuration.
 */

// ── configuration ────────────────────────────────────────────────────────────────────────────────

/** The providers the push channel can be bound to. `logging` is the inert default. */
export type PushProvider = 'logging' | 'fcm';

/**
 * Read the push provider switch.
 *
 * Unset or empty is `logging`, which is what keeps every existing test and every existing deployment
 * exactly as it was. An unrecognised value **throws** rather than falling back: a typo that quietly
 * stays inert is how an operator comes to believe push is live when it is not, which is the precise
 * defect this slice exists to close — a fallback here would rebuild it one layer up.
 */
export function resolvePushProvider(env: NodeJS.ProcessEnv = process.env): PushProvider {
  const raw = (env.PUSH_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'logging') return 'logging';
  if (raw === 'fcm') return 'fcm';
  throw new Error(
    `PUSH_PROVIDER="${env.PUSH_PROVIDER}" is not a push provider this build knows. Valid values are ` +
      `"logging" (the inert default) and "fcm". Refusing to fall back to logging: a deployment that ` +
      `believes push is live while it is silently inert is the failure mode this switch exists to prevent.`,
  );
}

/** Service-account credentials for FCM HTTP v1, plus the endpoints (overridable for tests). */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PEM private key. `\n` escapes are unescaped on read, because that is how it survives a .env file. */
  privateKey: string;
  /** Defaults to Google's OAuth 2 token endpoint. */
  tokenUrl?: string;
  /** Defaults to `https://fcm.googleapis.com`. */
  baseUrl?: string;
}

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_BASE_URL = 'https://fcm.googleapis.com';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Read the service account from the environment, or throw naming the first missing key.
 *
 * A partially configured provider is not a usable one, and the failure has to be loud at boot rather
 * than at 05:00 on the first dispatch: an adapter that constructs without credentials would fail every
 * send, one FAILED row at a time, with nobody watching.
 */
export function readFcmConfig(env: NodeJS.ProcessEnv = process.env): FcmConfig {
  const required = ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'] as const;
  for (const key of required) {
    if (!(env[key] ?? '').trim()) {
      throw new Error(
        `PUSH_PROVIDER=fcm but ${key} is not set. The FCM adapter needs a service account ` +
          `(${required.join(', ')}). Set them, or set PUSH_PROVIDER=logging to stay on the inert seam.`,
      );
    }
  }
  return {
    projectId: env.FCM_PROJECT_ID!.trim(),
    clientEmail: env.FCM_CLIENT_EMAIL!.trim(),
    // A PEM in a .env file is one line with literal `\n` in it; unescape so the operator does not have
    // to discover that by reading a crypto error.
    privateKey: env.FCM_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    ...(env.FCM_TOKEN_URL?.trim() ? { tokenUrl: env.FCM_TOKEN_URL.trim() } : {}),
    ...(env.FCM_BASE_URL?.trim() ? { baseUrl: env.FCM_BASE_URL.trim() } : {}),
  };
}

// ── the HTTP port ────────────────────────────────────────────────────────────────────────────────

export interface FcmHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FcmHttpResponse {
  status: number;
  body: string;
}

/**
 * The one thing the adapter cannot own if it is to be testable without a network or a Google project:
 * the POST itself. A stub implementation is what lets the SENT / stale-token / 5xx mapping — the part
 * that actually decides whether an engineer is reachable tomorrow — be pinned by tests today, before
 * any credential exists.
 */
export interface FcmHttpClient {
  post(request: FcmHttpRequest): Promise<FcmHttpResponse>;
}

/** The real one. Node 20+ has global `fetch`; no HTTP dependency is added for this. */
export const fetchHttpClient: FcmHttpClient = {
  async post(request: FcmHttpRequest): Promise<FcmHttpResponse> {
    const res = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body });
    return { status: res.status, body: await res.text() };
  },
};

// ── access tokens ────────────────────────────────────────────────────────────────────────────────

export interface FcmAccessTokenProvider {
  accessToken(): Promise<string>;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Mint the self-signed JWT that Google exchanges for an access token (the `jwt-bearer` grant). Done
 * with `node:crypto` rather than `google-auth-library` because it is fifteen lines and the alternative
 * is a dependency — and its whole surface — inside the one seam that must stay easy to audit.
 */
function signServiceAccountAssertion(config: FcmConfig, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: FCM_SCOPE,
      aud: config.tokenUrl ?? DEFAULT_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(config.privateKey))}`;
}

/**
 * Exchanges the service account for an access token and holds it until shortly before it expires.
 *
 * Cached because the alternative is a second round trip on every single push, and a day-plan dispatch
 * fans out to every engineer in a zone at once. The 60-second safety margin is against the token
 * expiring in flight rather than against clock skew.
 */
export class ServiceAccountTokenProvider implements FcmAccessTokenProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly config: FcmConfig,
    private readonly http: FcmHttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAtMs > now + 60_000) return this.cached.token;

    const res = await this.http.post({
      url: this.config.tokenUrl ?? DEFAULT_TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:
        `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}` +
        `&assertion=${encodeURIComponent(signServiceAccountAssertion(this.config, now))}`,
    });
    if (res.status !== 200) {
      throw new Error(`token endpoint returned ${res.status}: ${truncate(res.body)}`);
    }
    const parsed = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error('token endpoint returned no access_token');
    this.cached = { token: parsed.access_token, expiresAtMs: now + (parsed.expires_in ?? 3600) * 1000 };
    return parsed.access_token;
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────────

const truncate = (s: string, max = 300): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface FcmChannelGatewayDeps {
  config: FcmConfig;
  deviceTokens: DeviceTokenService;
  http?: FcmHttpClient;
  tokens?: FcmAccessTokenProvider;
}

/**
 * FCM HTTP v1 adapter — the push half of the delivery seam, and only the push half.
 *
 * SMS, WhatsApp and email are answered `UNAVAILABLE` here exactly as the inert gateway answers them,
 * so binding this changes the behaviour of one channel and nothing else (#337 AC5).
 *
 * The response mapping is the substance of this class:
 *
 *   - **200 → SENT**, carrying FCM's `name` as the provider message id.
 *   - **404 / 410 → FAILED, and the token row is reaped.** These are FCM's two ways of saying the
 *     registration is gone (app uninstalled, token rotated, project moved). A dead token nobody reaps
 *     is not a one-off failure: it is every future push to that engineer, failing the same way,
 *     forever, while `device_tokens` keeps insisting they are reachable.
 *   - **5xx / 429 / transport error → FAILED, retryable, token untouched.** A provider blip says
 *     nothing about the registration, and reaping on one would take an engineer offline for a reason
 *     that had nothing to do with them.
 *   - **any other 4xx → FAILED, not retryable.** 400/401/403 are a malformed payload or a credential
 *     the operator has to fix; retrying is just the same mistake at a higher rate.
 *
 * Nothing here throws out of `deliver`. A push that cannot be delivered must never damage the outcome
 * it announces — that is #264's guarantee and #338 built the whole outbox around it — so a failure is
 * a recorded result, not an exception travelling back up into a committed dispatch.
 */
export class FcmChannelGateway implements NotificationChannelGateway {
  readonly sendsExternally = true;
  private readonly logger = new Logger('FcmChannelGateway');
  private readonly config: FcmConfig;
  private readonly http: FcmHttpClient;
  private readonly tokens: FcmAccessTokenProvider;
  private readonly deviceTokens: DeviceTokenService;

  constructor(deps: FcmChannelGatewayDeps) {
    this.config = deps.config;
    this.deviceTokens = deps.deviceTokens;
    this.http = deps.http ?? fetchHttpClient;
    this.tokens = deps.tokens ?? new ServiceAccountTokenProvider(this.config, this.http);
  }

  private get sendUrl(): string {
    return `${this.config.baseUrl ?? DEFAULT_BASE_URL}/v1/projects/${this.config.projectId}/messages:send`;
  }

  async deliver(input: ChannelSendInput): Promise<ChannelDeliveryOutcome> {
    // AC5 — this adapter answers for PUSH only; the other three channels stay exactly as inert as
    // they were, so binding it cannot accidentally light up a channel nobody has an account for.
    if (input.channel !== 'PUSH') return 'UNAVAILABLE';

    const registration = await this.deviceTokens.findForUser(input.recipientUserId);
    if (!registration) {
      // UNAVAILABLE, not FAILED: nothing was attempted and nothing is wrong. The chain falls through
      // exactly as it does today, and the row says why it fell through.
      return { status: 'UNAVAILABLE', error: 'no registered device token for this user' };
    }

    let accessToken: string;
    try {
      accessToken = await this.tokens.accessToken();
    } catch (e) {
      // Credentials are an operator problem, but the notice must still not be lost: retryable, because
      // a rotated key or a token endpoint blip both recover without anyone touching this row.
      return { status: 'FAILED', error: `FCM auth failed: ${messageOf(e)}`, retryable: true };
    }

    let response: FcmHttpResponse;
    try {
      response = await this.http.post({
        url: this.sendUrl,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: buildMessage(registration.token, input) }),
      });
    } catch (e) {
      return { status: 'FAILED', error: `FCM transport error: ${messageOf(e)}`, retryable: true };
    }

    if (response.status === 200) {
      return { status: 'SENT', providerMessageId: providerMessageId(response.body) };
    }

    if (response.status === 404 || response.status === 410) {
      // Reap by (user, token): if the handset re-registered while this request was in flight, the row
      // now holds a *live* token and deleting it would silence an engineer who is perfectly reachable.
      const reaped = await this.deviceTokens.deleteStale(input.recipientUserId, registration.token);
      this.logger.warn(
        `FCM ${response.status} for user=${input.recipientUserId} — registration is gone; ` +
          `${reaped ? 'stale token row deleted' : 'token had already been replaced, left alone'}.`,
      );
      return {
        status: 'FAILED',
        error: `FCM ${response.status}: device token is no longer registered${reaped ? ' (stale token row deleted)' : ''}`,
        retryable: false,
      };
    }

    const retryable = response.status >= 500 || response.status === 429;
    const error = `FCM ${response.status}: ${truncate(response.body)}`;
    this.logger.warn(`push to user=${input.recipientUserId} failed — ${error}`);
    return { status: 'FAILED', error, retryable };
  }
}

/**
 * The wire payload (AC1). `notification` is what the OS draws on the lock screen; `data` is what the
 * app reads when the engineer taps it, and FCM v1 rejects a `data` value that is not a string, so
 * absent fields are omitted rather than sent as `null`.
 */
function buildMessage(token: string, input: ChannelSendInput): Record<string, unknown> {
  const data: Record<string, string> = { type: input.type };
  if (input.entityId != null && input.entityId !== '') data.entityId = String(input.entityId);
  if (input.entityType != null && input.entityType !== '') data.entityType = String(input.entityType);
  return {
    token,
    notification: { title: input.title, ...(input.body ? { body: input.body } : {}) },
    data,
  };
}

/** FCM answers a success with `{ "name": "projects/<p>/messages/<id>" }`. */
function providerMessageId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { name?: string };
    return parsed.name ?? null;
  } catch {
    return null;
  }
}

// ── binding ──────────────────────────────────────────────────────────────────────────────────────

export interface ChannelGatewayFactoryDeps {
  deviceTokens: DeviceTokenService;
  env?: NodeJS.ProcessEnv;
  http?: FcmHttpClient;
}

/**
 * Build the bound gateway from configuration (`notifications.module.ts`).
 *
 * Default `logging`, so every existing deployment and every existing test is untouched (AC2). Asking
 * for `fcm` without credentials **aborts the boot** rather than degrading to logging, for the same
 * reason {@link resolvePushProvider} refuses an unknown value: the operator has said out loud that
 * push should be live, and the one outcome they must never get is a system that agrees in the config
 * file and stays silent in the field.
 */
export function createChannelGateway(deps: ChannelGatewayFactoryDeps): NotificationChannelGateway {
  const env = deps.env ?? process.env;
  if (resolvePushProvider(env) === 'logging') return new LoggingChannelGateway();
  return new FcmChannelGateway({
    config: readFcmConfig(env),
    deviceTokens: deps.deviceTokens,
    ...(deps.http ? { http: deps.http } : {}),
  });
}
