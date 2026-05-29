const K=['model','tax_pct','acquiring_pct','redemption_pct','ad_pct'];
const D={model:'fbo',tax_pct:6,acquiring_pct:1.5,redemption_pct:80,ad_pct:10};
document.getElementById('ver').textContent='v'+chrome.runtime.getManifest().version;
chrome.storage.local.get(K,(d)=>{K.forEach(k=>{const el=document.getElementById(k);if(el)el.value=d[k]??D[k]});});
document.getElementById('save').addEventListener('click',()=>{
  const p={};K.forEach(k=>{const el=document.getElementById(k);if(!el)return;const v=el.value;p[k]=k==='model'?v:(parseFloat(v)||D[k]);});
  chrome.storage.local.set(p,()=>{const s=document.getElementById('saved');s.classList.add('show');setTimeout(()=>s.classList.remove('show'),1500);});
});