// Accounts. A username + password unlock a per-user data key; nothing is sent anywhere but your own private repo.
//
// Repo layout:  pace/users/<sha256(username)>/account.json   salt + wrapped key (no plaintext data)
//               pace/users/<sha256(username)>/vault.enc      AES-GCM encrypted, gzip-compressed vault
import { createAccountKeys, unlockAccount, rewrapAccount, lockedCopy, userIdFor, encryptText, decryptText } from './crypto.js';
import { GitHubStore, GitHubError, parseRepo, DATA_ROOT } from './github.js';
import { idb } from './idb.js';

const accountPath = (userId) => `${DATA_ROOT}/users/${userId}/account.json`;
const tokenCtx = (userId) => `pace:token:${userId}`;
const LAST_USER = 'pace:lastUser';

export class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function validate(username, password) {
  if (!/^[\w.@+-]{2,64}$/.test(username.trim())) throw new AuthError('BAD_USERNAME', 'Usernames are 2–64 letters, numbers, or . _ - @ +');
  if (password.length < 8) throw new AuthError('WEAK_PASSWORD', 'Use at least 8 characters for your password.');
}

async function openRepo(token, repoInput) {
  const r = parseRepo(repoInput);
  if (!r) throw new AuthError('BAD_REPO', 'Enter the repository as owner/name, for example jane/pace-data.');
  if (!token.trim()) throw new AuthError('NO_TOKEN', 'Paste a GitHub access token.');
  const gh = new GitHubStore({ token: token.trim(), owner: r.owner, repo: r.repo });
  await gh.checkRepo();
  return gh;
}

function remember(username) {
  try { localStorage.setItem(LAST_USER, username); } catch { /* storage may be blocked */ }
}
export function lastUsername() {
  try { return localStorage.getItem(LAST_USER) || ''; } catch { return ''; }
}

async function finish(record, dek, gh, keepSignedIn) {
  remember(record.username);
  if (keepSignedIn) await idb.set('session', { userId: record.userId, key: await lockedCopy(dek) });
  else await idb.del('session');
  return { userId: record.userId, username: record.username, mode: record.mode, dek, gh, record };
}

/** mode: 'github' | 'local' */
export async function createAccount({ username, password, mode, token = '', repo = '', keepSignedIn = false }) {
  validate(username, password);
  const userId = await userIdFor(username);
  if (await idb.get(`acct:${userId}`)) throw new AuthError('EXISTS', 'That username already has an account on this device. Sign in instead.');

  let gh = null;
  if (mode === 'github') {
    gh = await openRepo(token, repo);
    if (await gh.getFile(accountPath(userId))) throw new AuthError('EXISTS', 'That username is already taken in this repository. Sign in instead.');
  }
  const { account, dek } = await createAccountKeys(password);
  if (gh) await gh.putFile(accountPath(userId), JSON.stringify(account, null, 2), undefined, 'Add account');

  const record = {
    userId,
    username: username.trim(),
    mode,
    account,
    gh: gh ? { owner: gh.owner, repo: gh.repo, tokenEnc: await encryptText(dek, gh.token, tokenCtx(userId)) } : null,
    createdAt: Date.now(),
  };
  await idb.set(`acct:${userId}`, record);
  return finish(record, dek, gh, keepSignedIn);
}

/**
 * Sign in. If this device has never seen the account, pass token + repo to fetch it from GitHub.
 * Throws AuthError codes: NEED_GITHUB, NO_ACCOUNT, WRONG_PASSWORD.
 */
export async function signIn({ username, password, token = '', repo = '', keepSignedIn = false }) {
  const userId = await userIdFor(username);
  let record = await idb.get(`acct:${userId}`);
  let gh = null;

  if (token && repo) {
    // Fetching from GitHub also picks up a password changed on another device.
    gh = await openRepo(token, repo);
    const remote = await gh.getFile(accountPath(userId));
    if (!remote) throw new AuthError('NO_ACCOUNT', `No Pace account named “${username.trim()}” in ${gh.owner}/${gh.repo}.`);
    const account = JSON.parse(remote.content);
    record = { ...(record || {}), userId, username: username.trim(), mode: 'github', account, gh: { owner: gh.owner, repo: gh.repo }, createdAt: record?.createdAt || Date.now() };
  } else if (!record) {
    throw new AuthError('NEED_GITHUB', 'This device hasn’t seen that account yet. Connect the GitHub repository it’s stored in.');
  }

  let dek;
  try {
    dek = await unlockAccount(record.account, password);
  } catch {
    throw new AuthError('WRONG_PASSWORD', record.mode === 'github'
      ? 'That password didn’t work. If you changed it on another device, use “Sign in with GitHub” below.'
      : 'That password didn’t work.');
  }

  if (record.mode === 'github') {
    if (gh) {
      record.gh.tokenEnc = await encryptText(dek, gh.token, tokenCtx(userId));
    } else {
      const t = await decryptText(dek, record.gh.tokenEnc, tokenCtx(userId));
      gh = new GitHubStore({ token: t, owner: record.gh.owner, repo: record.gh.repo });
      refreshAccountRecord(gh, record).catch(() => {});
    }
  }
  await idb.set(`acct:${userId}`, record);
  return finish(record, dek, gh, keepSignedIn);
}

