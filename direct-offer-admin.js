// ============================================================
// DIRECT OFFER ADMIN — JavaScript (v2 with Withdrawals Section)
// ============================================================
// ⚠️ STANDALONE FILE
// Features:
//   - Two main sections: Overview & Withdrawals
//   - Withdrawals section has sub-tabs: Pending / Approved / Rejected / All
//   - Copy full BEP-20 wallet address
//   - Approve (directly marks as 'paid' so user sees "Payment Sent")
//   - Reject (with reason + auto-refund)
//   - Atomic multi-location sync
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
// CAMPAIGN IDs (Auto-detect supported)
// ============================================================
const POSSIBLE_CAMPAIGN_IDS = [
    'direct_offer_50pack_oct2026',  // new active campaign
    'direct_offer_2026'              // old campaign
];

// ============================================================
// GLOBAL STATE
// ============================================================
let allUsers = {};
let allCampaignRewards = {};
let allAdminWithdrawals = {};
let allOverviewRecords = [];  // for Overview tab
let allWithdrawalRecords = []; // for Withdrawals tab (only those with withdrawal requests)
let filteredWithdrawals = [];

let activeMainTab = 'overview';
let activeSubTab = 'pending';
let searchQuery = '';
let isProcessingAction = new Set();

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
// COPY WALLET ADDRESS
// ============================================================
window.copyWalletAddress = async function(address, btnEl) {
    if (!address || address === 'N/A' || !address.trim()) {
        showToast('❌ No wallet address to copy', 'error');
        return;
    }
    const fullAddress = String(address).trim();
    const isValidBEP20 = /^0x[a-fA-F0-9]{40}$/.test(fullAddress);
    if (!isValidBEP20) {
        showToast('⚠️ Warning: Address may not be valid BEP-20 format', 'warning');
    }

    const doCopy = async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(fullAddress);
            } else {
                const ta = document.createElement('textarea');
                ta.value = fullAddress;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }

            if (btnEl) {
                const orig = btnEl.innerHTML;
                btnEl.classList.add('copied');
                btnEl.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
                setTimeout(() => {
                    btnEl.classList.remove('copied');
                    btnEl.innerHTML = orig;
                }, 2000);
            }
            showToast('✅ Full wallet address copied', 'success');
        } catch (err) {
            console.error('Copy error:', err);
            showToast('❌ Copy failed — please copy manually', 'error');
        }
    };
    doCopy();
};

