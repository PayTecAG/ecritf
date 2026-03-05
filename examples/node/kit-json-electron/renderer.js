// KIT JSON Tester - Renderer Process
// Handles UI interaction and terminal communication

let connected = false;
let activated = false;
let terminalId = null;
let lastTrxSeqCnt = null;
let pendingTransaction = false;
let awaitingConfirmation = false;
let messageCount = 0;
let autoActivating = false;
let statusPollTimer = null;
let pendingTransaction_noAutoConfirm = false;
let lastTrmStatus = 0;
let lastReceiptRequest = null;
let pendingReceiptEntry = null;
let pendingApprovedTrxResponse = null;
let pendingConfirmationRequest = null;

// TrmStatus bit definitions
const TRM_STATUS_BITS = [
  { mask: 0x01,  label: 'Shift',   color: 'green' },
  { mask: 0x02,  label: 'Card',    color: 'blue' },
  { mask: 0x04,  label: 'Busy',    color: 'orange' },
  { mask: 0x08,  label: 'Reader',  color: 'blue' },
  { mask: 0x10,  label: 'Locked',  color: 'red' },
  { mask: 0x20,  label: 'AppSel',  color: 'blue' },
  { mask: 0x40,  label: 'WaitTrx', color: 'yellow' },
  { mask: 0x80,  label: 'WaitApp', color: 'yellow' },
  { mask: 0x100, label: 'Online',  color: 'orange' },
  { mask: 0x200, label: 'NoPrn',   color: 'red' },
  { mask: 0x400, label: 'NoPaper', color: 'red' },
];

// DOM elements
const statusDot = document.getElementById('statusDot');
const connectBtn = document.getElementById('connectBtn');
const hostInput = document.getElementById('hostInput');
const portInput = document.getElementById('portInput');
const posidInput = document.getElementById('posidInput');
const printerWidthInput = document.getElementById('printerWidthInput');
const messagesContent = document.getElementById('messagesContent');
const receiptContent = document.getElementById('receiptContent');

// Load saved settings
const savedHost = localStorage.getItem('kit-json-tester-host');
const savedPort = localStorage.getItem('kit-json-tester-port');
const savedPosid = localStorage.getItem('kit-json-tester-posid');
const savedPrinterWidth = localStorage.getItem('kit-json-tester-printerwidth');
if (savedHost) hostInput.value = savedHost;
if (savedPort) portInput.value = savedPort;
if (savedPosid) posidInput.value = savedPosid;
if (savedPrinterWidth) printerWidthInput.value = savedPrinterWidth;

// Adjust receipt panel width based on printer width setting
function updateReceiptWidth() {
  const pw = parseInt(printerWidthInput.value, 10) || 40;
  const clamped = Math.max(20, Math.min(80, pw));
  // Set width on receipt-content (which uses Courier New monospace) so ch unit is accurate
  const content = document.getElementById('receiptContent');
  if (content) {
    content.style.width = `calc(${clamped}ch + 50px)`;  // 15px padding each side + scrollbar
  }
}
printerWidthInput.addEventListener('input', updateReceiptWidth);
updateReceiptWidth();

function formatAmountInput(input) {
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const number = Number(text);
  if (!Number.isFinite(number)) return;
  input.value = number.toFixed(2);
}

function bindAmountFormatter(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('change', () => formatAmountInput(input));
  input.addEventListener('blur', () => formatAmountInput(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      requestAnimationFrame(() => formatAmountInput(input));
    }
  });
  input.addEventListener('wheel', () => {
    requestAnimationFrame(() => formatAmountInput(input));
  });
}

bindAmountFormatter('amountInput');
bindAmountFormatter('cashbackInput');
bindAmountFormatter('confirmAmountInput');

// Status display elements
const trmIdDisplay = document.getElementById('trmId');
const trmStatusDisplay = document.getElementById('trmStatus');
const trmStatusBitsContainer = document.getElementById('trmStatusBits');
const heartbeatIndicator = document.getElementById('heartbeat');

// Buttons
const allButtons = {
  activate: document.getElementById('activateBtn'),
  trx: document.getElementById('trxBtn'),
  status: document.getElementById('statusBtn'),
  balance: document.getElementById('balanceBtn'),
  report: document.getElementById('reportBtn'),
  receipt: document.getElementById('receiptBtn'),
  config: document.getElementById('configBtn'),
  init: document.getElementById('initBtn'),
  confirm: document.getElementById('confirmBtn'),
  rollback: document.getElementById('rollbackBtn')
};

