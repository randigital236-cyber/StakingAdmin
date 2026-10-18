// ============================================================
// DIRECT OFFER ADMIN — JavaScript (Dynamic Campaign Final v9)
// ============================================================
// - Strict compatibility for missing campaignId
// - Strict atomicSync with read verification
// - Accurate deduplication and metrics
// - Reject shows "Refund Pending"
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction, onValue } from "firebase/database";

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

let allUsers = {};
let allCampaignRewards = {};
let allAdminWithdrawals = {};
let allCampaignConfigs = {}; 

let availableCampaigns = [];
let selectedCampaignId = '';
let currentCampaignConfig = null;

let allWithdrawalRecords = [];
let allUnassignedRecords = [];
let pendingWithdrawals = [];
let allOverviewRecords = [];

let activeTab = 'withdrawals';
let searchQuery = '';
let isProcessingAction = new Set();

let usersOff = null, rewardsOff = null, adminWdsOff = null, configsOff = null;
let dataReady = false;

// UTILS
function escapeHtml(text) { if (!text) return ''; const d = document.createElement('div'); d.textContent = String(text); return d.innerHTML; }
function formatCurrency(amount) { const v = Number(amount); return '$' + (Number.isFinite(v) ? v : 0).toFixed(2); }
function formatDateTime(timestamp) {
    if (!timestamp) return { date: '—', time: '' };
    try {
        const d = new Date(Number(timestamp));
        if (isNaN(d.getTime())) return { date: '—', time: '' };
        return { date: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) };
    } catch (e) { return { date: '—', time: '' }; }
}
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer'); if (!container) return;
    const toast = document.createElement('div'); toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill' : type === 'error' ? 'bi-exclamation-triangle-fill' : 'bi-info-circle-fill';
    toast.innerHTML = `<i class="bi ${icon}"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 4500);
}

window.copyWalletAddress = async function(address, btnEl) {
    if (!address || !address.trim()) { showToast('❌ No address', 'error'); return; }
    const full = String(address).trim();
    const doCopy = async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(full);
            else { const ta = document.createElement('textarea'); ta.value = full; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
            if (btnEl) { const orig = btnEl.innerHTML; btnEl.classList.add('copied'); btnEl.innerHTML = '<i class="bi bi-check-lg"></i> Copied!'; setTimeout(() => { btnEl.classList.remove('copied'); btnEl.innerHTML = orig; }, 2000); }
            showToast('✅ Copied', 'success');
        } catch (e) { showToast('❌ Failed to copy', 'error'); }
    };
    doCopy();
};

function extractCampaigns() {
    const campaignsSet = new Set();
    for (const cid in allCampaignConfigs) campaignsSet.add(cid);
    for (const uid in allCampaignRewards) { for (const cid in (allCampaignRewards[uid] || {})) campaignsSet.add(cid); }
    availableCampaigns = Array.from(campaignsSet).sort().reverse();

    const selector = document.getElementById('campaignSelector');
    if (!selector) return;

    let currentVal = selectedCampaignId;
    if (!availableCampaigns.includes(currentVal)) currentVal = availableCampaigns[0] || '';

    if (availableCampaigns.length === 0) {
        selector.innerHTML = `<option value="">No Campaigns Found</option>`;
        document.getElementById('contentContainer').style.display = 'none';
        document.getElementById('loadingContainer').style.display = 'block';
        document.querySelector('.loading-text').innerHTML = '<i class="bi bi-exclamation-triangle text-warning"></i> No campaigns found.';
        
        // Show unassigned legacy withdrawals even if no campaigns exist
        if (allAdminWithdrawals && Object.keys(allAdminWithdrawals).length > 0) {
            document.getElementById('loadingContainer').style.display = 'none';
            document.getElementById('contentContainer').style.display = 'block';
            renderWithdrawalsTab();
        }
        return;
    }

    selector.innerHTML = availableCampaigns.map(cid => {
        const cfg = allCampaignConfigs[cid] || {};
        const isActive = cfg.status === 'active';
        const label = cfg.campaignName ? `${cfg.campaignName} (${cid})` : cid;
        return `<option value="${escapeHtml(cid)}" ${cid === currentVal ? 'selected' : ''}>${escapeHtml(label)} ${isActive ? '🟢' : ''}</option>`;
    }).join('');

    if (selectedCampaignId !== currentVal) { selectedCampaignId = currentVal; rebuildData(); }
}

window.changeCampaign = function(cid) { selectedCampaignId = cid; rebuildData(); };

function rebuildData() {
    if (!selectedCampaignId) return;
    currentCampaignConfig = allCampaignConfigs[selectedCampaignId] || null;

    const withdrawalsMap = new Map();
    const overview = [];

    for (const uid in allCampaignRewards) {
        const campaigns = allCampaignRewards[uid] || {};
        if (!campaigns[selectedCampaignId]) continue;
        const r = campaigns[selectedCampaignId];
        if (!r || typeof r !== 'object') continue;

        const user = allUsers[uid] || { name: 'Unknown', username: 'N/A' };
        const status = String(r.status || 'available').toLowerCase();
        const amount = Number(r.finalReward ?? r.currentReward ?? 0);
        const refs = Number(r.finalDirectCount ?? r.currentDirectCount ?? 0);
        const isCompleted = (r.isFinalized === true);

        if (r.isFinalized === true || amount > 0 || refs > 0) {
            overview.push({ uid, campaignId: selectedCampaignId, userName: user.name, userUsername: user.username, refs, amount, status, isCompleted, updatedAt: r.updatedAt || r.snapshotAt || 0 });
        }

        const hasWithdrawal = r.withdrawalId || ['pending', 'approved', 'paid', 'rejected'].includes(status);
        if (hasWithdrawal) {
            const wid = r.withdrawalId || `__no_wid_${uid}`;
            withdrawalsMap.set(wid, {
                uid, campaignId: selectedCampaignId, withdrawalId: r.withdrawalId || '', status, amount,
                walletAddress: r.walletAddress || '', userName: user.name, userUsername: user.username,
                requestedAt: r.requestedAt || r.updatedAt || 0, approvedAt: r.approvedAt || 0, paidAt: r.paidAt || 0,
                rejectedAt: r.rejectedAt || 0, updatedAt: r.updatedAt || r.snapshotAt || 0, rejectReason: r.rejectReason || '',
                txHash: r.txHash || '', network: r.network || 'BEP-20', source: 'campaign_rewards', refundPending: r.refundPending || false
            });
        }
    }

    for (const wid in allAdminWithdrawals) {
        const w = allAdminWithdrawals[wid];
        if (!w || w.campaignId !== selectedCampaignId) continue;
        const realWid = w.withdrawalId || wid;
        if (!withdrawalsMap.has(realWid)) {
            const status = String(w.status || 'pending').toLowerCase();
            if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) continue;
            const user = allUsers[w.userId || w.uid] || { name: 'Unknown', username: 'N/A' };
            withdrawalsMap.set(realWid, {
                uid: w.userId || w.uid, campaignId: selectedCampaignId, withdrawalId: realWid, status, amount: Number(w.amount || 0),
                walletAddress: w.walletAddress || w.wallet || '', userName: user.name || w.username || 'Unknown', userUsername: user.username || 'N/A',
                requestedAt: w.requestedAt || w.timestamp || 0, approvedAt: w.approvedAt || 0, paidAt: w.paidAt || 0, rejectedAt: w.rejectedAt || 0,
                updatedAt: w.updatedAt || w.requestedAt || 0, rejectReason: w.rejectReason || '', txHash: w.txHash || '', network: w.network || 'BEP-20', source: 'admin/withdrawals', refundPending: w.refundPending || false
            });
        }
    }

    const withdrawals = Array.from(withdrawalsMap.values());
    overview.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const priority = { pending: 0, approved: 1, paid: 2, rejected: 3 };
    withdrawals.sort((a, b) => { const pA = priority[a.status] ?? 9, pB = priority[b.status] ?? 9; return pA !== pB ? pA - pB : (b.requestedAt || 0) - (a.requestedAt || 0); });

    const unassigned = [];
    for (const wid in allAdminWithdrawals) {
        const w = allAdminWithdrawals[wid];
        // Accept both old and new withdrawal types
        if (w.type !== 'direct_offer_50pack_withdrawal' && w.type !== 'direct_offer_withdrawal') continue;
        if (!w.campaignId) {
            const user = allUsers[w.userId || w.uid] || { name: 'Unknown', username: 'N/A' };
            unassigned.push({
                uid: w.userId || w.uid, campaignId: 'UNASSIGNED', withdrawalId: w.withdrawalId || wid,
                status: String(w.status || 'pending').toLowerCase(), amount: Number(w.amount || 0),
                walletAddress: w.walletAddress || w.wallet || '', userName: user.name || w.username || 'Unknown', userUsername: user.username || 'N/A',
                requestedAt: w.requestedAt || w.timestamp || 0, updatedAt: w.updatedAt || 0, network: w.network || 'BEP-20'
            });
        }
    }

    allOverviewRecords = overview; allWithdrawalRecords = withdrawals; allUnassignedRecords = unassigned;
    updateSummary(); renderAll();
}

function updateSummary() {
    document.getElementById('totalParticipants').textContent = new Set(allOverviewRecords.map(r => r.uid)).size;
    document.getElementById('totalCompleted').textContent = allOverviewRecords.filter(r => r.isCompleted === true).length;
    document.getElementById('totalEarned').textContent = formatCurrency(allOverviewRecords.reduce((sum, r) => sum + (r.amount || 0), 0));

    const pending = allWithdrawalRecords.filter(r => r.status === 'pending').length;
    document.getElementById('totalPending').textContent = pending;
    document.getElementById('totalRejected').textContent = allWithdrawalRecords.filter(r => r.status === 'rejected').length;

    // ONLY 'paid' counts as total withdrawn
    const totalPaid = allWithdrawalRecords.filter(r => r.status === 'paid').reduce((sum, r) => sum + (r.amount || 0), 0);
    document.getElementById('totalWithdrawn').textContent = formatCurrency(totalPaid);

    document.getElementById('tabPendingCount').textContent = pending;
    document.getElementById('allTabCount').textContent = allOverviewRecords.length;
}

function renderAll() { renderWithdrawalsTab(); renderAllRecordsTab(); }

function renderWithdrawalsTab() {
    pendingWithdrawals = allWithdrawalRecords.filter(r => r.status === 'pending');
    let filteredPending = pendingWithdrawals;
    const q = searchQuery.trim().toLowerCase();
    if (q) filteredPending = filteredPending.filter(r => [r.userName, r.userUsername, r.walletAddress, r.withdrawalId].join(' ').toLowerCase().includes(q));

    const pendingContainer = document.getElementById('pendingCardsContainer');
    const pendingEmpty = document.getElementById('pendingEmptyState');

    if (filteredPending.length === 0) { pendingContainer.innerHTML = ''; pendingEmpty.style.display = 'block'; }
    else { pendingEmpty.style.display = 'none'; pendingContainer.innerHTML = filteredPending.map(r => renderPendingCard(r)).join(''); }

    if (allUnassignedRecords.length > 0) {
        pendingContainer.insertAdjacentHTML('afterbegin', `
            <div style="margin-top: 20px; margin-bottom: 20px; padding: 15px; background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px;">
                <h6 style="color: #f87171; margin-bottom: 10px;"><i class="bi bi-exclamation-triangle"></i> Needs Review / Unassigned (${allUnassignedRecords.length})</h6>
                <div class="table-responsive">
                    <table class="table table-custom">
                        <thead><tr><th>Date</th><th>User</th><th>Amount</th><th>Wallet</th><th>Status</th></tr></thead>
                        <tbody>
                            ${allUnassignedRecords.map(u => `
                                <tr>
                                    <td style="font-size:0.75rem;">${escapeHtml(formatDateTime(u.requestedAt).date)}</td>
                                    <td>${escapeHtml(u.userName)} (@${escapeHtml(u.userUsername)})</td>
                                    <td style="color:#fbbf24; font-weight:700;">${formatCurrency(u.amount)}</td>
                                    <td style="font-family:monospace; font-size:0.72rem;">${escapeHtml(u.walletAddress.substring(0,10))}...</td>
                                    <td><span class="status-badge ${u.status}">${u.status.toUpperCase()}</span></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `);
    }

    const historyList = allWithdrawalRecords.filter(r => r.status !== 'pending');
    let filteredHistory = historyList;
    if (q) filteredHistory = filteredHistory.filter(r => [r.userName, r.userUsername, r.walletAddress, r.withdrawalId].join(' ').toLowerCase().includes(q));

    const historyTbody = document.getElementById('historyTableBody');
    if (filteredHistory.length === 0) historyTbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 40px; color: #556688;">No history found.</td></tr>`;
    else {
        historyTbody.innerHTML = filteredHistory.map(r => {
            const reqDate = formatDateTime(r.requestedAt);
            let statusDateStr = r.status === 'paid' && r.paidAt ? formatDateTime(r.paidAt).date : (r.status === 'rejected' && r.rejectedAt ? formatDateTime(r.rejectedAt).date : '—');
            const statusClass = r.status === 'paid' ? 'paid' : r.status === 'approved' ? 'approved' : 'rejected';
            let statusText = r.status.toUpperCase();
            if (r.status === 'rejected' && r.refundPending) statusText = 'Rejected (Refund Pending)';

            return `
                <tr>
                    <td style="font-size: 0.78rem; color: #8899bb;"><div style="font-weight:600; color:#fff;">${escapeHtml(reqDate.date)}</div><div style="font-size:0.68rem;">Req: ${escapeHtml(reqDate.time)}</div></td>
                    <td><div style="font-weight: 600; color: #fff;">${escapeHtml(r.userName)}</div><div style="font-size: 0.72rem; color: #a78bfa;">@${escapeHtml(r.userUsername)}</div></td>
                    <td style="font-weight: 700; color: #fbbf24;">${formatCurrency(r.amount)}</td>
                    <td><span style="font-family: monospace; font-size: 0.72rem; color: #60a5fa;">${escapeHtml(r.walletAddress ? r.walletAddress.substring(0, 10) + '...' + r.walletAddress.substring(r.walletAddress.length - 6) : 'N/A')}</span></td>
                    <td><span class="status-badge ${statusClass}">${statusText}</span><div style="font-size:0.65rem; color:#8899bb; margin-top:4px;">${escapeHtml(statusDateStr)}</div></td>
                </tr>`;
        }).join('');
    }
}

