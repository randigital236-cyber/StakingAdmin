// ============================================================
// RANK REWARD ADMIN — JavaScript (Read-Only)
// ============================================================
// ⚠️ STANDALONE FILE
// ⚠️ Does NOT modify admin.js or admin-gss.js
// ⚠️ Only READS from: users/*, rankRewards/*/*
// ⚠️ NO writes, NO updates, NO deletes
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, onValue } from "firebase/database";

// ============================================================
// FIREBASE CONFIG (same as main admin)
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
// RANK DEFINITIONS (matches user-side rank system)
// ============================================================
const RANK_LEVELS = [
    { key: 'member', rank: 'Member', minBusiness: 0, reward: 0, icon: '👤', order: 0 },
    { key: 'executive', rank: 'Executive', minBusiness: 3000, reward: 100, icon: '📈', order: 1 },
    { key: 'seniorExecutive', rank: 'Senior Executive', minBusiness: 10000, reward: 200, icon: '⭐', order: 2 },
    { key: 'manager', rank: 'Manager', minBusiness: 25000, reward: 500, icon: '👔', order: 3 },
    { key: 'seniorManager', rank: 'Senior Manager', minBusiness: 50000, reward: 1000, icon: '🏆', order: 4 },
    { key: 'diamond', rank: 'Diamond', minBusiness: 100000, reward: 2500, icon: '💎', order: 5 }
];

// Higher order = higher rank
const RANK_HIERARCHY = {
    'member': 0, 'executive': 1, 'seniorExecutive': 2,
    'manager': 3, 'seniorManager': 4, 'diamond': 5};

// ============================================================
// GLOBAL STATE
// ============================================================
let allUsers = {};
let allClaims = [];           // Flattened claims
let filteredClaims = [];      // After search + filter
let activeRankFilter = '';
let searchQuery = '';
let displayLimit = 50;        // Load more pagination
let usersListenerOff = null;
let rewardsListenerOff = null;
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

function formatDate(timestamp) {
    if (!timestamp) return { main: '—', time: '' };
    try {
        const date = new Date(Number(timestamp));
        if (isNaN(date.getTime())) return { main: '—', time: '' };
        return {
            main: date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            time: date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        };
    } catch (e) {
        return { main: '—', time: '' };
    }
}

function getRankInfo(rankKey) {
    return RANK_LEVELS.find(r => r.key === rankKey) || RANK_LEVELS[0];
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
    }, 4000);
}