// Transaction function metadata: which inputs each function needs
const TRX_INPUTS = {
  32768:    { amount: true },                                        // Purchase
  2048:     { amount: true },                                        // Credit
  32:       { },                                                     // Reversal
  16:       { amount: true },                                        // Reservation
  8:        { amount: true, ref: true },                              // Reservation Adjustment
  33554432: { ref: true },                                           // Cancel Reservation
  16384:    { amount: true, ref: true },                              // Purchase Reservation
  128:      { amount: true, noAutoConfirm: true },                   // Authorization Purchase
  1:        { amount: true, cashback: true },                        // Purchase with Cashback
  64:       { amount: true },                                        // Purchase Mail Ordered
  256:      { amount: true },                                        // Purchase Phone Ordered
  512:      { amount: true },                                        // Purchase Forced Acceptance
  1024:     { amount: true, authCode: true },                        // Purchase Phone Authorized
  4:        { amount: true, ref: true },                              // Confirm Phone Auth Reservation
  16777216: { amount: true },                                        // Load
  131072:   { },                                                     // Balance Inquiry
  8388608:  { },                                                     // Activate Card
  67108864: { }                                                      // Account Verification
};

const TRX_FUNCTIONS_WITHOUT_ORDER_ID = new Set([32, 33554432]);

function onTrxFunctionChange() {
  const fn = parseInt(document.getElementById('trxFunctionSelect').value);
  const meta = TRX_INPUTS[fn] || {};
  document.getElementById('trxCurrGroup').style.display = (meta.amount || meta.cashback) ? '' : 'none';
  document.getElementById('trxAmountGroup').style.display = meta.amount ? '' : 'none';
  document.getElementById('trxCashbackGroup').style.display = meta.cashback ? '' : 'none';
  document.getElementById('trxAuthCodeGroup').style.display = meta.authCode ? '' : 'none';
  document.getElementById('trxOrderIdGroup').style.display = TRX_FUNCTIONS_WITHOUT_ORDER_ID.has(fn) ? 'none' : '';
  document.getElementById('trxRefGroup').style.display = meta.ref ? '' : 'none';
  document.getElementById('trxAcqGroup').style.display = meta.ref ? '' : 'none';
}
// Initialize visibility
onTrxFunctionChange();

function updateUI() {
  statusDot.classList.toggle('connected', connected);
  connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
  hostInput.disabled = connected;
  portInput.disabled = connected;
  posidInput.disabled = connected;
  printerWidthInput.disabled = connected;
  
  // Activate/Deactivate toggle button
  allButtons.activate.disabled = !connected;
  if (activated) {
    allButtons.activate.innerHTML = '<span class="icon">\u23f9</span> Deactivate';
    allButtons.activate.className = '';
    allButtons.activate.onclick = sendDeactivation;
  } else {
    allButtons.activate.innerHTML = '<span class="icon">\u25b6</span> Activate';
    allButtons.activate.className = 'success';
    allButtons.activate.onclick = sendActivation;
  }
  
  // Transaction / Abort toggle button
  allButtons.trx.disabled = !connected || !activated;
  if (pendingTransaction) {
    allButtons.trx.innerHTML = '<span class="icon">\u2298</span> Abort';
    allButtons.trx.className = '';
    allButtons.trx.onclick = abortTransaction;
  } else {
    allButtons.trx.innerHTML = '<span class="icon">\ud83d\udcb3</span> Transaction';
    allButtons.trx.className = 'success';
    allButtons.trx.onclick = sendTransaction;
  }
  document.getElementById('trxFunctionSelect').disabled = !connected || !activated || pendingTransaction;

  allButtons.status.disabled = !connected;
  allButtons.balance.disabled = !connected || !activated;
  allButtons.report.disabled = !connected;
  allButtons.receipt.disabled = !connected;
  document.getElementById('reportTypeSelect').disabled = !connected;
  document.getElementById('receiptTypeSelect').disabled = !connected;
  onReceiptTypeChange();
  allButtons.config.disabled = !connected;
  allButtons.init.disabled = !connected;
  document.getElementById('batchCaptureBtn').disabled = !connected || !activated;
  document.getElementById('batchCaptureSelect').disabled = !connected || !activated;
  allButtons.confirm.disabled = !connected || !awaitingConfirmation;
  allButtons.rollback.disabled = !connected || !awaitingConfirmation;
  document.getElementById('sendJsonBtn').disabled = !connected;
  
  // Show/hide manual confirm buttons based on autoConfirm checkbox
  const autoConfirm = document.getElementById('autoConfirmCheck').checked;
  const manualAmountRow = document.getElementById('manualConfirmAmountRow');
  const manualRow = document.getElementById('manualConfirmRow');
  const confirmAmountInput = document.getElementById('confirmAmountInput');
  manualAmountRow.style.display = autoConfirm ? 'none' : 'block';
  manualRow.style.display = autoConfirm ? 'none' : 'flex';
  confirmAmountInput.disabled = !connected || !awaitingConfirmation || autoConfirm;
  
  trmIdDisplay.textContent = terminalId || '-';
  trmStatusDisplay.textContent = connected ? (activated ? 'Ready' : 'Connected') : 'Disconnected';
  updateTrmStatusBits(lastTrmStatus);
  
  document.getElementById('messageCount').textContent = `${messageCount} messages`;
}