function renderPendingCard(r) {
    const date = formatDateTime(r.requestedAt);
    const initial = (r.userName || 'U').charAt(0).toUpperCase();
    const processing = isProcessingAction.has(r.uid + '::' + r.withdrawalId);
    const walletHtml = r.walletAddress ? `
        <div class="wallet-box">
            <div class="wallet-label"><i class="bi bi-wallet2"></i> BEP-20 Wallet Address</div>
            <div class="wallet-address-row">
                <div class="wallet-address">${escapeHtml(r.walletAddress)}</div>
                <button class="btn-copy-wallet" onclick="copyWalletAddress('${escapeHtml(r.walletAddress)}', this)"><i class="bi bi-clipboard"></i> Copy</button>
            </div>
        </div>` : `<div class="wallet-box" style="border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.05);"><div class="wallet-label" style="color: #f87171;"><i class="bi bi-exclamation-triangle"></i> No Wallet Address</div></div>`;

    return `
        <div class="withdrawal-card pending">
            <div class="wc-header">
                <div class="wc-user">
                    <div class="wc-avatar">${escapeHtml(initial)}</div>
                    <div class="wc-user-info"><div class="wc-name">${escapeHtml(r.userName)}</div><div class="wc-username">@${escapeHtml(r.userUsername)}</div><div class="wc-user-id">UID: ${escapeHtml(String(r.uid).substring(0, 14))}...</div></div>
                </div>
                <div class="wc-amount-wrap"><div class="wc-amount">${formatCurrency(r.amount)}<span class="currency">USDT</span></div><div class="wc-date">${escapeHtml(date.date)} · ${escapeHtml(date.time)}</div><div style="margin-top: 6px;"><span class="status-badge pending"><i class="bi bi-hourglass-split"></i> Pending</span></div></div>
            </div>
            ${walletHtml}
            <div style="display: flex; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(167,139,250,0.1); font-size: 0.75rem; color: #8899bb;"><span><i class="bi bi-receipt"></i> ID: <span style="font-family: monospace; color: #a78bfa;">${escapeHtml(r.withdrawalId || 'N/A')}</span></span><span><i class="bi bi-diagram-3"></i> ${escapeHtml(r.network)}</span></div>
            <div class="wc-actions">
                <button class="btn-reject" onclick="handleReject('${escapeHtml(r.uid)}', '${escapeHtml(r.withdrawalId)}', '${escapeHtml(r.campaignId)}')" ${processing ? 'disabled' : ''}><i class="bi bi-x-lg"></i> Reject</button>
                <button class="btn-approve" onclick="handleApprove('${escapeHtml(r.uid)}', '${escapeHtml(r.withdrawalId)}', '${escapeHtml(r.campaignId)}', ${r.amount})" ${processing ? 'disabled' : ''}>${processing ? 'Processing...' : '<i class="bi bi-check-lg"></i> Approve (Payment Sent)'}</button>
            </div>
        </div>`;
}

