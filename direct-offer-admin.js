// ============================================================
// DIRECT OFFER ADMIN — JavaScript
// ============================================================
// ⚠️ STANDALONE FILE — does NOT modify admin.js or rank-reward-admin.js
// Features:
//   - Copy full BEP-20 wallet address (with verification)
//   - Approve → status becomes 'paid' → user website shows "Payment Sent"
//   - Reject → status becomes 'rejected' → reward refunded to available
//   - Atomic multi-location sync (campaign_rewards + admin/withdrawals + user tx + global tx)
//   - Duplicate processing protection (status guards)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction, onValue } from "firebase/database";

// ============================================================
// FIREBASE CONFIG
// ============================================================
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

// ============================================================
// CAMPAIGN CONFIG
// ============================================================
// यहाँ दोनों Campaign IDs supported हैं — auto-detect करेगा
const POSSIBLE_CAMPAIGN_IDS = [
    'direct_offer_50pack_oct2026',  // यूजर फाइल से (active campaign)
    'direct_offer_2026'              // पुरानी admin फाइल से
];

// ============================================================
// GLOBAL STATE
// ============================================================
let allUsers = {};
let allCampaignRewards = {};      // { uid: { campaignId: {...} } }
let allAdminWithdrawals = {};     // { withdrawalId: {...} }
let allRecords = [];              // Flattened
let filteredRecords = [];
let activeTab = 'pending';
let searchQuery = '';
let isProcessingAction = new Set(); // Track uid::wid currently processing

let usersOff = null;
let rewardsOff = null;
let adminWdsOff = null;
let dataReady = false;

// ============================================================
// UTILS
// ============================================================
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function formatCurrency(amount) {
    const value = Number(amount);
    return '$' + (Number.isFinite(value) ? value : 0).toFixed(2);
}

