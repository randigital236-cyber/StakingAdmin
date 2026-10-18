// ============================================================
// ADMIN PANEL - RND STAKING (Final v8 - Step 1 Updated)
// ============================================================
// Changes from v7:
//   - ❌ REMOVED: Direct Offer Overview card from Dashboard
//   - ❌ REMOVED: Direct Offer tab (its content moved to separate page)
//   - ❌ REMOVED: Direct Offer Stats from Settings
//   - ✅ ADDED: Quick Nav section with 2 buttons (Rank Reward, Direct Offer)
//   - ✅ Both buttons navigate to separate standalone pages
//   - ✅ All existing functionality preserved (Users, Withdrawals, Deposits, etc.)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { getDatabase, ref, get, update, set, onValue, remove, runTransaction, push } from "firebase/database";

const firebaseConfig = {
    apiKey: "AIzaSyAz-TLmOhiy-_vHHmIjW8gyIOqTR_PT9o0",
    authDomain: "rnd2-70080.firebaseapp.com",
    databaseURL: "https://rnd2-70080-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "rnd2-70080",
    storageBucket: "rnd2-70080.firebasestorage.app",
    messagingSenderId: "468625887938",
    appId: "1:468625887938:web:5cb4ddbcf31b6fc0a4615b",
    measurementId: "G-ELVJD5NQKB"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const ADMIN_EMAIL = "admin@rndstaking.com";
const CAMPAIGN_ID = 'direct_offer_2026';

// ============================================================
// GLOBAL STATE
// ============================================================
let currentTab = 'dashboard';
let allUsers = {};
let allTransactions = [];
let allPackages = [];
let allWithdrawals = {};
let allDeposits = {};
let allAdminWithdrawals = {};
let allCampaignRewards = {};
let allSettings = { rate: 1.00 };
let isDataLoaded = false;
let dataListeners = {};

let activityFeed = [];
let seenActivityIds = new Set();

let previousSnapshot = {
    users: new Set(), packages: new Set(),
    transactions: new Set(), campaignRewards: new Set(),
    deposits: new Set(), initialized: false
};

// ============================================================
// XSS HELPERS
// ============================================================
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
function escapeAttr(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' :
                 type === 'error' ? 'bi-exclamation-triangle-fill text-danger' :
                 type === 'warning' ? 'bi-exclamation-triangle-fill text-warning' :
                 'bi-info-circle-fill text-info';
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// COPY ADDRESS
// ============================================================
window.copyAddress = function(address, label = 'Address', btnElement) {
    if (!address || address === 'N/A') {
        showToast('❌ No address to copy!', 'error');
        return;
    }
    const cleanAddress = String(address).trim();
    const doCopy = () => {
        if (btnElement) {
            const originalHtml = btnElement.innerHTML;
            btnElement.classList.add('copied');
            btnElement.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
            setTimeout(() => {
                btnElement.classList.remove('copied');
                btnElement.innerHTML = originalHtml;
            }, 2000);
        }
        showToast(`✅ ${label} copied`, 'success');
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(cleanAddress).then(doCopy).catch(() => {
            fallbackCopy(cleanAddress);
            doCopy();
        });
    } else {
        fallbackCopy(cleanAddress);
        doCopy();
    }
};

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { console.error('Copy failed:', e); }
    document.body.removeChild(ta);
}

// ============================================================
// RELATIVE TIME
// ============================================================
function relativeTime(timestamp) {
    if (!timestamp) return 'N/A';
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 5) return 'Just now';
    if (diff < 60) return `${diff} sec ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)} days ago`;
    if (diff < 31536000) return `${Math.floor(diff / 2592000)} months ago`;
    return `${Math.floor(diff / 31536000)} years ago`;
}

// ============================================================
// REFERRAL HELPERS (minimal — only for Referred By column)
// ============================================================
function getSponsorInfo(candidate, ownerMap) {
    const sponsorUid = candidate.sponsorUid || candidate.referredByUid || null;
    if (sponsorUid && ownerMap[sponsorUid]) {
        const s = ownerMap[sponsorUid];
        return { uid: sponsorUid, name: s.name || s.username || 'Unknown', username: s.username || 'N/A' };
    }
    const legacy = candidate.referredBy || candidate.sponsor || null;
    if (legacy) {
        for (const oUid in ownerMap) {
            const o = ownerMap[oUid];
            if (String(legacy) === String(o.referralCode || '') ||
                String(legacy) === String(o.username || '') ||
                String(legacy) === String(oUid)) {
                return { uid: oUid, name: o.name || o.username || 'Unknown', username: o.username || 'N/A' };
            }
        }
        return { uid: null, name: String(legacy), username: String(legacy) };
    }
    return null;
}

// ============================================================
// AUTH
// ============================================================
document.getElementById('loginForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const email = document.getElementById('adminEmail').value;
    const password = document.getElementById('adminPasswordInput').value;
    const btn = document.getElementById('loginBtn');
    const errorDiv = document.getElementById('loginError');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Logging in...';
    errorDiv.style.display = 'none';
    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        errorDiv.style.display = 'block';
        errorDiv.textContent = '❌ ' + error.message;
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-lock me-2"></i>Login';
        showToast('❌ Login failed: ' + error.message, 'error');
    }
});

document.getElementById('logoutBtn').addEventListener('click', async function() {
    try { await signOut(auth); } catch (error) { showToast('❌ Logout error: ' + error.message, 'error'); }
});

// ============================================================
// 🔥 NORMAL WITHDRAWAL — SAFE STATUS UPDATE (with refund)
// ============================================================
async function updateWithdrawalStatusAtomic(uid, withdrawalId, newStatus, remark = '') {
    if (!uid || !withdrawalId) {
        return { success: false, error: 'Missing uid or withdrawalId' };
    }
    if (!['approved', 'rejected'].includes(newStatus)) {
        return { success: false, error: 'Invalid target status' };
    }

    const userRef = ref(db, 'users/' + uid);
    const now = Date.now();
    let finalResult = { success: false, error: 'Unknown error' };

    try {
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;

            const transactions = currentData.transactions || {};
            let targetTxKey = null;
            let targetTx = null;

            for (let key in transactions) {
                const tx = transactions[key];
                if (tx && tx.type === 'withdrawal' && tx.withdrawalId === withdrawalId) {
                    targetTxKey = key;
                    targetTx = { ...tx };
                    break;
                }
            }

            if (!targetTxKey || !targetTx) return currentData;

            const currentStatus = String(targetTx.status || 'pending').toLowerCase();
            if (currentStatus !== 'pending') return currentData;

            targetTx.status = newStatus;
            targetTx.updatedAt = now;
            if (remark) targetTx.remark = remark;

            if (newStatus === 'rejected' && targetTx.deducted === true && targetTx.deductedAmount) {
                const refundWallet = targetTx.deductedFromWallet || 'depositWallet';
                const refundAmount = Number(targetTx.deductedAmount) || 0;

                if (refundAmount > 0 && isFinite(refundAmount)) {
                    const currentBal = Number(currentData[refundWallet] || 0);
                    const newBal = Math.round((currentBal + refundAmount) * 1e8) / 1e8;

                    currentData[refundWallet] = newBal;
                    targetTx.refunded = true;
                    targetTx.refundedAt = now;
                    targetTx.refundedAmount = refundAmount;
                    targetTx.refundedToWallet = refundWallet;
                }
            }

            targetTx.processedAt = now;
            targetTx.processedBy = 'admin';
            targetTx.isFinalized = true;

            transactions[targetTxKey] = targetTx;

            return { ...currentData, transactions };
        });

        if (result.committed) {
            finalResult = { success: true };
            await syncWithdrawalAcrossLocations(uid, withdrawalId, newStatus, remark);
        } else {
            const snap = await get(userRef);
            if (snap.exists()) {
                const txs = snap.val().transactions || {};
                let found = null;
                for (let k in txs) {
                    if (txs[k] && txs[k].type === 'withdrawal' && txs[k].withdrawalId === withdrawalId) {
                        found = txs[k];
                        break;
                    }
                }
                if (!found) {
                    finalResult = { success: false, error: 'Withdrawal not found' };
                } else {
                    finalResult = {
                        success: false,
                        error: `Already processed (current status: ${found.status})`
                    };
                }
            } else {
                finalResult = { success: false, error: 'User data not found' };
            }
        }
    } catch (err) {
        console.error('Withdrawal status update error:', err);
        finalResult = { success: false, error: err.message || 'Transaction failed' };
    }

    return finalResult;
}