/** Keep the local copy of account.json current (e.g. after a password change elsewhere). */
async function refreshAccountRecord(gh, record) {
  const remote = await gh.getFile(accountPath(record.userId));
  if (!remote) return;
  const account = JSON.parse(remote.content);
  if (account.key.wrapped !== record.account.key.wrapped) {
    record.account = account;
    await idb.set(`acct:${record.userId}`, record);
  }
}

/** Restore a "keep me signed in" session, or null. */
export async function resumeSession() {
  const s = await idb.get('session');
  if (!s?.key) return null;
  const record = await idb.get(`acct:${s.userId}`);
  if (!record) return null;
  let gh = null;
  if (record.mode === 'github') {
    try {
      const t = await decryptText(s.key, record.gh.tokenEnc, tokenCtx(record.userId));
      gh = new GitHubStore({ token: t, owner: record.gh.owner, repo: record.gh.repo });
    } catch {
      return null;
    }
  }
  return { userId: record.userId, username: record.username, mode: record.mode, dek: s.key, gh, record };
}

export async function signOut({ forgetDevice = false, userId } = {}) {
  await idb.del('session');
  if (forgetDevice && userId) {
    await idb.del(`acct:${userId}`);
    await idb.del(`vault:${userId}`);
  }
}

export async function changePassword(session, oldPassword, newPassword) {
  if (newPassword.length < 8) throw new AuthError('WEAK_PASSWORD', 'Use at least 8 characters for your new password.');
  const record = await idb.get(`acct:${session.userId}`);
  let dek;
  try { dek = await unlockAccount(record.account, oldPassword); } catch { throw new AuthError('WRONG_PASSWORD', 'Your current password is incorrect.'); }
  const account = await rewrapAccount(record.account, dek, newPassword);
  if (session.gh) {
    const remote = await session.gh.getFile(accountPath(session.userId));
    await session.gh.putFile(accountPath(session.userId), JSON.stringify(account, null, 2), remote?.sha, 'Update account');
  }
  record.account = account;
  await idb.set(`acct:${session.userId}`, record);
  const kept = await idb.get('session');
  if (kept?.userId === session.userId) await idb.set('session', { userId: session.userId, key: await lockedCopy(dek) });
}

/** Move a device-only account to GitHub sync. */
export async function connectGitHub(session, { token, repo }) {
  const gh = await openRepo(token, repo);
  const existing = await gh.getFile(accountPath(session.userId));
  if (existing) throw new AuthError('EXISTS', 'An account with your username already exists in that repository.');
  const record = await idb.get(`acct:${session.userId}`);
  await gh.putFile(accountPath(session.userId), JSON.stringify(record.account, null, 2), undefined, 'Add account');
  record.mode = 'github';
  record.gh = { owner: gh.owner, repo: gh.repo, tokenEnc: await encryptText(session.dek, gh.token, tokenCtx(session.userId)) };
  await idb.set(`acct:${session.userId}`, record);
  session.gh = gh;
  session.mode = 'github';
  session.record = record;
  return gh;
}

/** Swap in a new token (e.g. the old one expired). */
export async function updateToken(session, token) {
  const record = await idb.get(`acct:${session.userId}`);
  const gh = new GitHubStore({ token: token.trim(), owner: record.gh.owner, repo: record.gh.repo });
  await gh.checkRepo();
  record.gh.tokenEnc = await encryptText(session.dek, gh.token, tokenCtx(session.userId));
  await idb.set(`acct:${session.userId}`, record);
  session.gh = gh;
  return gh;
}

export { GitHubError };