function renderAllRecordsTab() {
    const tbody = document.getElementById('allRecordsTableBody');
    let filtered = allOverviewRecords;
    const q = searchQuery.trim().toLowerCase();
    if (q) filtered = filtered.filter(r => [r.userName, r.userUsername].join(' ').toLowerCase().includes(q));
    if (filtered.length === 0) { tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 40px;">No records.</td></tr>`; return; }
    tbody.innerHTML = filtered.map(r => {
        let statusClass = r.isCompleted ? 'approved' : 'available';
        let statusText = r.isCompleted ? 'Offer Completed' : 'In Progress';
        if (r.status === 'paid') { statusClass = 'paid'; statusText = 'Paid'; }
        else if (r.status === 'approved') { statusClass = 'approved'; statusText = 'Approved'; }
        else if (r.status === 'pending') { statusClass = 'pending'; statusText = 'Pending'; }
        else if (r.status === 'rejected') { statusClass = 'rejected'; statusText = 'Rejected'; }
        return `<tr><td><div style="display: flex; align-items: center; gap: 10px;"><div class="wc-avatar" style="width: 34px; height: 34px; font-size: 0.8rem;">${escapeHtml((r.userName||'U').charAt(0).toUpperCase())}</div><div><div style="font-weight: 600; color: #fff;">${escapeHtml(r.userName)}</div><div style="font-size: 0.72rem; color: #a78bfa;">@${escapeHtml(r.userUsername)}</div></div></div></td><td style="font-weight: 700; color: #2ecc71;">${r.refs}</td><td style="font-weight: 800; color: #fbbf24;">${formatCurrency(r.amount)}</td><td><span class="status-badge ${statusClass}">${statusText}</span></td><td style="font-size: 0.75rem; color: #8899bb;">${escapeHtml(formatDateTime(r.updatedAt).date)}</td></tr>`;
    }).join('');
}

async function atomicSync(uid, withdrawalId, campaignId, updates) {
    const rootUpdates = {};
    let adminFound = false, userFound = false, globalFound = false;

    try {
        const adminSnap = await get(ref(db, 'admin/withdrawals'));
        if (adminSnap.exists()) {
            const adminData = adminSnap.val();
            for (let key in adminData) {
                if (adminData[key].withdrawalId === withdrawalId) {
                    const path = `admin/withdrawals/${key}`;
                    rootUpdates[`${path}/status`] = updates.status; rootUpdates[`${path}/updatedAt`] = updates.updatedAt;
                    if (updates.approvedAt) rootUpdates[`${path}/approvedAt`] = updates.approvedAt;
                    if (updates.paidAt) rootUpdates[`${path}/paidAt`] = updates.paidAt;
                    if (updates.txHash !== undefined) rootUpdates[`${path}/txHash`] = updates.txHash;
                    if (updates.rejectReason !== undefined) rootUpdates[`${path}/rejectReason`] = updates.rejectReason;
                    if (updates.rejectedAt) rootUpdates[`${path}/rejectedAt`] = updates.rejectedAt;
                    adminFound = true; break;
                }
            }
        }
    } catch (err) { console.warn('admin sync warning:', err); }

    try {
        const userSnap = await get(ref(db, `users/${uid}/transactions`));
        if (userSnap.exists()) {
            const txs = userSnap.val();
            for (let txKey in txs) {
                if (txs[txKey].withdrawalId === withdrawalId) {
                    const path = `users/${uid}/transactions/${txKey}`;
                    rootUpdates[`${path}/status`] = updates.status; rootUpdates[`${path}/updatedAt`] = updates.updatedAt;
                    if (updates.approvedAt) rootUpdates[`${path}/approvedAt`] = updates.approvedAt;
                    if (updates.paidAt) rootUpdates[`${path}/paidAt`] = updates.paidAt;
                    if (updates.txHash !== undefined) rootUpdates[`${path}/txHash`] = updates.txHash;
                    if (updates.rejectReason !== undefined) rootUpdates[`${path}/rejectReason`] = updates.rejectReason;
                    if (updates.rejectedAt) rootUpdates[`${path}/rejectedAt`] = updates.rejectedAt;
                    userFound = true; break;
                }
            }
        }
    } catch (err) { console.warn('user sync warning:', err); }

    try {
        const globalSnap = await get(ref(db, 'transactions'));
        if (globalSnap.exists()) {
            const globalData = globalSnap.val();
            for (let key in globalData) {
                if (globalData[key].withdrawalId === withdrawalId) {
                    const path = `transactions/${key}`;
                    rootUpdates[`${path}/status`] = updates.status; rootUpdates[`${path}/updatedAt`] = updates.updatedAt;
                    if (updates.approvedAt) rootUpdates[`${path}/approvedAt`] = updates.approvedAt;
                    if (updates.paidAt) rootUpdates[`${path}/paidAt`] = updates.paidAt;
                    if (updates.txHash !== undefined) rootUpdates[`${path}/txHash`] = updates.txHash;
                    if (updates.rejectReason !== undefined) rootUpdates[`${path}/rejectReason`] = updates.rejectReason;
                    if (updates.rejectedAt) rootUpdates[`${path}/rejectedAt`] = updates.rejectedAt;
                    globalFound = true; break;
                }
            }
        }
    } catch (err) { console.warn('global sync warning:', err); }

    if (Object.keys(rootUpdates).length > 0) await update(ref(db), rootUpdates);
    return { adminFound, userFound, globalFound, totalUpdated: Object.keys(rootUpdates).length };
}

window.handleApprove = async function(uid, withdrawalId, campaignId, amount) {
    const key = uid + '::' + withdrawalId;
    if (isProcessingAction.has(key)) return;
    if (!confirm(`✅ CONFIRM APPROVAL\n\nAmount: $${Number(amount).toFixed(2)} USDT\nWithdrawal ID: ${withdrawalId}\n\n⚠️ क्या आपने इस यूजर के wallet address पर $${Number(amount).toFixed(2)} USDT (BEP-20) भेज दिया है?\n\nOK = हाँ, Approved कर दो\nCancel = रुको`)) return;

    isProcessingAction.add(key); renderWithdrawalsTab();

    try {
        let realCampaignId = campaignId || selectedCampaignId;
        if (!realCampaignId) throw new Error('Campaign ID not found');
        const campaignRef = ref(db, `campaign_rewards/${uid}/${realCampaignId}`);

        const lockResult = await runTransaction(campaignRef, (current) => {
            if (!current || String(current.status || '').toLowerCase() !== 'pending') return current;
            const now = Date.now();
            return { ...current, status: 'paid', approvedAt: now, paidAt: now, updatedAt: now, isProcessed: true, isPaidFinal: true };
        });

        if (!lockResult.committed) throw new Error('Not pending — may have been processed');
        const now = Date.now();

        let syncResult = { adminFound: false, userFound: false, globalFound: false, totalUpdated: 0 };
        try { syncResult = await atomicSync(uid, withdrawalId, realCampaignId, { status: 'paid', approvedAt: now, paidAt: now, updatedAt: now }); }
        catch (syncErr) {
            await runTransaction(campaignRef, (current) => {
                if (current && current.status === 'paid' && current.paidAt === now) return { ...current, status: 'pending', approvedAt: null, paidAt: null, updatedAt: Date.now(), isProcessed: false, isPaidFinal: false };
                return current;
            });
            throw new Error('Sync failed — rolled back');
        }

        if (!syncResult.adminFound || (!syncResult.userFound && !syncResult.globalFound)) {
            showToast(`⚠️ Partial Sync: Some records missing. Please review.`, 'warning');
        } else {
            showToast(`✅ Approved & Fully Verified!`, 'success');
        }
    } catch (err) {
        showToast('❌ ' + (err.message || 'Failed to approve'), 'error');
    } finally { isProcessingAction.delete(key); renderWithdrawalsTab(); }
};

window.handleReject = async function(uid, withdrawalId, campaignId) {
    const key = uid + '::' + withdrawalId;
    if (isProcessingAction.has(key)) return;
    const reason = prompt(`❌ REJECT WITHDRAWAL\n\nWithdrawal ID: ${withdrawalId}\n\nRejection reason (optional):`, '');
    if (reason === null) return;

    isProcessingAction.add(key); renderWithdrawalsTab();

    try {
        let realCampaignId = campaignId || selectedCampaignId;
        if (!realCampaignId) throw new Error('Campaign ID not found');
        const campaignRef = ref(db, `campaign_rewards/${uid}/${realCampaignId}`);

        const lockResult = await runTransaction(campaignRef, (current) => {
            if (!current || String(current.status || '').toLowerCase() !== 'pending') return current;
            const now = Date.now();
            const updateObj = { ...current, status: 'rejected', rejectReason: reason || '', rejectedAt: now, updatedAt: now, isProcessed: true };
            const wasDeducted = current.deducted === true;
            const deductedAmount = Number(current.deductedAmount || 0);
            if (wasDeducted && deductedAmount > 0 && isFinite(deductedAmount)) { updateObj.refundPending = true; updateObj.refundAmount = deductedAmount; }
            else { updateObj.refundPending = false; updateObj.refundAmount = 0; }
            return updateObj;
        });

        if (!lockResult.committed) throw new Error('Not pending — may have been processed');
        const rejectedData = lockResult.snapshot.val();
        const now = Date.now();

        let syncResult = { adminFound: false, userFound: false, globalFound: false, totalUpdated: 0 };
        try { syncResult = await atomicSync(uid, withdrawalId, realCampaignId, { status: 'rejected', rejectedAt: now, updatedAt: now, rejectReason: reason || '' }); }
        catch (syncErr) {
            await runTransaction(campaignRef, (current) => {
                if (current && current.status === 'rejected' && current.rejectedAt === now) return { ...current, status: 'pending', updatedAt: Date.now(), isProcessed: false, refundPending: false };
                return current;
            });
            throw new Error('Sync failed — rolled back');
        }

        const refundMsg = rejectedData.refundPending ? ' (Refund Pending)' : '';
        if (!syncResult.adminFound || (!syncResult.userFound && !syncResult.globalFound)) {
            showToast(`⚠️ Partial Sync: Some records missing.${refundMsg}`, 'warning');
        } else {
            showToast(`✅ Rejected & Fully Verified!${refundMsg}`, 'success');
        }
    } catch (err) {
        showToast('❌ ' + (err.message || 'Failed to reject'), 'error');
    } finally { isProcessingAction.delete(key); renderWithdrawalsTab(); }
};

function setupTabs() {
    document.querySelectorAll('.custom-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.custom-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active'); activeTab = tab.getAttribute('data-tab');
            document.getElementById('withdrawalsSection').style.display = activeTab === 'withdrawals' ? 'block' : 'none';
            document.getElementById('allRecordsSection').style.display = activeTab === 'all' ? 'block' : 'none';
            if (activeTab === 'withdrawals') renderWithdrawalsTab(); else renderAllRecordsTab();
        });
    });
}
function setupSearch() {
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        if (activeTab === 'withdrawals') renderWithdrawalsTab(); else renderAllRecordsTab();
    });
}