function addMessage(type, direction, content, valid = true) {
  messageCount++;
  const div = document.createElement('div');
  div.className = `message ${direction}`;
  
  const msgType = Object.keys(content)[0] || 'Unknown';
  const time = new Date().toLocaleTimeString();
  
  const jsonText = JSON.stringify(content, null, 2).replace(/\\n/g, '\n');
  div.innerHTML = `
    <div class="message-header">
      <span>${direction.toUpperCase()} \u2022 ${time}</span>
      <span>${valid ? '\u2713' : '\u2717'}<button class="copy-btn" title="Copy to clipboard">\u29c9</button></span>
    </div>
    <div class="message-type">${msgType}</div>
    <pre>${jsonText}</pre>
  `;
  div.querySelector('.copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(jsonText);
  });
  
  messagesContent.appendChild(div);
  messagesContent.scrollTop = messagesContent.scrollHeight;
  updateUI();
}

const TRX_RESULT_LABELS = { 0: 'Approved', 1: 'Declined', 2: 'Referred', 3: 'Aborted' };
const TRX_RESULT_CLASSES = { 0: 'approved', 1: 'declined', 2: 'referred', 3: 'aborted' };
const CURRENCY_SYMBOLS = { 756: 'CHF', 978: 'EUR', 840: 'USD' };

function formatAmount(cents, currC) {
  const sym = CURRENCY_SYMBOLS[currC] || currC || '';
  return `${sym} ${(cents / 100).toFixed(2)}`;
}

