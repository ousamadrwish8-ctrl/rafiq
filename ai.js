/* RAFIQ AI layer – شخصية، ذاكرة، مشاعر، ومزوّدو ذكاء اصطناعي حقيقيون ومجانيون.
 * لا توجد هنا أي ردود جاهزة تُقدَّم على أنها ذكاء اصطناعي: إذا لم يتوفر نموذج، يُبلَّغ المستخدم بذلك.
 * المزوّدان:
 *   webllm : نموذج مفتوح يعمل داخل الجهاز عبر WebGPU (تنزيل لمرة واحدة بموافقة المستخدم).
 *   ollama : نموذج مفتوح يعمل على حاسوب المستخدم عبر Ollama، ويمرّره server.js (/api/llm/*).
 */
(function (global) {
  'use strict';

  /* ---------- أدوات النص العربي ---------- */
  const TASHKEEL = /[ً-ٰٟـ]/g;
  const clean = s => String(s || '').replace(TASHKEEL, '');
  // تطبيع للمطابقة فقط (لا يُخزَّن)
  const norm = s => clean(s).toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^؀-ۿa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // يحوّل نمطاً عربياً إلى نمط يتسامح مع اختلاف الهمزات والتاء المربوطة والألف المقصورة
  const A = p => new RegExp(p.replace(/ا/g, '[اأإآ]').replace(/[ةه]/g, '[ةه]').replace(/[يى]/g, '[يى]'), 'i');

  /* ---------- المشاعر (معجم عربي بسيط – ليس نموذجاً عميقاً) ---------- */
  const EMO = {
    sad:     { ar: 'حزن',      words: ['حزين','حزينه','زعلان','زعلانه','حزن','مكتئب','بكيت','ابكي','قلبي مكسور','محبط','احباط','خسرت','ضايق','كئيب','يائس','يأس','تعيس','مكسور'] },
    anxious: { ar: 'قلق',      words: ['قلق','قلقان','قلقه','خايف','خايفه','خوف','متوتر','توتر','مضغوط','ضغط','ما بنام','ارق','رعب','مرعوب','خائف'] },
    angry:   { ar: 'غضب',      words: ['غضبان','عصبي','معصب','غاضب','قرفان','مستفز','حقود','اكرهه','بكره','طفح الكيل','زهقت منه'] },
    joy:     { ar: 'فرح',      words: ['سعيد','سعيده','مبسوط','مبسوطه','فرحان','فرحانه','فرحه','متحمس','حماس','رائع','نجحت','تخرجت','مرتاح','الحمدلله','فرح'] },
    lonely:  { ar: 'وحدة',     words: ['وحيد','وحيده','وحده','لوحدي','مافي حدا','ما حدا','ما عندي اصدقاء','مهمل','منعزل'] },
    tired:   { ar: 'تعب',      words: ['تعبان','تعبانه','مرهق','ارهاق','منهك','ما عندي طاقه','نعسان','مللت','ملل','زهقان','زهقانه','مستنزف'] },
    grief:   { ar: 'فقد',      words: ['توفي','توفيت','وفاه','فقدان','رحل عنا','عزاء','فقدت'] },
    thanks:  { ar: 'امتنان',   words: ['شكرا','ممنون','يعطيك العافيه','الله يخليك','مشكور','امتنان'] },
  };
  const NEG = new Set(['مو', 'مش', 'ما', 'لا', 'لست', 'ليس', 'غير']);
  const INTENS = ['جدا', 'كتير', 'كثير', 'مره', 'اوي', 'قوي', 'للغايه', 'بشده'];

  function detectEmotion(text) {
    const n = norm(text);
    if (!n) return { label: 'neutral', ar: 'محايد', level: 0 };
    const tokens = n.split(' ');
    const scores = {};
    for (const [label, def] of Object.entries(EMO)) {
      for (const w of def.words) {
        const nw = norm(w);
        let idx = n.indexOf(nw);
        while (idx !== -1) {
          // التحقق من حدود الكلمة تقريباً
          const before = idx === 0 || n[idx - 1] === ' ';
          if (before) {
            const prevTok = n.slice(0, idx).trim().split(' ').pop();
            let target = label;
            if (NEG.has(prevTok)) target = (label === 'joy') ? 'sad' : null; // «مو مبسوط»
            if (target) scores[target] = (scores[target] || 0) + 1;
          }
          idx = n.indexOf(nw, idx + nw.length);
        }
      }
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (!best) return { label: 'neutral', ar: 'محايد', level: 0 };
    const boost = INTENS.some(i => tokens.includes(i)) || /!{2,}|؟{2,}/.test(text) ? 1 : 0;
    const level = Math.min(3, best[1] + boost);
    return { label: best[0], ar: EMO[best[0]].ar, level };
  }

  const CRISIS = /(انتحر|اقتل نفسي|اقتل حالي|انهي حياتي|ابي اموت|ابغي اموت|بدي موت|بدي اموت|اتمنى اموت|ما بدي عيش|لا اريد العيش|ما في فايده من حياتي|اذي نفسي|اوذي نفسي|اجرح نفسي|اريد ان اموت)/;
  const isCrisis = text => CRISIS.test(norm(text));

  /* ---------- الذكريات ---------- */
  const SPLIT = /[.!؟?\n]+/;
  const MEM_PATTERNS = [
    { kind: 'name',    re: A('(?:^|\\s)(?:انا\\s+)?اسمي\\s+(?:هو\\s+)?([^\\s,،.!؟?]{2,20})'), fmt: m => `اسم المستخدم: ${m[1]}` },
    { kind: 'age',     re: A('(?:عمري|عندي)\\s+(\\d{1,3})\\s*(?:سنه|سنة|عام)'), fmt: m => `عمر المستخدم: ${m[1]} سنة` },
    { kind: 'dislike', re: A('(?:^|\\s)(?:انا\\s+)?(?:بكره|اكره|ما بحب|لا احب|ما يعجبني|لا يعجبني)\\s+([^,،.!؟?]{2,50})'), fmt: m => `لا يحب ${m[1].trim()}` },
    { kind: 'like',    re: A('(?:^|\\s)(?:انا\\s+)?(?:بحب|احب|يعجبني|بعشق|اعشق)\\s+([^,،.!؟?]{2,50})'), fmt: m => `يحب ${m[1].trim()}`, skipIf: 'dislike' },
    { kind: 'job',     re: A('(?:^|\\s)(?:بشتغل|اشتغل|اعمل|بعمل|شغلي|وظيفتي)\\s+([^,،.!؟?]{2,50})'), fmt: m => `عمل المستخدم: ${m[1].trim()}` },
    { kind: 'place',   re: A('(?:ساكن|ساكنه|اسكن|بسكن|عايش|بعيش|اعيش)\\s+(?:في|ب)\\s*([^,،.!؟?]{2,40})'), fmt: m => `يسكن في ${m[1].trim()}` },
    { kind: 'note',    re: A('(?:تذكر|تذكري|خلي بالك|خليك فاكر|لا تنسى|ما تنسى|لا تنس)\\s+(?:ان|انو|إن|أن)?\\s*([^.!؟?\\n]{3,120})'), fmt: m => m[1].trim() },
  ];

  function extractMemories(text) {
    const found = [];
    for (const sentence of clean(text).split(SPLIT)) {
      if (!sentence.trim()) continue;
      const hit = new Set();
      for (const p of MEM_PATTERNS) {
        if (p.skipIf && hit.has(p.skipIf)) continue;
        const m = sentence.match(p.re);
        if (m) { hit.add(p.kind); found.push({ kind: p.kind, text: p.fmt(m) }); }
      }
    }
    return found;
  }

  function makeMemory(text, kind, auto) {
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, kind: kind || 'note', ts: Date.now(), auto: !!auto };
  }
  // ذكريات قديمة كانت نصوصاً فقط
  function migrateMemories(list) {
    return (Array.isArray(list) ? list : []).map(m => typeof m === 'string' ? makeMemory(m, 'note', false) : m).filter(m => m && m.text);
  }
  // يُرجع الذكرى المضافة أو null إن كانت مكررة
  function addMemoryTo(list, text, kind, auto) {
    const key = norm(text);
    if (!key || list.some(m => norm(m.text) === key)) return null;
    const mem = makeMemory(text, kind, auto);
    list.unshift(mem);
    return mem;
  }
  const stem = w => w.replace(/^(ال|و|ب|ل|ف)(?=.{3,})/, '');
  function retrieveMemories(memories, query, k) {
    k = k || 12;
    if (memories.length <= k) return memories.slice();
    const q = new Set(norm(query).split(' ').map(stem).filter(w => w.length > 2));
    const scored = memories.map((m, i) => {
      const toks = norm(m.text).split(' ').map(stem);
      let s = toks.reduce((a, t) => a + (q.has(t) ? 2 : 0), 0);
      if (m.kind === 'name') s += 100;
      s += Math.max(0, 1 - i / memories.length); // الأحدث أولاً (القائمة مرتبة بالأحدث)
      return { m, s };
    });
    return scored.sort((a, b) => b.s - a.s).slice(0, k).map(x => x.m);
  }

  /* ---------- الشخصية والبرومبت ---------- */
  const DIALECT = {
    'العربية الفصحى المبسطة': 'تحدّث بعربية فصحى مبسّطة دافئة وقريبة من الناس، بلا تعقيد.',
    'اللبنانية': 'تحدّث باللهجة اللبنانية (مثل: شو، كيفك، هيك، بدّي، منيح، يا صديقي) بشكل طبيعي دون مبالغة.',
    'الشامية': 'تحدّث باللهجة الشامية (مثل: شو، كيفك، هيك، بدّي، لسا، يا زلمة) بشكل طبيعي دون مبالغة.',
    'المصرية': 'تحدّث باللهجة المصرية (مثل: إزيك، عامل إيه، أوي، كده، يا صاحبي) بشكل طبيعي دون مبالغة.',
    'الإنجليزية': 'Speak natural, warm English.',
    'الفلبينية': 'Magsalita sa natural at magiliw na Filipino/Tagalog.',
  };
  const TRAIT = {
    '😊': 'ودود: دافئ وحنون ومشجّع.',
    '🧠': 'حكيم: هادئ ومتأنٍّ، تعطي منظوراً أعمق وتسأل أسئلة تساعد على التفكير.',
    '😄': 'مرح: خفيف الظل تمازح بلطف، لكنك تتوقف عن المزاح فوراً إذا كان المستخدم حزيناً أو متضايقاً.',
    '🗣️': 'صريح: تقول رأيك بصدق ولطف دون مجاملة كاذبة ودون جرح.',
  };
  const GENDER = {
    '👨🏻': 'أنت صديق رجل: استخدم صيغة المذكّر عندما تتحدث عن نفسك.',
    '👩🏻': 'أنت صديقة امرأة: استخدمي صيغة المؤنّث عندما تتحدثين عن نفسك.',
    '🧑🏻': 'استخدم صياغة محايدة عن نفسك قدر الإمكان.',
  };
  const EMO_HINT = {
    sad: 'يبدو أن المستخدم حزين. ابدأ بتقدير مشاعره بجملة صادقة، لا تستعجل الحلول، ولا تقلّل من ألمه.',
    anxious: 'يبدو أن المستخدم قلق أو متوتر. اهدأ في نبرتك، طمئنه بلطف، واقترح خطوة صغيرة واحدة إن ناسب.',
    angry: 'يبدو أن المستخدم غاضب. أصغِ أولاً واعترف بمشاعره دون جدال، ثم ساعده على التفكير بهدوء.',
    joy: 'يبدو أن المستخدم سعيد. شاركه فرحته بصدق واسأله عن التفاصيل.',
    lonely: 'يبدو أن المستخدم يشعر بالوحدة. كن حاضراً ودافئاً، وشجّعه بلطف على التواصل مع أشخاص يحبهم.',
    tired: 'يبدو أن المستخدم متعب. خفّف نبرتك، ولا تُثقِل عليه بأسئلة كثيرة، وذكّره بلطف بالراحة.',
    grief: 'يبدو أن المستخدم يمرّ بفقد. كن لطيفاً جداً، قلّل الكلام، وأعطه مساحة ليحكي.',
    thanks: 'المستخدم يشكرك. ردّ بتواضع ودفء وباختصار.',
  };

  // أمثلة قصيرة تُظهر النبرة المطلوبة؛ أقوى وسيلة لتحسين اللهجة في النماذج الصغيرة. (تُكتب بصيغة محايدة الجنس.)
  const FEWSHOT = {
    'العربية الفصحى المبسطة': [
      ['أشعر أنني لا أنجز شيئاً هذه الأيام.', 'أتفهّم هذا الشعور، وهو مُتعب فعلاً. ما الشيء الذي تمنّيت إنجازه ولم يحدث؟ ربما نبدأ معاً بخطوة صغيرة جداً.'],
      ['ما رأيك أن أبدأ بتعلّم البرمجة؟', 'فكرة جميلة. ما الذي يجذبك إليها: العمل، أم صنع شيء تحبّه؟ جوابك يحدّد من أين نبدأ.'],
    ],
    'اللبنانية': [
      ['مبارح ما نمت منيح وكتير تعبان', 'يا ساتر، الله يعينك. شو اللي شاغل بالك؟ إذا بدك احكيلي، وإذا بس بدك ترتاح قلّي وبفكّر معك شو بيريّحك.'],
      ['شو رأيك نحكي شوي؟', 'أكيد، أنا حدّك. شو أخبارك اليوم؟'],
    ],
    'الشامية': [
      ['والله اليوم كان يوم تقيل', 'يعطيك العافية، شكله يوم تعبان. شو صار معك؟ احكيلي على راحتك، أنا سامعك.'],
      ['بدي أبدأ أتعلم لغة جديدة', 'حلو كتير! أي لغة بدك؟ وليش هاللغة بالذات؟'],
    ],
    'المصرية': [
      ['أنا متضايق أوي النهاردة', 'معلش، ربنا يهوّن عليك. حصل إيه؟ احكيلي وأنا سامعك.'],
      ['عايز أبدأ أمارس رياضة', 'فكرة حلوة جداً! تحب تبدأ بإيه، مشي ولا جيم؟ وكام يوم في الأسبوع تقدر تلتزم بيهم؟'],
    ],
    'الإنجليزية': [
      ["I've been feeling really stressed about work.", "That sounds exhausting. What's been weighing on you the most? I'm here, take your time."],
    ],
    'الفلبينية': [
      ['Pagod na pagod ako ngayon.', 'Naiintindihan kita. Ano ang nangyari ngayong araw? Nandito lang ako, makikinig ako.'],
    ],
  };

  // تذكير قصير يُلحق برسالة المستخدم الأخيرة فقط (النماذج الصغيرة تعطي وزناً أكبر لآخر ما تقرأ). لا يُخزَّن في السجل.
  function turnReminder(profile) {
    const d = (profile && profile.dialect) || '';
    const lang = d.includes('الإنجليزية') ? 'الإنجليزية' : (d.includes('الفلبينية') ? 'الفلبينية' : 'نفس لغة المستخدم، وبلهجة: ' + (d || 'العربية الفصحى المبسطة'));
    return 'تذكير: أجب بـ' + lang + '، بإيجاز ودفء وبلا قوائم أو رموز تنسيق، ولا تستخدم أي حرف صيني أو لغة أخرى.';
  }

  function buildSystemPrompt(profile, memories, emotion, crisis) {
    const p = profile || {};
    const name = p.name || 'رفيق';
    const parts = [];
    parts.push(`أنت «${name}»، رفيق ذكاء اصطناعي وصديق مقرّب للمستخدم داخل تطبيق RAFIQ. أنت ذكاء اصطناعي وليس إنساناً، ولا تدّعِ غير ذلك؛ وإن سألك المستخدم قل له بصدق ولطف.`);
    parts.push(GENDER[p.shape] || GENDER['🧑🏻']);
    parts.push('الطبع: ' + (TRAIT[p.trait] || TRAIT['😊']));
    parts.push('اللغة واللهجة: ' + (DIALECT[p.dialect] || DIALECT['العربية الفصحى المبسطة']) + ' إن كتب المستخدم بلغة أخرى فأجبه بلغته.');
    parts.push([
      'القيم: الصدق، والاحترام، والرحمة، والحكمة. اهتم بالمستخدم فعلاً: اسمع أولاً، وافهم ما وراء كلامه، وأظهر التعاطف قبل النصيحة.',
      'لا تشجّع على أذى النفس أو الغير أو أي سلوك ضار. لا تعطِ أحكاماً طبية أو قانونية قاطعة؛ انصح بمختص عند الحاجة.',
      'إن لم تكن متأكداً من معلومة فقل ذلك ولا تخترع. لا تخترع ذكريات أو أحداثاً مشتركة لم تُذكر لك؛ استخدم فقط الذكريات المدرجة أدناه.',
    ].join('\n'));
    parts.push('الأسلوب: ردودك قصيرة وطبيعية كصديق (من جملة إلى أربع جمل غالباً)، تسأل سؤالاً واحداً على الأكثر، ولا تعظ ولا تحاضر. لا تستخدم تنسيق Markdown ولا قوائم، وقلّل الرموز التعبيرية لأن ردّك سيُنطَق صوتياً.');
    const shots = FEWSHOT[p.dialect] || FEWSHOT['العربية الفصحى المبسطة'];
    parts.push('أمثلة على نبرتك (للاسترشاد بالأسلوب فقط، لا تكرّرها حرفياً):\n' + shots.map(x => 'المستخدم: ' + x[0] + '\nأنت: ' + x[1]).join('\n\n'));
    if (memories && memories.length) {
      parts.push('ما تعرفه عن المستخدم (من ذكرياته المحفوظة):\n' + memories.map(m => '- ' + m.text).join('\n') + '\nاستخدمها بطبيعية عندما تناسب الحديث، دون سردها كقائمة.');
    } else {
      parts.push('لا تعرف شيئاً عن المستخدم بعد؛ تعرّف عليه تدريجياً وبلا استجواب.');
    }
    if (emotion && EMO_HINT[emotion.label]) parts.push('الحالة الشعورية المرصودة في آخر رسالة: ' + EMO_HINT[emotion.label]);
    if (crisis) parts.push('تنبيه مهم: عبّر المستخدم عمّا قد يكون أفكاراً لإيذاء نفسه. استجب بهدوء ودفء شديدين، خذ كلامه على محمل الجد، اسأله بلطف إن كان بأمان الآن، وشجّعه على التواصل فوراً مع شخص يثق به أو خدمات الطوارئ في بلده. لا تقدّم أي طريقة أو تفاصيل للإيذاء، ولا تنهِ الحديث.');
    return parts.join('\n\n');
  }

  // يبني قائمة الرسائل مع حدّ للحجم (النماذج الصغيرة لها سياق محدود)
  function buildMessages(system, history, maxChars, reminder) {
    maxChars = maxChars || 3500; // سياق النماذج الصغيرة ~4096 رمزاً؛ البرومبت نفسه يأخذ جزءاً كبيراً
    const picked = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.role !== 'user' && h.role !== 'bot') continue;
      used += h.text.length;
      if (used > maxChars && picked.length >= 2) break;
      picked.unshift({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
    }
    if (reminder) {
      for (let i = picked.length - 1; i >= 0; i--) {
        if (picked[i].role === 'user') { picked[i] = { role: 'user', content: picked[i].content + '\n\n[' + reminder + ']' }; break; }
      }
    }
    return [{ role: 'system', content: system }, ...picked];
  }

  /* ---------- تنظيف الخرج ----------
   * النماذج الصغيرة (خاصة Qwen) قد تُسرّب حروفاً صينية/يابانية/كورية أو رموز Markdown وسط الرد العربي. نحذفها أثناء البث. */
  const BAD_CHARS = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF*#`~|]/g;
  function sanitize(t) { return String(t || '').replace(BAD_CHARS, '').replace(/ {2,}/g, ' '); }
  function filterToken(t) { return String(t || '').replace(BAD_CHARS, ''); }

  /* ---------- المزوّدون ---------- */
  const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm';
  const WEBLLM_MODELS = [
    { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B – خفيف (~1 جيجابايت)' },
    { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',   label: 'Qwen2.5 3B – أفضل عربياً (~2 جيجابايت)' },
    { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B – سريع جداً وضعيف (~0.4 جيجابايت)' },
  ];

  const webllm = {
    engine: null, loadedId: null, mod: null, loading: false,
    supported() { return !!(global.navigator && navigator.gpu); },
    ready(id) { return !!this.engine && this.loadedId === id; },
    async load(id, onProgress) {
      const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };
      const say = (progress, text) => onProgress && onProgress({ progress, text });
      if (!this.supported()) throw fail('NO_WEBGPU');
      if (this.ready(id)) return;
      this.loading = true;
      try {
        // المرحلة 0: هل يوجد معالج رسوميات متوافق فعلاً؟ (navigator.gpu قد يوجد دون محوّل صالح)
        say(0, 'المرحلة 1 من 3: فحص معالج الرسوميات في هاتفك…');
        let adapter = null;
        try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { adapter = null; }
        if (!adapter) throw fail('NO_ADAPTER');
        // المرحلة 1: تحميل مكتبة الذكاء من الإنترنت (أول مرة قد تستغرق دقيقة أو أكثر)
        if (!this.mod) {
          say(0, 'المرحلة 2 من 3: تحميل مكتبة الذكاء من الإنترنت (قد يستغرق دقيقة، لا تغلق الصفحة)…');
          this.mod = await Promise.race([
            import(WEBLLM_URL),
            new Promise((_, rej) => setTimeout(() => rej(fail('IMPORT_TIMEOUT')), 120000)),
          ]);
        }
        const list = (this.mod.prebuiltAppConfig && this.mod.prebuiltAppConfig.model_list) || [];
        if (list.length && !list.some(m => m.model_id === id)) throw fail('MODEL_NOT_FOUND');
        // المرحلة 2: تنزيل النموذج وتجهيزه
        say(0.01, 'المرحلة 3 من 3: بدء تنزيل النموذج…');
        this.engine = await this.mod.CreateMLCEngine(id, { initProgressCallback: p => say(p.progress || 0, p.text || '') });
        this.loadedId = id;
      } finally { this.loading = false; }
    },
    async chat(messages, opts) {
      if (!this.engine) throw new Error('NOT_LOADED');
      const stream = await this.engine.chat.completions.create({ messages, stream: true, temperature: 0.7, top_p: 0.9, frequency_penalty: 0.3, presence_penalty: 0.2, max_tokens: 400 });
      let full = '';
      for await (const chunk of stream) {
        if (opts.signal && opts.signal.aborted) { try { this.engine.interruptGenerate(); } catch (e) {} break; }
        const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (t) { full += t; opts.onToken && opts.onToken(t); }
      }
      return full;
    },
  };

  const ollama = {
    async status() {
      try {
        const r = await fetch('api/llm/status', { cache: 'no-store' });
        if (!r.ok) return { ok: false, models: [] };
        return await r.json();
      } catch (e) { return { ok: false, models: [] }; }
    },
    async chat(messages, opts) {
      const r = await fetch('api/llm/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: opts.signal,
        body: JSON.stringify({ model: opts.model, messages, stream: true, options: { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.12, num_ctx: 4096, num_predict: 400 } }),
      });
      if (!r.ok || !r.body) { const e = new Error('OLLAMA_HTTP_' + r.status); e.code = 'OLLAMA_UNREACHABLE'; throw e; }
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = '', full = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch (e) { continue; }
          if (j.error) { const e = new Error(j.error); e.code = 'OLLAMA_ERROR'; throw e; }
          const t = j.message && j.message.content;
          if (t) { full += t; opts.onToken && opts.onToken(t); }
        }
      }
      return full;
    },
  };

  /* يرسل المحادثة إلى المزوّد المختار؛ يرمي خطأً واضحاً إن لم يتوفر نموذج. */
  async function respond(cfg, messages, opts) {
    opts = { ...(opts || {}) };
    const userOnToken = opts.onToken;
    if (userOnToken) opts.onToken = t => { const f = filterToken(t); if (f) userOnToken(f); };
    if (cfg.provider === 'webllm') {
      if (!webllm.ready(cfg.webllmModel)) { const e = new Error('NOT_LOADED'); e.code = 'NOT_LOADED'; throw e; }
      return sanitize(await webllm.chat(messages, opts));
    }
    if (cfg.provider === 'ollama') return sanitize(await ollama.chat(messages, { ...opts, model: cfg.ollamaModel }));
    const e = new Error('NO_PROVIDER'); e.code = 'NO_PROVIDER'; throw e;
  }

  global.RafiqAI = {
    norm, detectEmotion, isCrisis, extractMemories, migrateMemories, addMemoryTo, retrieveMemories,
    buildSystemPrompt, buildMessages, turnReminder, sanitize, respond, webllm, ollama, WEBLLM_MODELS, EMO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