function loadData() {
    let usersLoaded = false, rewardsLoaded = false, adminWdsLoaded = false, configsLoaded = false;
    const checkReady = () => {
        if (usersLoaded && rewardsLoaded && adminWdsLoaded && configsLoaded) {
            dataReady = true; extractCampaigns();
            if (availableCampaigns.length > 0) {
                document.getElementById('loadingContainer').style.display = 'none';
                document.getElementById('contentContainer').style.display = 'block';
                setupTabs(); setupSearch(); rebuildData();
            }
        }
    };
    const refresh = () => { if (!dataReady) return; const sel = document.getElementById('campaignSelector'); if (sel && sel.value) selectedCampaignId = sel.value; extractCampaigns(); rebuildData(); };
    usersOff = onValue(ref(db, 'users'), (s) => { allUsers = s.exists() ? s.val() : {}; usersLoaded = true; dataReady ? refresh() : checkReady(); });
    rewardsOff = onValue(ref(db, 'campaign_rewards'), (s) => { allCampaignRewards = s.exists() ? s.val() : {}; rewardsLoaded = true; dataReady ? refresh() : checkReady(); });
    adminWdsOff = onValue(ref(db, 'admin/withdrawals'), (s) => { allAdminWithdrawals = s.exists() ? s.val() : {}; adminWdsLoaded = true; dataReady ? refresh() : checkReady(); });
    configsOff = onValue(ref(db, 'direct_offer_campaigns'), (s) => { allCampaignConfigs = s.exists() ? s.val() : {}; configsLoaded = true; dataReady ? refresh() : checkReady(); });
}

onAuthStateChanged(auth, (user) => {
    if (!user) { showToast('Redirecting...', 'warning'); setTimeout(() => { window.location.href = 'index.html'; }, 1500); return; }
    if (user.email && !user.email.includes('admin')) { showToast('Access denied.', 'error'); setTimeout(() => { signOut(auth); window.location.href = 'index.html'; }, 2000); return; }
    loadData();
});

window.addEventListener('beforeunload', () => {
    if (usersOff) usersOff(); if (rewardsOff) rewardsOff(); if (adminWdsOff) adminWdsOff(); if (configsOff) configsOff();
});