// ============================================================
// BUILD DATA
// ============================================================
function buildData(users, campaignRewards, adminWithdrawals) {
    const overview = [];
    const withdrawals = [];
    const seenWid = new Set();
    const seenOverview = new Set();

    // 1. Campaign Rewards
    for (const uid in campaignRewards) {
        const campaigns = campaignRewards[uid] || {};
        for (const cid in campaigns) {
            const r = campaigns[cid];
            if (!r || typeof r !== 'object') continue;

            const status = String(r.status || 'available').toLowerCase();
            const user = users[uid] || { name: 'Unknown', username: 'N/A', email: 'N/A' };
            const amount = Number(r.finalReward ?? r.currentReward ?? 0);
            const refs = Number(r.finalDirectCount ?? r.currentDirectCount ?? 0);
            
            // Overview records (all finalized/completed)
            const ovKey = `${uid}::${cid}`;
            if (!seenOverview.has(ovKey) && (r.isFinalized === true || amount > 0 || refs > 0)) {
                seenOverview.add(ovKey);
                overview.push({
                    uid, campaignId: cid,
                    userName: user.name, userUsername: user.username, userEmail: user.email,
                    refs, amount, status,
                    walletAddress: r.walletAddress || '',
                    updatedAt: r.updatedAt || r.snapshotAt || 0
                });
            }

            // Withdrawals records (only if there's a withdrawalId or status is pending/approved/paid/rejected)
            const hasWithdrawal = r.withdrawalId || ['pending', 'approved', 'paid', 'rejected'].includes(status);
            if (hasWithdrawal) {
                const wid = r.withdrawalId || `__no_wid_${uid}_${cid}`;
                if (!seenWid.has(wid)) {
                    seenWid.add(wid);
                    withdrawals.push({
                        uid, campaignId: cid,
                        withdrawalId: r.withdrawalId || '',
                        status,
                        amount,
                        walletAddress: r.walletAddress || '',
                        userName: user.name, userUsername: user.username, userEmail: user.email,
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
        }
    }

    // 2. Admin Withdrawals
    for (const wid in adminWithdrawals) {
        const w = adminWithdrawals[wid];
        if (!w || typeof w !== 'object') continue;
        if (w.type !== 'direct_offer_withdrawal' && !w.campaignId) continue;

        const realWid = w.withdrawalId || wid;
        if (seenWid.has(realWid)) continue;
        seenWid.add(realWid);

        const status = String(w.status || 'pending').toLowerCase();
        if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) continue;

        const uid = w.userId || w.uid;
        const user = users[uid] || { name: 'Unknown', username: 'N/A', email: 'N/A' };

        withdrawals.push({
            uid, campaignId: w.campaignId || '',
            withdrawalId: realWid,
            status,
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

    // Sort overview (recent first)
    overview.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    
    // Sort withdrawals (pending first, then recent)
    const priority = { pending: 0, approved: 1, paid: 2, rejected: 3 };
    withdrawals.sort((a, b) => {
        const pA = priority[a.status] ?? 9;
        const pB = priority[b.status] ?? 9;
        if (pA !== pB) return pA - pB;
        return (b.requestedAt || 0) - (a.requestedAt || 0);
    });

    return { overview, withdrawals };
}

// ============================================================
// UPDATE SUMMARY
// ============================================================
function updateSummary() {
    // Overview
    const participants = new Set(allOverviewRecords.map(r => r.uid)).size;
    const completed = allOverviewRecords.filter(r => r.amount > 0).length;
    const paidTotal = allWithdrawalRecords
        .filter(r => r.status === 'paid' || r.status === 'approved')
        .reduce((sum, r) => sum + (r.amount || 0), 0);
    const rejected = allWithdrawalRecords.filter(r => r.status === 'rejected').length;

    document.getElementById('totalParticipants').textContent = participants;
    document.getElementById('totalCompleted').textContent = completed;
    document.getElementById('totalPaid').textContent = formatCurrency(paidTotal);
    document.getElementById('totalRejected').textContent = rejected;

    // Withdrawals counts
    const pending = allWithdrawalRecords.filter(r => r.status === 'pending').length;
    const approved = allWithdrawalRecords.filter(r => r.status === 'approved' || r.status === 'paid').length;
    const rej = allWithdrawalRecords.filter(r => r.status === 'rejected').length;

    document.getElementById('mainPendingCount').textContent = pending;
    document.getElementById('subPendingCount').textContent = pending;
    document.getElementById('subApprovedCount').textContent = approved;
    document.getElementById('subRejectedCount').textContent = rej;
    document.getElementById('subAllCount').textContent = allWithdrawalRecords.length;
}

// ============================================================
// RENDER OVERVIEW TABLE
// ============================================================
function renderOverview() {
    const tbody = document.getElementById('overviewTableBody');
    if (allOverviewRecords.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 40px; color: #556688;">No records found</td></tr>`;
        return;
    }

    tbody.innerHTML = allOverviewRecords.map(r => {
        const status = r.status === 'paid' || r.status === 'approved' ? 'success' :
                       r.status === 'pending' ? 'warning' : 'error';
        const statusText = r.status === 'paid' ? 'Paid' :
                           r.status === 'approved' ? 'Approved' :
                           r.status === 'pending' ? 'Pending' :
                           r.status === 'rejected' ? 'Rejected' : r.status;
        const statusClass = r.status === 'paid' ? 'paid' :
                           r.status === 'approved' ? 'approved' :
                           r.status === 'pending' ? 'pending' : 'rejected';

        const date = formatDateTime(r.updatedAt);

        return `
            <tr>
                <td>
                    <div class="wc-user" style="min-width: auto;">
                        <div class="wc-avatar" style="width: 34px; height: 34px; font-size: 0.8rem;">${escapeHtml((r.userName||'U').charAt(0).toUpperCase())}</div>
                        <div class="wc-user-info">
                            <div class="wc-name" style="font-size: 0.85rem;">${escapeHtml(r.userName)}</div>
                            <div class="wc-username" style="font-size: 0.72rem;">@${escapeHtml(r.userUsername)}</div>
                        </div>
                    </div>
                </td>
                <td style="font-weight: 700; color: #2ecc71;">${r.refs}</td>
                <td style="font-weight: 800; color: #fbbf24;">${formatCurrency(r.amount)}</td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td style="font-size: 0.75rem; color: #8899bb;">${escapeHtml(date.date)}</td>
            </tr>
        `;
    }).join('');
}

// ============================================================
// RENDER WITHDRAWALS LIST
// ============================================================
function renderWithdrawals() {
    let list = allWithdrawalRecords.slice();

    // Sub-tab filter
    if (activeSubTab === 'pending') {
        list = list.filter(r => r.status === 'pending');
    } else if (activeSubTab === 'approved') {
        list = list.filter(r => r.status === 'approved' || r.status === 'paid');
    } else if (activeSubTab === 'rejected') {
        list = list.filter(r => r.status === 'rejected');
    }

    // Search
    const q = searchQuery.trim().toLowerCase();
    if (q) {
        list = list.filter(r => {
            const hay = [r.userName, r.userUsername, r.userEmail, r.walletAddress, r.withdrawalId, r.txHash].join(' ').toLowerCase();
            return hay.includes(q);
        });
    }

    filteredWithdrawals = list;
    const container = document.getElementById('withdrawalsList');
    const emptyState = document.getElementById('emptyState');

    if (list.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';
    container.innerHTML = list.map(r => renderRecordCard(r)).join('');
}

// ============================================================
// RENDER SINGLE WITHDRAWAL CARD
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

    let extraInfoHtml = '';
    if (r.status === 'rejected' && r.rejectReason) {
        extraInfoHtml = `
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(239,68,68,0.2); font-size: 0.78rem;">
                <span style="color: #8899bb;"><i class="bi bi-info-circle"></i> Reason:</span>
                <strong style="color: #f87171; margin-left: 6px;">${escapeHtml(r.rejectReason)}</strong>
            </div>
        `;
    } else if ((r.status === 'approved' || r.status === 'paid') && r.txHash) {
        extraInfoHtml = `
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(46,204,113,0.2); font-size: 0.78rem;">
                <span style="color: #8899bb;"><i class="bi bi-hash"></i> TX Hash:</span>
                <span style="color: #a78bfa; margin-left: 6px; font-family: monospace;">${escapeHtml(r.txHash)}</span>
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

            <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(167,139,250,0.1); font-size: 0.75rem; color: #8899bb;">
                <span><i class="bi bi-receipt"></i> ID: <span style="font-family: monospace; color: #a78bfa;">${escapeHtml(r.withdrawalId || 'N/A')}</span></span>
                <span><i class="bi bi-diagram-3"></i> ${escapeHtml(r.network)}</span>
            </div>

            ${extraInfoHtml}
            ${actionsHtml}
        </div>
    `;
}

// ============================================================
// ATOMIC SYNC
// ============================================================
async function atomicSync(uid, withdrawalId, campaignId, updates) {
    const rootUpdates = {};

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
    } catch (err) { console.warn('admin/withdrawals sync warning:', err); }

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
    } catch (err) { console.warn('users/transactions sync warning:', err); }

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
    } catch (err) { console.warn('transactions sync warning:', err); }

    if (Object.keys(rootUpdates).length > 0) {
        await update(ref(db), rootUpdates);
    }
}

// ============================================================
// APPROVE HANDLER
// ============================================================
window.handleApprove = async function(uid, withdrawalId, campaignId, amount) {
    const key = uid + '::' + withdrawalId;
    if (isProcessingAction.has(key)) return;

    const confirmed = confirm(
        `✅ CONFIRM APPROVAL\n\n` +
        `Amount: $${Number(amount).toFixed(2)} USDT\n` +
        `Withdrawal ID: ${withdrawalId}\n\n` +
        `⚠️ क्या आपने इस यूजर के wallet address पर ` +
        `$${Number(amount).toFixed(2)} USDT (BEP-20) भेज दिया है?\n\n` +
        `OK = हाँ, Approved कर दो\nCancel = रुको`
    );
    if (!confirmed) return;

    isProcessingAction.add(key);
    renderWithdrawals();

    try {
        let realCampaignId = campaignId;
        if (!realCampaignId) {
            const userCampaigns = allCampaignRewards[uid] || {};
            for (const possibleCid of POSSIBLE_CAMPAIGN_IDS) {
                if (userCampaigns[possibleCid]) { realCampaignId = possibleCid; break; }
            }
            if (!realCampaignId) realCampaignId = Object.keys(userCampaigns)[0];
        }
        if (!realCampaignId) throw new Error('Campaign ID not found');

        const campaignRef = ref(db, `campaign_rewards/${uid}/${realCampaignId}`);

        const lockResult = await runTransaction(campaignRef, (current) => {
            if (!current) return current;
            if (String(current.status || '').toLowerCase() !== 'pending') return current;
            const now = Date.now();
            return {
                ...current,
                status: 'paid',
                approvedAt: now, paidAt: now, updatedAt: now,
                isProcessed: true, isPaidFinal: true
            };
        });

        if (!lockResult.committed) throw new Error('Not pending — may have been processed');

        const now = Date.now();
        try {
            await atomicSync(uid, withdrawalId, realCampaignId, {
                status: 'paid', approvedAt: now, paidAt: now, updatedAt: now
            });
        } catch (syncErr) {
            console.error('Sync failed:', syncErr);
            try {
                await update(campaignRef, { status: 'pending', approvedAt: null, paidAt: null, updatedAt: Date.now(), isProcessed: false, isPaidFinal: false });
            } catch (rErr) { console.error('Rollback failed:', rErr); }
            throw new Error('Sync failed — rolled back');
        }

        showToast(`✅ Approved! User sees "Payment Sent" now.`, 'success');
    } catch (err) {
        console.error('Approve error:', err);
        showToast('❌ ' + (err.message || 'Failed to approve'), 'error');
    } finally {
        isProcessingAction.delete(key);
        renderWithdrawals();
    }
};

// ============================================================
// REJECT HANDLER
// ============================================================
window.handleReject = async function(uid, withdrawalId, campaignId) {
    const key = uid + '::' + withdrawalId;
    if (isProcessingAction.has(key)) return;

    const reason = prompt(
        `❌ REJECT WITHDRAWAL\n\nWithdrawal ID: ${withdrawalId}\n\nRejection reason (optional):`,
        ''
    );
    if (reason === null) return;

    isProcessingAction.add(key);
    renderWithdrawals();

    try {
        let realCampaignId = campaignId;
        if (!realCampaignId) {
            const userCampaigns = allCampaignRewards[uid] || {};
            for (const possibleCid of POSSIBLE_CAMPAIGN_IDS) {
                if (userCampaigns[possibleCid]) { realCampaignId = possibleCid; break; }
            }
            if (!realCampaignId) realCampaignId = Object.keys(userCampaigns)[0];
        }
        if (!realCampaignId) throw new Error('Campaign ID not found');

        const campaignRef = ref(db, `campaign_rewards/${uid}/${realCampaignId}`);

        const lockResult = await runTransaction(campaignRef, (current) => {
            if (!current) return current;
            if (String(current.status || '').toLowerCase() !== 'pending') return current;
            const now = Date.now();
            const updateObj = {
                ...current,
                status: 'rejected',
                rejectReason: reason || '',
                rejectedAt: now, updatedAt: now, isProcessed: true
            };
            const wasDeducted = current.deducted === true;
            const deductedAmount = Number(current.deductedAmount || 0);
            if (wasDeducted && deductedAmount > 0 && isFinite(deductedAmount)) {
                updateObj.refundPending = true;
                updateObj.refundAmount = deductedAmount;
            } else {
                updateObj.refundPending = false;
                updateObj.refundAmount = 0;
            }
            return updateObj;
        });

        if (!lockResult.committed) throw new Error('Not pending — may have been processed');

        const rejectedData = lockResult.snapshot.val();
        const now = Date.now();
        try {
            await atomicSync(uid, withdrawalId, realCampaignId, {
                status: 'rejected', rejectedAt: now, updatedAt: now, rejectReason: reason || ''
            });
        } catch (syncErr) {
            console.error('Sync failed:', syncErr);
            try {
                await update(campaignRef, { status: 'pending', updatedAt: Date.now(), isProcessed: false, refundPending: false });
            } catch (rErr) { console.error('Rollback failed:', rErr); }
            throw new Error('Sync failed — rolled back');
        }

        const refundMsg = rejectedData.refundPending ? ' + reward refunded' : '';
        showToast(`❌ Rejected${refundMsg}`, 'success');
    } catch (err) {
        console.error('Reject error:', err);
        showToast('❌ ' + (err.message || 'Failed to reject'), 'error');
    } finally {
        isProcessingAction.delete(key);
        renderWithdrawals();
    }
};

// ============================================================
// TAB HANDLERS
// ============================================================
function setupTabs() {
    document.querySelectorAll('.main-tab-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.main-tab-btn').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeMainTab = tab.getAttribute('data-main-tab');

            document.getElementById('overviewSection').style.display = activeMainTab === 'overview' ? 'block' : 'none';
            document.getElementById('withdrawalsSection').style.display = activeMainTab === 'withdrawals' ? 'block' : 'none';

            if (activeMainTab === 'withdrawals') renderWithdrawals();
        });
    });

    document.querySelectorAll('.sub-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeSubTab = tab.getAttribute('data-sub-tab');
            renderWithdrawals();
        });
    });
}

