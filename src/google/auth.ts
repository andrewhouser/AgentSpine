/**
 * One-time Google sign-in:  npm run auth
 *
 * Loopback OAuth for an installed ("Desktop app") client. It starts a tiny local server,
 * prints a URL for YOU to open and approve in your own browser, receives only the
 * authorization code Google redirects back to 127.0.0.1, and exchanges it for a refresh
 * token stored 0600 outside the repo. This script never sees your password.
 *
 * The default token grants calendar.readonly + gmail.readonly and nothing else.
 *
 *   npm run auth            the read-only token (everything that reads Google)
 *   npm run auth -- write   a SECOND, separate token with gmail.modify + calendar.events, used only by
 *                           src/google/write.ts for the inbox cleanup and bill events. Run it only on
 *                           the machine that should be allowed to change mail and calendar.
 *
 * Setup (once): in Google Cloud Console create a project, enable the Calendar and Gmail
 * APIs, make an OAuth client of type "Desktop app", add yourself as a test user, and put
 * the downloaded client_secret_*.json in ~/.config/agentspine/ (or set GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET in the environment).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { GOOGLE_SCOPES, GOOGLE_TOKEN_PATH, GOOGLE_WRITE_SCOPES, GOOGLE_WRITE_TOKEN_PATH, loadGoogleCreds } from "../config.ts";

const WRITE = process.argv.includes("write");
const SCOPES = WRITE ? GOOGLE_WRITE_SCOPES : GOOGLE_SCOPES;
const TOKEN_PATH = WRITE ? GOOGLE_WRITE_TOKEN_PATH : GOOGLE_TOKEN_PATH;
const KIND = WRITE ? "write" : "read-only";

const PORT = 4477;
const REDIRECT = `http://127.0.0.1:${PORT}`;

const creds = loadGoogleCreds();
if (!creds) {
  console.error(
    "No Google credentials found. Put your client_secret_*.json in ~/.config/agentspine/,\n" +
      "or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. See the top of src/google/auth.ts.",
  );
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

const exchange = async (code: string): Promise<any> => {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  return res.json();
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) return void res.writeHead(400).end("No authorization code received.");
  try {
    const token = await exchange(code);
    if (!token.refresh_token) throw new Error("Google returned no refresh token. Revoke prior access and retry.");
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`agentspine is authorized (${KIND}). You can close this tab.`);
    console.log(`\nSaved ${KIND} token to ${TOKEN_PATH}`);
    console.log("Scopes granted:", SCOPES.join(", "));
    server.close(() => process.exit(0));
  } catch (err) {
    res.writeHead(500).end(err instanceof Error ? err.message : String(err));
    console.error("Auth failed:", err instanceof Error ? err.message : err);
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Open this URL in your browser and approve the ${KIND} access:\n`);
  console.log(authUrl + "\n");
  console.log(`Waiting for the redirect on ${REDIRECT} ...`);
});
