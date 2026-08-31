import admin from 'firebase-admin';

const scanId = String(process.env.SCAN_ID || '').trim();
const serviceJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const reason = String(process.env.SCAN_END_REASON || 'cancelled').toLowerCase();
if (!scanId || !serviceJson) process.exit(0);

let credential;
try { credential = JSON.parse(serviceJson); } catch { process.exit(0); }

admin.initializeApp({
  credential: admin.credential.cert(credential),
  databaseURL: 'https://nichegamesfinder-default-rtdb.firebaseio.com',
});
const db = admin.database();
const root = db.ref('nichegames');

try {
  const scanRef = root.child(`scans/${scanId}`);
  const snap = await scanRef.once('value');
  const current = snap.val() || {};
  if (!['complete','error','cancelled','stopped'].includes(String(current.status || ''))) {
    const cancelled = reason === 'cancelled';
    await scanRef.update({
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'cancelled' : 'error',
      label: cancelled ? 'Scan stopped' : 'Scan ended unexpectedly',
      error: cancelled ? 'GitHub Actions run was cancelled.' : 'GitHub Actions ended before the scanner completed.',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const activeSnap = await root.child('meta/activeScanId').once('value');
  if (String(activeSnap.val() || '') === scanId) {
    await root.child('meta').update({
      activeScanId: null,
      scanning: false,
      scanHeartbeatAt: null,
      lastError: reason === 'cancelled' ? 'Scan cancelled' : 'Scan ended unexpectedly',
    });
  }
} catch (error) {
  console.error(`[Nichegames cloud] Could not mark stopped scan: ${error?.message || error}`);
} finally {
  try { db.goOffline(); } catch {}
  try { await admin.app().delete(); } catch {}
}