async function syncWithdrawalAcrossLocations(uid, withdrawalId, newStatus, remark) {
    const now = Date.now();
    const updates = [];

    try {
        const rootSnap = await get(ref(db, 'withdrawals'));
        if (rootSnap.exists()) {
            const rootData = rootSnap.val();
            for (let key in rootData) {
                if (rootData[key].withdrawalId === withdrawalId) {
                    updates.push(update(ref(db, 'withdrawals/' + key), {
                        status: newStatus,
                        updatedAt: now,
                        remark: remark || rootData[key].remark || ''
                    }));
                    break;
                }
            }
        }

        const adminSnap = await get(ref(db, 'admin/withdrawals'));
        if (adminSnap.exists()) {
            const adminData = adminSnap.val();
            for (let key in adminData) {
                if (adminData[key].withdrawalId === withdrawalId) {
                    updates.push(update(ref(db, 'admin/withdrawals/' + key), {
                        status: newStatus,
                        updatedAt: now,
                        remark: remark || adminData[key].remark || ''
                    }));
                    break;
                }
            }
        }

        const globalSnap = await get(ref(db, 'transactions'));
        if (globalSnap.exists()) {
            const globalData = globalSnap.val();
            for (let key in globalData) {
                if (globalData[key].withdrawalId === withdrawalId) {
                    updates.push(update(ref(db, 'transactions/' + key), {
                        status: newStatus,
                        updatedAt: now,
                        remark: remark || globalData[key].remark || ''
                    }));
                    break;
                }
            }
        }

        if (updates.length > 0) await Promise.all(updates);
    } catch (err) {
        console.warn('Sync across locations warning (non-critical):', err);
    }
}

// ============================================================
// 🔥 ADMIN ADJUSTMENT — SAFE WITH AUDIT
// ============================================================
async function processAdminAdjustment(uid, walletType, amount, type, description, remark = '') {
    if (!uid) return { success: false, error: 'Missing user' };
    if (!['depositWallet', 'referralWallet', 'rndWallet'].includes(walletType)) {
        return { success: false, error: 'Invalid wallet type' };
    }
    if (!['credit', 'debit'].includes(type)) {
        return { success: false, error: 'Invalid type' };
    }

    const numAmount = Number(amount);
    if (!isFinite(numAmount) || isNaN(numAmount) || numAmount <= 0) {
        return { success: false, error: 'Amount must be a positive finite number' };
    }

    const cleanAmount = Math.round(numAmount * 1e8) / 1e8;

    const userRef = ref(db, 'users/' + uid);
    const now = Date.now();
    const txId = 'tx_adj_' + now + '_' + Math.random().toString(36).substr(2, 8);

    try {
        let auditRecord = null;

        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;

            const currentBalance = Number(currentData[walletType] || 0);
            const cleanCurrent = isFinite(currentBalance) ? currentBalance : 0;

            const newBalanceRaw = type === 'credit'
                ? cleanCurrent + cleanAmount
                : cleanCurrent - cleanAmount;

            const newBalance = Math.round(newBalanceRaw * 1e8) / 1e8;

            if (newBalance < 0) return currentData;

            auditRecord = {
                txId: txId,
                type: type === 'credit' ? 'admin_credit' : 'admin_debit',
                walletType: walletType,
                amount: cleanAmount,
                oldBalance: cleanCurrent,
                newBalance: newBalance,
                currency: 'USDT',
                timestamp: now,
                date: new Date().toDateString(),
                status: 'completed',
                description: description || `${type === 'credit' ? 'Admin Credit' : 'Admin Debit'}`,
                remark: remark,
                performedBy: 'admin',
                source: 'admin_panel'
            };

            const transactions = currentData.transactions || {};
            transactions[txId] = auditRecord;

            return {
                ...currentData,
                [walletType]: newBalance,
                transactions: transactions
            };
        });

        if (!result.committed) {
            const snap = await get(userRef);
            if (!snap.exists()) return { success: false, error: 'User not found' };
            const bal = Number(snap.val()[walletType] || 0);
            if (type === 'debit' && bal < cleanAmount) {
                return { success: false, error: `Insufficient balance. Available: $${bal.toFixed(2)}` };
            }
            return { success: false, error: 'Transaction not committed' };
        }

        try {
            await update(ref(db, `admin/audit_log/${txId}`), auditRecord);
        } catch (e) {
            console.warn('Audit log write failed (non-critical):', e);
        }

        return { success: true, txId: txId, newBalance: auditRecord?.newBalance };
    } catch (error) {
        console.error('Admin adjustment error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// AUTH STATE
// ============================================================
onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('passwordScreen').style.display = 'none';
        document.getElementById('mainNav').style.display = 'flex';
        document.getElementById('adminContent').style.display = 'block';
        document.getElementById('userEmail').textContent = user.email;
        document.getElementById('dbStatus').className = 'db-status loading';
        document.getElementById('dbStatus').innerHTML = '<i class="bi bi-database"></i> Authenticated';
        showToast('✅ Welcome Admin!', 'success');
        loadAdminPanel();
    } else {
        document.getElementById('passwordScreen').style.display = 'flex';
        document.getElementById('mainNav').style.display = 'none';
        document.getElementById('adminContent').style.display = 'none';
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').focus();
        document.getElementById('loginBtn').disabled = false;
        document.getElementById('loginBtn').innerHTML = '<i class="bi bi-shield-lock me-2"></i>Login';
        for (let key in dataListeners) if (dataListeners[key]) dataListeners[key]();
        dataListeners = {};
        allUsers = {}; allTransactions = []; allPackages = [];
        allWithdrawals = {}; allDeposits = {};
        allAdminWithdrawals = {}; allCampaignRewards = {};
        activityFeed = []; seenActivityIds.clear();
        previousSnapshot = {
            users: new Set(), packages: new Set(),
            transactions: new Set(), campaignRewards: new Set(),
            deposits: new Set(), initialized: false
        };
        isDataLoaded = false;
    }
});

// ============================================================
// REALTIME LISTENERS
// ============================================================
function setupRealtimeListeners() {
    for (let key in dataListeners) if (dataListeners[key]) dataListeners[key]();
    dataListeners = {};

    dataListeners.users = onValue(ref(db, 'users'), (snapshot) => {
        const newUsers = snapshot.exists() ? snapshot.val() : {};
        detectActivityFromUsers(newUsers, allUsers);
        allUsers = newUsers;
        extractTransactionsFromUsers();
        if (isDataLoaded) renderDashboard();
    }, (error) => { console.error('Users listener error:', error); showToast('⚠️ Error loading users: ' + error.message, 'error'); });

    dataListeners.withdrawals = onValue(ref(db, 'withdrawals'), (snapshot) => {
        allWithdrawals = snapshot.exists() ? snapshot.val() : {};
        if (isDataLoaded) renderDashboard();
    }, (error) => console.error('Withdrawals listener error:', error));

    dataListeners.deposits = onValue(ref(db, 'deposits'), (snapshot) => {
        const newDeposits = snapshot.exists() ? snapshot.val() : {};
        detectActivityFromDeposits(newDeposits, allDeposits);
        allDeposits = newDeposits;
        if (isDataLoaded) renderDashboard();
    }, (error) => console.error('Deposits listener error:', error));

    dataListeners.adminWithdrawals = onValue(ref(db, 'admin/withdrawals'), (snapshot) => {
        allAdminWithdrawals = snapshot.exists() ? snapshot.val() : {};
        if (isDataLoaded) renderDashboard();
    }, (error) => console.error('Admin withdrawals listener error:', error));

    dataListeners.campaignRewards = onValue(ref(db, 'campaign_rewards'), (snapshot) => {
        const newRewards = snapshot.exists() ? snapshot.val() : {};
        detectActivityFromCampaignRewards(newRewards, allCampaignRewards);
        allCampaignRewards = newRewards;
        if (isDataLoaded) renderDashboard();
    }, (error) => console.error('Campaign rewards listener error:', error));

    dataListeners.globalTransactions = onValue(ref(db, 'transactions'), (snapshot) => {
        const globalTx = snapshot.exists() ? snapshot.val() : {};
        detectActivityFromGlobalTransactions(globalTx);
        if (isDataLoaded) renderDashboard();
    }, (error) => console.error('Global transactions listener error:', error));

    dataListeners.settings = onValue(ref(db, 'settings'), (snapshot) => {
        allSettings = snapshot.exists() ? snapshot.val() : { rate: 1.00 };
        if (isDataLoaded) {
            const rateInput = document.getElementById('rndRate');
            const rateDisplay = document.getElementById('currentRateDisplay');
            if (rateInput && allSettings.rate) {
                rateInput.value = allSettings.rate;
                if (rateDisplay) rateDisplay.textContent = allSettings.rate;
            }
            renderDashboard();
        }
    });

    document.getElementById('dbStatus').className = 'db-status connected';
    document.getElementById('dbStatus').innerHTML = '<i class="bi bi-database"></i> Connected';
}