function setupSearch() {
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderWithdrawals();
    });
}

// ============================================================
// MAIN LOADING
// ============================================================
function loadData() {
    let usersLoaded = false, rewardsLoaded = false, adminWdsLoaded = false;

    const checkReady = () => {
        if (usersLoaded && rewardsLoaded && adminWdsLoaded) {
            dataReady = true;
            const { overview, withdrawals } = buildData(allUsers, allCampaignRewards, allAdminWithdrawals);
            allOverviewRecords = overview;
            allWithdrawalRecords = withdrawals;

            document.getElementById('loadingContainer').style.display = 'none';
            document.getElementById('contentContainer').style.display = 'block';

            updateSummary();
            renderOverview();
            renderWithdrawals();
        }
    };

    const refresh = () => {
        if (!dataReady) return;
        const { overview, withdrawals } = buildData(allUsers, allCampaignRewards, allAdminWithdrawals);
        allOverviewRecords = overview;
        allWithdrawalRecords = withdrawals;
        updateSummary();
        renderOverview();
        renderWithdrawals();
    };

    usersOff = onValue(ref(db, 'users'), (snap) => {
        allUsers = snap.exists() ? snap.val() : {};
        usersLoaded = true;
        if (dataReady) refresh(); else checkReady();
    }, (err) => {
        console.error('Users load error:', err);
        showToast('Failed to load users: ' + err.message, 'error');
    });

    rewardsOff = onValue(ref(db, 'campaign_rewards'), (snap) => {
        allCampaignRewards = snap.exists() ? snap.val() : {};
        rewardsLoaded = true;
        if (dataReady) refresh(); else checkReady();
    }, (err) => {
        console.error('Rewards load error:', err);
        showToast('Failed to load rewards: ' + err.message, 'error');
    });

    adminWdsOff = onValue(ref(db, 'admin/withdrawals'), (snap) => {
        allAdminWithdrawals = snap.exists() ? snap.val() : {};
        adminWdsLoaded = true;
        if (dataReady) refresh(); else checkReady();
    }, (err) => {
        console.error('Withdrawals load error:', err);
        showToast('Failed to load withdrawals: ' + err.message, 'error');
    });
}

// ============================================================
// AUTH
// ============================================================
onAuthStateChanged(auth, (user) => {
    if (!user) {
        showToast('Not authenticated — redirecting...', 'warning');
        setTimeout(() => { window.location.href = 'index.html'; }, 1500);
        return;
    }
    if (user.email && !user.email.includes('admin')) {
        showToast('Access denied — admin only', 'error');
        setTimeout(() => { signOut(auth); window.location.href = 'index.html'; }, 2000);
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

console.log('%c🎁 Direct Offer Admin — v2 with Withdrawals Tab', 'color: #a78bfa; font-size: 14px; font-weight: bold;');
