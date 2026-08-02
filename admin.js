import { initializeApp } from "firebase/app";
import { 
    getAuth, 
    signInWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged 
} from "firebase/auth";
import { 
    getDatabase, 
    ref, 
    get, 
    update, 
    set, 
    onValue, 
    remove,
    runTransaction,
    push
} from "firebase/database";

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

let currentTab = 'users';
let allUsers = {};
let allTransactions = [];
let allPackages = [];
let allWithdrawals = {};
let allDeposits = {};
let allSettings = { rate: 1.00 };
let isDataLoaded = false;
let dataListeners = {};
let pendingWithdrawals = [];
let pendingDeposits = [];
let selectedUserId = null;
let searchTimeout = null;

// ============================================================
// 🔥 TOAST
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// 🔥 COPY
// ============================================================
window.copyAddress = function(address, label = 'Address') {
    if (!address || address === 'N/A') {
        showToast('❌ No address to copy!', 'error');
        return;
    }
    navigator.clipboard.writeText(address).then(() => {
        showToast(`✅ ${label} copied to clipboard!`, 'success');
    }).catch(() => {
        const textArea = document.createElement('textarea');
        textArea.value = address;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast(`✅ ${label} copied to clipboard!`, 'success');
    });
};

// ============================================================
// 🔥 AUTHENTICATION
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
    try {
        await signOut(auth);
    } catch (error) {
        showToast('❌ Logout error: ' + error.message, 'error');
    }
});

// ============================================================
// 🔥 ATOMIC TRANSACTION SAVE
// ============================================================
async function saveTransaction(uid, transactionData) {
    try {
        const userRef = ref(db, 'users/' + uid);
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return { ...currentData };
            const transactions = currentData.transactions || {};
            if (transactionData.withdrawalId) {
                for (let key in transactions) {
                    const tx = transactions[key];
                    if (tx.type === 'withdrawal' && tx.withdrawalId === transactionData.withdrawalId) {
                        return { ...currentData };
                    }
                }
            }
            if (transactionData.packageId) {
                for (let key in transactions) {
                    const tx = transactions[key];
                    if (tx.type === 'package' && tx.packageId === transactionData.packageId) {
                        return { ...currentData };
                    }
                }
            }
            const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            transactions[txId] = transactionData;
            return { ...currentData, transactions: transactions };
        });
        return result.committed;
    } catch (error) {
        console.error('Error saving transaction:', error);
        return false;
    }
}

// ============================================================
// 🔥 ATOMIC UPDATE WITHDRAWAL STATUS
// ============================================================
async function updateWithdrawalStatusAtomic(uid, withdrawalId, newStatus, remark = '') {
    const userRef = ref(db, 'users/' + uid);
    const result = await runTransaction(userRef, (currentData) => {
        if (!currentData) return { ...currentData };
        const transactions = currentData.transactions || {};
        let found = false;
        for (let key in transactions) {
            const tx = transactions[key];
            if (tx.type === 'withdrawal' && tx.withdrawalId === withdrawalId) {
                transactions[key].status = newStatus;
                transactions[key].updatedAt = Date.now();
                if (remark) transactions[key].remark = remark;
                found = true;
                break;
            }
        }
        if (!found) return { ...currentData };
        return { ...currentData, transactions: transactions };
    });
    if (result.committed) {
        return { success: true };
    } else {
        return { success: false, error: 'Withdrawal not found' };
    }
}

// ============================================================
// 🔥 ATOMIC UPDATE DEPOSIT STATUS
// ============================================================
async function updateDepositStatusAtomic(uid, depositId, newStatus, remark = '') {
    const userRef = ref(db, 'users/' + uid);
    const result = await runTransaction(userRef, (currentData) => {
        if (!currentData) return { ...currentData };
        const transactions = currentData.transactions || {};
        let found = false;
        for (let key in transactions) {
            const tx = transactions[key];
            if (tx.type === 'deposit' && tx.depositId === depositId) {
                transactions[key].status = newStatus;
                transactions[key].updatedAt = Date.now();
                if (remark) transactions[key].remark = remark;
                found = true;
                break;
            }
        }
        if (!found) return { ...currentData };
        return { ...currentData, transactions: transactions };
    });
    if (result.committed) {
        return { success: true };
    } else {
        return { success: false, error: 'Deposit not found' };
    }
}

// ============================================================
// 🔥 ATOMIC ADMIN ADJUSTMENT
// ============================================================
async function processAdminAdjustment(uid, walletType, amount, type, description, remark = '') {
    const userRef = ref(db, 'users/' + uid);
    const result = await runTransaction(userRef, (currentData) => {
        if (!currentData) return { ...currentData };
        const currentBalance = currentData[walletType] || 0;
        const newBalance = type === 'credit' ? currentBalance + amount : currentBalance - amount;
        if (newBalance < 0) return { ...currentData };
        const transactions = currentData.transactions || {};
        const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        transactions[txId] = {
            type: type === 'credit' ? 'admin_credit' : 'admin_debit',
            amount: amount,
            currency: 'USDT',
            walletType: walletType,
            timestamp: Date.now(),
            date: new Date().toDateString(),
            status: 'completed',
            description: description || `${type === 'credit' ? 'Admin Credit' : 'Admin Debit'}`,
            remark: remark
        };
        return { ...currentData, [walletType]: newBalance, transactions: transactions };
    });
    if (result.committed) {
        return { success: true };
    } else {
        return { success: false, error: 'Insufficient balance or transaction failed' };
    }
}

// ============================================================
// 🔥 AUTH STATE CHANGE
// ============================================================
onAuthStateChanged(auth, (user) => {
    if (user) {
        console.log('✅ Admin logged in:', user.email);
        if (user.email === ADMIN_EMAIL || true) {
            document.getElementById('passwordScreen').style.display = 'none';
            document.getElementById('mainNav').style.display = 'flex';
            document.getElementById('adminContent').style.display = 'block';
            document.getElementById('userEmail').textContent = user.email;
            document.getElementById('dbStatus').className = 'db-status loading';
            document.getElementById('dbStatus').innerHTML = '<i class="bi bi-database"></i> Authenticated';
            showToast('✅ Welcome Admin!', 'success');
            loadAdminPanel();
        } else {
            showToast('❌ You are not authorized as admin.', 'error');
            signOut(auth);
        }
    } else {
        console.log('❌ Admin logged out');
        document.getElementById('passwordScreen').style.display = 'flex';
        document.getElementById('mainNav').style.display = 'none';
        document.getElementById('adminContent').style.display = 'none';
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').focus();
        document.getElementById('loginBtn').disabled = false;
        document.getElementById('loginBtn').innerHTML = '<i class="bi bi-shield-lock me-2"></i>Login';
        for (let key in dataListeners) {
            if (dataListeners[key]) {
                dataListeners[key]();
            }
        }
        dataListeners = {};
        allUsers = {};
        allTransactions = [];
        allPackages = [];
        allWithdrawals = {};
        allDeposits = {};
        pendingWithdrawals = [];
        pendingDeposits = [];
        isDataLoaded = false;
    }
});