function showTransactionResult(resp) {
  const card = document.createElement('div');
  card.className = 'message trx-result-card';
  card.style.borderLeft = '3px solid #e94560';

  // Result badge
  const resultCode = resp.TrxResult;
  const badge = document.createElement('div');
  badge.className = `trx-result-badge ${TRX_RESULT_CLASSES[resultCode] || 'aborted'}`;
  badge.textContent = TRX_RESULT_LABELS[resultCode] || `Result ${resultCode}`;
  card.appendChild(badge);

  // Extended result
  if (resp.TrxResultExtended !== undefined) {
    const ext = document.createElement('span');
    ext.style.cssText = 'font-size:11px;color:#888;margin-left:8px';
    ext.textContent = `(${resp.TrxResultExtended})`;
    badge.appendChild(ext);
  }

  // Details grid
  const details = [];
  if (resp.Brand) details.push(['Brand', resp.Brand]);
  if (resp.AmtAuth !== undefined) details.push(['Amount, authorized', formatAmount(resp.AmtAuth, resp.TrxCurrC)]);
  if (resp.AmtOther) details.push(['Cashback', formatAmount(resp.AmtOther, resp.TrxCurrC)]);
  if (resp.TrxAmt !== undefined) details.push(['Transaction Amount', formatAmount(resp.TrxAmt, resp.TrxCurrC)]);
  if (resp.TipAmt) details.push(['Tip', formatAmount(resp.TipAmt, resp.TrxCurrC)]);
  if (resp.AuthC) details.push(['Auth Code', resp.AuthC]);
  if (resp.ARC) details.push(['Authorization Response Code', resp.ARC]);
  if (resp.AppPANPrtAttendant) details.push(['PAN (attendant)', resp.AppPANPrtAttendant]);
  if (resp.AppPANPrtCardholder) details.push(['PAN (cardholder)', resp.AppPANPrtCardholder]);
  if (resp.TrxSeqCnt !== undefined) details.push(['Transaction Sequence Counter', resp.TrxSeqCnt]);
  if (resp.TrxRefNum) details.push(['Transaction Reference Number', resp.TrxRefNum]);
  // Pretty-print Transaction Date and Time
  if (resp.TrxDate) {
    const prettyDate = formatTrxDate(resp.TrxDate);
    details.push(['Transaction Date', prettyDate]);
  }
  if (resp.TrxTime) {
    const prettyTime = formatTrxTime(resp.TrxTime);
    details.push(['Transaction Time', prettyTime]);
  }
  // Helper to pretty-print transaction date (expects YYMMDD or YYYYMMDD)
  function formatTrxDate(dateStr) {
    if (!dateStr) return '';
    // Try YYYYMMDD first
    if (dateStr.length === 8) {
      const yyyy = dateStr.slice(0, 4);
      const mm = dateStr.slice(4, 6);
      const dd = dateStr.slice(6, 8);
      return `${yyyy}-${mm}-${dd}`;
    }
    // Fallback to YYMMDD
    if (dateStr.length === 6) {
      const yy = dateStr.slice(0, 2);
      const mm = dateStr.slice(2, 4);
      const dd = dateStr.slice(4, 6);
      return `20${yy}-${mm}-${dd}`;
    }
    return dateStr;
  }

  // Helper to pretty-print transaction time (expects HHMMSS)
  function formatTrxTime(timeStr) {
    if (!timeStr || timeStr.length !== 6) return timeStr || '';
    const hh = timeStr.slice(0, 2);
    const mm = timeStr.slice(2, 4);
    const ss = timeStr.slice(4, 6);
    return `${hh}:${mm}:${ss}`;
  }
  if (resp.AcqID !== undefined) details.push(['Acquirer ID', resp.AcqID]);
  if (resp.POSEntryMode !== undefined) details.push(['POS Entry Mode', resp.POSEntryMode]);

  if (details.length > 0) {
    const grid = document.createElement('div');
    grid.style.marginTop = '8px';
    for (const [label, value] of details) {
      const row = document.createElement('div');
      row.className = 'trx-detail-row';
      row.innerHTML = `<span class="trx-detail-label">${label}</span><span class="trx-detail-value">${value}</span>`;
      grid.appendChild(row);
    }
    card.appendChild(grid);
  }

  // Attendant text
  if (resp.AttendantText) {
    const block = document.createElement('div');
    block.className = 'trx-text-block attendant';
    block.innerHTML = `<div class="trx-text-label">Attendant</div>${escapeHtml(resp.AttendantText)}`;
    card.appendChild(block);
  }

  // Cardholder text
  if (resp.CardholderText) {
    const block = document.createElement('div');
    block.className = 'trx-text-block cardholder';
    block.innerHTML = `<div class="trx-text-label">Cardholder</div>${escapeHtml(resp.CardholderText)}`;
    card.appendChild(block);
  }

  // Timestamp
  const ts = document.createElement('div');
  ts.style.cssText = 'font-size:9px;color:#555;margin-top:8px;text-align:right';
  ts.textContent = new Date().toLocaleTimeString();
  card.appendChild(ts);

  messagesContent.appendChild(card);
  messagesContent.scrollTop = messagesContent.scrollHeight;
}