// ============================================================
// EXTRACT TRANSACTIONS / PACKAGES
// ============================================================
function extractTransactionsFromUsers() {
    allTransactions = [];
    allPackages = [];
    for (let uid in allUsers) {
        const user = allUsers[uid];
        if (user.role === 'admin') continue;
        const transactions = user.transactions || {};
        for (let txId in transactions) {
            allTransactions.push({ id: txId, uid, user, source: 'user_transactions', ...transactions[txId] });
        }
        const packages = user.packages || {};
        for (let pkgId in packages) {
            allPackages.push({ id: pkgId, uid, user, ...packages[pkgId] });
        }
    }
    allTransactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    allPackages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// ============================================================
// ACTIVITY DETECTION
// ============================================================
function pushActivity(activity) {
    if (seenActivityIds.has(activity.id)) return;
    seenActivityIds.add(activity.id);
    activityFeed.unshift(activity);
    if (activityFeed.length > 300) {
        const removed = activityFeed.splice(300);
        removed.forEach(a => seenActivityIds.delete(a.id));
    }
}

function detectActivityFromUsers(newUsers, oldUsers) {
    const ownerMap = newUsers;
    for (const uid in newUsers) {
        const u = newUsers[uid];
        if (!u || u.role === 'admin') continue;

        const userKey = `user_${uid}`;
        if (!previousSnapshot.users.has(userKey)) {
            previousSnapshot.users.add(userKey);
            if (previousSnapshot.initialized) {
                const sponsor = getSponsorInfo(u, ownerMap);
                pushActivity({
                    id: userKey, type: 'user', icon: 'bi-person-plus-fill',
                    title: 'New User Registered',
                    desc: `<strong>${escapeHtml(u.name || u.username || 'Unknown')}</strong> joined the platform` +
                          (sponsor ? ` · Referred by <strong style="color:#60a5fa;">${escapeHtml(sponsor.name)}</strong>` : ''),
                    user: u, sponsor, uid,
                    timestamp: u.createdAt || u.joinedAt || Date.now(),
                    status: 'completed'
                });
            }
        }

        const packages = u.packages || {};
        for (const pkgId in packages) {
            const pkg = packages[pkgId];
            const pkgKey = `pkg_${uid}_${pkgId}`;
            if (!previousSnapshot.packages.has(pkgKey)) {
                previousSnapshot.packages.add(pkgKey);
                if (previousSnapshot.initialized) {
                    pushActivity({
                        id: pkgKey, type: 'package', icon: 'bi-box-seam-fill',
                        title: 'Package Purchased',
                        desc: `<strong>${escapeHtml(u.name || u.username || 'Unknown')}</strong> purchased ${escapeHtml(pkg.planName || 'a package')}`,
                        user: u, uid,
                        amount: pkg.usdtAmount || 0, amountType: 'credit',
                        refId: pkgId,
                        timestamp: pkg.purchaseDate || pkg.createdAt || Date.now(),
                        status: pkg.status || 'active'
                    });
                }
            }
        }

        const txs = u.transactions || {};
        for (const txId in txs) {
            const tx = txs[txId];
            const txKey = `tx_${uid}_${txId}`;
            if (!previousSnapshot.transactions.has(txKey)) {
                previousSnapshot.transactions.add(txKey);
                if (previousSnapshot.initialized) {
                    processTransactionForActivity(tx, u, uid, txId);
                }
            }
        }
    }
}

function processTransactionForActivity(tx, user, uid, txId) {
    if (!tx) return;

    let icon = 'bi-receipt', amountType = null;
    let title = 'Transaction', type = 'reward';
    let desc = `<strong>${escapeHtml(user.name || user.username || 'Unknown')}</strong> — ${escapeHtml(tx.type || 'tx')}`;

    if (tx.type === 'deposit') {
        icon = 'bi-arrow-down-circle-fill'; title = 'Deposit Made'; amountType = 'credit'; type = 'deposit';
    }
    else if (tx.type === 'withdrawal') {
        icon = 'bi-arrow-up-circle-fill'; title = 'Withdrawal Requested'; amountType = 'debit'; type = 'withdrawal';
    }
    else if (tx.type === 'admin_credit') {
        icon = 'bi-plus-circle-fill'; title = 'Admin Credit'; amountType = 'credit'; type = 'admin';
    }
    else if (tx.type === 'admin_debit') {
        icon = 'bi-dash-circle-fill'; title = 'Admin Debit'; amountType = 'debit'; type = 'admin';
    }
    else if (tx.type === 'direct_offer_withdrawal') {
        icon = 'bi-gift-fill'; title = 'Direct Offer Withdrawal'; amountType = 'debit'; type = 'direct-offer';
    }
    else if (tx.type === 'package') {
        icon = 'bi-box-seam-fill'; title = 'Package Purchase'; amountType = 'debit'; type = 'package';
    }
    else if (tx.type === 'referral_commission') {
        icon = 'bi-people-fill'; title = 'Referral Commission'; amountType = 'credit'; type = 'reward';
        const fromName = tx.fromName || tx.fromUsername || tx.fromUid || 'a user';
        const level = tx.level || tx.referralLevel || '';
        const levelStr = level ? ` (Level ${level})` : '';
        desc = `<strong>${escapeHtml(user.name || user.username || 'Unknown')}</strong> received commission from <strong style="color:#fbbf24;">${escapeHtml(String(fromName))}</strong>${levelStr}`;
    }
    else if (tx.type === 'level_commission' || tx.type === 'direct_commission' || tx.type === 'team_commission') {
        icon = 'bi-people-fill';
        title = tx.type === 'direct_commission' ? 'Direct Referral Commission' : 'Team Commission';
        amountType = 'credit'; type = 'reward';
        const fromName = tx.fromName || tx.fromUsername || 'a user';
        const level = tx.level || tx.referralLevel || '';
        const levelStr = level ? ` (L${level})` : '';
        desc = `<strong>${escapeHtml(user.name || user.username || 'Unknown')}</strong> earned ${escapeHtml(String(fromName))} referral${levelStr}`;
    }
    else if (tx.type === 'daily_release') {
        icon = 'bi-clock-history'; title = 'Daily Release'; amountType = 'credit'; type = 'release';
        const dayStr = tx.day ? ` · Day ${escapeHtml(String(tx.day))}` : '';
        desc = `<strong>${escapeHtml(user.name || user.username || 'Unknown')}</strong> received daily release${dayStr}`;
        if (String(tx.status).toLowerCase() === 'pending') { title = 'Pending Release'; }
    }
    else if (tx.type === 'package_completed') {
        icon = 'bi-check-circle-fill'; title = 'Package Completed'; amountType = 'credit'; type = 'reward';
    }
    else if (tx.type === 'referral_bonus') {
        icon = 'bi-gift-fill'; title = 'Referral Bonus'; amountType = 'credit'; type = 'reward';
        const fromName = tx.fromName || tx.fromUsername || 'a user';
        desc = `<strong>${escapeHtml(user.name || user.username || 'Unknown')}</strong> received referral bonus from <strong style="color:#fbbf24;">${escapeHtml(String(fromName))}</strong>`;
    }

    pushActivity({
        id: `tx_${uid}_${txId}`,
        type, icon, title, desc, user, uid,
        amount: tx.amount || 0, amountType,
        refId: tx.withdrawalId || txId,
        timestamp: tx.timestamp || Date.now(),
        status: tx.status || 'completed'
    });
}

function detectActivityFromGlobalTransactions(globalTx) {
    if (!globalTx) return;

    for (const txId in globalTx) {
        const tx = globalTx[txId];
        if (!tx) continue;

        const isReferralType = ['referral_commission', 'level_commission', 'direct_commission', 'team_commission', 'referral_bonus'].includes(tx.type);
        if (!isReferralType) continue;

        const gKey = `gtx_${txId}`;
        if (previousSnapshot.transactions.has(gKey)) continue;
        previousSnapshot.transactions.add(gKey);

        if (!previousSnapshot.initialized) continue;

        const recipientUid = tx.uid || tx.userId || tx.toUid || null;
        const recipient = recipientUid ? (allUsers[recipientUid] || { name: 'Unknown', username: 'N/A' }) : { name: 'Unknown', username: 'N/A' };

        const fromName = tx.fromName || tx.fromUsername || tx.fromUid || tx.sourceUserName || 'a user';
        const level = tx.level || tx.referralLevel || '';
        const levelStr = level ? ` (Level ${level})` : '';

        let title = 'Referral Commission';
        let icon = 'bi-people-fill';
        let desc = '';

        if (tx.type === 'direct_commission') {
            title = 'Direct Referral Commission';
            desc = `<strong>${escapeHtml(recipient.name)}</strong> earned commission from <strong style="color:#fbbf24;">${escapeHtml(String(fromName))}</strong>${levelStr}`;
        } else if (tx.type === 'level_commission' || tx.type === 'team_commission') {
            title = 'Team Commission';
            desc = `<strong>${escapeHtml(recipient.name)}</strong> earned from <strong style="color:#fbbf24;">${escapeHtml(String(fromName))}</strong>${levelStr}`;
        } else if (tx.type === 'referral_bonus') {
            title = 'Referral Bonus';
            desc = `<strong>${escapeHtml(recipient.name)}</strong> received bonus from <strong style="color:#fbbf24;">${escapeHtml(String(fromName))}</strong>`;
        } else {
            desc = `<strong>${escapeHtml(recipient.name)}</strong> received commission from <strong style="color:#fbbf24;">${escapeHtml(String(fromName))}</strong>${levelStr}`;
        }

        pushActivity({
            id: gKey, type: 'reward', icon, title, desc, user: recipient, uid: recipientUid,
            amount: tx.amount || 0, amountType: 'credit',
            refId: txId, timestamp: tx.timestamp || Date.now(),
            status: tx.status || 'completed'
        });
    }
}

function detectActivityFromDeposits(newDeposits, oldDeposits) {
    for (const key in newDeposits) {
        const d = newDeposits[key];
        const dKey = `dep_${key}`;
        if (!previousSnapshot.deposits.has(dKey)) {
            previousSnapshot.deposits.add(dKey);
            if (previousSnapshot.initialized) {
                const user = allUsers[d.uid] || { name: 'Unknown', username: 'N/A' };
                pushActivity({
                    id: dKey, type: 'deposit', icon: 'bi-arrow-down-circle-fill',
                    title: 'Deposit Received',
                    desc: `<strong>${escapeHtml(user.name || 'Unknown')}</strong> deposited $${(d.amount || 0).toFixed(2)}`,
                    user, uid: d.uid, amount: d.amount || 0, amountType: 'credit',
                    refId: key, timestamp: d.timestamp || Date.now(),
                    status: d.status || 'pending'
                });
            }
        }
    }
}

function detectActivityFromCampaignRewards(newRewards, oldRewards) {
    for (const uid in newRewards) {
        const userRewards = newRewards[uid];
        if (!userRewards) continue;
        for (const campaignId in userRewards) {
            const reward = userRewards[campaignId];
            if (!reward) continue;
            const rKey = `cr_${uid}_${campaignId}_${reward.status}_${reward.updatedAt || reward.snapshotAt || reward.lastUpdated || 0}`;
            if (!previousSnapshot.campaignRewards.has(rKey)) {
                previousSnapshot.campaignRewards.add(rKey);
                const user = allUsers[uid] || { name: 'Unknown', username: 'N/A' };
                if (previousSnapshot.initialized) {
                    const status = String(reward.status || 'available').toLowerCase();
                    let title = 'Direct Offer Update', icon = 'bi-gift-fill';

                    if (reward.isFinalized && status === 'available') { title = 'Direct Offer Finalized'; icon = 'bi-trophy-fill'; }
                    else if (status === 'progress') { title = 'Direct Offer Progress'; icon = 'bi-graph-up-arrow'; }
                    else if (status === 'pending') { title = 'Direct Offer Withdrawal Requested'; icon = 'bi-hourglass-split'; }
                    else if (status === 'approved') { title = 'Direct Offer Withdrawal Approved'; icon = 'bi-check-circle-fill'; }
                    else if (status === 'paid') { title = 'Direct Offer Reward Paid'; icon = 'bi-currency-dollar'; }
                    else if (status === 'rejected') { title = 'Direct Offer Withdrawal Rejected'; icon = 'bi-x-circle-fill'; }

                    const amtVal = Number(reward.finalReward ?? reward.currentReward ?? 0);
                    pushActivity({
                        id: rKey, type: 'direct-offer', icon, title,
                        desc: `<strong>${escapeHtml(user.name || 'Unknown')}</strong> — ${escapeHtml(campaignId)} · $${amtVal.toFixed(2)}`,
                        user, uid, amount: amtVal, amountType: 'credit',
                        refId: reward.withdrawalId || campaignId,
                        timestamp: reward.updatedAt || reward.snapshotAt || reward.lastUpdated || Date.now(),
                        status
                    });
                }
            }
        }
    }
}

// ============================================================
// LOAD ADMIN PANEL
// ============================================================
async function loadAdminPanel() {
    try {
        setupRealtimeListeners();
        await new Promise((resolve) => {
            let attempts = 0;
            const checkData = () => {
                attempts++;
                const hasData = Object.keys(allUsers).length > 0 || attempts > 15;
                if (hasData) { isDataLoaded = true; previousSnapshot.initialized = true; resolve(); }
                else setTimeout(checkData, 500);
            };
            checkData();
        });
        renderDashboard();
    } catch (error) {
        console.error('Error loading admin:', error);
        document.getElementById('adminContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Panel</h4>
                <p class="text-muted">${escapeHtml(error.message || 'Please check your connection.')}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
}

// ============================================================
// STATS HELPERS
// ============================================================
function computeStats() {
    let totalUsers = 0, totalDepositWallet = 0, totalRNDWallet = 0,
        totalLockedRND = 0, totalReferrals = 0;
    for (let key in allUsers) {
        const u = allUsers[key];
        if (u.role === 'admin') continue;
        totalUsers++;
        totalRNDWallet += (u.rndWallet || 0);
        totalLockedRND += (u.lockedRND || 0);
        totalDepositWallet += (u.depositWallet || 0);
        totalReferrals += (u.totalReferrals || 0);
    }
    return { totalUsers, totalDepositWallet, totalRNDWallet, totalLockedRND, totalReferrals };
}

function countPendingItems() {
    let pendingWithdrawals = 0, pendingDeposits = 0;
    for (const tx of allTransactions) {
        if (tx.type === 'withdrawal' && String(tx.status).toLowerCase() === 'pending') pendingWithdrawals++;
        if (tx.type === 'deposit' && String(tx.status).toLowerCase() === 'pending') pendingDeposits++;
    }
    return { pendingWithdrawals, pendingDeposits };
}

// ============================================================
// RENDER DASHBOARD
// ============================================================
function renderDashboard() {
    const stats = computeStats();
    const currentRate = allSettings.rate || 1.00;
    const pendingCounts = countPendingItems();

    document.getElementById('adminContent').innerHTML = `
        <div class="row g-4">

            <!-- USER SEARCH -->
            <div class="col-12">
                <div class="user-search-section">
                    <div class="section-title">
                        <i class="bi bi-search"></i> Search User
                        <span class="text-muted small" style="font-weight:400;font-size:0.75rem;margin-left:auto;">Name, Username, Email ya UID se</span>
                    </div>
                    <div class="user-search-input-wrap">
                        <i class="bi bi-search search-icon"></i>
                        <input type="text" id="userSearchInput" placeholder="Type user name, username, email or UID..." oninput="handleUserSearch(this.value)">
                    </div>
                    <div class="search-results-list" id="userSearchResults"></div>
                </div>
            </div>

            <!-- HEADER -->
            <div class="col-12">
                <div class="d-flex flex-wrap justify-content-between align-items-center">
                    <h4 class="fw-bold"><i class="bi bi-shield-lock text-success me-2"></i>Admin Dashboard</h4>
                    <span class="text-muted small">${escapeHtml(new Date().toLocaleString('en-IN'))}</span>
                </div>
                <hr class="border-secondary">
            </div>

            <!-- 🆕 QUICK NAV SECTION (Rank Reward + Direct Offer) -->
            <div class="col-12">
                <div class="quick-nav-section">
                    <span class="quick-nav-label"><i class="bi bi-lightning-charge-fill"></i> Quick Access:</span>
                    <a href="rank-reward-admin.html" class="btn-rank-reward">
                        <i class="bi bi-trophy-fill"></i> Rank Reward
                    </a>
                    <a href="direct-offer-admin.html" class="btn-direct-offer">
                        <i class="bi bi-gift-fill"></i> Direct Offer
                    </a>
                </div>
            </div>

            <!-- STATS ROW 1 -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-md-2 col-4">
                        <div class="stat-card">
                            <div class="stat-icon green"><i class="bi bi-people"></i></div>
                            <div class="stat-number">${stats.totalUsers}</div>
                            <div class="stat-label">Total Users</div>
                        </div>
                    </div>
                    <div class="col-md-2 col-4">
                        <div class="stat-card">
                            <div class="stat-icon blue"><i class="bi bi-arrow-down-circle"></i></div>
                            <div class="stat-number">${allTransactions.filter(t => t.type === 'deposit').length}</div>
                            <div class="stat-label">Total Deposits</div>
                        </div>
                    </div>
                    <div class="col-md-2 col-4">
                        <div class="stat-card">
                            <div class="stat-icon orange"><i class="bi bi-arrow-up-circle"></i></div>
                            <div class="stat-number">${allTransactions.filter(t => t.type === 'withdrawal').length}</div>
                            <div class="stat-label">Withdrawals</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon purple"><i class="bi bi-cash-stack"></i></div>
                            <div class="stat-number">$${allTransactions.filter(t => t.type === 'deposit' && t.status !== 'rejected').reduce((s, t) => s + (t.amount || 0), 0).toFixed(2)}</div>
                            <div class="stat-label">Total Deposited</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(251,191,36,0.12);color:#fbbf24;"><i class="bi bi-currency-dollar"></i></div>
                            <div class="stat-number" style="color:#fbbf24;">$${currentRate}</div>
                            <div class="stat-label">RND Rate</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- STATS ROW 2 -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(46,204,113,0.12);color:#2ecc71;"><i class="bi bi-wallet2"></i></div>
                            <div class="stat-number" style="color:#2ecc71;">$${stats.totalDepositWallet.toFixed(2)}</div>
                            <div class="stat-label">Deposit Wallet</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(96,165,250,0.12);color:#60a5fa;"><i class="bi bi-coin"></i></div>
                            <div class="stat-number" style="color:#60a5fa;">${stats.totalRNDWallet.toFixed(2)}</div>
                            <div class="stat-label">RND Wallet</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(167,139,250,0.12);color:#a78bfa;"><i class="bi bi-lock"></i></div>
                            <div class="stat-number" style="color:#a78bfa;">${stats.totalLockedRND.toFixed(2)}</div>
                            <div class="stat-label">Locked RND</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(251,191,36,0.12);color:#fbbf24;"><i class="bi bi-people"></i></div>
                            <div class="stat-number" style="color:#fbbf24;">${stats.totalReferrals}</div>
                            <div class="stat-label">Total Referrals</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- TABS -->
            <div class="col-12">
                <ul class="nav nav-tabs-custom" style="border-bottom:1px solid rgba(46,204,113,0.1);margin-bottom:20px;flex-wrap:wrap;">
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'dashboard' ? 'active' : ''}" onclick="switchTab('dashboard')">
                            <i class="bi bi-speedometer2"></i> Dashboard
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'activity' ? 'active' : ''}" onclick="switchTab('activity')">
                            <i class="bi bi-activity"></i> Live Activity
                            ${activityFeed.length > 0 ? `<span class="tab-count-badge">${activityFeed.length}</span>` : ''}
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'withdrawals' ? 'active' : ''}" onclick="switchTab('withdrawals')">
                            <i class="bi bi-arrow-up-circle"></i> Withdrawals
                            ${pendingCounts.pendingWithdrawals > 0 ? `<span class="tab-count-badge pending">${pendingCounts.pendingWithdrawals}</span>` : ''}
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'deposits' ? 'active' : ''}" onclick="switchTab('deposits')">
                            <i class="bi bi-arrow-down-circle"></i> Deposits
                            ${pendingCounts.pendingDeposits > 0 ? `<span class="tab-count-badge pending">${pendingCounts.pendingDeposits}</span>` : ''}
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'users' ? 'active' : ''}" onclick="switchTab('users')">
                            <i class="bi bi-people"></i> Users (${stats.totalUsers})
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'packages' ? 'active' : ''}" onclick="switchTab('packages')">
                            <i class="bi bi-box-seam"></i> Packages (${allPackages.length})
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'settings' ? 'active' : ''}" onclick="switchTab('settings')">
                            <i class="bi bi-gear"></i> Settings
                        </a>
                    </li>
                </ul>
            </div>

            <div class="col-12">
                ${currentTab === 'dashboard' ? renderDashboardTab() : ''}
                ${currentTab === 'activity' ? renderActivityTab() : ''}
                ${currentTab === 'withdrawals' ? renderWithdrawalsTab() : ''}
                ${currentTab === 'deposits' ? renderDepositsTab() : ''}
                ${currentTab === 'users' ? renderUsersTab() : ''}
                ${currentTab === 'packages' ? renderPackagesTab() : ''}
                ${currentTab === 'settings' ? renderSettingsTab() : ''}
            </div>
        </div>
    `;

    setTimeout(() => {
        const settingsForm = document.getElementById('settingsForm');
        if (settingsForm) settingsForm.addEventListener('submit', async (e) => { e.preventDefault(); await saveSettings(); });
        const adminForm = document.getElementById('adminAdjustForm');
        if (adminForm) adminForm.addEventListener('submit', async (e) => { e.preventDefault(); await handleAdminAdjustment(); });
        const searchInput = document.getElementById('userSearchInput');
        if (searchInput && window.__lastSearchValue) {
            searchInput.value = window.__lastSearchValue;
            handleUserSearch(window.__lastSearchValue);
        }
    }, 300);
}

// ============================================================
// USER SEARCH
// ============================================================
window.__lastSearchValue = '';

window.handleUserSearch = function(query) {
    window.__lastSearchValue = query;
    const resultsDiv = document.getElementById('userSearchResults');
    if (!resultsDiv) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) { resultsDiv.innerHTML = ''; return; }

    const matched = [];
    for (const uid in allUsers) {
        const u = allUsers[uid];
        if (!u || u.role === 'admin') continue;
        const name = String(u.name || '').toLowerCase();
        const username = String(u.username || '').toLowerCase();
        const email = String(u.email || '').toLowerCase();
        const uidL = String(uid).toLowerCase();
        const code = String(u.referralCode || '').toLowerCase();
        if (name.includes(q) || username.includes(q) || email.includes(q) || uidL.includes(q) || code.includes(q)) {
            matched.push({ uid, u });
        }
    }
    if (matched.length === 0) {
        resultsDiv.innerHTML = `<div class="no-data" style="padding:20px;"><i class="bi bi-person-x" style="font-size:2rem;"></i><p style="font-size:0.85rem;">No user found for "${escapeHtml(query)}"</p></div>`;
        return;
    }
    resultsDiv.innerHTML = matched.slice(0, 20).map(({ uid, u }) => {
        const sponsor = getSponsorInfo(u, allUsers);
        const initial = (u.name || u.username || 'U').charAt(0).toUpperCase();
        const referredHtml = sponsor
            ? `<div class="referred-by"><i class="bi bi-arrow-return-right"></i> Referred by <strong>${escapeHtml(sponsor.name)}</strong> (@${escapeHtml(sponsor.username)})</div>`
            : `<div class="referred-by" style="color:#556688;"><i class="bi bi-dash-circle"></i> No referrer</div>`;
        return `
            <div class="search-result-item" onclick="viewUserDetails('${escapeAttr(uid)}')">
                <div class="avatar-sm">${escapeHtml(initial)}</div>
                <div class="info">
                    <div class="name">${escapeHtml(u.name || 'Unknown')} <span style="color:#8899bb;font-weight:400;">@${escapeHtml(u.username || 'N/A')}</span></div>
                    <div class="meta">${escapeHtml(u.email || 'No email')} · ${escapeHtml(uid.substring(0, 14))}...</div>
                    ${referredHtml}
                </div>
                <div class="arrow"><i class="bi bi-chevron-right"></i></div>
            </div>
        `;
    }).join('');
};

// ============================================================
// DASHBOARD TAB
// ============================================================
function renderDashboardTab() {
    const recent = allTransactions.slice(0, 20);
    if (recent.length === 0) {
        return `<div class="card-glass"><div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Recent Transactions</div><div class="no-data"><i class="bi bi-inbox"></i><p>No recent activity</p></div></div>`;
    }
    return `
        <div class="card-glass">
            <div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Recent Transactions</div>
            <div class="table-responsive">
                <table class="table table-custom">
                    <thead><tr><th>Type</th><th>User</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
                    <tbody>
                        ${recent.map(item => {
                            const s = String(item.status || 'pending').toLowerCase();
                            const statusClass = s === 'pending' ? 'badge-pending' :
                                               ['approved','completed','success','paid'].includes(s) ? 'badge-approved' : 'badge-rejected';
                            const statusText = s === 'pending' ? '⏳ Pending' :
                                               ['approved','completed','success','paid'].includes(s) ? '✅ Done' : '❌ Rejected';
                            const isDebit = item.type === 'withdrawal' || item.type === 'admin_debit' || item.type === 'direct_offer_withdrawal';
                            const amountColor = isDebit ? '#f87171' : '#2ecc71';
                            const sign = isDebit ? '-' : '+';
                            return `
                                <tr>
                                    <td><i class="bi ${getTypeIcon(item.type)}" style="color:${amountColor};"></i> ${escapeHtml(getTypeLabel(item.type))}</td>
                                    <td><strong>${escapeHtml(item.user?.name || 'Unknown')}</strong></td>
                                    <td><strong style="color:${amountColor}">${sign}$${(item.amount || 0).toFixed(2)}</strong></td>
                                    <td><span class="${statusClass}">${statusText}</span></td>
                                    <td style="font-size:0.8rem;color:#8899bb;">${escapeHtml(new Date(item.timestamp || 0).toLocaleString('en-IN'))}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// ============================================================
// ACTIVITY TAB
// ============================================================
function renderActivityTab() {
    if (activityFeed.length === 0) {
        return `<div class="card-glass"><div class="card-title"><i class="bi bi-activity text-success me-2"></i>Live Activity</div><div class="no-data"><i class="bi bi-hourglass-split"></i><p>Waiting for activity...</p><p style="font-size:0.8rem;color:#556688;">Naye events yahan turant dikhenge.</p></div></div>`;
    }
    return `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;">
                    <i class="bi bi-activity text-success me-2"></i>Live Activity
                    <span class="tab-count-badge">${activityFeed.length}</span>
                </div>
                <button class="btn btn-sm" style="background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.2);border-radius:8px;" onclick="clearActivityFeed()">
                    <i class="bi bi-trash"></i> Clear Feed
                </button>
            </div>
            <div class="activity-feed">
                ${activityFeed.slice(0, 100).map(a => renderActivityCard(a)).join('')}
            </div>
        </div>
    `;
}

function renderActivityCard(a) {
    const statusBadge = getStatusBadge(a.status);
    const amountHtml = a.amount > 0
        ? `<span class="activity-amount ${a.amountType || 'credit'}">${a.amountType === 'debit' ? '-' : '+'}$${(a.amount || 0).toFixed(2)}</span>` : '';
    return `
        <div class="activity-card type-${escapeAttr(a.type)}">
            <div class="activity-icon type-${escapeAttr(a.type)}"><i class="bi ${escapeAttr(a.icon)}"></i></div>
            <div class="activity-content">
                <div class="activity-title">${escapeHtml(a.title)} ${statusBadge}</div>
                <div class="activity-desc">${a.desc}</div>
                <div class="activity-meta">
                    <span class="rel-time"><i class="bi bi-clock"></i> ${escapeHtml(relativeTime(a.timestamp))}</span>
                    <span class="abs-time">${escapeHtml(new Date(a.timestamp).toLocaleString('en-IN'))}</span>
                    ${a.refId ? `<span class="ref-id">${escapeHtml(String(a.refId).substring(0, 20))}</span>` : ''}
                    ${amountHtml}
                </div>
            </div>
        </div>
    `;
}

function getStatusBadge(status) {
    if (!status) return '';
    const s = String(status).toLowerCase();
    if (s === 'pending') return `<span class="activity-status-badge badge-pending">Pending</span>`;
    if (['approved','completed','success','paid','active'].includes(s)) return `<span class="activity-status-badge badge-approved">${escapeHtml(s)}</span>`;
    if (['rejected','failed','cancelled'].includes(s)) return `<span class="activity-status-badge badge-rejected">${escapeHtml(s)}</span>`;
    if (s === 'available') return `<span class="activity-status-badge badge-available">Available</span>`;
    if (s === 'progress') return `<span class="activity-status-badge badge-approved">Progress</span>`;
    return `<span class="activity-status-badge badge-completed">${escapeHtml(s)}</span>`;
}

window.clearActivityFeed = function() {
    activityFeed = []; seenActivityIds.clear(); renderDashboard();
    showToast('✅ Activity feed cleared', 'success');
};

// ============================================================
// WITHDRAWALS TAB
// ============================================================
function renderWithdrawalsTab() {
    const seenIds = new Set();
    const list = [];

    for (const tx of allTransactions) {
        if (tx.type !== 'withdrawal' && tx.type !== 'direct_offer_withdrawal') continue;
        const wid = tx.withdrawalId || tx.id;
        if (seenIds.has(wid)) continue;
        seenIds.add(wid);
        list.push({ ...tx, withdrawalId: wid });
    }

    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (list.length === 0) return `<div class="card-glass"><div class="no-data"><i class="bi bi-inbox"></i><p>No withdrawals found.</p></div></div>`;
    const pendingCount = list.filter(w => String(w.status).toLowerCase() === 'pending').length;
    return `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;">
                    <i class="bi bi-arrow-up-circle text-success me-2"></i>Withdrawals (${list.length})
                    ${pendingCount > 0 ? `<span class="tab-count-badge pending">${pendingCount} pending</span>` : ''}
                </div>
                <input type="text" class="search-box" placeholder="Search by user..." oninput="filterWithdrawals(this.value)">
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="withdrawalsTable">
                    <thead><tr><th>#</th><th>User</th><th>Type</th><th>Amount</th><th>Wallet Address</th><th>Date</th><th>Status</th><th>Action</th></tr></thead>
                    <tbody>
                        ${list.map((w, i) => {
                            const user = w.user || allUsers[w.uid] || { name: 'Unknown', username: 'N/A' };
                            const status = String(w.status || 'pending').toLowerCase();
                            const statusClass = status === 'pending' ? 'badge-pending' : ['approved','success','paid'].includes(status) ? 'badge-approved' : 'badge-rejected';
                            const statusText = status === 'pending' ? '⏳ Pending' : ['approved','success','paid'].includes(status) ? '✅ Done' : '❌ Rejected';
                            const isDirectOffer = w.type === 'direct_offer_withdrawal';
                            const walletAddr = w.walletAddress || w.wallet || '';
                            const walletHtml = walletAddr
                                ? `<div class="wallet-cell"><span class="addr" title="${escapeAttr(walletAddr)}">${escapeHtml(walletAddr)}</span><button class="btn-copy" onclick="event.stopPropagation(); copyAddress('${escapeAttr(walletAddr)}','Wallet', this)"><i class="bi bi-clipboard"></i></button></div>`
                                : `<span style="color:#556688;font-size:0.75rem;">No address</span>`;
                            return `
                                <tr data-user="${escapeAttr((user.username || user.name || '').toLowerCase())}">
                                    <td>${i + 1}</td>
                                    <td><strong>${escapeHtml(user.name || 'Unknown')}</strong><br><small style="color:#556688;">${escapeHtml(user.username || 'N/A')}</small></td>
                                    <td>${isDirectOffer ? '<span style="color:#f59e0b;font-size:0.75rem;"><i class="bi bi-gift"></i> Direct Offer</span>' : '<span style="color:#2ecc71;font-size:0.75rem;">Regular</span>'}</td>
                                    <td><strong style="color:#fbbf24;">${(w.amount || 0).toFixed(2)} ${escapeHtml(w.currency || 'USDT')}</strong></td>
                                    <td>${walletHtml}</td>
                                    <td style="font-size:0.8rem;color:#8899bb;">${escapeHtml(new Date(w.timestamp || 0).toLocaleString('en-IN'))}</td>
                                    <td><span class="${statusClass}">${statusText}</span></td>
                                    <td>
                                        ${status === 'pending' && !isDirectOffer ? `
                                            <button class="btn btn-success-custom btn-sm me-1" onclick="approveWithdrawal('${escapeAttr(w.uid)}', '${escapeAttr(w.withdrawalId || '')}')"><i class="bi bi-check-lg"></i></button>
                                            <button class="btn btn-danger-custom btn-sm" onclick="rejectWithdrawal('${escapeAttr(w.uid)}', '${escapeAttr(w.withdrawalId || '')}')"><i class="bi bi-x-lg"></i></button>
                                        ` : isDirectOffer ? `<span style="color:#f59e0b;font-size:0.7rem;">Manage in Direct Offer page</span>` : `<span style="color:#34d399;font-size:0.75rem;">✓ Done</span>`}
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

window.filterWithdrawals = function(value) {
    const rows = document.querySelectorAll('#withdrawalsTable tbody tr');
    const s = value.toLowerCase();
    rows.forEach(r => { r.style.display = (r.getAttribute('data-user') || '').includes(s) ? '' : 'none'; });
};
window.approveWithdrawal = async function(uid, withdrawalId) {
    if (!confirm('✅ Approve this withdrawal?')) return;
    const result = await updateWithdrawalStatusAtomic(uid, withdrawalId, 'approved');
    if (result.success) { showToast('✅ Approved!', 'success'); setTimeout(renderDashboard, 500); }
    else showToast('❌ ' + (result.error || 'Failed'), 'error');
};
window.rejectWithdrawal = async function(uid, withdrawalId) {
    const remark = prompt('❌ Reason for rejection (optional):');
    if (remark === null) return;
    const result = await updateWithdrawalStatusAtomic(uid, withdrawalId, 'rejected', remark);
    if (result.success) { showToast('❌ Rejected + refund (if applicable)', 'success'); setTimeout(renderDashboard, 500); }
    else showToast('❌ ' + (result.error || 'Failed'), 'error');
};

// ============================================================
// DEPOSITS TAB
// ============================================================
function renderDepositsTab() {
    const list = allTransactions.filter(t => t.type === 'deposit').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (list.length === 0) return `<div class="card-glass"><div class="no-data"><i class="bi bi-inbox"></i><p>No deposits found.</p></div></div>`;
    const pendingCount = list.filter(d => String(d.status).toLowerCase() === 'pending').length;
    return `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;">
                    <i class="bi bi-arrow-down-circle text-success me-2"></i>Deposits (${list.length})
                    ${pendingCount > 0 ? `<span class="tab-count-badge pending">${pendingCount} pending</span>` : ''}
                </div>
                <input type="text" class="search-box" placeholder="Search by user..." oninput="filterDeposits(this.value)">
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="depositsTable">
                    <thead><tr><th>#</th><th>User</th><th>Amount</th><th>Details</th><th>Date</th><th>Status</th></tr></thead>
                    <tbody>
                        ${list.map((d, i) => {
                            const user = d.user || allUsers[d.uid] || { name: 'Unknown', username: 'N/A' };
                            const status = String(d.status || 'pending').toLowerCase();
                            const statusClass = status === 'pending' ? 'badge-pending' : ['approved','completed','success'].includes(status) ? 'badge-approved' : 'badge-rejected';
                            const statusText = status === 'pending' ? '⏳ Pending' : ['approved','completed','success'].includes(status) ? '✅ Approved' : '❌ Rejected';
                            return `
                                <tr data-user="${escapeAttr((user.username || user.name || '').toLowerCase())}">
                                    <td>${i + 1}</td>
                                    <td><strong>${escapeHtml(user.name || 'Unknown')}</strong><br><small style="color:#556688;">${escapeHtml(user.username || 'N/A')}</small></td>
                                    <td><strong style="color:#2ecc71;">$${(d.amount || 0).toFixed(2)}</strong></td>
                                    <td style="font-size:0.8rem;color:#8899bb;">${escapeHtml(d.description || 'Deposit')}${d.txHash ? `<br><small>TX: ${escapeHtml(String(d.txHash).substring(0, 15))}...</small>` : ''}</td>
                                    <td style="font-size:0.8rem;color:#8899bb;">${escapeHtml(new Date(d.timestamp || 0).toLocaleString('en-IN'))}</td>
                                    <td><span class="${statusClass}">${statusText}</span></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}
window.filterDeposits = function(value) {
    const rows = document.querySelectorAll('#depositsTable tbody tr');
    const s = value.toLowerCase();
    rows.forEach(r => { r.style.display = (r.getAttribute('data-user') || '').includes(s) ? '' : 'none'; });
};

// ============================================================
// USERS TAB
// ============================================================
function renderUsersTab() {
    const filteredUsers = Object.keys(allUsers).filter(k => allUsers[k].role !== 'admin');
    if (filteredUsers.length === 0) return `<div class="card-glass"><div class="no-data"><i class="bi bi-inbox"></i><p>No users found.</p></div></div>`;
    return `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;"><i class="bi bi-people text-success me-2"></i>All Users (${filteredUsers.length})</div>
                <input type="text" class="search-box" placeholder="Search by name..." oninput="filterUsers(this.value)">
            </div>
            <div class="card-glass mb-3" style="background:rgba(251,191,36,0.05);border-color:rgba(251,191,36,0.1);">
                <h6 class="text-muted"><i class="bi bi-shield"></i> Admin Adjustment</h6>
                <form id="adminAdjustForm" class="row g-2 align-items-end">
                    <div class="col-md-3">
                        <label class="form-label">User</label>
                        <select id="adminUserSelect" class="form-control form-control-custom">
                            ${filteredUsers.map(uid => { const u = allUsers[uid]; return `<option value="${escapeAttr(uid)}">${escapeHtml(u.name || 'Unknown')} (@${escapeHtml(u.username || 'N/A')})</option>`; }).join('')}
                        </select>
                    </div>
                    <div class="col-md-2"><label class="form-label">Wallet</label>
                        <select id="adminWalletSelect" class="form-control form-control-custom">
                            <option value="depositWallet">Deposit Wallet</option>
                            <option value="referralWallet">Referral Wallet</option>
                            <option value="rndWallet">RND Wallet</option>
                        </select>
                    </div>
                    <div class="col-md-2"><label class="form-label">Type</label>
                        <select id="adminAdjustType" class="form-control form-control-custom">
                            <option value="credit">➕ Credit</option><option value="debit">➖ Debit</option>
                        </select>
                    </div>
                    <div class="col-md-2"><label class="form-label">Amount (USDT)</label>
                        <input type="number" id="adminAdjustAmount" class="form-control form-control-custom" placeholder="0.00" step="0.01" min="0.01" required>
                    </div>
                    <div class="col-md-3"><label class="form-label">Description</label>
                        <input type="text" id="adminAdjustDesc" class="form-control form-control-custom" placeholder="Reason">
                    </div>
                    <div class="col-12 mt-2"><button type="submit" class="btn btn-warning-custom w-100"><i class="bi bi-shield me-1"></i> Apply Adjustment</button></div>
                </form>
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="usersTable">
                    <thead><tr><th>#</th><th>User</th><th>Email</th><th>Deposit</th><th>RND</th><th>Locked</th><th>Refs</th><th>Referred By</th><th>Action</th></tr></thead>
                    <tbody>
                        ${filteredUsers.map((key, i) => {
                            const u = allUsers[key];
                            const sponsor = getSponsorInfo(u, allUsers);
                            const sponsorHtml = sponsor
                                ? `<span style="color:#60a5fa;font-size:0.78rem;"><i class="bi bi-person-check"></i> ${escapeHtml(sponsor.name)}</span>`
                                : `<span style="color:#556688;font-size:0.78rem;">Direct</span>`;
                            return `
                                <tr data-user="${escapeAttr((u.username || u.name || '').toLowerCase())}">
                                    <td>${i + 1}</td>
                                    <td><strong>${escapeHtml(u.name || 'Unknown')}</strong><br><small style="color:#556688;">@${escapeHtml(u.username || 'N/A')}</small></td>
                                    <td style="font-size:0.85rem;">${escapeHtml(u.email || 'N/A')}</td>
                                    <td><strong style="color:#2ecc71;">$${(u.depositWallet || 0).toFixed(2)}</strong></td>
                                    <td><strong style="color:#60a5fa;">${(u.rndWallet || 0).toFixed(4)}</strong></td>
                                    <td><strong style="color:#a78bfa;">${(u.lockedRND || 0).toFixed(2)}</strong></td>
                                    <td>${u.totalReferrals || 0}</td>
                                    <td>${sponsorHtml}</td>
                                    <td><button class="btn btn-info btn-sm" style="background:rgba(96,165,250,0.15);border-color:rgba(96,165,250,0.2);color:#60a5fa;" onclick="viewUserDetails('${escapeAttr(key)}')"><i class="bi bi-eye"></i></button></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}
window.filterUsers = function(value) {
    const rows = document.querySelectorAll('#usersTable tbody tr');
    const s = value.toLowerCase();
    rows.forEach(r => { r.style.display = (r.getAttribute('data-user') || '').includes(s) ? '' : 'none'; });
};
window.viewUserDetails = function(userId) {
    const user = allUsers[userId];
    if (!user) { showToast('❌ User not found!', 'error'); return; }
    const userTxs = allTransactions.filter(t => t.uid === userId);
    const userPackages = allPackages.filter(p => p.uid === userId);
    const campaignData = allCampaignRewards[userId]?.[CAMPAIGN_ID];
    const sponsor = getSponsorInfo(user, allUsers);
    const campaignReward = campaignData
        ? Number(campaignData.finalReward ?? campaignData.currentReward ?? 0)
        : 0;
    const campaignRefs = campaignData
        ? Number(campaignData.finalDirectCount ?? campaignData.currentDirectCount ?? 0)
        : 0;
    alert(`📊 User Details
━━━━━━━━━━━━━━━━━━━━━━
👤 Name: ${user.name || 'Unknown'}
📛 Username: ${user.username || 'N/A'}
📧 Email: ${user.email || 'N/A'}
🆔 UID: ${userId}
━━━━━━━━━━━━━━━━━━━━━━
👥 Referred By: ${sponsor ? `${sponsor.name} (@${sponsor.username})` : 'Direct Signup'}
━━━━━━━━━━━━━━━━━━━━━━
💰 Deposit Wallet: $${(user.depositWallet || 0).toFixed(2)}
📊 RND Wallet: ${(user.rndWallet || 0).toFixed(4)}
🔒 Locked RND: ${(user.lockedRND || 0).toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━
📥 Transactions: ${userTxs.length}
📦 Packages: ${userPackages.length}
👥 Referrals: ${user.totalReferrals || 0}
━━━━━━━━━━━━━━━━━━━━━━
🎁 Direct Offer:
   Status: ${campaignData?.status || 'Not Participated'}
   Refs Counted: ${campaignRefs}
   Reward: $${campaignReward.toFixed(2)}
   Wallet: ${campaignData?.walletAddress || 'N/A'}
   TX Hash: ${campaignData?.txHash || 'N/A'}`);
};

// ============================================================
// PACKAGES TAB
// ============================================================
function renderPackagesTab() {
    if (allPackages.length === 0) return `<div class="card-glass"><div class="no-data"><i class="bi bi-inbox"></i><p>No packages found.</p></div></div>`;
    return `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;"><i class="bi bi-box-seam text-success me-2"></i>All Packages (${allPackages.length})</div>
                <input type="text" class="search-box" placeholder="Search by user..." oninput="filterPackages(this.value)">
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="packagesTable">
                    <thead><tr><th>#</th><th>User</th><th>Plan</th><th>Amount</th><th>Total RND</th><th>Released</th><th>Locked</th><th>Status</th></tr></thead>
                    <tbody>
                        ${allPackages.map((pkg, i) => {
                            const user = pkg.user || allUsers[pkg.uid] || { name: 'Unknown', username: 'N/A' };
                            const status = String(pkg.status || 'active').toLowerCase();
                            const statusClass = status === 'active' ? 'badge-active' : 'badge-completed';
                            const statusText = status === 'active' ? '🟢 Active' : '🔵 ' + status;
                            const released = pkg.releasedRND || 0;
                            const locked = Math.max(0, (pkg.totalRND || 0) - released);
                            return `
                                <tr data-user="${escapeAttr((user.username || user.name || '').toLowerCase())}">
                                    <td>${i + 1}</td>
                                    <td><strong>${escapeHtml(user.name || 'Unknown')}</strong><br><small style="color:#556688;">${escapeHtml(user.username || 'N/A')}</small></td>
                                    <td style="color:#fbbf24;">${escapeHtml(pkg.planName || 'Package')}</td>
                                    <td><strong style="color:#2ecc71;">$${(pkg.usdtAmount || 0).toFixed(2)}</strong></td>
                                    <td><strong style="color:#60a5fa;">${(pkg.totalRND || 0).toFixed(2)}</strong></td>
                                    <td style="color:#34d399;">${released.toFixed(2)}</td>
                                    <td style="color:#a78bfa;">${locked.toFixed(2)}</td>
                                    <td><span class="${statusClass}">${statusText}</span></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}
window.filterPackages = function(value) {
    const rows = document.querySelectorAll('#packagesTable tbody tr');
    const s = value.toLowerCase();
    rows.forEach(r => { r.style.display = (r.getAttribute('data-user') || '').includes(s) ? '' : 'none'; });
};

// ============================================================
// SETTINGS TAB (Direct Offer Stats REMOVED)
// ============================================================
function renderSettingsTab() {
    const currentRate = allSettings.rate || 1.00;
    const stats = computeStats();
    return `
        <div class="card-glass">
            <div class="card-title"><i class="bi bi-gear text-success me-2"></i>Admin Settings</div>
            <form id="settingsForm">
                <div class="row g-3">
                    <div class="col-md-6">
                        <label class="form-label">RND Token Rate (USD)</label>
                        <input type="number" id="rndRate" class="form-control form-control-custom" step="0.0001" value="${currentRate}" required>
                        <small class="text-muted">Current rate: 1 RND = $<span id="currentRateDisplay">${currentRate}</span></small>
                    </div>
                    <div class="col-md-6 d-flex align-items-end">
                        <button type="submit" class="btn-primary-custom" id="saveSettingsBtn"><i class="bi bi-save me-2"></i>Update Rate</button>
                    </div>
                </div>
            </form>
            <hr class="border-secondary">
            <div class="row g-3">
                <div class="col-md-6">
                    <h6 class="text-muted">📊 Platform Stats</h6>
                    <div class="info-row"><span class="label">Total Users</span><span class="value">${stats.totalUsers}</span></div>
                    <div class="info-row"><span class="label">Total Deposits</span><span class="value">${allTransactions.filter(t => t.type === 'deposit').length}</span></div>
                    <div class="info-row"><span class="label">Total Withdrawals</span><span class="value">${allTransactions.filter(t => t.type === 'withdrawal').length}</span></div>
                    <div class="info-row"><span class="label">Total Packages</span><span class="value">${allPackages.length}</span></div>
                    <div class="info-row"><span class="label">Total Deposit Wallet</span><span class="value" style="color:#2ecc71;">$${stats.totalDepositWallet.toFixed(2)}</span></div>
                    <div class="info-row"><span class="label">Total RND Wallet</span><span class="value" style="color:#60a5fa;">${stats.totalRNDWallet.toFixed(2)}</span></div>
                    <div class="info-row"><span class="label">Total Locked RND</span><span class="value" style="color:#a78bfa;">${stats.totalLockedRND.toFixed(2)}</span></div>
                </div>
                <div class="col-md-6">
                    <h6 class="text-muted">🔗 Quick Links</h6>
                    <div class="info-row" style="padding:12px 0;display:flex;justify-content:space-between;align-items:center;">
                        <span class="label"><i class="bi bi-trophy-fill" style="color:#fbbf24;"></i> Rank Reward</span>
                        <a href="rank-reward-admin.html" class="btn-rank-reward" style="padding:6px 14px;font-size:0.75rem;">Open →</a>
                    </div>
                    <div class="info-row" style="padding:12px 0;display:flex;justify-content:space-between;align-items:center;">
                        <span class="label"><i class="bi bi-gift-fill" style="color:#a78bfa;"></i> Direct Offer</span>
                        <a href="direct-offer-admin.html" class="btn-direct-offer" style="padding:6px 14px;font-size:0.75rem;">Open →</a>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// SWITCH TAB
// ============================================================
window.switchTab = function(tab) {
    currentTab = tab;
    renderDashboard();
};

// ============================================================
// ADMIN ADJUSTMENT HANDLER
// ============================================================
async function handleAdminAdjustment() {
    const uid = document.getElementById('adminUserSelect').value;
    const walletType = document.getElementById('adminWalletSelect').value;
    const type = document.getElementById('adminAdjustType').value;
    const amount = parseFloat(document.getElementById('adminAdjustAmount').value);
    const description = document.getElementById('adminAdjustDesc').value || `${type === 'credit' ? 'Admin Credit' : 'Admin Debit'}`;
    if (!amount || amount <= 0) { showToast('❌ Enter a valid amount!', 'error'); return; }
    if (!uid) { showToast('❌ Select a user!', 'error'); return; }
    if (!confirm(`⚠️ ${type === 'credit' ? 'CREDIT' : 'DEBIT'} $${amount} USDT ${walletType}?`)) return;
    const btn = document.querySelector('#adminAdjustForm button[type="submit"]');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';
    try {
        const result = await processAdminAdjustment(uid, walletType, amount, type, description);
        if (result.success) {
            showToast(`✅ ${type === 'credit' ? 'Credited' : 'Debited'} $${amount}!`, 'success');
            document.getElementById('adminAdjustAmount').value = '';
            document.getElementById('adminAdjustDesc').value = '';
            setTimeout(renderDashboard, 500);
        } else showToast('❌ Failed: ' + (result.error || 'Error'), 'error');
    } catch (error) { showToast('❌ Error: ' + error.message, 'error'); }
    btn.disabled = false;
    btn.innerHTML = orig;
}

// ============================================================
// SAVE SETTINGS
// ============================================================
async function saveSettings() {
    const rateInput = document.getElementById('rndRate');
    if (!rateInput) return;
    const rate = parseFloat(rateInput.value);
    if (!rate || rate <= 0) { showToast('❌ Enter a valid rate.', 'error'); return; }
    const btn = document.getElementById('saveSettingsBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving...'; }
    try {
        await set(ref(db, 'settings/rate'), rate);
        const display = document.getElementById('currentRateDisplay');
        if (display) display.textContent = rate;
        showToast('✅ Rate updated to $' + rate, 'success');
    } catch (error) { showToast('❌ Error: ' + error.message, 'error'); }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-save me-2"></i>Update Rate'; }
}

// ============================================================
// TYPE HELPERS
// ============================================================
function getTypeLabel(type) {
    const map = {
        'deposit': 'Deposit', 'withdrawal': 'Withdrawal',
        'package': 'Package Purchase', 'transfer_sent': 'Transfer Sent',
        'transfer_received': 'Transfer Received', 'referral_commission': 'Referral Commission',
        'daily_release': 'Daily Release', 'admin_credit': 'Admin Credit',
        'admin_debit': 'Admin Debit', 'bonus': 'Bonus Credit',
        'package_completed': 'Package Completed',
        'direct_offer_withdrawal': 'Direct Offer Withdrawal',
        'level_commission': 'Level Commission',
        'direct_commission': 'Direct Commission',
        'team_commission': 'Team Commission',
        'referral_bonus': 'Referral Bonus'
    };
    return map[type] || type;
}
function getTypeIcon(type) {
    const map = {
        'deposit': 'bi-arrow-down-circle', 'withdrawal': 'bi-arrow-up-circle',
        'package': 'bi-box-seam', 'transfer_sent': 'bi-arrow-up-right',
        'transfer_received': 'bi-arrow-down-left', 'referral_commission': 'bi-people',
        'daily_release': 'bi-clock-history', 'admin_credit': 'bi-plus-circle',
        'admin_debit': 'bi-dash-circle', 'bonus': 'bi-gift',
        'package_completed': 'bi-check-circle',
        'direct_offer_withdrawal': 'bi-gift-fill',
        'level_commission': 'bi-people-fill',
        'direct_commission': 'bi-people-fill',
        'team_commission': 'bi-diagram-3',
        'referral_bonus': 'bi-gift-fill'
    };
    return map[type] || 'bi-circle';
}