function formatDateTime(timestamp) {
    if (!timestamp) return { date: '—', time: '' };
    try {
        const d = new Date(Number(timestamp));
        if (isNaN(d.getTime())) return { date: '—', time: '' };
        return {
            date: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        };
    } catch (e) {
        return { date: '—', time: '' };
    }
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill' :
                 type === 'error' ? 'bi-exclamation-triangle-fill' :
                 'bi-info-circle-fill';
    toast.innerHTML = `<i class="bi ${icon}"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

// ============================================================
// COPY WALLET ADDRESS (Full, verified)
// ============================================================
window.copyWalletAddress = async function(address, btnEl) {
    if (!address || address === 'N/A' || !address.trim()) {
        showToast('❌ No wallet address to copy', 'error');
        return;
    }

    const fullAddress = String(address).trim();

    // Verify BEP-20 format (loose check — 0x + 40 hex)
    const isValidBEP20 = /^0x[a-fA-F0-9]{40}$/.test(fullAddress);
    if (!isValidBEP20) {
        showToast('⚠️ Warning: Address may not be valid BEP-20 format', 'warning');
    }

    const doCopy = async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(fullAddress);
            } else {
                // Fallback
                const ta = document.createElement('textarea');
                ta.value = fullAddress;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }

            // Visual feedback on button
            if (btnEl) {
                const orig = btnEl.innerHTML;
                btnEl.classList.add('copied');
                btnEl.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
                setTimeout(() => {
                    btnEl.classList.remove('copied');
                    btnEl.innerHTML = orig;
                }, 2000);
            }

            showToast('✅ Full wallet address copied to clipboard', 'success');
        } catch (err) {
            console.error('Copy error:', err);
            showToast('❌ Copy failed — please copy manually', 'error');
        }
    };

    doCopy();
};

// ============================================================
// BUILD FLAT RECORDS
// ============================================================
function buildRecords(users, campaignRewards, adminWithdrawals) {
    const records = [];
    const seenWithdrawalIds = new Set();

    // 1. From campaign_rewards (primary source)
    for (const uid in campaignRewards) {
        const campaigns = campaignRewards[uid] || {};
        for (const cid in campaigns) {
            const r = campaigns[cid];
            if (!r || typeof r !== 'object') continue;

            const status = String(r.status || 'available').toLowerCase();

            // Only show records that have a withdrawal request
            // (pending, approved, paid, rejected)
            if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) continue;

            const wid = r.withdrawalId || '';
            if (wid) {
                if (seenWithdrawalIds.has(wid)) continue;
                seenWithdrawalIds.add(wid);
            }

            const user = users[uid] || { name: 'Unknown', username: 'N/A', email: 'N/A' };

            records.push({
                uid: uid,
                campaignId: cid,
                withdrawalId: wid,
                status: status,
                amount: Number(r.finalReward ?? r.currentReward ?? 0),
                walletAddress: r.walletAddress || '',
                userName: user.name || 'Unknown',
                userUsername: user.username || user.referralCode || 'N/A',
                userEmail: user.email || 'N/A',
                requestedAt: r.requestedAt || r.updatedAt || r.snapshotAt || 0,
                approvedAt: r.approvedAt || 0,
                paidAt: r.paidAt || 0,
                rejectedAt: r.rejectedAt || 0,
                rejectReason: r.rejectReason || '',
                txHash: r.txHash || '',
                network: r.network || 'BEP-20',
                source: 'campaign_rewards'
            });
        }
    }

    // 2. From admin/withdrawals (supplement — for withdrawals created via admin panel)
    for (const wid in adminWithdrawals) {
        const w = adminWithdrawals[wid];
        if (!w || typeof w !== 'object') continue;
        if (w.type !== 'direct_offer_withdrawal' && !w.campaignId) continue;

        const realWid = w.withdrawalId || wid;
        if (seenWithdrawalIds.has(realWid)) continue;
        seenWithdrawalIds.add(realWid);

        const status = String(w.status || 'pending').toLowerCase();
        if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) continue;

        const user = users[w.userId || w.uid] || { name: 'Unknown', username: 'N/A', email: 'N/A' };

        records.push({
            uid: w.userId || w.uid,
            campaignId: w.campaignId || '',
            withdrawalId: realWid,
            status: status,
            amount: Number(w.amount || 0),
            walletAddress: w.walletAddress || w.wallet || '',
            userName: user.name || w.username || 'Unknown',
            userUsername: user.username || 'N/A',
            userEmail: user.email || 'N/A',
            requestedAt: w.requestedAt || w.timestamp || 0,
            approvedAt: w.approvedAt || 0,
            paidAt: w.paidAt || 0,
            rejectedAt: w.rejectedAt || 0,
            rejectReason: w.rejectReason || '',
            txHash: w.txHash || '',
            network: w.network || 'BEP-20',
            source: 'admin/withdrawals'
        });
    }

    // Sort: pending first → most recent
    records.sort((a, b) => {
        const priority = { pending: 0, approved: 1, paid: 2, rejected: 3 };
        const pA = priority[a.status] ?? 9;
        const pB = priority[b.status] ?? 9;
        if (pA !== pB) return pA - pB;
        return (b.requestedAt || 0) - (a.requestedAt || 0);
    });

    return records;
}

// ============================================================
// UPDATE SUMMARY & TAB COUNTS
// ============================================================
function updateSummary() {
    const participants = new Set(allRecords.map(r => r.uid)).size;
    const pending = allRecords.filter(r => r.status === 'pending').length;
    const approved = allRecords.filter(r => r.status === 'approved' || r.status === 'paid').length;
    const rejected = allRecords.filter(r => r.status === 'rejected').length;

    document.getElementById('totalParticipants').textContent = participants;
    document.getElementById('totalPending').textContent = pending;
    document.getElementById('totalApproved').textContent = approved;
    document.getElementById('totalRejected').textContent = rejected;

    document.getElementById('pendingTabCount').textContent = pending;
    document.getElementById('approvedTabCount').textContent = approved;
    document.getElementById('rejectedTabCount').textContent = rejected;
    document.getElementById('allTabCount').textContent = allRecords.length;
}

// ============================================================
// APPLY FILTERS (Tab + Search)
// ============================================================
function applyFilters() {
    let list = allRecords.slice();

    // Tab filter
    if (activeTab === 'pending') {
        list = list.filter(r => r.status === 'pending');
    } else if (activeTab === 'approved') {
        list = list.filter(r => r.status === 'approved' || r.status === 'paid');
    } else if (activeTab === 'rejected') {
        list = list.filter(r => r.status === 'rejected');
    }
    // 'all' → no filter

    // Search filter
    const q = searchQuery.trim().toLowerCase();
    if (q) {
        list = list.filter(r => {
            const hay = [
                r.userName, r.userUsername, r.userEmail,
                r.walletAddress, r.withdrawalId, r.txHash
            ].join(' ').toLowerCase();
            return hay.includes(q);
        });
    }

    filteredRecords = list;
    renderList();
}

// ============================================================
// RENDER LIST
// ============================================================
function renderList() {
    const container = document.getElementById('withdrawalsList');
    const emptyState = document.getElementById('emptyState');

    if (filteredRecords.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';
    container.innerHTML = filteredRecords.map(record => renderRecordCard(record)).join('');
}

// ============================================================
// RENDER SINGLE CARD
// ============================================================
function renderRecordCard(r) {
    const date = formatDateTime(r.requestedAt);
    const initial = (r.userName || 'U').charAt(0).toUpperCase();
    const isPending = r.status === 'pending';
    const processing = isProcessingAction.has(r.uid + '::' + r.withdrawalId);

    let statusBadgeHtml = '';
    if (r.status === 'pending') {
        statusBadgeHtml = `<span class="status-badge pending"><i class="bi bi-hourglass-split"></i> Pending</span>`;
    } else if (r.status === 'approved') {
        statusBadgeHtml = `<span class="status-badge approved"><i class="bi bi-check-circle-fill"></i> Approved</span>`;
    } else if (r.status === 'paid') {
        statusBadgeHtml = `<span class="status-badge paid"><i class="bi bi-currency-dollar"></i> Paid</span>`;
    } else if (r.status === 'rejected') {
        statusBadgeHtml = `<span class="status-badge rejected"><i class="bi bi-x-circle-fill"></i> Rejected</span>`;
    }

    // Action buttons only if pending
    const actionsHtml = isPending ? `
        <div class="wc-actions">
            <button class="btn-reject" 
                    onclick="handleReject('${escapeHtml(r.uid)}', '${escapeHtml(r.withdrawalId)}', '${escapeHtml(r.campaignId)}')"
                    ${processing ? 'disabled' : ''}>
                <i class="bi bi-x-lg"></i> Reject
            </button>
            <button class="btn-approve" 
                    onclick="handleApprove('${escapeHtml(r.uid)}', '${escapeHtml(r.withdrawalId)}', '${escapeHtml(r.campaignId)}', ${r.amount})"
                    ${processing ? 'disabled' : ''}>
                ${processing
                    ? '<span class="spinner-border spinner-border-sm" style="width: 1rem; height: 1rem;"></span> Processing...'
                    : '<i class="bi bi-check-lg"></i> Approve (Payment Sent)'}
            </button>
        </div>
    ` : '';

    // Wallet display
    const walletHtml = r.walletAddress ? `
        <div class="wallet-box">
            <div class="wallet-label">
                <i class="bi bi-wallet2"></i> BEP-20 Wallet Address
            </div>
            <div class="wallet-address-row">
                <div class="wallet-address">${escapeHtml(r.walletAddress)}</div>
                <button class="btn-copy-wallet" 
                        onclick="copyWalletAddress('${escapeHtml(r.walletAddress)}', this)"
                        title="Copy full address">
                    <i class="bi bi-clipboard"></i> Copy
                </button>
            </div>
        </div>
    ` : `
        <div class="wallet-box" style="border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.05);">
            <div class="wallet-label" style="color: #f87171;">
                <i class="bi bi-exclamation-triangle"></i> No Wallet Address Provided
            </div>
        </div>
    `;

    // Extra info for non-pending
    let extraInfoHtml = '';
    if (r.status === 'rejected' && r.rejectReason) {
        extraInfoHtml = `
            <div class="tx-info-row" style="border-top-color: rgba(239,68,68,0.2);">
                <span><i class="bi bi-info-circle"></i> Reason: <strong style="color: #f87171;">${escapeHtml(r.rejectReason)}</strong></span>
            </div>
        `;
    } else if ((r.status === 'approved' || r.status === 'paid') && r.txHash) {
        extraInfoHtml = `
            <div class="tx-info-row">
                <span><i class="bi bi-hash"></i> TX Hash: <span class="tx-id-val">${escapeHtml(r.txHash)}</span></span>
            </div>
        `;
    }

    return `
        <div class="withdrawal-card ${escapeHtml(r.status)}">
            <div class="wc-header">
                <div class="wc-user">
                    <div class="wc-avatar">${escapeHtml(initial)}</div>
                    <div class="wc-user-info">
                        <div class="wc-name">${escapeHtml(r.userName)}</div>
                        <div class="wc-username">@${escapeHtml(r.userUsername)}</div>
                        <div class="wc-user-id">UID: ${escapeHtml(String(r.uid).substring(0, 14))}...</div>
                    </div>
                </div>
                <div class="wc-amount-wrap">
                    <div class="wc-amount">
                        ${formatCurrency(r.amount)}<span class="currency">USDT</span>
                    </div>
                    <div class="wc-date">${escapeHtml(date.date)} · ${escapeHtml(date.time)}</div>
                    <div style="margin-top: 6px;">${statusBadgeHtml}</div>
                </div>
            </div>

            ${walletHtml}

            <div class="tx-info-row">
                <span><i class="bi bi-receipt"></i> Withdrawal ID: <span class="tx-id-val">${escapeHtml(r.withdrawalId || 'N/A')}</span></span>
                <span><i class="bi bi-diagram-3"></i> ${escapeHtml(r.network)}</span>
            </div>

            ${extraInfoHtml}
            ${actionsHtml}
        </div>
    `;
}

// ============================================================
// ATOMIC MULTI-LOCATION SYNC (matches your original admin logic)
// ============================================================
async function atomicSync(uid, withdrawalId, campaignId, updates) {
    const rootUpdates = {};

    // 1. Update admin/withdrawals (find matching record)
    try {
        const adminSnap = await get(ref(db, 'admin/withdrawals'));
        if (adminSnap.exists()) {
            const adminData = adminSnap.val();
            for (let key in adminData) {
                if (adminData[key].withdrawalId === withdrawalId) {
                    const path = `admin/withdrawals/${key}`;
                    rootUpdates[`${path}/status`] = updates.status;
                    rootUpdates[`${path}/updatedAt`] = updates.updatedAt;
                    if (updates.approvedAt) rootUpdates[`${path}/approvedAt`] = updates.approvedAt;
                    if (updates.paidAt) rootUpdates[`${path}/paidAt`] = updates.paidAt;
                    if (updates.txHash !== undefined) rootUpdates[`${path}/txHash`] = updates.txHash;
                    if (updates.rejectReason !== undefined) rootUpdates[`${path}/rejectReason`] = updates.rejectReason;
                    if (updates.rejectedAt) rootUpdates[`${path}/rejectedAt`] = updates.rejectedAt;
                    break;
                }
            }
        }
    } catch (err) {
        console.warn('admin/withdrawals sync warning:', err);
    }

    // 2. Update user's transaction record
    try {
        const userSnap = await get(ref(db, `users/${uid}/transactions`));
        if (userSnap.exists()) {
            const txs = userSnap.val();
            for (let txKey in txs) {
                if (txs[txKey].withdrawalId === withdrawalId) {
                    const path = `users/${uid}/transactions/${txKey}`;
                    rootUpdates[`${path}/status`] = updates.status;
                    rootUpdates[`${path}/updatedAt`] = updates.updatedAt;
                    if (updates.approvedAt) rootUpdates[`${path}/approvedAt`] = updates.approvedAt;
                    if (updates.paidAt) rootUpdates[`${path}/paidAt`] = updates.paidAt;
                    if (updates.txHash !== undefined) rootUpdates[`${path}/txHash`] = updates.txHash;
                    if (updates.rejectReason !== undefined) rootUpdates[`${path}/rejectReason`] = updates.rejectReason;
                    if (updates.rejectedAt) rootUpdates[`${path}/rejectedAt`] = updates.rejectedAt;
                    break;
                }
            }
        }
    } catch (err) {
        console.warn('users/transactions sync warning:', err);
    }

    // 3. Update global transactions
    try {
        const globalSnap = await get(ref(db, 'transactions'));
        if (globalSnap.exists()) {
            const globalData = globalSnap.val();
            for (let key in globalData) {
                if (globalData[key].withdrawalId === withdrawalId) {
                    const path = `transactions/${key}`;
                    rootUpdates[`${path}/status`] = updates.status;
                    rootUpdates[`${path}/updatedAt`] = updates.updatedAt;
                    if (updates.approvedAt) rootUpdates[`${path}/approvedAt`] = updates.approvedAt;
                    if (updates.paidAt) rootUpdates[`${path}/paidAt`] = updates.paidAt;
                    if (updates.txHash !== undefined) rootUpdates[`${path}/txHash`] = updates.txHash;
                    if (updates.rejectReason !== undefined) rootUpdates[`${path}/rejectReason`] = updates.rejectReason;
                    if (updates.rejectedAt) rootUpdates[`${path}/rejectedAt`] = updates.rejectedAt;
                    break;
                }
            }
        }
    } catch (err) {
        console.warn('transactions sync warning:', err);
    }

    // Apply all updates atomically
    if (Object.keys(rootUpdates).length > 0) {
        await update(ref(db), rootUpdates);
    }
}

// ============================================================
// APPROVE
// ============================================================
window.handleApprove = async function(uid, withdrawalId, campaignId, amount) {
    const key = uid + '::' + withdrawalId;

    if (isProcessingAction.has(key)) return;

    // Confirmation dialog
    const confirmed = confirm(
        `✅ CONFIRM APPROVAL\n\n` +
        `User UID: ${uid}\n` +
        `Amount: $${Number(amount).toFixed(2)} USDT\n` +
        `Withdrawal ID: ${withdrawalId}\n\n` +
        `⚠️ क्या आपने इस यूजर के wallet address पर ` +
        `$${Number(amount).toFixed(2)} USDT (BEP-20) भेज दिया है?\n\n` +
        `OK = हाँ, Approved कर दो\nCancel = रुको`
    );

    if (!confirmed) return;

    isProcessingAction.add(key);
    renderList(); // Show spinner

    try {
        // Auto-detect campaign ID if not provided
        let realCampaignId = campaignId;
        if (!realCampaignId) {
            const userCampaigns = allCampaignRewards[uid] || {};
            for (const possibleCid of POSSIBLE_CAMPAIGN_IDS) {
                if (userCampaigns[possibleCid]) {
                    realCampaignId = possibleCid;
                    break;
                }
            }
            if (!realCampaignId) {
                realCampaignId = Object.keys(userCampaigns)[0];
            }
        }

        if (!realCampaignId) {
            throw new Error('Campaign ID not found for this user');
        }

        const campaignRef = ref(db, `campaign_rewards/${uid}/${realCampaignId}`);

        // Atomic lock: only approve if still pending
        const lockResult = await runTransaction(campaignRef, (current) => {
            if (!current) return current;
            const status = String(current.status || '').toLowerCase();
            if (status !== 'pending') return current; // Abort

            const now = Date.now();
            return {
                ...current,
                status: 'paid',           // Directly to 'paid' so user sees "Payment Sent"
                approvedAt: now,
                paidAt: now,
                updatedAt: now,
                isProcessed: true,
                isPaidFinal: true
            };
        });

        if (!lockResult.committed) {
            throw new Error('Withdrawal is not in pending state — may have been processed already');
        }

        const now = Date.now();

        // Sync across all locations
        try {
            await atomicSync(uid, withdrawalId, realCampaignId, {
                status: 'paid',
                approvedAt: now,
                paidAt: now,
                updatedAt: now
            });
        } catch (syncErr) {
            console.error('Multi-location sync failed:', syncErr);
            // Rollback
            try {
                await update(campaignRef, {
                    status: 'pending',
                    approvedAt: null,
                    paidAt: null,
                    updatedAt: Date.now(),
                    isProcessed: false,
                    isPaidFinal: false
                });
            } catch (rollbackErr) {
                console.error('CRITICAL: Rollback failed', rollbackErr);
            }
            throw new Error('Sync failed — rolled back');
        }

        showToast(`✅ Approved! User will see "Payment Sent" on their website now.`, 'success');

    } catch (err) {
        console.error('Approve error:', err);
        showToast('❌ ' + (err.message || 'Failed to approve'), 'error');
    } finally {
        isProcessingAction.delete(key);
        renderList();
    }
};

// ============================================================
// REJECT
// ============================================================
window.handleReject = async function(uid, withdrawalId, campaignId) {
    const key = uid + '::' + withdrawalId;

    if (isProcessingAction.has(key)) return;

    const reason = prompt(
        `❌ REJECT WITHDRAWAL\n\n` +
        `User UID: ${uid}\n` +
        `Withdrawal ID: ${withdrawalId}\n\n` +
        `Rejection reason (optional):\n` +
        `(यूजर को यह कारण दिखेगा)`,
        ''
    );

    // If user clicked Cancel on prompt, reason === null → abort
    if (reason === null) return;

    isProcessingAction.add(key);
    renderList();

    try {
        let realCampaignId = campaignId;
        if (!realCampaignId) {
            const userCampaigns = allCampaignRewards[uid] || {};
            for (const possibleCid of POSSIBLE_CAMPAIGN_IDS) {
                if (userCampaigns[possibleCid]) {
                    realCampaignId = possibleCid;
                    break;
                }
            }
            if (!realCampaignId) {
                realCampaignId = Object.keys(userCampaigns)[0];
            }
        }

        if (!realCampaignId) {
            throw new Error('Campaign ID not found for this user');
        }

        const campaignRef = ref(db, `campaign_rewards/${uid}/${realCampaignId}`);

        const lockResult = await runTransaction(campaignRef, (current) => {
            if (!current) return current;
            const status = String(current.status || '').toLowerCase();
            if (status !== 'pending') return current;

            const now = Date.now();
            const wasDeducted = current.deducted === true;
            const deductedAmount = Number(current.deductedAmount || 0);

            const updateObj = {
                ...current,
                status: 'rejected',
                rejectReason: reason || '',
                rejectedAt: now,
                updatedAt: now,
                isProcessed: true
            };

            // Refund logic
            if (wasDeducted && deductedAmount > 0 && isFinite(deductedAmount)) {
                updateObj.refundPending = true;
                updateObj.refundAmount = deductedAmount;
            } else {
                updateObj.refundPending = false;
                updateObj.refundAmount = 0;
            }

            return updateObj;
        });

        if (!lockResult.committed) {
            throw new Error('Withdrawal is not in pending state — may have been processed already');
        }

        const rejectedData = lockResult.snapshot.val();
        const now = Date.now();

        try {
            await atomicSync(uid, withdrawalId, realCampaignId, {
                status: 'rejected',
                rejectedAt: now,
                updatedAt: now,
                rejectReason: reason || ''
            });
        } catch (syncErr) {
            console.error('Multi-location sync failed:', syncErr);
            try {
                await update(campaignRef, {
                    status: 'pending',
                    updatedAt: Date.now(),
                    isProcessed: false,
                    refundPending: false
                });
            } catch (rollbackErr) {
                console.error('CRITICAL: Rollback failed', rollbackErr);
            }
            throw new Error('Sync failed — rolled back');
        }

        const refundMsg = rejectedData.refundPending
            ? ' + reward refunded to user (available again)'
            : '';
        showToast(`❌ Rejected${refundMsg}`, 'success');

    } catch (err) {
        console.error('Reject error:', err);
        showToast('❌ ' + (err.message || 'Failed to reject'), 'error');
    } finally {
        isProcessingAction.delete(key);
        renderList();
    }
};

// ============================================================
// TAB SWITCHING
// ============================================================
function setupTabs() {
    document.querySelectorAll('.custom-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.custom-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeTab = tab.getAttribute('data-tab');
            applyFilters();
        });
    });
}

// ============================================================
// SEARCH
// ============================================================
function setupSearch() {
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        applyFilters();
    });
}

// ============================================================
// MAIN DATA LOADING
// ============================================================
function loadData() {
    let usersLoaded = false;
    let rewardsLoaded = false;
    let adminWdsLoaded = false;

    const checkReady = () => {
        if (usersLoaded && rewardsLoaded && adminWdsLoaded) {
            dataReady = true;
            allRecords = buildRecords(allUsers, allCampaignRewards, allAdminWithdrawals);
            document.getElementById('loadingContainer').style.display = 'none';
            document.getElementById('contentContainer').style.display = 'block';

            updateSummary();
            applyFilters();
        }
    };

    const refresh = () => {
        if (!dataReady) return;
        allRecords = buildRecords(allUsers, allCampaignRewards, allAdminWithdrawals);
        updateSummary();
        applyFilters();
    };

    // Users
    usersOff = onValue(ref(db, 'users'), (snap) => {
        allUsers = snap.exists() ? snap.val() : {};
        usersLoaded = true;
        if (dataReady) refresh(); else checkReady();
    }, (err) => {
        console.error('Users load error:', err);
        showToast('Failed to load users: ' + err.message, 'error');
    });

    // Campaign rewards
    rewardsOff = onValue(ref(db, 'campaign_rewards'), (snap) => {
        allCampaignRewards = snap.exists() ? snap.val() : {};
        rewardsLoaded = true;
        if (dataReady) refresh(); else checkReady();
    }, (err) => {
        console.error('Campaign rewards load error:', err);
        showToast('Failed to load rewards: ' + err.message, 'error');
    });

    // Admin withdrawals
    adminWdsOff = onValue(ref(db, 'admin/withdrawals'), (snap) => {
        allAdminWithdrawals = snap.exists() ? snap.val() : {};
        adminWdsLoaded = true;
        if (dataReady) refresh(); else checkReady();
    }, (err) => {
        console.error('Admin withdrawals load error:', err);
        showToast('Failed to load withdrawals: ' + err.message, 'error');
    });
}

// ============================================================
// AUTH CHECK
// ============================================================
onAuthStateChanged(auth, (user) => {
    if (!user) {
        showToast('Not authenticated — redirecting to admin login...', 'warning');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 1500);
        return;
    }

    if (user.email && !user.email.includes('admin')) {
        showToast('Access denied — admin only', 'error');
        setTimeout(() => {
            signOut(auth);
            window.location.href = 'index.html';
        }, 2000);
        return;
    }

    setupTabs();
    setupSearch();
    loadData();
});

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (usersOff) { try { usersOff(); } catch (e) {} }
    if (rewardsOff) { try { rewardsOff(); } catch (e) {} }
    if (adminWdsOff) { try { adminWdsOff(); } catch (e) {} }
});

// ============================================================
// BOOT LOG
// ============================================================
console.log('%c🎁 Direct Offer Admin — Live Management', 'color: #a78bfa; font-size: 14px; font-weight: bold;');
console.log('%c💸 Approve → status becomes "paid" (user sees "Payment Sent")', 'color: #2ecc71; font-size: 11px;');
console.log('%c❌ Reject → status becomes "rejected" (refund auto-applied)', 'color: #f87171; font-size: 11px;');
console.log('%c📋 Copy button copies FULL BEP-20 address', 'color: #60a5fa; font-size: 11px;');
