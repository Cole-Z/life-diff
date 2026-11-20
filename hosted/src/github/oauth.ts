import { bindFetch } from "../bind-fetch";

export interface GitHubTokenSet {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
}

export interface GitHubProfile {
  id: number;
  login: string;
}

export interface AuthProps {
  userId: string;
  login: string;
}

/** Props stored on the Life Diff grant. The GitHub token is never included. */
export function authProps(profile: GitHubProfile): AuthProps {
  return { userId: String(profile.id), login: profile.login };
}

export function githubAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export async function exchangeGithubCode(fetchImpl: typeof fetch, input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GitHubTokenSet> {
  return tokenRequest(fetchImpl, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
}

export async function refreshGithubToken(fetchImpl: typeof fetch, input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GitHubTokenSet> {
  return tokenRequest(fetchImpl, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
}

export async function fetchGithubProfile(fetchImpl: typeof fetch, accessToken: string): Promise<GitHubProfile> {
  const response = await bindFetch(fetchImpl)("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "life-diff",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub user lookup failed (${response.status})`);
  const body = await response.json() as { id?: number; login?: string };
  if (typeof body.id !== "number" || typeof body.login !== "string" || !body.login) {
    throw new Error("GitHub did not return a user id");
  }
  return { id: body.id, login: body.login };
}

async function tokenRequest(fetchImpl: typeof fetch, body: Record<string, string>): Promise<GitHubTokenSet> {
  const response = await bindFetch(fetchImpl)("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub token request failed (${response.status})`);
  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!payload.access_token) {
    throw new Error(payload.error === "access_denied" ? "GitHub authorization was declined" : "GitHub did not return an access token");
  }
  const now = Date.now();
  return {
    accessToken: payload.access_token,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(payload.expires_in ? { accessExpiresAt: new Date(now + payload.expires_in * 1000).toISOString() } : {}),
    ...(payload.refresh_token_expires_in ? { refreshExpiresAt: new Date(now + payload.refresh_token_expires_in * 1000).toISOString() } : {}),
  };
}
