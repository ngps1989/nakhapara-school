// নখাপাড়া সপ্রাবি - Firebase লগইন ও সিঙ্ক (Spark প্ল্যান, কার্ড ছাড়া)
// কাজের ধরন: অ্যাপ আগের মতোই localStorage-এ লেখে; এই ফাইল সেই লেখা ধরে Firestore-এ পাঠায়
// এবং অন্য ডিভাইসের বদল নামিয়ে localStorage-এ বসিয়ে পর্দা নতুন করে আঁকতে বলে (window.onRemoteData)।
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail }
    from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDoc, getDocs,
         setDoc, deleteDoc, writeBatch, onSnapshot, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// কনফিগ বসানো না হলে কিছুই করে না (অ্যাপ ডিভাইসে একাই চলে)
if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE')) {
    console.info('Firebase কনফিগ বসানো হয়নি, সিঙ্ক বন্ধ।');
} else { boot(); }

function boot() {
    // ---------- কোন তথ্য সিঙ্ক হবে ----------
    // তালিকা-ধরনের তথ্য: প্রতিটি রেকর্ড আলাদা ডকুমেন্ট (দুজনের লেখা কম সংঘর্ষ করে)
    const REC = {
        lessonPlans: ['date', 'className', 'subject', 'title', 'details', 'teacher'],
        students: ['name', 'className', 'roll', 'phone'],
        attendance: ['date', 'name', 'type', 'time', 'lat', 'lng', 'acc', 'dist']
    };
    // বাকি তথ্য: প্রতিটি কী একটি ডকুমেন্ট (kv/{কী})
    const KV = [
        'nakhapara_glance_data', 'nakhapara_senior_officers',
        'nakhapara_last_visit_date', 'nakhapara_last_visit_officer', 'nakhapara_last_visit_desig',
        'nakhapara_visit_desig_options', 'nakhapara_evaluation',
        'nakhapara_school_geo', 'nakhapara_student_geo', 'nakhapara_last_visit_loc'
    ];
    const ALL_KEYS = Object.keys(REC).concat(KV);

    // ---------- অবস্থা ----------
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    let user = null, unsubs = [], pending = 0, lastError = '', applying = false;
    const lastRec = { lessonPlans: new Map(), students: new Map(), attendance: new Map() };
    const lastKv = {};
    const pushTimers = {};
    const origSet = Storage.prototype.setItem;
    const origRemove = Storage.prototype.removeItem;
    const origGet = Storage.prototype.getItem;
    const ls = { get: k => origGet.call(localStorage, k), set: (k, v) => origSet.call(localStorage, k, v), del: k => origRemove.call(localStorage, k) };
    const $ = id => document.getElementById(id);

    // নিজের অ্যাপের লেখা ধরার জন্য setItem মুড়ে দেওয়া (ফিরতি লেখার সময় applying=true থাকে, তাই ঘুরে আসে না)
    Storage.prototype.setItem = function (k, v) {
        origSet.call(this, k, v);
        if (this === localStorage && !applying && user && ALL_KEYS.includes(k)) schedulePush(k);
    };
    function lsWrite(k, v) { applying = true; try { ls.set(k, v); } finally { applying = false; } }

    // ---------- সাহায্যকারী ----------
    function readArr(k) { try { const a = JSON.parse(ls.get(k) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
    function clean(k, r) {
        const o = { id: Number(r.id) };
        REC[k].forEach(f => { o[f] = r[f] == null ? '' : String(r[f]); });
        return o;
    }
    function errMsg(e) {
        const c = (e && e.code) || '';
        if (c.includes('permission-denied')) return 'অনুমতি নেই। আপনার ইমেইল Security Rules-এর অনুমোদিত তালিকায় আছে কি না দেখুন।';
        return (e && (e.message || e.code)) || String(e);
    }
    function authMsg(e) {
        const c = (e && e.code) || '';
        if (/invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/.test(c)) return 'ইমেইল বা পাসওয়ার্ড ভুল।';
        if (c.includes('too-many-requests')) return 'অনেকবার ভুল চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';
        if (c.includes('network')) return 'ইন্টারনেট সংযোগ নেই।';
        if (c.includes('user-disabled')) return 'এই অ্যাকাউন্ট বন্ধ করা আছে।';
        return 'লগইন করা যায়নি (' + (c || 'অজানা ত্রুটি') + ')।';
    }

    // ---------- নিচের কোণার অবস্থা-চিহ্ন ----------
    const chip = document.createElement('div');
    chip.id = 'fbChip';
    chip.className = 'no-print hidden fixed bottom-3 left-3 z-[55] items-center gap-2 px-3 py-2 rounded-full bg-white border border-slate-200 shadow-lg text-xs text-slate-700 max-w-[92vw]';
    chip.innerHTML = '<span id="fbChipText"></span><button type="button" id="fbLogout" class="text-slate-400 hover:text-red-600 font-semibold">লগআউট</button>';
    document.body.appendChild(chip);
    $('fbLogout').onclick = logout;

    function setStatus() {
        if (!user) { chip.classList.add('hidden'); chip.classList.remove('flex'); return; }
        chip.classList.remove('hidden'); chip.classList.add('flex');
        let t;
        if (!navigator.onLine) t = '<i class="fas fa-cloud text-amber-500"></i> অফলাইন, নেট এলে সিঙ্ক হবে';
        else if (lastError) t = '<i class="fas fa-exclamation-triangle text-red-500"></i> সিঙ্ক ত্রুটি';
        else if (pending > 0) t = '<i class="fas fa-sync fa-spin text-blue-500"></i> সিঙ্ক হচ্ছে...';
        else t = '<i class="fas fa-cloud text-emerald-500"></i> সিঙ্ক হয়েছে';
        $('fbChipText').innerHTML = t;
        chip.title = (user.email || '') + (lastError ? '\n' + lastError : '');
    }
    window.addEventListener('online', setStatus);
    window.addEventListener('offline', setStatus);

    // ---------- লগইন পর্দা ----------
    const overlay = document.createElement('div');
    overlay.id = 'fbLogin';
    overlay.className = 'no-print fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm p-4';
    overlay.innerHTML =
        '<div class="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4">' +
          '<div class="text-center"><div class="w-14 h-14 mx-auto rounded-2xl bg-brand-900 text-amber-300 flex items-center justify-center text-2xl mb-3"><i class="fas fa-school"></i></div>' +
          '<h2 class="text-lg font-bold text-slate-800">নখাপাড়া সরকারি প্রাথমিক বিদ্যালয়</h2>' +
          '<p class="text-xs text-slate-500">শিক্ষকদের লগইন</p></div>' +
          '<div id="fbLoading" class="text-center text-sm text-slate-500 py-4"><i class="fas fa-spinner fa-spin"></i> লোড হচ্ছে...</div>' +
          '<form id="fbForm" class="hidden space-y-3">' +
            '<input id="fbEmail" type="email" autocomplete="username" required placeholder="ইমেইল" class="w-full px-3 py-2.5 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-brand-500">' +
            '<input id="fbPass" type="password" autocomplete="current-password" required placeholder="পাসওয়ার্ড" class="w-full px-3 py-2.5 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-brand-500">' +
            '<p id="fbMsg" class="text-xs min-h-[1rem]"></p>' +
            '<button id="fbBtn" type="submit" class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-sm">লগইন করুন</button>' +
            '<button id="fbReset" type="button" class="w-full text-xs text-slate-500 hover:text-brand-700">পাসওয়ার্ড ভুলে গেছেন?</button>' +
          '</form>' +
        '</div>';
    document.body.appendChild(overlay);
    function loginMsg(text, ok) { const m = $('fbMsg'); m.textContent = text; m.className = 'text-xs min-h-[1rem] ' + (ok ? 'text-emerald-700' : 'text-red-600'); }
    $('fbForm').onsubmit = async e => {
        e.preventDefault();
        const btn = $('fbBtn'); btn.disabled = true; loginMsg('', true);
        try { await signInWithEmailAndPassword(auth, $('fbEmail').value.trim(), $('fbPass').value); }
        catch (err) { loginMsg(authMsg(err), false); }
        finally { btn.disabled = false; }
    };
    $('fbReset').onclick = async () => {
        const em = $('fbEmail').value.trim();
        if (!em) { loginMsg('আগে ইমেইল ঘরে ইমেইল লিখুন।', false); return; }
        try { await sendPasswordResetEmail(auth, em); loginMsg('পাসওয়ার্ড বদলের লিংক ইমেইলে পাঠানো হয়েছে।', true); }
        catch (err) { loginMsg(authMsg(err), false); }
    };
    function showLogin() { overlay.classList.remove('hidden'); $('fbLoading').classList.add('hidden'); $('fbForm').classList.remove('hidden'); }
    function hideLogin() { overlay.classList.add('hidden'); $('fbPass').value = ''; }

    // ---------- Firestore-এ পাঠানো ----------
    function track(p) {
        pending++; setStatus();
        p.then(() => { lastError = ''; })
         .catch(e => { lastError = errMsg(e); console.error('সিঙ্ক ত্রুটি:', e); })
         .finally(() => { pending--; setStatus(); });
    }
    function schedulePush(k) {
        clearTimeout(pushTimers[k]);
        pushTimers[k] = setTimeout(() => { delete pushTimers[k]; pushKey(k); }, 400);
    }
    function pushKey(k) { if (!user) return; if (REC[k]) pushRecords(k); else pushKv(k); }

    function pushKv(k) {
        const v = ls.get(k);
        lastKv[k] = v;
        if (v == null) return;
        track(setDoc(doc(db, 'kv', k), { value: v, updatedAt: serverTimestamp(), by: user.email || '' }));
    }
    function pushRecords(k) {
        const last = lastRec[k], cur = new Map(), ops = [];
        readArr(k).forEach(r => { if (r && isFinite(Number(r.id))) cur.set(String(r.id), clean(k, r)); });
        cur.forEach((data, id) => { const s = JSON.stringify(data); if (last.get(id) !== s) ops.push({ t: 's', id, data, s }); });
        last.forEach((s, id) => { if (!cur.has(id)) ops.push({ t: 'd', id }); });
        for (let i = 0; i < ops.length; i += 400) {
            const batch = writeBatch(db);
            ops.slice(i, i + 400).forEach(o => {
                if (o.t === 's') { batch.set(doc(db, k, o.id), o.data); last.set(o.id, o.s); }
                else { batch.delete(doc(db, k, o.id)); last.delete(o.id); }
            });
            track(batch.commit());
        }
    }

    // ---------- Firestore থেকে নামানো ----------
    let notifyTimer = null; const changedKeys = new Set();
    function notify(k) {
        changedKeys.add(k);
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(() => {
            const keys = new Set(changedKeys); changedKeys.clear();
            try { if (typeof window.onRemoteData === 'function') window.onRemoteData(keys); } catch (e) { console.error(e); }
        }, 150);
    }
    function listenRecords(k) {
        return onSnapshot(collection(db, k), snap => {
            const last = lastRec[k]; let changed = false;
            snap.docChanges().forEach(ch => {
                const id = ch.doc.id;
                if (ch.type === 'removed') { if (last.delete(id)) changed = true; return; }
                const d = ch.doc.data();
                if (!isFinite(Number(d.id))) return;
                const s = JSON.stringify(clean(k, d));
                if (last.get(id) !== s) { last.set(id, s); changed = true; }
            });
            if (!changed) return;
            const arr = Array.from(last.values()).map(s => JSON.parse(s));
            arr.sort((a, b) => k === 'lessonPlans' ? b.id - a.id : a.id - b.id);
            lsWrite(k, JSON.stringify(arr));
            notify(k);
        }, e => { lastError = errMsg(e); setStatus(); console.error(e); });
    }
    function listenKv() {
        return onSnapshot(collection(db, 'kv'), snap => {
            snap.docChanges().forEach(ch => {
                const k = ch.doc.id;
                if (!KV.includes(k) || ch.type === 'removed') return;
                if (pushTimers[k]) return;                 // এই ডিভাইসের অসংরক্ষিত লেখা আছে, সেটিই জিতবে
                const v = ch.doc.data().value;
                if (typeof v !== 'string' || v === lastKv[k] || v === ls.get(k)) { if (typeof v === 'string') lastKv[k] = v; return; }
                lastKv[k] = v;
                lsWrite(k, v);
                notify(k);
            });
        }, e => { lastError = errMsg(e); setStatus(); console.error(e); });
    }

    // ---------- প্রথমবার: এই ডিভাইসের তথ্য ক্লাউডে তোলা ----------
    function hasLocalData() { return Object.keys(REC).some(k => readArr(k).length) || KV.some(k => ls.get(k) != null); }
    async function uploadMissing() {
        const cloud = {};
        for (const k of Object.keys(REC)) cloud[k] = new Set((await getDocs(collection(db, k))).docs.map(d => d.id));
        const cloudKv = new Set((await getDocs(collection(db, 'kv'))).docs.map(d => d.id));
        let batch = writeBatch(db), n = 0; const jobs = [];
        const flush = () => { if (n) { jobs.push(batch.commit()); batch = writeBatch(db); n = 0; } };
        Object.keys(REC).forEach(k => readArr(k).forEach(r => {
            if (!r || !isFinite(Number(r.id)) || cloud[k].has(String(r.id))) return;
            batch.set(doc(db, k, String(r.id)), clean(k, r)); if (++n >= 400) flush();
        }));
        KV.forEach(k => {
            const v = ls.get(k);
            if (v == null || cloudKv.has(k)) return;
            batch.set(doc(db, 'kv', k), { value: v, updatedAt: serverTimestamp(), by: user.email || '' }); if (++n >= 400) flush();
        });
        flush();
        await Promise.all(jobs);
    }
    async function initialSync() {
        const flag = 'fb_init_' + user.uid;
        if (ls.get(flag)) return;
        try {
            const metaRef = doc(db, 'kv', '_meta');
            const meta = await getDoc(metaRef);
            if (!meta.exists()) {
                await uploadMissing();
                await setDoc(metaRef, { createdAt: serverTimestamp(), by: user.email || '' });
            } else if (hasLocalData() &&
                confirm('ক্লাউডে আগে থেকেই বিদ্যালয়ের তথ্য আছে, আর এই ডিভাইসেও কিছু তথ্য আছে।\n\nOK চাপলে এই ডিভাইসের নতুন তথ্য ক্লাউডের সঙ্গে মিলিয়ে দেওয়া হবে।\nCancel চাপলে এই ডিভাইসের তথ্য বাদ দিয়ে ক্লাউডের তথ্য নেওয়া হবে।\n\n(ছবির গ্যালারি এতে প্রভাবিত হয় না।)')) {
                await uploadMissing();
            }
            ls.set(flag, '1');
        } catch (e) {
            lastError = errMsg(e); setStatus(); console.error('প্রথম সিঙ্ক ব্যর্থ:', e);
        }
    }

    async function start() {
        await initialSync();
        Object.keys(REC).forEach(k => {
            // শুরুর অবস্থা: এই ডিভাইসে যা আছে তা "পাঠানো হয়েছে" ধরা হয় না; ক্লাউডের তথ্যই ভিত্তি
            unsubs.push(listenRecords(k));
        });
        unsubs.push(listenKv());
    }
    function stop() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; Object.values(lastRec).forEach(m => m.clear()); }

    async function logout() {
        if (pending > 0 && !confirm('কিছু তথ্য এখনও সিঙ্ক হয়নি। এখন লগআউট করলে তা হারাতে পারে। তবুও লগআউট করবেন?')) return;
        if (!confirm('লগআউট করলে এই ডিভাইস থেকে স্কুলের তথ্য (ছবি ছাড়া) মুছে যাবে। তথ্য ক্লাউডে নিরাপদ থাকবে এবং আবার লগইন করলে ফিরে আসবে। এগিয়ে যাবেন?')) return;
        stop();
        try { await signOut(auth); } catch (e) {}
        ALL_KEYS.forEach(k => ls.del(k));
        location.reload();
    }

    onAuthStateChanged(auth, async u => {
        if (u) { user = u; hideLogin(); setStatus(); await start(); }
        else { stop(); user = null; setStatus(); showLogin(); }
    });
}
