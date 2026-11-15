/* RAFIQ voice layer – نطق واستماع عبر محرّك المتصفح/النظام (مجاني، ولا يرسل شيئاً إلى خدمة مدفوعة).
 * ملاحظة صدق: التعرف على الكلام في Chrome/Android غالباً يمرّ عبر خوادم Google (مجاني لكن يحتاج إنترنت)،
 * وفي Safari/iPhone عبر خدمة Apple. جودة الصوت العربي تعتمد على الأصوات المثبّتة في الجهاز.
 */
(function (global) {
  'use strict';

  const LANG_PREF = {
    'العربية الفصحى المبسطة': ['ar-SA', 'ar-AE', 'ar-EG', 'ar'],
    'اللبنانية': ['ar-LB', 'ar-SY', 'ar-SA', 'ar'],
    'الشامية': ['ar-SY', 'ar-LB', 'ar-JO', 'ar-SA', 'ar'],
    'المصرية': ['ar-EG', 'ar-SA', 'ar'],
    'الإنجليزية': ['en-US', 'en-GB', 'en'],
    'الفلبينية': ['fil-PH', 'en-PH', 'en-US'],
  };
  const FEMALE_HINT = /(female|woman|laila|leila|zariyah|salma|hoda|maryam|mariam|amira|fatima|zira|samantha|karen|sara|nora|hala|noura|لين|ليلى|سلمى)/i;
  const MALE_HINT = /(male|man|maged|majed|hamed|naayf|tarik|tarek|shakir|omar|hamza|david|mark|ahmed|ahmad|مجد|طارق)/i;

  function wantsFemale(profile) {
    const v = profile.voice || '';
    if (v.includes('نسائي')) return true;
    if (v.includes('رجولي')) return false;
    return profile.shape === '👩🏻';
  }

  function pickVoice(profile) {
    if (!('speechSynthesis' in global)) return null;
    const voices = speechSynthesis.getVoices() || [];
    const prefs = LANG_PREF[profile.dialect] || LANG_PREF['العربية الفصحى المبسطة'];
    const female = wantsFemale(profile);
    for (const lang of prefs) {
      const cands = voices.filter(v => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(lang.toLowerCase()));
      if (!cands.length) continue;
      const gendered = cands.find(v => (female ? FEMALE_HINT : MALE_HINT).test(v.name));
      return { voice: gendered || cands[0], lang: (gendered || cands[0]).lang, matchedGender: !!gendered };
    }
    return { voice: null, lang: prefs[0], matchedGender: false };
  }

  /* ---------- النطق (طابور جمل) ---------- */
  // داخل غلاف Expo Go تتوفر ReactNativeWebView، فنستخدم نطق الهاتف الأصلي (expo-speech) لأنه أوثق من WebView.
  const hasNative = () => !!(global.ReactNativeWebView && typeof global.ReactNativeWebView.postMessage === 'function');
  const speaker = {
    queue: [], speaking: false, waiters: [], profile: {}, _id: 0, _timer: null,
    supported() { return hasNative() || ('speechSynthesis' in global && 'SpeechSynthesisUtterance' in global); },
    setProfile(p) { this.profile = p || {}; },
    _clean(t) { return t.replace(/[*_#`~>\[\]]/g, ' ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ').replace(/\s+/g, ' ').trim(); },
    say(text) {
      if (!this.supported()) return;
      const t = this._clean(text);
      if (!t) return;
      this.queue.push(t);
      this._next();
    },
    _next() {
      if (this.speaking || !this.queue.length) { if (!this.speaking && !this.queue.length) this._flush(); return; }
      const t = this.queue.shift();
      if (hasNative()) {
        const id = ++this._id, female = wantsFemale(this.profile);
        const prefs = LANG_PREF[this.profile.dialect] || LANG_PREF['العربية الفصحى المبسطة'];
        this.speaking = true;
        const done = () => { if (this._id !== id || !this.speaking) return; clearTimeout(this._timer); global.__rafiqSpeakDone = null; this.speaking = false; this._next(); };
        global.__rafiqSpeakDone = i => { if (i === id) done(); };
        this._timer = setTimeout(done, 3000 + t.length * 140); // احتياط إن لم تصل إشارة الانتهاء
        try { global.ReactNativeWebView.postMessage(JSON.stringify({ type: 'speak', id, text: t, lang: prefs[0], pitch: female ? 1.15 : 0.9, rate: 0.95 })); } catch (e) { done(); }
        return;
      }
      const u = new SpeechSynthesisUtterance(t);
      const pv = pickVoice(this.profile);
      if (pv && pv.voice) u.voice = pv.voice;
      u.lang = (pv && pv.lang) || 'ar-SA';
      const female = wantsFemale(this.profile);
      u.pitch = pv && pv.matchedGender ? 1 : (female ? 1.15 : 0.85); // تقريب إن لم يتوفر صوت بالجنس المطلوب
      u.rate = 0.95;
      this.speaking = true;
      const done = () => { this.speaking = false; this._next(); };
      u.onend = done; u.onerror = done;
      try { speechSynthesis.speak(u); } catch (e) { done(); }
    },
    _flush() { const w = this.waiters; this.waiters = []; w.forEach(f => f()); },
    // يعدّ الوعد منتهياً عند انتهاء كل ما في الطابور
    idle() { return (!this.speaking && !this.queue.length) ? Promise.resolve() : new Promise(r => this.waiters.push(r)); },
    stop() {
      this.queue = []; this.speaking = false; this._id++; clearTimeout(this._timer);
      if (hasNative()) { try { global.ReactNativeWebView.postMessage(JSON.stringify({ type: 'stopSpeak' })); } catch (e) {} }
      else { try { speechSynthesis.cancel(); } catch (e) {} }
      this._flush();
    },
  };

  // يقسّم نصاً متدفقاً إلى جمل لتبدأ النطق قبل اكتمال الرد
  function makeSentenceStreamer(onSentence) {
    let buf = '';
    return {
      push(t) {
        buf += t;
        let m;
        while ((m = buf.match(/^([\s\S]*?[.!؟?!\n،,؛;]+)\s/))) { // نقطع عند علامة ترقيم تليها مسافة
          if (m[1].trim().length >= 12 || /[.!؟?!\n]/.test(m[1])) { onSentence(m[1]); buf = buf.slice(m[0].length); }
          else break;
        }
      },
      end() { if (buf.trim()) onSentence(buf); buf = ''; },
    };
  }

  /* ---------- الاستماع ---------- */
  const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
  function recLang(profile) {
    const d = profile.dialect || '';
    if (d.includes('الإنجليزية')) return 'en-US';
    if (d.includes('الفلبينية')) return 'fil-PH';
    if (d.includes('اللبنانية')) return 'ar-LB';
    if (d.includes('الشامية')) return 'ar-SY';
    if (d.includes('المصرية')) return 'ar-EG';
    return 'ar-SA';
  }
  const listener = {
    supported() { return !!SR; },
    // يستمع لجملة واحدة ويعيد النص ('' إن لم يُسمع شيء)
    listenOnce(profile, { onStart, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (!SR) return reject(Object.assign(new Error('NO_SR'), { code: 'NO_SR' }));
        const rec = new SR();
        rec.lang = recLang(profile); rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
        let text = '', settled = false;
        const finish = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(text); };
        rec.onstart = () => onStart && onStart();
        rec.onresult = e => { text = Array.from(e.results).map(r => r[0].transcript).join(' ').trim(); };
        rec.onerror = e => finish(e.error === 'no-speech' || e.error === 'aborted' ? null : Object.assign(new Error(e.error), { code: e.error }));
        rec.onend = () => finish();
        if (signal) signal.addEventListener('abort', () => { try { rec.abort(); } catch (e) {} });
        try { rec.start(); } catch (e) { finish(e); }
      });
    },
  };

  /* ---------- حلقة المحادثة الصوتية: استماع ← تفكير ← نطق ← استماع ----------
   * handler(text) يجب أن يعيد وعداً ينتهي بعد اكتمال الرد (ونطقه إن أمكن).
   * الحلقة نفسها مستقلة عن الواجهة، فيمكن لاحقاً ربط مكالمة صوتية/مرئية بها دون تغييرها. */
  function createVoiceLoop({ getProfile, handler, onState, onError }) {
    let active = false, ctrl = null;
    const set = s => onState && onState(s);
    async function run() {
      let silent = 0;
      while (active) {
        ctrl = new AbortController();
        try {
          set('listening');
          const text = await listener.listenOnce(getProfile(), { signal: ctrl.signal });
          if (!active) break;
          if (!text) { if (++silent >= 4) { onError && onError({ code: 'silence' }); break; } continue; }
          silent = 0;
          set('thinking');
          await handler(text, set);
          await speaker.idle();
        } catch (e) {
          if (!active) break;
          onError && onError(e); break;
        }
      }
      active = false; set('idle');
    }
    return {
      get active() { return active; },
      start() { if (active) return; active = true; run(); },
      stop() { active = false; if (ctrl) ctrl.abort(); speaker.stop(); set('idle'); },
    };
  }

  global.RafiqVoice = { speaker, listener, pickVoice, createVoiceLoop, makeSentenceStreamer, wantsFemale };
})(window);