// ============================================================
// BUILD CLAIMS LIST FROM DATA
// ============================================================
function buildClaimsFromData(users, rankRewards) {
    const claims = [];
    const seen = new Set();  // For deduplication

    for (const uid in rankRewards) {
        const userClaims = rankRewards[uid];
        if (!userClaims || typeof userClaims !== 'object') continue;

        const user = users[uid] || { name: 'Unknown', email: 'N/A', username: 'N/A', teamBusiness: 0 };

        for (const rankKey in userClaims) {
            const claim = userClaims[rankKey];
            if (!claim || typeof claim !== 'object') continue;

            // Only count completed claims
            if (String(claim.status || '').toLowerCase() !== 'completed') continue;

            const dedupKey = `${uid}::${rankKey}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const rankInfo = getRankInfo(rankKey);

            claims.push({
                uid,
                rankKey,
                rank: claim.rank || rankInfo.rank,
                icon: rankInfo.icon,
                reward: Number(claim.rewardAmount) || rankInfo.reward || 0,
                requiredBusiness: Number(claim.requiredBusiness) || rankInfo.minBusiness || 0,
                teamBusinessAtReward: Number(claim.teamBusinessAtReward) || 0,
                currentTeamBusiness: Number(user.teamBusiness) || 0,
                creditedAt: claim.creditedAt || 0,
                transactionId: claim.transactionId || claim.txId || '',
                userName: user.name || 'Unknown',
                userEmail: user.email || 'N/A',
                userUsername: user.username || user.referralCode || 'N/A',
                rankOrder: RANK_HIERARCHY[rankKey] || 0
            });
        }
    }

    // Sort: highest rank first, then most recent
    claims.sort((a, b) => {
        if (b.rankOrder !== a.rankOrder) return b.rankOrder - a.rankOrder;
        return (b.creditedAt || 0) - (a.creditedAt || 0);
    });

    return claims;
}

// ============================================================
// RENDER SUMMARY
// ============================================================
function renderSummary() {
    // Total unique users who claimed
    const uniqueUsers = new Set(allClaims.map(c => c.uid));
    document.getElementById('totalUsers').textContent = uniqueUsers.size;

    // Total reward
    const totalReward = allClaims.reduce((sum, c) => sum + c.reward, 0);
    document.getElementById('totalReward').textContent = formatCurrency(totalReward);

    // Total claims
    document.getElementById('totalClaims').textContent = allClaims.length;

    // Highest rank
    if (allClaims.length > 0) {
        const highest = allClaims[0]; // Already sorted by rank order desc
        document.getElementById('highestRank').textContent = highest.rank;
        document.getElementById('highestRank').style.fontSize = '1.1rem';
    } else {
        document.getElementById('highestRank').textContent = '—';
    }
}

// ============================================================
// RENDER RANK BREAKDOWN
// ============================================================
function renderRankBreakdown() {
    const grid = document.getElementById('rankBreakdownGrid');
    const breakdown = {};

    // Group claims by rank
    for (const claim of allClaims) {
        if (!breakdown[claim.rankKey]) {
            breakdown[claim.rankKey] = { count: 0, value: 0, rankInfo: getRankInfo(claim.rankKey) };
        }
        breakdown[claim.rankKey].count++;
        breakdown[claim.rankKey].value += claim.reward;
    }

    // Sort by rank order desc
    const sortedRanks = Object.keys(breakdown).sort(
        (a, b) => (RANK_HIERARCHY[b] || 0) - (RANK_HIERARCHY[a] || 0)
    );

    if (sortedRanks.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 30px 10px; color: #556688;">
                <i class="bi bi-inbox" style="font-size: 2rem; display: block; margin-bottom: 10px; opacity: 0.5;"></i>
                No claims yet
            </div>
        `;
        return;
    }

    grid.innerHTML = sortedRanks.map(rankKey => {
        const data = breakdown[rankKey];
        const isActive = activeRankFilter === rankKey;
        return `
            <div class="rank-card ${isActive ? 'active' : ''}" data-rank="${escapeHtml(rankKey)}" onclick="filterByRank('${escapeHtml(rankKey)}')">
                <div class="rank-card-header">
                    <div class="rank-card-icon">${data.rankInfo.icon}</div>
                    <div class="rank-card-name">${escapeHtml(data.rankInfo.rank)}</div>
                </div>
                <div class="rank-card-stats">
                    <div class="rank-card-count">
                        ${data.count}<small>users</small>
                    </div>
                    <div class="rank-card-value">${formatCurrency(data.value)}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================
// FILTER LOGIC
// ============================================================
function applyFilters() {
    const q = searchQuery.trim().toLowerCase();

    filteredClaims = allClaims.filter(claim => {
        // Rank filter
        if (activeRankFilter && claim.rankKey !== activeRankFilter) return false;

        // Search filter
        if (q) {
            const haystack = [
                claim.userName,
                claim.userUsername,
                claim.userEmail,
                claim.transactionId,
                claim.rank
            ].join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }

        return true;
    });

    renderTable();
}

// ============================================================
// RENDER TABLE
// ============================================================
function renderTable() {
    const tbody = document.getElementById('claimsTableBody');
    const emptyState = document.getElementById('emptyState');
    const loadMoreWrap = document.getElementById('loadMoreWrap');
    const badge = document.getElementById('totalCountBadge');

    badge.textContent = filteredClaims.length;

    if (filteredClaims.length === 0) {
        tbody.innerHTML = '';
        document.getElementById('claimsTable').style.display = 'none';
        emptyState.style.display = 'block';
        loadMoreWrap.style.display = 'none';
        return;
    }

    document.getElementById('claimsTable').style.display = 'table';
    emptyState.style.display = 'none';

    const visible = filteredClaims.slice(0, displayLimit);

    tbody.innerHTML = visible.map((claim, index) => {
        const date = formatDate(claim.creditedAt);
        const rankInfo = getRankInfo(claim.rankKey);
        const initial = (claim.userName || 'U').charAt(0).toUpperCase();

        return `
            <tr>
                <td style="color: #556688; font-weight: 600;">${index + 1}</td>
                <td>
                    <div class="user-cell">
                        <div class="user-avatar">${escapeHtml(initial)}</div>
                        <div class="user-info">
                            <div class="name">${escapeHtml(claim.userName)}</div>
                            <div class="meta">@${escapeHtml(claim.userUsername)}</div>
                            <div class="meta">${escapeHtml(claim.userEmail)}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <span class="rank-badge ${escapeHtml(claim.rankKey)}">
                        ${rankInfo.icon} ${escapeHtml(claim.rank)}
                    </span>
                </td>
                <td>
                    <div class="amount-cell">
                        ${formatCurrency(claim.reward)}
                        <span class="currency">USDT</span>
                    </div>
                </td>
                <td>
                    <div class="business-cell">${formatCurrency(claim.currentTeamBusiness)}</div>
                </td>
                <td>
                    <div class="date-cell">
                        <div class="date-main">${escapeHtml(date.main)}</div>
                        <div class="date-time">${escapeHtml(date.time)}</div>
                    </div>
                </td>
                <td>
                    ${claim.transactionId
                        ? `<span class="tx-id" title="${escapeHtml(claim.transactionId)}">${escapeHtml(claim.transactionId)}</span>`
                        : '<span style="color: #556688;">—</span>'
                    }
                </td>
            </tr>
        `;
    }).join('');

    // Load more
    if (filteredClaims.length > displayLimit) {
        loadMoreWrap.style.display = 'block';
        const remaining = filteredClaims.length - displayLimit;
        document.getElementById('loadMoreBtn').innerHTML = `
            <i class="bi bi-arrow-down-circle"></i> Load More (${remaining} remaining)
        `;
    } else {
        loadMoreWrap.style.display = 'none';
    }
}

// ============================================================
// EVENT HANDLERS
// ============================================================
window.filterByRank = function(rankKey) {
    if (activeRankFilter === rankKey) {
        activeRankFilter = '';
    } else {
        activeRankFilter = rankKey;
    }
    document.getElementById('rankFilter').value = activeRankFilter;
    displayLimit = 50;
    renderRankBreakdown();
    applyFilters();
};

function setupEventListeners() {
    // Search input
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        displayLimit = 50;
        applyFilters();
    });

    // Rank filter dropdown
    document.getElementById('rankFilter').addEventListener('change', (e) => {
        activeRankFilter = e.target.value;
        displayLimit = 50;
        renderRankBreakdown();
        applyFilters();
    });

    // Reset button
    document.getElementById('resetBtn').addEventListener('click', () => {
        searchQuery = '';
        activeRankFilter = '';
        displayLimit = 50;
        document.getElementById('searchInput').value = '';
        document.getElementById('rankFilter').value = '';
        renderRankBreakdown();
        applyFilters();
    });

    // Load more
    document.getElementById('loadMoreBtn').addEventListener('click', () => {
        displayLimit += 50;
        renderTable();
    });
}

// ============================================================
// MAIN LOADING
// ============================================================
function loadData() {
    let usersLoaded = false;
    let rewardsLoaded = false;

    const checkReady = () => {
        if (usersLoaded && rewardsLoaded) {
            dataReady = true;
            allClaims = buildClaimsFromData(allUsers, window.__rankRewardsCache || {});
            document.getElementById('loadingContainer').style.display = 'none';
            document.getElementById('contentContainer').style.display = 'block';

            renderSummary();
            renderRankBreakdown();
            applyFilters();
        }
    };

    // Users listener
    usersListenerOff = onValue(ref(db, 'users'), (snapshot) => {
        allUsers = snapshot.exists() ? snapshot.val() : {};
        usersLoaded = true;
        if (dataReady) {
            // Refresh if already loaded
            allClaims = buildClaimsFromData(allUsers, window.__rankRewardsCache || {});
            renderSummary();
            renderRankBreakdown();
            applyFilters();
        } else {
            checkReady();
        }
    }, (error) => {
        console.error('Users load error:', error);
        showToast('Failed to load users: ' + error.message, 'error');
    });

    // Rank rewards listener
    rewardsListenerOff = onValue(ref(db, 'rankRewards'), (snapshot) => {
        window.__rankRewardsCache = snapshot.exists() ? snapshot.val() : {};
        rewardsLoaded = true;
        if (dataReady) {
            // Refresh if already loaded
            allClaims = buildClaimsFromData(allUsers, window.__rankRewardsCache);
            renderSummary();
            renderRankBreakdown();
            applyFilters();
        } else {
            checkReady();
        }
    }, (error) => {
        console.error('Rank rewards load error:', error);
        showToast('Failed to load rank rewards: ' + error.message, 'error');
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

    // Verify admin
    if (user.email && !user.email.includes('admin')) {
        showToast('Access denied — admin only', 'error');
        setTimeout(() => {
            signOut(auth);
            window.location.href = 'index.html';
        }, 2000);
        return;
    }

    loadData();
    setupEventListeners();
});

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (usersListenerOff) { try { usersListenerOff(); } catch (e) {} }
    if (rewardsListenerOff) { try { rewardsListenerOff(); } catch (e) {} }
});

// ============================================================
// BOOT LOG
// ============================================================
console.log('%c🏆 Rank Reward Admin — Read Only', 'color: #fbbf24; font-size: 14px; font-weight: bold;');
console.log('%c📊 Reading from: users/*, rankRewards/*/*', 'color: #8899bb; font-size: 11px;');
console.log('%c🔒 No write operations — display only', 'color: #2ecc71; font-size: 11px;');