// ============================================================
// 🔥 SETUP REALTIME LISTENERS
// ============================================================
function setupRealtimeListeners() {
    for (let key in dataListeners) {
        if (dataListeners[key]) {
            dataListeners[key]();
        }
    }
    dataListeners = {};
    
    const usersRef = ref(db, 'users');
    dataListeners.users = onValue(usersRef, (snapshot) => {
        if (snapshot.exists()) {
            allUsers = snapshot.val();
            console.log('✅ Users loaded:', Object.keys(allUsers).length);
            extractTransactionsFromUsers();
        } else {
            allUsers = {};
            allTransactions = [];
            allPackages = [];
        }
        if (isDataLoaded) renderDashboard();
    }, (error) => {
        console.error('Users listener error:', error);
        showToast('⚠️ Error loading users: ' + error.message, 'error');
    });

    const withdrawalsRef = ref(db, 'withdrawals');
    dataListeners.withdrawals = onValue(withdrawalsRef, (snapshot) => {
        if (snapshot.exists()) {
            allWithdrawals = snapshot.val();
            console.log('✅ Withdrawals loaded:', Object.keys(allWithdrawals).length);
        } else {
            allWithdrawals = {};
        }
        if (isDataLoaded) renderDashboard();
    }, (error) => {
        console.error('Withdrawals listener error:', error);
    });

    const depositsRef = ref(db, 'deposits');
    dataListeners.deposits = onValue(depositsRef, (snapshot) => {
        if (snapshot.exists()) {
            allDeposits = snapshot.val();
            console.log('✅ Deposits loaded:', Object.keys(allDeposits).length);
        } else {
            allDeposits = {};
        }
        if (isDataLoaded) renderDashboard();
    }, (error) => {
        console.error('Deposits listener error:', error);
    });

    const settingsRef = ref(db, 'settings');
    dataListeners.settings = onValue(settingsRef, (snapshot) => {
        if (snapshot.exists()) {
            allSettings = snapshot.val();
            console.log('✅ Settings loaded:', allSettings);
        } else {
            allSettings = { rate: 1.00 };
        }
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
// 🔥 EXTRACT TRANSACTIONS FROM USERS
// ============================================================
function extractTransactionsFromUsers() {
    allTransactions = [];
    allPackages = [];
    pendingWithdrawals = [];
    pendingDeposits = [];
    
    for (let uid in allUsers) {
        const user = allUsers[uid];
        if (user.role === 'admin') continue;
        
        const transactions = user.transactions || {};
        for (let txId in transactions) {
            const tx = transactions[txId];
            allTransactions.push({
                id: txId,
                uid: uid,
                user: user,
                source: 'user_transactions',
                ...tx
            });
            if (tx.type === 'withdrawal' && tx.status === 'pending') {
                pendingWithdrawals.push({ id: txId, uid: uid, user: user, ...tx });
            }
            if (tx.type === 'deposit' && tx.status === 'pending') {
                pendingDeposits.push({ id: txId, uid: uid, user: user, ...tx });
            }
        }
        
        const packages = user.packages || {};
        for (let pkgId in packages) {
            const pkg = packages[pkgId];
            allPackages.push({ id: pkgId, uid: uid, user: user, ...pkg });
        }
    }
    
    for (let key in allWithdrawals) {
        const w = allWithdrawals[key];
        if (w.status === 'pending') {
            const exists = pendingWithdrawals.some(p => p.withdrawalId === w.withdrawalId || p.id === key);
            if (!exists) {
                const user = allUsers[w.uid] || { name: 'Unknown', username: 'N/A' };
                pendingWithdrawals.push({ id: key, uid: w.uid, user: user, ...w });
            }
        }
    }
    
    allTransactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    allPackages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// ============================================================
// 🔥 LOAD ADMIN PANEL
// ============================================================
async function loadAdminPanel() {
    try {
        setupRealtimeListeners();
        await new Promise((resolve) => {
            let attempts = 0;
            const checkData = () => {
                attempts++;
                const hasData = Object.keys(allUsers).length > 0 || attempts > 15;
                if (hasData) {
                    isDataLoaded = true;
                    resolve();
                } else {
                    setTimeout(checkData, 500);
                }
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
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
}

// ============================================================
// 🔥 GET SORTED USERS (Newest First)
// ============================================================
function getSortedUsers() {
    return Object.entries(allUsers)
        .filter(([id, user]) => user.role !== 'admin')
        .sort((a, b) => (b[1].createdAt || b[1].registrationDate || 0) - (a[1].createdAt || a[1].registrationDate || 0))
        .map(([id, user]) => ({ id, ...user }));
}

// ============================================================
// 🔥 RENDER DASHBOARD
// ============================================================
function renderDashboard() {
    const sortedUsers = getSortedUsers();
    
    let totalUsers = sortedUsers.length;
    let totalDepositWallet = 0;
    let totalRNDWallet = 0;
    let totalLockedRND = 0;
    let totalReferrals = 0;
    
    for (let user of sortedUsers) {
        totalDepositWallet += (user.depositWallet || 0);
        totalRNDWallet += (user.rndWallet || 0);
        totalLockedRND += (user.lockedRND || 0);
        totalReferrals += (user.totalReferrals || 0);
    }
    
    const currentRate = allSettings.rate || 1.00;

    document.getElementById('adminContent').innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="d-flex flex-wrap justify-content-between align-items-center">
                    <h4 class="fw-bold"><i class="bi bi-shield-lock text-success me-2"></i>Admin Dashboard</h4>
                    <span class="text-muted small">${new Date().toLocaleString('hi-IN')}</span>
                </div>
                <hr class="border-secondary">
            </div>

            <!-- Stats Row -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-md-2 col-4">
                        <div class="stat-card">
                            <div class="stat-icon green"><i class="bi bi-people"></i></div>
                            <div class="stat-number">${totalUsers}</div>
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
                            <div class="stat-label">Total Withdrawals</div>
                            ${pendingWithdrawals.length > 0 ? `<span class="badge" style="background:rgba(251,191,36,0.15);color:#fbbf24;font-size:0.7rem;">${pendingWithdrawals.length} Pending</span>` : ''}
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon purple"><i class="bi bi-cash-stack"></i></div>
                            <div class="stat-number">$${allTransactions.filter(t => t.type === 'deposit' && t.status !== 'rejected').reduce((sum, t) => sum + (t.amount || 0), 0).toFixed(2)}</div>
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

            <!-- Stats Row 2 -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(46,204,113,0.12);color:#2ecc71;"><i class="bi bi-wallet2"></i></div>
                            <div class="stat-number" style="color:#2ecc71;">$${totalDepositWallet.toFixed(2)}</div>
                            <div class="stat-label">Total Deposit Wallet</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(96,165,250,0.12);color:#60a5fa;"><i class="bi bi-coin"></i></div>
                            <div class="stat-number" style="color:#60a5fa;">${totalRNDWallet.toFixed(2)}</div>
                            <div class="stat-label">Total RND Wallet</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(167,139,250,0.12);color:#a78bfa;"><i class="bi bi-lock"></i></div>
                            <div class="stat-number" style="color:#a78bfa;">${totalLockedRND.toFixed(2)}</div>
                            <div class="stat-label">Total Locked RND</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="stat-card">
                            <div class="stat-icon" style="background:rgba(251,191,36,0.12);color:#fbbf24;"><i class="bi bi-people"></i></div>
                            <div class="stat-number" style="color:#fbbf24;">${totalReferrals}</div>
                            <div class="stat-label">Total Referrals</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Tabs -->
            <div class="col-12">
                <ul class="nav nav-tabs-custom" style="border-bottom:1px solid rgba(46,204,113,0.1);margin-bottom:20px;flex-wrap:wrap;">
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'users' ? 'active' : ''}" onclick="switchTab('users')">
                            <i class="bi bi-people"></i> Users (${totalUsers})
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'withdrawals' ? 'active' : ''}" onclick="switchTab('withdrawals')">
                            <i class="bi bi-arrow-up-circle"></i> Withdrawals 
                            ${pendingWithdrawals.length > 0 ? `<span class="badge" style="background:rgba(251,191,36,0.15);color:#fbbf24;margin-left:5px;">${pendingWithdrawals.length}</span>` : ''}
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link ${currentTab === 'deposits' ? 'active' : ''}" onclick="switchTab('deposits')">
                            <i class="bi bi-arrow-down-circle"></i> Deposits
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
                ${currentTab === 'users' ? renderUsersTab(sortedUsers) : ''}
                ${currentTab === 'withdrawals' ? renderWithdrawalsTab() : ''}
                ${currentTab === 'deposits' ? renderDepositsTab() : ''}
                ${currentTab === 'packages' ? renderPackagesTab() : ''}
                ${currentTab === 'settings' ? renderSettingsTab(sortedUsers) : ''}
            </div>
        </div>
    `;
    
    // Attach event listeners after render
    setTimeout(() => {
        attachEventListeners();
    }, 300);
}

// ============================================================
// 🔥 ATTACH EVENT LISTENERS
// ============================================================
function attachEventListeners() {
    // Settings form
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveSettings();
        });
    }
    
    // Admin adjustment form
    const adminForm = document.getElementById('adminAdjustForm');
    if (adminForm) {
        adminForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await handleAdminAdjustment();
        });
    }
    
    // Search input
    const searchInput = document.getElementById('userSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimeout);
            const query = this.value.trim();
            const resultsContainer = document.getElementById('searchResults');
            
            if (query.length === 0) {
                resultsContainer.classList.remove('show');
                resultsContainer.innerHTML = '';
                return;
            }
            
            searchTimeout = setTimeout(() => {
                performUserSearch(query);
            }, 300);
        });
        
        document.addEventListener('click', function(e) {
            const container = document.getElementById('userSearchContainer');
            if (container && !container.contains(e.target)) {
                document.getElementById('searchResults').classList.remove('show');
            }
        });
    }
    
    // If no user selected, select the first one
    if (!selectedUserId) {
        const sortedUsers = getSortedUsers();
        if (sortedUsers.length > 0) {
            selectedUserId = sortedUsers[0].id;
            renderUserProfile(selectedUserId);
            highlightUserRow(selectedUserId);
        }
    } else {
        renderUserProfile(selectedUserId);
        highlightUserRow(selectedUserId);
    }
}

// ============================================================
// 🔥 HIGHLIGHT USER ROW
// ============================================================
function highlightUserRow(userId) {
    const rows = document.querySelectorAll('#usersTable tbody tr');
    rows.forEach(row => {
        row.classList.remove('active-row');
        if (row.dataset.userId === userId) {
            row.classList.add('active-row');
        }
    });
}

// ============================================================
// 🔥 PERFORM USER SEARCH
// ============================================================
function performUserSearch(query) {
    const resultsContainer = document.getElementById('searchResults');
    const lowerQuery = query.toLowerCase();
    
    const results = getSortedUsers().filter(user => {
        const id = (user.id || '').toLowerCase();
        const name = (user.name || '').toLowerCase();
        const username = (user.username || '').toLowerCase();
        const email = (user.email || '').toLowerCase();
        const phone = (user.phone || user.mobile || '').toLowerCase();
        
        return id.includes(lowerQuery) || 
               name.includes(lowerQuery) || 
               username.includes(lowerQuery) || 
               email.includes(lowerQuery) || 
               phone.includes(lowerQuery);
    });
    
    if (results.length === 0) {
        resultsContainer.innerHTML = `
            <div class="p-3 text-center text-muted">
                <i class="bi bi-search"></i> No users found
            </div>
        `;
        resultsContainer.classList.add('show');
        return;
    }
    
    resultsContainer.innerHTML = results.slice(0, 15).map(user => `
        <div class="user-search-result" onclick="window.selectUser('${user.id}')">
            <div class="d-flex justify-content-between align-items-center">
                <div>
                    <span class="result-name">${user.name || 'Unknown'}</span>
                    <span class="result-id ms-2">${user.username || user.id || 'N/A'}</span>
                </div>
                <span class="result-wallet">$${(user.depositWallet || 0).toFixed(2)}</span>
            </div>
            <div class="d-flex gap-3 mt-1">
                <span style="font-size:0.7rem;color:#556688;">${user.id || 'N/A'}</span>
                ${user.email ? `<span style="font-size:0.7rem;color:#556688;">${user.email}</span>` : ''}
                ${user.mobile || user.phone ? `<span style="font-size:0.7rem;color:#556688;">${user.mobile || user.phone}</span>` : ''}
            </div>
        </div>
    `).join('');
    
    resultsContainer.classList.add('show');
}

// ============================================================
// 🔥 SELECT USER
// ============================================================
window.selectUser = function(userId) {
    const user = allUsers[userId];
    if (!user) return;
    
    selectedUserId = userId;
    document.getElementById('searchResults').classList.remove('show');
    const searchInput = document.getElementById('userSearchInput');
    if (searchInput) {
        searchInput.value = user.name || user.username || userId;
    }
    renderUserProfile(userId);
    highlightUserRow(userId);
};

// ============================================================
// 🔥 RENDER USER PROFILE
// ============================================================
function renderUserProfile(userId) {
    const container = document.getElementById('userProfileContainer');
    if (!container) return;
    
    const user = allUsers[userId];
    if (!user) {
        container.innerHTML = `
            <div class="text-center py-5 text-muted">
                <i class="bi bi-person fs-1 d-block mb-3"></i>
                <p>Select a user to view details</p>
            </div>
        `;
        return;
    }
    
    // Calculate user stats
    const userTxs = allTransactions.filter(t => t.uid === userId);
    const deposits = userTxs.filter(t => t.type === 'deposit');
    const withdrawals = userTxs.filter(t => t.type === 'withdrawal');
    const pendingWithdrawals = withdrawals.filter(t => t.status === 'pending');
    const approvedDeposits = deposits.filter(t => t.status === 'approved' || t.status === 'completed' || t.status === 'success');
    
    const totalDeposit = deposits.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalWithdrawal = withdrawals.filter(t => t.status === 'approved' || t.status === 'success').reduce((sum, t) => sum + (t.amount || 0), 0);
    const pendingWithdrawalAmount = pendingWithdrawals.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalReferralIncome = userTxs.filter(t => t.type === 'referral_commission').reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalAdminCredits = userTxs.filter(t => t.type === 'admin_credit').reduce((sum, t) => sum + (t.amount || 0), 0);
    
    // Active packages
    const userPackages = allPackages.filter(p => p.uid === userId);
    const activePackages = userPackages.filter(p => p.status === 'active');
    
    let totalReleased = 0;
    let totalLockedRND = 0;
    let totalStake = 0;
    for (let pkg of userPackages) {
        const released = pkg.releasedRND || 0;
        const totalRND = pkg.totalRND || 0;
        totalReleased += released;
        totalLockedRND += Math.max(0, totalRND - released);
        totalStake += (pkg.usdtAmount || 0);
    }
    
    // Today's income (last 24 hours)
    const today = Date.now() - 24 * 60 * 60 * 1000;
    const todayIncome = userTxs.filter(t => 
        (t.type === 'daily_release' || t.type === 'referral_commission' || t.type === 'bonus') && 
        (t.timestamp || 0) > today
    ).reduce((sum, t) => sum + (t.amount || 0), 0);
    
    // Total income
    const totalIncome = userTxs.filter(t => 
        t.type === 'daily_release' || t.type === 'referral_commission' || t.type === 'bonus'
    ).reduce((sum, t) => sum + (t.amount || 0), 0) + totalAdminCredits;
    
    // Blockchain deposits
    const blockchainDeposits = userTxs.filter(t => t.type === 'deposit' && t.source === 'blockchain');
    const blockchainTotal = blockchainDeposits.reduce((sum, t) => sum + (t.amount || 0), 0);
    const blockchainPending = blockchainDeposits.filter(t => t.status === 'pending').reduce((sum, t) => sum + (t.amount || 0), 0);
    const blockchainApproved = blockchainDeposits.filter(t => t.status === 'approved' || t.status === 'completed').reduce((sum, t) => sum + (t.amount || 0), 0);
    
    const userStatus = user.status || 'active';
    const statusBadge = userStatus === 'active' ? 'active' : 'inactive';
    const avatarLetter = (user.name || 'U').charAt(0).toUpperCase();
    const registrationDate = user.createdAt || user.registrationDate || Date.now();
    
    container.innerHTML = `
        <div class="row g-3">
            <!-- User Info Card -->
            <div class="col-lg-4 col-md-5">
                <div class="card-glass">
                    <div class="d-flex align-items-center gap-3 mb-3">
                        <div class="profile-avatar">${avatarLetter}</div>
                        <div class="flex-grow-1">
                            <div class="d-flex align-items-center gap-2">
                                <h5 class="fw-bold mb-0">${user.name || 'Unknown'}</h5>
                                <span class="profile-badge ${statusBadge}">${userStatus.toUpperCase()}</span>
                            </div>
                            <div style="font-size:0.85rem;color:#8899bb;">${user.username || 'N/A'}</div>
                            <div style="font-size:0.7rem;color:#556688;font-family:monospace;">${userId || 'N/A'}</div>
                        </div>
                        <button class="btn-copy" onclick="copyAddress('${userId || ''}', 'User ID')"><i class="bi bi-clipboard"></i></button>
                    </div>
                    
                    <div class="info-row">
                        <span class="label"><i class="bi bi-envelope me-1"></i> Email</span>
                        <span class="value">${user.email || 'N/A'}</span>
                    </div>
                    <div class="info-row">
                        <span class="label"><i class="bi bi-phone me-1"></i> Mobile</span>
                        <span class="value">${user.mobile || user.phone || 'N/A'}</span>
                    </div>
                    <div class="info-row">
                        <span class="label"><i class="bi bi-people me-1"></i> Sponsor</span>
                        <span class="value">${user.sponsorName || user.sponsor || 'N/A'}</span>
                    </div>
                    <div class="info-row">
                        <span class="label"><i class="bi bi-link-45deg me-1"></i> Referral ID</span>
                        <span class="value" style="font-family:monospace;">${user.referralId || user.username || 'N/A'}</span>
                    </div>
                    <div class="info-row">
                        <span class="label"><i class="bi bi-calendar3 me-1"></i> Registration</span>
                        <span class="value">${new Date(registrationDate).toLocaleString('hi-IN')}</span>
                    </div>
                    <div class="info-row" style="border-bottom:none;">
                        <span class="label"><i class="bi bi-clock me-1"></i> Last Login</span>
                        <span class="value">${user.lastLogin ? new Date(user.lastLogin).toLocaleString('hi-IN') : 'N/A'}</span>
                    </div>
                    
                    <div class="mt-3 pt-3 border-top border-secondary">
                        <div class="row g-2">
                            <div class="col-6">
                                <div class="wallet-summary-card">
                                    <div class="wallet-label">Deposit Wallet</div>
                                    <div class="wallet-value usd">$${(user.depositWallet || 0).toFixed(2)}</div>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="wallet-summary-card">
                                    <div class="wallet-label">RND Wallet</div>
                                    <div class="wallet-value rnd">${(user.rndWallet || 0).toFixed(4)}</div>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="wallet-summary-card">
                                    <div class="wallet-label">Locked RND</div>
                                    <div class="wallet-value locked">${(user.lockedRND || 0).toFixed(2)}</div>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="wallet-summary-card">
                                    <div class="wallet-label">Total Stake</div>
                                    <div class="wallet-value gold">$${(user.totalStake || totalStake || 0).toFixed(2)}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Wallet Summary -->
            <div class="col-lg-8 col-md-7">
                <div class="card-glass">
                    <h6 class="fw-bold mb-3"><i class="bi bi-wallet2 text-success me-2"></i>Wallet Summary</h6>
                    <div class="row g-2">
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">💰 Deposit Wallet</div>
                                <div class="wallet-value usd">$${(user.depositWallet || 0).toFixed(2)}</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">📊 RND Wallet</div>
                                <div class="wallet-value rnd">${(user.rndWallet || 0).toFixed(4)}</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">🔒 Locked RND</div>
                                <div class="wallet-value locked">${(user.lockedRND || totalLockedRND || 0).toFixed(2)}</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">⛓️ Blockchain Deposit</div>
                                <div class="wallet-value usd">$${blockchainTotal.toFixed(2)}</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">📈 Total Stake</div>
                                <div class="wallet-value gold">$${(user.totalStake || totalStake || 0).toFixed(2)}</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">📆 Today's Income</div>
                                <div class="wallet-value rnd">${todayIncome.toFixed(4)} RND</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">📊 Total Released</div>
                                <div class="wallet-value rnd">${totalReleased.toFixed(2)} RND</div>
                            </div>
                        </div>
                        <div class="col-md-3 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">👥 Referral Income</div>
                                <div class="wallet-value gold">$${totalReferralIncome.toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Blockchain Deposit Details -->
                ${blockchainDeposits.length > 0 ? `
                <div class="card-glass mt-3">
                    <h6 class="fw-bold mb-3"><i class="bi bi-blockchain text-success me-2"></i>Blockchain Deposit</h6>
                    <div class="row g-2">
                        <div class="col-md-4 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">Total Deposit</div>
                                <div class="wallet-value usd">$${blockchainTotal.toFixed(2)}</div>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">✅ Approved</div>
                                <div class="wallet-value" style="color:#2ecc71;">$${blockchainApproved.toFixed(2)}</div>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="wallet-summary-card">
                                <div class="wallet-label">⏳ Pending</div>
                                <div class="wallet-value" style="color:#fbbf24;">$${blockchainPending.toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                <!-- Stats -->
                <div class="card-glass mt-3">
                    <h6 class="fw-bold mb-3"><i class="bi bi-graph-up text-success me-2"></i>Statistics</h6>
                    <div class="row g-2">
                        <div class="col-md-4 col-6">
                            <div class="info-row">
                                <span class="label">Total Deposit</span>
                                <span class="value highlight">$${totalDeposit.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="info-row">
                                <span class="label">Total Withdrawal</span>
                                <span class="value red">$${totalWithdrawal.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="info-row">
                                <span class="label">⏳ Pending Withdrawal</span>
                                <span class="value gold">$${pendingWithdrawalAmount.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="info-row">
                                <span class="label">Direct Referral</span>
                                <span class="value">${user.directReferrals || 0}</span>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="info-row">
                                <span class="label">Team Size</span>
                                <span class="value">${user.totalReferrals || 0}</span>
                            </div>
                        </div>
                        <div class="col-md-4 col-6">
                            <div class="info-row" style="border-bottom:none;">
                                <span class="label">Total Income</span>
                                <span class="value highlight">${totalIncome.toFixed(2)} RND</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Active Packages -->
                ${activePackages.length > 0 ? `
                <div class="card-glass mt-3">
                    <h6 class="fw-bold mb-3"><i class="bi bi-box-seam text-success me-2"></i>Active Packages (${activePackages.length})</h6>
                    <div class="table-responsive">
                        <table class="table table-custom table-sm">
                            <thead>
                                <tr>
                                    <th>Plan</th>
                                    <th>Amount</th>
                                    <th>Total RND</th>
                                    <th>Released</th>
                                    <th>Daily</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${activePackages.map(pkg => `
                                    <tr>
                                        <td style="color:#fbbf24;">${pkg.planName || 'Package'}</td>
                                        <td>$${(pkg.usdtAmount || 0).toFixed(2)}</td>
                                        <td style="color:#60a5fa;">${(pkg.totalRND || 0).toFixed(2)}</td>
                                        <td style="color:#34d399;">${(pkg.releasedRND || 0).toFixed(2)}</td>
                                        <td style="color:#fbbf24;">${(pkg.dailyRelease || 0).toFixed(4)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// ============================================================
// 🔥 RENDER USERS TAB
// ============================================================
function renderUsersTab(sortedUsers) {
    return `
        <div class="row g-3">
            <div class="col-12">
                <div class="card-glass">
                    <div class="d-flex flex-wrap gap-3 align-items-center" id="userSearchContainer">
                        <div class="flex-grow-1" style="position:relative;max-width:500px;">
                            <div style="position:relative;">
                                <i class="bi bi-search" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#556688;"></i>
                                <input type="text" id="userSearchInput" class="form-control form-control-custom" 
                                       placeholder="Search by Name, User ID, Email, Phone..." style="padding-left:40px;">
                            </div>
                            <div id="searchResults" class="search-results-container"></div>
                        </div>
                        <span class="text-muted small">${sortedUsers.length} users • Newest first</span>
                    </div>
                </div>
            </div>
            
            <div class="col-12">
                <div class="card-glass">
                    <div class="table-responsive">
                        <table class="table table-custom" id="usersTable">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>User</th>
                                    <th>Email</th>
                                    <th>Mobile</th>
                                    <th>Deposit</th>
                                    <th>RND</th>
                                    <th>Locked</th>
                                    <th>Refs</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${sortedUsers.map((user, index) => `
                                    <tr data-user-id="${user.id}" onclick="window.selectUser('${user.id}')" 
                                        class="${selectedUserId === user.id ? 'active-row' : ''}">
                                        <td>${index + 1}</td>
                                        <td>
                                            <strong>${user.name || 'Unknown'}</strong><br>
                                            <small style="color:#556688;">${user.username || user.id || 'N/A'}</small>
                                        </td>
                                        <td style="font-size:0.85rem;">${user.email || 'N/A'}</td>
                                        <td style="font-size:0.85rem;">${user.mobile || user.phone || 'N/A'}</td>
                                        <td><strong style="color:#2ecc71;">$${(user.depositWallet || 0).toFixed(2)}</strong></td>
                                        <td><strong style="color:#60a5fa;">${(user.rndWallet || 0).toFixed(4)}</strong></td>
                                        <td><strong style="color:#a78bfa;">${(user.lockedRND || 0).toFixed(2)}</strong></td>
                                        <td>${user.totalReferrals || 0}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <div class="col-12" id="userProfileContainer">
                <div class="text-center py-5 text-muted">
                    <i class="bi bi-person fs-1 d-block mb-3"></i>
                    <p>Loading user details...</p>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 🔥 RENDER WITHDRAWALS TAB
// ============================================================
function renderWithdrawalsTab() {
    const allWithdrawalsList = allTransactions.filter(t => t.type === 'withdrawal');
    allWithdrawalsList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    for (let key in allWithdrawals) {
        const w = allWithdrawals[key];
        const exists = allWithdrawalsList.some(t => t.withdrawalId === w.withdrawalId);
        if (!exists) {
            const user = allUsers[w.uid] || { name: 'Unknown', username: 'N/A' };
            allWithdrawalsList.push({
                id: key,
                uid: w.uid,
                user: user,
                withdrawalId: w.withdrawalId || key,
                amount: w.amount || 0,
                currency: w.currency || 'USDT',
                status: w.status || 'pending',
                timestamp: w.timestamp || Date.now(),
                walletAddress: w.wallet || '',
                walletType: w.walletType || '',
                source: 'root'
            });
        }
    }
    
    allWithdrawalsList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    if (allWithdrawalsList.length === 0) {
        return `
            <div class="card-glass">
                <div class="no-data">
                    <i class="bi bi-inbox"></i>
                    <p>No withdrawals found.</p>
                </div>
            </div>
        `;
    }

    let html = `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;">
                    <i class="bi bi-arrow-up-circle text-success me-2"></i>
                    Withdrawals (${allWithdrawalsList.length})
                    ${allWithdrawalsList.filter(w => w.status === 'pending').length > 0 ? 
                        `<span class="badge" style="background:rgba(251,191,36,0.15);color:#fbbf24;margin-left:10px;">${allWithdrawalsList.filter(w => w.status === 'pending').length} Pending</span>` : ''}
                </div>
                <input type="text" class="search-box" placeholder="Search by user..." oninput="filterWithdrawals(this.value)">
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="withdrawalsTable">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>User</th>
                            <th>Amount</th>
                            <th>Wallet Address</th>
                            <th>Date</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    let count = 0;
    for (let w of allWithdrawalsList) {
        count++;
        const user = w.user || allUsers[w.uid] || { name: 'Unknown', username: 'N/A' };
        const statusClass = w.status === 'pending' ? 'badge-pending' : 
                           w.status === 'approved' || w.status === 'success' ? 'badge-approved' : 
                           'badge-rejected';
        const statusText = w.status === 'pending' ? '⏳ Pending' : 
                           w.status === 'approved' || w.status === 'success' ? '✅ Approved' : 
                           '❌ Rejected';
        const currency = w.currency || 'USDT';
        const walletDisplay = w.walletAddress ? w.walletAddress.substring(0, 20) + '...' : 'N/A';
        const withdrawalId = w.withdrawalId || w.id;
        
        html += `
            <tr data-user="${(user.username || user.name || '').toLowerCase()}">
                <td>${count}</td>
                <td>
                    <strong>${user.name || 'Unknown'}</strong><br>
                    <small style="color:#556688;">${user.username || 'N/A'}</small>
                </td>
                <td><strong style="color:#fbbf24;">${(w.amount || 0).toFixed(2)} ${currency}</strong></td>
                <td>
                    <span class="wallet-address-cell">${walletDisplay}</span>
                    ${w.walletAddress ? `<button class="btn-copy ms-1" onclick="copyAddress('${w.walletAddress}','Wallet')"><i class="bi bi-clipboard"></i></button>` : ''}
                </td>
                <td style="font-size:0.8rem;color:#8899bb;">${new Date(w.timestamp).toLocaleString('hi-IN')}</td>
                <td><span class="${statusClass}">${statusText}</span></td>
                <td>
                    ${w.status === 'pending' ? `
                        <button class="btn btn-success-custom btn-sm me-1" onclick="approveWithdrawal('${w.uid}', '${withdrawalId}')"><i class="bi bi-check-lg"></i></button>
                        <button class="btn btn-danger-custom btn-sm" onclick="rejectWithdrawal('${w.uid}', '${withdrawalId}')"><i class="bi bi-x-lg"></i></button>
                    ` : w.status === 'approved' || w.status === 'success' ? `
                        <span class="text-success"><i class="bi bi-check-circle"></i> Done</span>
                    ` : `
                        <span class="text-danger"><i class="bi bi-x-circle"></i> Rejected</span>
                    `}
                </td>
            </tr>
        `;
    }

    html += `</tbody></table></div></div>`;
    return html;
}

// ============================================================
// 🔥 RENDER DEPOSITS TAB
// ============================================================
function renderDepositsTab() {
    const allDepositsList = allTransactions.filter(t => t.type === 'deposit');
    allDepositsList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    if (allDepositsList.length === 0) {
        return `
            <div class="card-glass">
                <div class="no-data">
                    <i class="bi bi-inbox"></i>
                    <p>No deposits found.</p>
                </div>
            </div>
        `;
    }

    let html = `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;">
                    <i class="bi bi-arrow-down-circle text-success me-2"></i>
                    Deposits (${allDepositsList.length})
                </div>
                <input type="text" class="search-box" placeholder="Search by user..." oninput="filterDeposits(this.value)">
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="depositsTable">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>User</th>
                            <th>Amount</th>
                            <th>Source</th>
                            <th>Date</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    let count = 0;
    for (let d of allDepositsList) {
        count++;
        const user = d.user || allUsers[d.uid] || { name: 'Unknown', username: 'N/A' };
        const statusClass = d.status === 'pending' ? 'badge-pending' : 
                           d.status === 'approved' || d.status === 'completed' || d.status === 'success' ? 'badge-approved' : 
                           'badge-rejected';
        const statusText = d.status === 'pending' ? '⏳ Pending' : 
                           d.status === 'approved' || d.status === 'completed' || d.status === 'success' ? '✅ Approved' : 
                           '❌ Rejected';
        const sourceIcon = d.source === 'blockchain' ? '⛓️' : '🏦';
        const sourceLabel = d.source === 'blockchain' ? 'Blockchain' : 'Manual';
        
        html += `
            <tr data-user="${(user.username || user.name || '').toLowerCase()}">
                <td>${count}</td>
                <td>
                    <strong>${user.name || 'Unknown'}</strong><br>
                    <small style="color:#556688;">${user.username || 'N/A'}</small>
                </td>
                <td><strong style="color:#2ecc71;">$${(d.amount || 0).toFixed(2)}</strong></td>
                <td style="font-size:0.8rem;color:#8899bb;">
                    ${sourceIcon} ${sourceLabel}
                    ${d.txHash ? `<br><small>TX: ${d.txHash.substring(0, 15)}...</small>` : ''}
                </td>
                <td style="font-size:0.8rem;color:#8899bb;">${new Date(d.timestamp).toLocaleString('hi-IN')}</td>
                <td><span class="${statusClass}">${statusText}</span></td>
            </tr>
        `;
    }

    html += `</tbody></table></div></div>`;
    return html;
}

// ============================================================
// 🔥 RENDER PACKAGES TAB
// ============================================================
function renderPackagesTab() {
    if (allPackages.length === 0) {
        return `
            <div class="card-glass">
                <div class="no-data">
                    <i class="bi bi-inbox"></i>
                    <p>No packages found.</p>
                </div>
            </div>
        `;
    }

    let html = `
        <div class="card-glass">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3">
                <div class="card-title" style="margin-bottom:0;"><i class="bi bi-box-seam text-success me-2"></i>All Packages (${allPackages.length})</div>
                <input type="text" class="search-box" placeholder="Search by user..." oninput="filterPackages(this.value)">
            </div>
            <div class="table-responsive">
                <table class="table table-custom" id="packagesTable">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>User</th>
                            <th>Plan</th>
                            <th>Amount</th>
                            <th>Total RND</th>
                            <th>Released</th>
                            <th>Locked</th>
                            <th>Daily</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    let count = 0;
    for (let pkg of allPackages) {
        count++;
        const user = pkg.user || allUsers[pkg.uid] || { name: 'Unknown', username: 'N/A' };
        const statusClass = pkg.status === 'active' ? 'badge-active' : 'badge-completed';
        const statusText = pkg.status === 'active' ? '🟢 Active' : '🔵 Completed';
        const released = pkg.releasedRND || 0;
        const locked = Math.max(0, (pkg.totalRND || 0) - released);
        
        html += `
            <tr data-user="${(user.username || user.name || '').toLowerCase()}">
                <td>${count}</td>
                <td>
                    <strong>${user.name || 'Unknown'}</strong><br>
                    <small style="color:#556688;">${user.username || 'N/A'}</small>
                </td>
                <td style="color:#fbbf24;">${pkg.planName || 'Package'}</td>
                <td><strong style="color:#2ecc71;">$${(pkg.usdtAmount || 0).toFixed(2)}</strong></td>
                <td><strong style="color:#60a5fa;">${(pkg.totalRND || 0).toFixed(2)}</strong></td>
                <td style="color:#34d399;">${released.toFixed(2)}</td>
                <td style="color:#a78bfa;">${locked.toFixed(2)}</td>
                <td style="color:#fbbf24;">${(pkg.dailyRelease || 0).toFixed(4)}</td>
                <td><span class="${statusClass}">${statusText}</span></td>
            </tr>
        `;
    }

    html += `</tbody></table></div></div>`;
    return html;
}

// ============================================================
// 🔥 RENDER SETTINGS TAB
// ============================================================
function renderSettingsTab(sortedUsers) {
    const currentRate = allSettings.rate || 1.00;
    
    let totalUsers = sortedUsers.length;
    let totalDepositWallet = 0;
    let totalRNDWallet = 0;
    let totalLockedRND = 0;
    
    for (let user of sortedUsers) {
        totalDepositWallet += (user.depositWallet || 0);
        totalRNDWallet += (user.rndWallet || 0);
        totalLockedRND += (user.lockedRND || 0);
    }
    
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
                        <button type="submit" class="btn-primary-custom" id="saveSettingsBtn">
                            <i class="bi bi-save me-2"></i>Update Rate
                        </button>
                    </div>
                </div>
            </form>

            <hr class="border-secondary">

            <h6 class="text-muted mb-3"><i class="bi bi-shield me-2"></i>Admin Adjustment</h6>
            <form id="adminAdjustForm" class="row g-2 align-items-end">
                <div class="col-md-3">
                    <label class="form-label">User</label>
                    <select id="adminUserSelect" class="form-control form-control-custom">
                        ${sortedUsers.map(user => 
                            `<option value="${user.id}">${user.name || 'Unknown'} (@${user.username || 'N/A'})</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="col-md-2">
                    <label class="form-label">Wallet</label>
                    <select id="adminWalletSelect" class="form-control form-control-custom">
                        <option value="depositWallet">Deposit Wallet</option>
                        <option value="referralWallet">Referral Wallet</option>
                        <option value="rndWallet">RND Wallet</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <label class="form-label">Type</label>
                    <select id="adminAdjustType" class="form-control form-control-custom">
                        <option value="credit">➕ Credit</option>
                        <option value="debit">➖ Debit</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <label class="form-label">Amount (USDT)</label>
                    <input type="number" id="adminAdjustAmount" class="form-control form-control-custom" placeholder="0.00" step="0.01" min="0.01" required>
                </div>
                <div class="col-md-3">
                    <label class="form-label">Description</label>
                    <input type="text" id="adminAdjustDesc" class="form-control form-control-custom" placeholder="Reason for adjustment">
                </div>
                <div class="col-12 mt-2">
                    <button type="submit" class="btn btn-warning-custom w-100">
                        <i class="bi bi-shield me-1"></i> Apply Adjustment
                    </button>
                </div>
            </form>

            <hr class="border-secondary">

            <div class="row g-3">
                <div class="col-md-6">
                    <h6 class="text-muted">📊 Platform Stats</h6>
                    <div class="info-row"><span class="label">Total Users</span><span class="value">${totalUsers}</span></div>
                    <div class="info-row"><span class="label">Total Deposits</span><span class="value">${allTransactions.filter(t => t.type === 'deposit').length}</span></div>
                    <div class="info-row"><span class="label">Total Withdrawals</span><span class="value">${allTransactions.filter(t => t.type === 'withdrawal').length}</span></div>
                    <div class="info-row"><span class="label">Total Packages</span><span class="value">${allPackages.length}</span></div>
                    <div class="info-row"><span class="label">Total Deposit Wallet</span><span class="value highlight">$${totalDepositWallet.toFixed(2)}</span></div>
                    <div class="info-row"><span class="label">Total RND Wallet</span><span class="value rnd-color">${totalRNDWallet.toFixed(2)}</span></div>
                    <div class="info-row"><span class="label">Total Locked RND</span><span class="value locked-color">${totalLockedRND.toFixed(2)}</span></div>
                </div>
                <div class="col-md-6">
                    <h6 class="text-muted">🔐 Security</h6>
                    <div class="info-row"><span class="label">Admin Status</span><span class="value"><i class="bi bi-check-circle text-success"></i> Active</span></div>
                    <div class="info-row"><span class="label">Session Time</span><span class="value">${new Date().toLocaleString('hi-IN')}</span></div>
                    <div class="info-row"><span class="label">Database</span><span class="value"><i class="bi bi-check-circle text-success"></i> Connected</span></div>
                    <div class="info-row"><span class="label">Pending Withdrawals</span><span class="value gold">${pendingWithdrawals.length}</span></div>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 🔥 SWITCH TAB
// ============================================================
window.switchTab = function(tab) {
    currentTab = tab;
    renderDashboard();
};

// ============================================================
// 🔥 FILTER FUNCTIONS
// ============================================================
window.filterDeposits = function(value) {
    const rows = document.querySelectorAll('#depositsTable tbody tr');
    const search = value.toLowerCase();
    rows.forEach(row => {
        const user = row.getAttribute('data-user') || '';
        row.style.display = user.includes(search) ? '' : 'none';
    });
};

window.filterWithdrawals = function(value) {
    const rows = document.querySelectorAll('#withdrawalsTable tbody tr');
    const search = value.toLowerCase();
    rows.forEach(row => {
        const user = row.getAttribute('data-user') || '';
        row.style.display = user.includes(search) ? '' : 'none';
    });
};

window.filterPackages = function(value) {
    const rows = document.querySelectorAll('#packagesTable tbody tr');
    const search = value.toLowerCase();
    rows.forEach(row => {
        const user = row.getAttribute('data-user') || '';
        row.style.display = user.includes(search) ? '' : 'none';
    });
};

// ============================================================
// 🔥 APPROVE WITHDRAWAL
// ============================================================
window.approveWithdrawal = async function(uid, withdrawalId) {
    if (!confirm('✅ Approve this withdrawal?')) return;
    
    try {
        const result = await updateWithdrawalStatusAtomic(uid, withdrawalId, 'approved');
        if (result.success) {
            showToast('✅ Withdrawal approved successfully!', 'success');
            try {
                const rootSnap = await get(ref(db, 'withdrawals'));
                if (rootSnap.exists()) {
                    const rootData = rootSnap.val();
                    for (let key in rootData) {
                        if (rootData[key].withdrawalId === withdrawalId) {
                            await update(ref(db, 'withdrawals/' + key), { status: 'approved', approvedAt: Date.now() });
                            break;
                        }
                    }
                }
            } catch (err) { console.warn('Root withdrawal update warning:', err); }
            setTimeout(() => renderDashboard(), 500);
        } else {
            showToast('❌ Failed to approve withdrawal: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Approve error:', error);
        showToast('❌ Error: ' + error.message, 'error');
    }
};

// ============================================================
// 🔥 REJECT WITHDRAWAL
// ============================================================
window.rejectWithdrawal = async function(uid, withdrawalId) {
    const remark = prompt('❌ Reason for rejection (optional):');
    if (remark === null) return;
    
    try {
        const result = await updateWithdrawalStatusAtomic(uid, withdrawalId, 'rejected', remark);
        if (result.success) {
            showToast('❌ Withdrawal rejected!', 'success');
            try {
                const rootSnap = await get(ref(db, 'withdrawals'));
                if (rootSnap.exists()) {
                    const rootData = rootSnap.val();
                    for (let key in rootData) {
                        if (rootData[key].withdrawalId === withdrawalId) {
                            await update(ref(db, 'withdrawals/' + key), { status: 'rejected', rejectedAt: Date.now(), rejectReason: remark });
                            break;
                        }
                    }
                }
            } catch (err) { console.warn('Root withdrawal update warning:', err); }
            setTimeout(() => renderDashboard(), 500);
        } else {
            showToast('❌ Failed to reject withdrawal: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Reject error:', error);
        showToast('❌ Error: ' + error.message, 'error');
    }
};

// ============================================================
// 🔥 ADMIN ADJUSTMENT
// ============================================================
async function handleAdminAdjustment() {
    const uid = document.getElementById('adminUserSelect').value;
    const walletType = document.getElementById('adminWalletSelect').value;
    const type = document.getElementById('adminAdjustType').value;
    const amount = parseFloat(document.getElementById('adminAdjustAmount').value);
    const description = document.getElementById('adminAdjustDesc').value || `${type === 'credit' ? 'Admin Credit' : 'Admin Debit'} to ${walletType}`;
    
    if (!amount || amount <= 0) {
        showToast('❌ Please enter a valid amount!', 'error');
        return;
    }
    if (!uid) {
        showToast('❌ Please select a user!', 'error');
        return;
    }
    if (!confirm(`⚠️ Are you sure you want to ${type === 'credit' ? 'CREDIT' : 'DEBIT'} ${amount} USDT to/from ${walletType}?`)) {
        return;
    }
    
    const btn = document.querySelector('#adminAdjustForm button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';
    
    try {
        const result = await processAdminAdjustment(uid, walletType, amount, type, description);
        if (result.success) {
            showToast(`✅ ${type === 'credit' ? 'Credited' : 'Debited'} ${amount} USDT successfully!`, 'success');
            document.getElementById('adminAdjustAmount').value = '';
            document.getElementById('adminAdjustDesc').value = '';
            setTimeout(() => renderDashboard(), 500);
        } else {
            showToast('❌ Failed: ' + (result.error || 'Insufficient balance or error'), 'error');
        }
    } catch (error) {
        console.error('Admin adjustment error:', error);
        showToast('❌ Error: ' + error.message, 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = originalText;
}

// ============================================================
// 🔥 SAVE SETTINGS
// ============================================================
async function saveSettings() {
    const rateInput = document.getElementById('rndRate');
    if (!rateInput) {
        showToast('❌ Settings form not found!', 'error');
        return;
    }
    
    const rate = parseFloat(rateInput.value);
    if (!rate || rate <= 0) {
        showToast('❌ Please enter a valid rate.', 'error');
        return;
    }
    
    const btn = document.getElementById('saveSettingsBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving...';
    }
    
    try {
        await set(ref(db, 'settings/rate'), rate);
        const display = document.getElementById('currentRateDisplay');
        if (display) display.textContent = rate;
        showToast('✅ RND rate updated to $' + rate, 'success');
    } catch (error) {
        showToast('❌ Error: ' + error.message, 'error');
    }
    
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-save me-2"></i>Update Rate';
    }
}