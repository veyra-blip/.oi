(function(){
'use strict';
const $=id=>document.getElementById(id);
const moneySafe=n=>typeof money==='function'?money(Number(n)||0):'₦'+(Number(n)||0).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const escSafe=s=>typeof esc==='function'?esc(String(s??'')):String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uidSafe=()=>window.crypto?.randomUUID?crypto.randomUUID():'veyra-'+Date.now()+'-'+Math.random().toString(16).slice(2);
const userKey=()=>String(window.current?.()?.id||window.current?.()?.userId||'anonymous');
const savedKey=()=>`veyra_saved_recipients_${userKey()}`;
const readSaved=()=>{try{const x=JSON.parse(localStorage.getItem(savedKey())||'[]');return Array.isArray(x)?x:[]}catch{return[]}};
const writeSaved=x=>localStorage.setItem(savedKey(),JSON.stringify(x.slice(0,30)));
const statusOf=d=>String(d?.status||d?.transaction?.status||d?.data?.status||'PENDING').toUpperCase();
const statusText=s=>s==='SUCCESS'?'Transfer successful':s==='FAILED'?'Transfer failed':s==='REVERSED'?'Transfer reversed':'Transfer submitted';
const safeErr=e=>String(e?.message||'Something went wrong. Please try again.');
let recipient=null,bankRecipient=null,banks=[],selectedBank=null,lookupTimer=null,resolveTimer=null,lookupSeq=0,resolvedSeq=0,mode='veyra',draft=null;

const css=`
:root{--vxgold:#c9a96e}
.vx-wrap{color:#f4f2ec}.vx-head{display:flex;justify-content:space-between;margin-bottom:18px}
.vx-kicker{font-size:11px;letter-spacing:1.7px;color:var(--vxgold);font-weight:900}
.vx-title{font-size:25px;margin:5px 0;color:#fff}.vx-sub{color:#a8ada8;font-size:13px;margin:0}
.vx-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0}
.vx-tab{border:1px solid #454941;background:#222522;color:#c9c9c1;border-radius:13px;padding:13px;font-weight:800}
.vx-tab.active{background:var(--vxgold);color:#191916;border-color:var(--vxgold)}
.vx-card{background:#222522;border:1px solid #393d39;border-radius:19px;padding:17px;margin:12px 0}
.vx-field{margin:14px 0}.vx-field label{display:block;color:#d9d6cc;font-size:12px;font-weight:800;margin-bottom:7px}
.vx-field input,.vx-field select{width:100%;padding:14px;border-radius:12px;border:1px solid #454941;background:#171a18;color:#fff;outline:0}
.vx-field input:focus,.vx-field select:focus{border-color:var(--vxgold);box-shadow:0 0 0 3px #c9a96e22}
.vx-btn{width:100%;border:0;border-radius:13px;padding:14px;background:var(--vxgold);color:#191916;font-weight:900;margin-top:8px}
.vx-btn.secondary{background:#30342f;color:#e9dfc9;border:1px solid #565044}
.vx-note{padding:12px;border-radius:12px;background:#2a2d28;color:#c7c7bd;font-size:13px;margin:10px 0}
.vx-error{background:#392729;color:#ffc3c3}.vx-good{background:#303027;color:#ead8ad}
.vx-list{display:grid;gap:8px;margin:10px 0}
.vx-saved,.vx-bank{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;border:1px solid #41453f;background:#1b1e1b;border-radius:12px;color:#f2eee4;text-align:left;width:100%}
.vx-saved small,.vx-bank small{display:block;color:#a8ada8;margin-top:3px}
.vx-stepbar{display:flex;gap:6px;margin:12px 0 18px}.vx-stepbar span{height:4px;flex:1;background:#44483f;border-radius:9px}
.vx-stepbar span.on{background:var(--vxgold)}
.vx-summary{display:grid}.vx-sumrow{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #3c403a;font-size:13px}
.vx-sumrow span{color:#a8ada8}.vx-sumrow b{text-align:right;color:#f5f0e5;overflow-wrap:anywhere}
.vx-amount{font-size:30px;font-weight:950;color:#e3c98f;text-align:center;margin:16px 0}
.vx-result{text-align:center;padding:18px 5px}.vx-result-icon{width:62px;height:62px;border:1px solid var(--vxgold);border-radius:50%;display:grid;place-items:center;margin:0 auto 12px;color:#e4cf9e;font-size:28px}
.vx-muted{color:#a8ada8;font-size:12px}.vx-inline{display:flex;gap:8px}.vx-inline>*{flex:1;min-width:0}
`;
if(!document.getElementById('veyra-transfer-rebuild-css')){
 const st=document.createElement('style');st.id='veyra-transfer-rebuild-css';st.textContent=css;document.head.appendChild(st);
}
function shell(title,sub,m){
 return `<section class="page active vx-wrap" id="page-${m==='bank'?'bank':'send'}">
 <div class="vx-head"><div><div class="vx-kicker">VEYRA TRANSFERS</div><h1 class="vx-title">${title}</h1><p class="vx-sub">${sub}</p></div></div>
 <div class="vx-tabs"><button class="vx-tab ${m==='veyra'?'active':''}" onclick="go('send')">To Veyra</button><button class="vx-tab ${m==='bank'?'active':''}" onclick="go('bank')">To Bank</button></div>
 <div class="vx-card" id="vx-transfer-root"></div></section>`;
}
window.sendHtml=()=>shell('Send to Veyra','Transfer to another Veyra account securely.','veyra');
window.vBankPage=()=>shell('Send to Bank','Transfer to a verified Nigerian bank account.','bank');
function steps(n){return `<div class="vx-stepbar">${[1,2,3,4].map(i=>`<span class="${i<=n?'on':''}"></span>`).join('')}</div>`}
function root(html){const r=$('vx-transfer-root');if(r)r.innerHTML=html}
function nameOf(r){return [r?.firstName,r?.lastName].filter(Boolean).join(' ')||r?.accountName||r?.username||'Veyra recipient'}
function savedHtml(){
 const a=readSaved();
 return a.length?`<div class="vx-field"><label>Saved recipients</label><div class="vx-list">${a.map((r,i)=>`<button class="vx-saved" onclick="window.__vxUseSaved(${i})"><span><b>${escSafe(r.label||r.name||'Saved recipient')}</b><small>${escSafe(r.accountNumber||r.username||'')}</small></span><span>›</span></button>`).join('')}</div></div>`:'<div class="vx-note">Your saved recipients will appear here.</div>';
}
window.__vxUseSaved=i=>{const r=readSaved()[Number(i)];if(r){const el=$('vxRecipientQuery');if(el){el.value=r.accountNumber||r.username||'';lookupVeyra(el.value)}}};
function startVeyra(){
 mode='veyra';recipient=null;draft=null;
 root(`${steps(1)}${savedHtml()}<div class="vx-field"><label>Account number or username</label><input id="vxRecipientQuery" autocomplete="off" placeholder="Enter Veyra account number or username" maxlength="40"></div><div id="vxRecipientResult"></div><div class="vx-note">Recipient details are checked against the Veyra account directory before you continue.</div>`);
 const el=$('vxRecipientQuery');el?.addEventListener('input',()=>{clearTimeout(lookupTimer);lookupTimer=setTimeout(()=>lookupVeyra(el.value.trim()),350)});
}
async function lookupVeyra(q){
 const out=$('vxRecipientResult');if(!out)return;const seq=++lookupSeq;recipient=null;
 if(q.length<3){out.innerHTML='';return}
 out.innerHTML='<div class="vx-note">Checking Veyra account…</div>';
 try{
  const d=await api('/api/users/lookup?q='+encodeURIComponent(q));
  if(seq!==lookupSeq||$('vxRecipientQuery')?.value.trim()!==q)return;
  const r=d?.recipient;if(!r?.id)throw new Error('No active Veyra account found.');
  if(String(r.id)===String(current()?.id))throw new Error('You cannot send money to your own account.');
  recipient=r;
  out.innerHTML=`<div class="vx-note vx-good"><b>${escSafe(nameOf(r))}</b><br>Account ${escSafe(r.accountNumber||'—')} · @${escSafe(r.username||'—')}</div>
  <div class="vx-field"><label>Save recipient as (optional)</label><input id="vxRecipientLabel" maxlength="24" placeholder="e.g. Mum, Supplier"></div>
  <div class="vx-inline"><button class="vx-btn secondary" onclick="window.__vxSaveRecipient()">Save recipient</button><button class="vx-btn" onclick="window.__vxContinueVeyra()">Continue</button></div>`;
 }catch(e){if(seq===lookupSeq)out.innerHTML=`<div class="vx-note vx-error">${escSafe(safeErr(e))}</div>`}
}
window.__vxSaveRecipient=()=>{
 if(!recipient)return;const r=recipient;
 const list=readSaved().filter(x=>String(x.id)!==String(r.id));
 list.unshift({id:r.id,accountNumber:r.accountNumber,username:r.username,name:nameOf(r),label:($('vxRecipientLabel')?.value||'').trim()||nameOf(r)});
 writeSaved(list);const out=$('vxRecipientResult');
 if(out){const n=document.createElement('div');n.className='vx-note vx-good';n.textContent='Recipient saved on this device.';out.appendChild(n)}
};
window.__vxContinueVeyra=()=>{
 if(!recipient)return;draft={type:'INTERNAL_TRANSFER',recipient};
 root(`${steps(2)}<div class="vx-note vx-good"><b>Recipient verified</b><br>${escSafe(nameOf(recipient))} · ${escSafe(recipient.accountNumber||'')}</div>
 <div class="vx-field"><label>Amount (NGN)</label><input id="vxAmount" type="number" min="1" max="50000000" step="0.01" inputmode="decimal" placeholder="₦0.00"></div>
 <div class="vx-field"><label>Narration</label><input id="vxNarration" maxlength="140" placeholder="What is this transfer for? (optional)"></div>
 <div class="vx-inline"><button class="vx-btn secondary" onclick="window.__vxStartOver()">Back</button><button class="vx-btn" onclick="window.__vxReview()">Review transfer</button></div>`);
};
function startBank(){
 mode='bank';bankRecipient=null;selectedBank=null;draft=null;
 root(`${steps(1)}<div class="vx-field"><label>Search Nigerian bank</label><input id="vxBankSearch" placeholder="Search bank name…" autocomplete="off"></div><div id="vxBankList"><div class="vx-note">Loading supported banks…</div></div>`);
 $('vxBankSearch')?.addEventListener('input',renderBankList);loadBanks();
}
async function loadBanks(){
 const out=$('vxBankList');
 try{const d=await api('/api/paystack/banks');banks=Array.isArray(d?.banks)?d.banks:[];renderBankList()}
 catch(e){if(out)out.innerHTML=`<div class="vx-note vx-error">${escSafe(safeErr(e))}</div>`}
}
function renderBankList(){
 const out=$('vxBankList');if(!out)return;const q=($('vxBankSearch')?.value||'').trim().toLowerCase();
 const list=banks.filter(b=>String(b.name||'').toLowerCase().includes(q));
 out.innerHTML=list.length?`<div class="vx-list">${list.slice(0,100).map((b,i)=>`<button class="vx-bank" onclick="window.__vxSelectBank(${i},'${escSafe(b.code)}')"><span><b>${escSafe(b.name)}</b><small>${escSafe(b.type||'Nigerian bank')}</small></span><span>›</span></button>`).join('')}</div>`:'<div class="vx-note">No matching banks found.</div>';
}
window.__vxSelectBank=(i,code)=>{
 const q=($('vxBankSearch')?.value||'').trim().toLowerCase();
 const list=banks.filter(b=>String(b.name||'').toLowerCase().includes(q));
 selectedBank=list[Number(i)]||banks.find(b=>String(b.code)===String(code));if(selectedBank)renderBankAccount();
};
function renderBankAccount(){
 root(`${steps(1)}<div class="vx-note vx-good">Selected bank: <b>${escSafe(selectedBank.name)}</b></div>
 <div class="vx-field"><label>10-digit account number</label><input id="vxBankAccount" inputmode="numeric" maxlength="10" placeholder="0123456789"></div>
 <div id="vxBankResolved"></div><button class="vx-btn secondary" onclick="window.__vxStartOver()">Choose another bank</button>`);
 $('vxBankAccount')?.addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,10);clearTimeout(resolveTimer);resolveTimer=setTimeout(()=>resolveBank(e.target.value),350)});
}
async function resolveBank(acc){
 const out=$('vxBankResolved');if(!out)return;const seq=++resolvedSeq;bankRecipient=null;
 if(!/^\d{10}$/.test(acc)){out.innerHTML='';return}
 out.innerHTML='<div class="vx-note">Verifying account name…</div>';
 try{
  const d=await api('/api/banks/resolve?accountNumber='+encodeURIComponent(acc)+'&bankCode='+encodeURIComponent(selectedBank.code));
  if(seq!==resolvedSeq||$('vxBankAccount')?.value!==acc)return;
  const a=d?.account;if(!a?.accountName||String(a.accountNumber||acc)!==acc)throw new Error('The account name could not be verified.');
  bankRecipient={accountNumber:acc,accountName:a.accountName,bankName:a.bank||selectedBank.name,bankCode:selectedBank.code};
  out.innerHTML=`<div class="vx-note vx-good"><b>✓ Account name verified</b><br>${escSafe(a.accountName)}<br><small>${escSafe(acc)} · ${escSafe(bankRecipient.bankName)}</small></div><button class="vx-btn" onclick="window.__vxContinueBank()">Continue with this account</button>`;
 }catch(e){if(seq===resolvedSeq)out.innerHTML=`<div class="vx-note vx-error">${escSafe(safeErr(e))}</div>`}
}
window.__vxContinueBank=()=>{
 if(!bankRecipient)return;draft={type:'BANK_TRANSFER',recipient:bankRecipient};
 root(`${steps(2)}<div class="vx-note vx-good"><b>${escSafe(bankRecipient.accountName)}</b><br>${escSafe(bankRecipient.accountNumber)} · ${escSafe(bankRecipient.bankName)}</div>
 <div class="vx-field"><label>Amount (NGN)</label><input id="vxAmount" type="number" min="1" max="50000000" step="0.01" inputmode="decimal" placeholder="₦0.00"></div>
 <div class="vx-field"><label>Narration</label><input id="vxNarration" maxlength="140" placeholder="Optional"></div>
 <div class="vx-inline"><button class="vx-btn secondary" onclick="window.__vxStartOver()">Back</button><button class="vx-btn" onclick="window.__vxReview()">Review transfer</button></div>`);
};
window.__vxStartOver=()=>mode==='bank'?startBank():startVeyra();
window.__vxReview=()=>{
 if(!draft)return;const amount=Number($('vxAmount')?.value),narration=($('vxNarration')?.value||'').trim();
 if(!Number.isFinite(amount)||amount<=0||amount>50000000)return notice('Enter a valid amount within the transfer limit.');
 if(amount>Number(current()?.balance||0))return notice('Insufficient available balance.');
 draft.amount=Number(amount.toFixed(2));draft.narration=narration;
 const r=draft.recipient,isBank=draft.type==='BANK_TRANSFER';
 root(`${steps(3)}<h3 style="margin:5px 0 14px;color:#fff">Review transfer</h3><div class="vx-amount">${moneySafe(amount)}</div>
 <div class="vx-summary"><div class="vx-sumrow"><span>Recipient</span><b>${escSafe(isBank?r.accountName:nameOf(r))}</b></div>
 <div class="vx-sumrow"><span>Account</span><b>${escSafe(r.accountNumber||'—')}</b></div>
 ${isBank?`<div class="vx-sumrow"><span>Bank</span><b>${escSafe(r.bankName)}</b></div>`:''}
 <div class="vx-sumrow"><span>Narration</span><b>${escSafe(narration||'—')}</b></div>
 <div class="vx-sumrow"><span>Transfer type</span><b>${isBank?'Bank transfer':'Veyra transfer'}</b></div></div>
 <div class="vx-note">Check the recipient and amount carefully. Transfers may not be reversible after completion.</div>
 <div class="vx-inline"><button class="vx-btn secondary" onclick="window.__vxEditDetails()">Edit</button><button class="vx-btn" onclick="window.__vxAuthorize()">Continue to authorization</button></div>`);
};
function notice(msg){const r=$('vx-transfer-root');if(!r)return;const n=document.createElement('div');n.className='vx-note vx-error';n.textContent=msg;r.appendChild(n)}
window.__vxEditDetails=()=>draft?.type==='BANK_TRANSFER'?window.__vxContinueBank():window.__vxContinueVeyra();
function authPayload(){
 const t=draft,r=t.recipient;
 return t.type==='INTERNAL_TRANSFER'
 ?{type:t.type,recipientId:String(r.id),amount:t.amount,narration:t.narration||''}
 :{type:t.type,countryCode:'NG',currency:'NGN',accountNumber:r.accountNumber,bankCode:r.bankCode,accountName:r.accountName,bankName:r.bankName,amount:t.amount,narration:t.narration||''};
}
window.__vxAuthorize=()=>{
 if(!draft)return;
 root(`${steps(4)}<h3 style="color:#fff;margin-top:0">Authorize transfer</h3><div class="vx-amount">${moneySafe(draft.amount)}</div>
 <div class="vx-field"><label>4-digit transaction PIN</label><input id="vxPin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="Enter transaction PIN"></div>
 <button class="vx-btn" onclick="window.__vxSubmit('pin')">Confirm with PIN</button>
 <button class="vx-btn secondary" onclick="window.__vxWebAuthn()">Use device authentication</button>
 <button class="vx-btn secondary" onclick="window.__vxReview()">Back to review</button>
 <div class="vx-muted" style="margin-top:10px">Device authentication is available if you have enrolled a device. Otherwise use your transaction PIN.</div>`);
};
window.__vxWebAuthn=async()=>{
 try{
  if(!window.PublicKeyCredential||!navigator.credentials)throw new Error('Device authentication is not supported in this browser.');
  const o=await api('/api/security/webauthn/transfer/options',{method:'POST',body:JSON.stringify(authPayload())});
  const credential=await navigator.credentials.get({publicKey:vPublicKeyOptions(o.publicKey)});
  if(!credential)throw new Error('Device authentication was cancelled.');
  const verified=await api('/api/security/webauthn/transfer/verify',{method:'POST',body:JSON.stringify({challengeId:o.challengeId,credential:vCredentialJSON(credential)})});
  if(!verified?.verified||!verified?.authorizationId)throw new Error('Device authorization could not be confirmed.');
  await submitTransfer({authorizationId:verified.authorizationId});
 }catch(e){notice(safeErr(e)+' You can use your transaction PIN instead.')}
};
window.__vxSubmit=async()=>{
 const pin=$('vxPin')?.value.trim()||'';
 if(!/^\d{4}$/.test(pin))return notice('Enter your 4-digit transaction PIN.');
 await submitTransfer({pin});
};
async function submitTransfer(auth){
 if(!draft)return;const t=draft;
 root(`${steps(4)}<div class="vx-result"><div class="vx-result-icon">…</div><h3 style="color:#fff">Submitting transfer</h3><p class="vx-muted">Keep this screen open while Veyra processes your request.</p></div>`);
 const headers={'Idempotency-Key':uidSafe()};let d;
 try{
  if(t.type==='INTERNAL_TRANSFER'){
   d=await api('/api/transfers/internal',{method:'POST',headers,body:JSON.stringify({recipientId:String(t.recipient.id),amount:t.amount,narration:t.narration||undefined,...auth})});
  }else{
   const r=t.recipient;
   d=await api('/api/providers/bank-transfer',{method:'POST',headers,body:JSON.stringify({countryCode:'NG',currency:'NGN',accountNumber:r.accountNumber,bankCode:r.bankCode,bankName:r.bankName,accountName:r.accountName,amount:t.amount,narration:t.narration||'Veyra bank transfer',...auth})});
  }
  try{await loadState()}catch{}
  const tx=d?.transaction||d?.data?.transaction||d;
  showResult({status:statusOf(d),reference:tx?.reference||d?.reference||'Pending provider reference',id:tx?.id||d?.transactionId||d?.id,amount:t.amount,type:t.type,recipient:t.recipient});
 }catch(e){showFailure(safeErr(e))}
}
function showResult(x){
 const r=x.recipient,isBank=x.type==='BANK_TRANSFER',ok=x.status==='SUCCESS',bad=['FAILED','CANCELLED','REVERSED'].includes(x.status);
 root(`<div class="vx-result"><div class="vx-result-icon">${ok?'✓':bad?'!':'…'}</div><div class="vx-kicker">${escSafe(x.status)}</div><h2 style="color:#fff;margin:8px 0">${statusText(x.status)}</h2><div class="vx-amount">${moneySafe(x.amount)}</div>
 <div class="vx-summary"><div class="vx-sumrow"><span>Recipient</span><b>${escSafe(isBank?r.accountName:nameOf(r))}</b></div>
 ${isBank?`<div class="vx-sumrow"><span>Bank</span><b>${escSafe(r.bankName)}</b></div>`:''}
 <div class="vx-sumrow"><span>Account</span><b>${escSafe(r.accountNumber||'—')}</b></div>
 <div class="vx-sumrow"><span>Reference</span><b>${escSafe(x.reference)}</b></div>
 <div class="vx-sumrow"><span>Status</span><b>${escSafe(x.status)}</b></div></div>
 <div class="vx-note ${ok?'vx-good':bad?'vx-error':''}">${ok?'Veyra has confirmed this transaction.':bad?'The transaction was not completed. Check your history before trying again.':'The request was accepted but is not yet confirmed as successful. Check transaction history for updates.'}</div>
 ${x.id?`<button class="vx-btn secondary" onclick="shareReceipt('${escSafe(x.id)}')">View / share receipt</button>`:''}
 <button class="vx-btn" onclick="go('home')">Done</button></div>`);
 draft=null;
}
function showFailure(msg){
 root(`<div class="vx-result"><div class="vx-result-icon">!</div><h3 style="color:#fff">Transfer not confirmed</h3>
 <div class="vx-note vx-error">${escSafe(msg)}</div><div class="vx-note">If you are unsure whether a request reached the provider, check transaction history before retrying.</div>
 <button class="vx-btn secondary" onclick="go('history')">Check transaction history</button>
 <button class="vx-btn" onclick="go('${mode==='bank'?'bank':'send'}')">Start again</button></div>`);
}
const priorPageHtml=window.pageHtml;
if(typeof priorPageHtml==='function'){
 window.pageHtml=function(page){
  if(page==='bank')return window.vBankPage();
  return priorPageHtml(page);
 };
}
const priorBind=window.bindPage;
window.bindPage=function(page){
 if(page==='send'){startVeyra();return}
 if(page==='bank'){startBank();return}
 if(typeof priorBind==='function')return priorBind(page);
};
window.lookupRecipient=lookupVeyra;
window.beginTransfer=()=>notice('Use the verified recipient and review steps on the new transfer screen.');
window.vChooseBank=window.__vxSelectBank;
window.liveResolveAccount=()=>{const a=$('vxBankAccount');if(a)resolveBank(a.value)};
window.resolvePaystackAccount=resolveBank;
window.vExternalSend=()=>window.__vxReview();
window.performBankTransfer=()=>window.__vxSubmit();
window.performVTransfer=()=>window.__vxSubmit();
window.transferStep2=()=>window.__vxContinueVeyra();
window.transferStep3=()=>window.__vxReview();
window.bindTransferWizard=()=>startVeyra();
})();