function updateNextTask(task) {
  const section = document.getElementById('nextTaskSection');
  const divider = document.getElementById('nextTaskDivider');
  const nameEl = document.getElementById('nextTaskName');
  const timeEl = document.getElementById('nextTaskTime');
  if (!task) {
    section.style.display = 'none';
    divider.style.display = 'none';
    return;
  }
  section.style.display = '';
  divider.style.display = '';
  let nameText = task.TaskName || '-';
  if (task.AcqID !== undefined) nameText += ` (AcqID ${task.AcqID})`;
  nameEl.textContent = nameText;
  // Format the NextRun datetime
  if (task.NextRun) {
    // NextRun is "yyyy-MM-dd HH:mm:ss"
    const parts = task.NextRun.split(' ');
    const datePart = parts[0] || '';
    const timePart = parts[1] || '';
    // Show relative time hint
    try {
      const runDate = new Date(datePart + 'T' + timePart);
      const now = new Date();
      const diffMs = runDate - now;
      let relative = '';
      if (diffMs > 0) {
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 60) relative = `in ${diffMin}m`;
        else if (diffMin < 1440) relative = `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;
        else relative = `in ${Math.floor(diffMin / 1440)}d`;
      } else {
        relative = 'overdue';
      }
      timeEl.textContent = `${task.NextRun} (${relative})`;
    } catch {
      timeEl.textContent = task.NextRun;
    }
  } else {
    timeEl.textContent = '-';
  }
}

function updateTrmStatusBits(status) {
  trmStatusBitsContainer.innerHTML = TRM_STATUS_BITS.map(bit => {
    const active = (status & bit.mask) !== 0;
    return `<span class="status-bit${active ? ' active ' + bit.color : ''}" title="0x${bit.mask.toString(16).toUpperCase()}">${bit.label}</span>`;
  }).join('');
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showReceipt(text) {
  const entry = document.createElement('div');
  entry.style.cssText = 'margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed #ccc';
  
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
  const time = document.createElement('span');
  time.style.cssText = 'font-size:9px;color:#888';
  time.textContent = new Date().toLocaleTimeString();
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy to clipboard';
  copyBtn.textContent = '\u29c9';
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(text));
  header.appendChild(time);
  header.appendChild(copyBtn);
  entry.appendChild(header);
  
  const pre = document.createElement('pre');
  pre.textContent = text;
  entry.appendChild(pre);
  
  receiptContent.insertBefore(entry, receiptContent.firstChild);
  
  // Keep only the last 5 receipts
  while (receiptContent.children.length > 5) {
    receiptContent.removeChild(receiptContent.lastChild);
  }
}

// Connection handling
async function toggleConnection() {
  if (connected) {
    await window.terminal.disconnect();
    connected = false;
    activated = false;
    terminalId = null;
    pendingTransaction = false;
    addMessage('info', 'info', { Info: 'Disconnected' });
  } else {
    try {
      const host = hostInput.value || '127.0.0.1';
      const port = portInput.value || '8307';
      await window.terminal.connect(host, port);
      connected = true;
      
      // Save settings for next time
      localStorage.setItem('kit-json-tester-host', host);
      localStorage.setItem('kit-json-tester-port', port);
      localStorage.setItem('kit-json-tester-posid', posidInput.value.trim());
      localStorage.setItem('kit-json-tester-printerwidth', printerWidthInput.value);
      
      addMessage('info', 'info', { Info: `Connected to ${host}:${port}` });
      
      // Auto-send connect request
      await sendConnect();
    } catch (err) {
      addMessage('error', 'error', { Error: err.message });
    }
  }
  updateUI();
}

// Message sending functions
async function sendMessage(msg) {
  try {
    await window.terminal.send(msg);
  } catch (err) {
    addMessage('error', 'error', { Error: err.message });
  }
}

async function sendConnect() {
  const pw = parseInt(printerWidthInput.value, 10);
  const req = {
    TrmLng: 'de',
    PrinterWidth: (pw >= 20 && pw <= 80) ? pw : 40,
    UnsolicitedReceipts: 1
  };
  const posid = posidInput.value.trim();
  if (posid) req.POSID = posid;
  await sendMessage({ ConnectRequest: req });
}

function toggleActivation() {
  if (activated) sendDeactivation();
  else sendActivation();
}

async function sendActivation() {
  await sendMessage({
    ActivationRequest: {}
  });
}

async function sendDeactivation() {
  await sendMessage({
    DeactivationRequest: {}
  });
}

function trxButtonClick() {
  if (pendingTransaction) abortTransaction();
  else sendTransaction();
}

async function sendTransaction() {
  const fn = parseInt(document.getElementById('trxFunctionSelect').value);
  const meta = TRX_INPUTS[fn] || {};
  const req = { TrxFunction: fn };

  if (meta.amount || meta.cashback) {
    req.TrxCurrC = parseInt(document.getElementById('currencySelect').value);
  }
  if (meta.amount) {
    let amt = Math.round(parseFloat(document.getElementById('amountInput').value) * 100);
    if (meta.cashback) {
      const cb = Math.round(parseFloat(document.getElementById('cashbackInput').value) * 100);
      req.AmtOther = cb;
      amt += cb;  // AmtAuth = purchase amount + cashback
    }
    req.AmtAuth = amt;
  }
  if (meta.authCode) {
    const ac = document.getElementById('authCodeInput').value.trim();
    if (ac) req.AuthC = ac;
  }
  const orderId = document.getElementById('orderIdInput').value.trim();
  if (orderId && !TRX_FUNCTIONS_WITHOUT_ORDER_ID.has(fn)) {
    req.RecOrderRef = { OrderID: orderId };
  }
  if (meta.ref) {
    const r = document.getElementById('trxRefInput').value.trim();
    if (r) req.TrxRefNum = r;
    const a = document.getElementById('acqIdInput').value.trim();
    if (a) req.AcqID = parseInt(a);
  }
  // For Reversal, attach last TrxSeqCnt if available
  if (fn === 32 && lastTrxSeqCnt) {
    req.TrxSeqCntOri = lastTrxSeqCnt;
  }

  pendingTransaction = true;
  // Store noAutoConfirm flag for this transaction
  pendingTransaction_noAutoConfirm = !!meta.noAutoConfirm;
  updateUI();
  await sendMessage({ TransactionRequest: req });
}

async function confirmTransaction(confirm, manual = false) {
  const req = {
    Confirm: confirm ? 1 : 0
  };

  if (confirm && manual) {
    const trxAmtText = document.getElementById('confirmAmountInput').value.trim();
    if (trxAmtText) {
      const trxAmt = Math.round(parseFloat(trxAmtText) * 100);
      if (!Number.isFinite(trxAmt) || trxAmt < 0) {
        addMessage('error', 'error', { Error: 'Invalid final amount (TrxAmt)' });
        return;
      }
      req.TrxAmt = trxAmt;
    }
  }

  pendingConfirmationRequest = {
    confirm: !!confirm,
    trxAmt: req.TrxAmt
  };

  await sendMessage({
    TransactionConfirmationRequest: req
  });
  pendingTransaction = false;
  updateUI();
}

async function abortTransaction() {
  await sendMessage({
    AbortTransactionRequest: {}
  });
  pendingTransaction = false;
  updateUI();
}

async function sendStatus() {
  await sendMessage({
    StatusRequest: {}
  });
}

async function sendBalanceRequest() {
  await sendMessage({
    BalanceRequest: {}
  });
}

async function sendReport() {
  const reportType = parseInt(document.getElementById('reportTypeSelect').value);
  await sendMessage({
    ReportRequest: {
      ReportType: reportType
    }
  });
}

function onReceiptTypeChange() {
  const rt = parseInt(document.getElementById('receiptTypeSelect').value);
  const idInput = document.getElementById('receiptIdInput');
  const isTrx = (rt === 1 || rt === 2);
  idInput.disabled = !connected || !isTrx;
  idInput.placeholder = ' ';
  if (!isTrx) idInput.value = '';
}

async function sendReceiptRequest() {
  const receiptType = parseInt(document.getElementById('receiptTypeSelect').value);
  const req = { ReceiptType: receiptType };
  const idVal = document.getElementById('receiptIdInput').value.trim();
  if (idVal && (receiptType === 1 || receiptType === 2)) {
    req.ReceiptIDNumeric = parseInt(idVal);
  }
  lastReceiptRequest = req;
  await sendMessage({ ReceiptRequest: req });
}

async function sendConfiguration() {
  await sendMessage({
    ConfigurationRequest: {}
  });
}

async function sendBatchCapture() {
  const flags = parseInt(document.getElementById('batchCaptureSelect').value);
  const req = {};
  req.BatchCaptureFlags = flags | 0x01;
  await sendMessage({ BatchCaptureRequest: req });
}

async function sendInitialization() {
  const req = {};
  const acqId = document.getElementById('initAcqIdInput').value.trim();
  if (acqId) req.AcqID = parseInt(acqId);
  await sendMessage({
    InitializationRequest: req
  });
}

// Response handling
async function handleResponse(data) {
  const { message, valid, errors } = data;
  if (message.TransactionConfirmationResponse && pendingApprovedTrxResponse) {
    const confirmationResp = message.TransactionConfirmationResponse;
    const deferredMessage = JSON.parse(JSON.stringify(pendingApprovedTrxResponse.message));
    const wasConfirmed = !pendingConfirmationRequest || pendingConfirmationRequest.confirm;
    if (wasConfirmed) {
      if (pendingConfirmationRequest.trxAmt !== undefined) {
        deferredMessage.TransactionResponse.TrxAmt = pendingConfirmationRequest.trxAmt;
      }
    } else {
      deferredMessage.TransactionResponse.TrxResult = 3;
      delete deferredMessage.TransactionResponse.TrxResultExtended;
      if (Object.prototype.hasOwnProperty.call(confirmationResp, 'CardholderText')) {
        deferredMessage.TransactionResponse.CardholderText = confirmationResp.CardholderText;
      } else {
        delete deferredMessage.TransactionResponse.CardholderText;
      }
      if (Object.prototype.hasOwnProperty.call(confirmationResp, 'AttendantText')) {
        deferredMessage.TransactionResponse.AttendantText = confirmationResp.AttendantText;
      } else {
        delete deferredMessage.TransactionResponse.AttendantText;
      }
    }
    showTransactionResult(deferredMessage.TransactionResponse);
    pendingApprovedTrxResponse = null;
  }

  const trxResp = message.TransactionResponse;
  const deferApprovedTrxResponse = !!(trxResp && trxResp.TrxResult === 0);
  if (deferApprovedTrxResponse) {
    pendingApprovedTrxResponse = {
      message: JSON.parse(JSON.stringify(message)),
      valid
    };
  }
  addMessage('response', 'rx', message, valid);
  
  // Process specific responses
  if (message.ConnectResponse) {
    terminalId = message.ConnectResponse.TrmID;
    // After connect, request status to check if shift is open
    sendStatus();
  }
  
  if (message.StatusResponse) {
    const status = message.StatusResponse.TrmStatus;
    lastTrmStatus = status;
    const shiftOpen = (status & 0x01) !== 0;
    const busy = (status & 0x04) !== 0;
    updateNextTask(message.StatusResponse.NextScheduledTask);
    
    if (autoActivating) {
      if (busy) {
        // Terminal is busy, retry after a short delay
        addMessage('info', 'info', { Info: 'Terminal busy, waiting...' });
        statusPollTimer = setTimeout(() => sendStatus(), 2000);
      } else {
        // Not busy, proceed with activation
        autoActivating = false;
        sendActivation();
      }
    } else if (!activated && shiftOpen) {
      // Shift is already open, auto-activate
      autoActivating = true;
      if (busy) {
        addMessage('info', 'info', { Info: 'Shift open, waiting for terminal to be ready...' });
        statusPollTimer = setTimeout(() => sendStatus(), 2000);
      } else {
        autoActivating = false;
        sendActivation();
      }
    }
  }
  
  if (message.ActivationResponse) {
    activated = true;
    autoActivating = false;
    terminalId = message.ActivationResponse.TrmID;
  }
  
  if (message.DeactivationResponse) {
    activated = false;
  }
  
  if (message.TransactionResponse) {
    const resp = message.TransactionResponse;
    if (resp.TrxResult === 0) {
      // Approved - needs confirmation
      lastTrxSeqCnt = resp.TrxSeqCnt;
      pendingTransaction = true;
      awaitingConfirmation = true;
      
      // Pre-fill reference fields from response for follow-up transactions
      if (resp.TrxRefNum) document.getElementById('trxRefInput').value = resp.TrxRefNum;
      if (resp.AcqID) document.getElementById('acqIdInput').value = resp.AcqID;
      const approvedAmount = (resp.TrxAmt !== undefined) ? resp.TrxAmt : resp.AmtAuth;
      document.getElementById('confirmAmountInput').value = (approvedAmount !== undefined)
        ? (approvedAmount / 100).toFixed(2)
        : '';
      
      // Auto-confirm if enabled (but not for Authorization Purchase etc.)
      if (document.getElementById('autoConfirmCheck').checked && !pendingTransaction_noAutoConfirm) {
        confirmTransaction(true);
      }
    } else {
      showTransactionResult(resp);
      // Declined/Aborted
      pendingTransaction = false;
      awaitingConfirmation = false;
      document.getElementById('confirmAmountInput').value = '';
      pendingApprovedTrxResponse = null;
    }
  }
  
  if (message.TransactionConfirmationResponse) {
    pendingTransaction = false;
    awaitingConfirmation = false;
    document.getElementById('confirmAmountInput').value = '';
    pendingConfirmationRequest = null;
  }
  
  if (message.AbortTransactionResponse) {
    pendingTransaction = false;
    awaitingConfirmation = false;
    document.getElementById('confirmAmountInput').value = '';
    pendingApprovedTrxResponse = null;
    pendingConfirmationRequest = null;
  }
  
  if (message.ReceiptResponse) {
    const receipt = message.ReceiptResponse.ReceiptText || '';
    const moreData = (message.ReceiptResponse.ReceiptFlags & 0x01) !== 0;
    if (pendingReceiptEntry) {
      // Append to existing receipt entry
      const pre = pendingReceiptEntry.querySelector('pre');
      pre.textContent += receipt;
    } else {
      showReceipt(receipt);
      // Keep reference to the just-created entry (first child) for appending
      if (moreData) {
        pendingReceiptEntry = receiptContent.firstChild;
      }
    }
    // If more data available, repeat the request; otherwise clear continuation
    if (moreData && lastReceiptRequest) {
      await sendMessage({ ReceiptRequest: lastReceiptRequest });
    } else {
      pendingReceiptEntry = null;
    }
  }
  
  if (message.ErrorNotification) {
    const err = message.ErrorNotification;
    addMessage('error', 'error', { Error: `${err.ErrorSource}: ${err.ErrorDescription}` });
  }
  
  updateUI();
}

function handleSent(data) {
  const { message, valid } = data;
  addMessage('request', 'tx', message, valid);
}

function handleHeartbeat() {
  heartbeatIndicator.classList.add('pulse');
  setTimeout(() => heartbeatIndicator.classList.remove('pulse'), 500);
}

function handleDisconnected() {
  connected = false;
  activated = false;
  autoActivating = false;
  awaitingConfirmation = false;
  lastTrmStatus = 0;
  updateNextTask(null);
  if (statusPollTimer) {
    clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
  terminalId = null;
  pendingTransaction = false;
  pendingApprovedTrxResponse = null;
  pendingConfirmationRequest = null;
  document.getElementById('confirmAmountInput').value = '';
  addMessage('info', 'info', { Info: 'Connection closed by terminal' });
  updateUI();
}

function handleError(msg) {
  addMessage('error', 'error', { Error: msg });
}

// Set up event listeners
window.terminal.onReceived(handleResponse);
window.terminal.onSent(handleSent);
window.terminal.onDisconnected(handleDisconnected);
window.terminal.onError(handleError);
window.terminal.onHeartbeat(handleHeartbeat);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Enter on host/port input connects
  if (e.key === 'Enter' && (e.target === hostInput || e.target === portInput || e.target === posidInput || e.target === printerWidthInput)) {
    if (!connected) {
      toggleConnection();
    }
    return;
  }
  
  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case 'Enter':
        if (connected && activated && !pendingTransaction) {
          sendTransaction();
        }
        break;
      case 'Backspace':
        if (pendingTransaction) {
          abortTransaction();
        }
        break;
    }
  }
});

// Send JSON dialog
function openSendJsonDialog() {
  const overlay = document.getElementById('sendJsonOverlay');
  overlay.style.display = 'flex';
  document.getElementById('sendJsonError').textContent = '';
  const textarea = document.getElementById('sendJsonTextarea');
  textarea.focus();
}

function closeSendJsonDialog() {
  document.getElementById('sendJsonOverlay').style.display = 'none';
}

async function submitSendJsonDialog() {
  const textarea = document.getElementById('sendJsonTextarea');
  const errorEl = document.getElementById('sendJsonError');
  const raw = textarea.value.trim();
  if (!raw) {
    errorEl.textContent = 'Please enter JSON';
    return;
  }
  try {
    const json = JSON.parse(raw);
    await sendMessage(json);
    closeSendJsonDialog();
  } catch (err) {
    errorEl.textContent = `Invalid JSON: ${err.message}`;
  }
}

// Close dialog on Escape, send on Ctrl+Enter
document.getElementById('sendJsonOverlay').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSendJsonDialog();
  if (e.key === 'Enter' && e.ctrlKey) submitSendJsonDialog();
});

function clearMessages() {
  messagesContent.innerHTML = '';
  messageCount = 0;
  updateUI();
}

// Initial UI state
updateUI();
