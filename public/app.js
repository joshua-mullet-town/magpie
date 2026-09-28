/* Magpie — Josh's layout.
   (Named for the bird that collects small bright things. Was "Clip Grabber";
   renamed 2026-09-08 — the old name sounded like a boast.)
   Two SCREENS, not modes: INPUT is where the work happens; OUTPUT is its own
   simplified place. The chunk gets its own little player in the lower right that
   loops on its own, so judging a chunk never disturbs the input.
   Hints live next to the thing they control. */

const $ = id => document.getElementById(id);
const v  = $('v');    // the input video
const cv = $('cv');   // the chunk's own player
const ov = $('ov');   // the output player

let S = { sources: [], audio: [], timeline: [], grabLen: 1, name: 'Untitled' };
let cur = null;            // selected input video
let chunkStart = 0;        // where the chunk begins in the input
let editingId = null;      // chunk being edited, or null for a new one
let screen = 'input';      // 'input' | 'output'
let inputPlaying = false;
let chunkLooper = null;
let outPlaying = false, outIdx = 0, tlPos = 0, audioEl = null;
let mode = 'grab';        // 'grab' = collect chunks | 'ramp' = mark real-time windows
let plan = null;          // ramp plan from the server

const LENS = [0.5, 1, 1.5, 2, 3];
/* 🎚 RATE — TWIN of server.js rateOf()/outLen(). `len` = seconds of FOOTAGE; `rate` =
   how fast it plays (1 real time, 2 double, 0.5 half); it occupies len/rate of AUDIO.
   Use oLen() wherever the question is "how much audio/output", len wherever it is
   "which footage". Josh, 2026-09-24: "please just one-shot this beautifully". */
const rateOf = x => { const r = +(x && x.rate); return (isFinite(r) && r > 0) ? Math.max(0.05, Math.min(20, r)) : 1; };
const oLen = x => (+(x && x.len) || 0) / rateOf(x);
const grabRate = () => rateOf({ rate: S && S.grabRate });
const nextOLen = () => (S.grabLen || 0) / grabRate();          // the chunk about to be marked
const fmtRate = r => (Math.abs(r - 1) < 0.001 ? 'real time' : `${+(+r).toFixed(2)}×`);
/* Browsers play video between 0.25x and 4x reliably. Outside that, steer by seeking —
   a flipbook of exactly the frames the export will show. One helper for every loop. */
const PLAYABLE = r => r >= 0.25 && r <= 4;
/* 🔇 A bed's silences, in playable-file seconds. TWIN of server.js bedGaps()/gapOutStart(). */
function bedGaps(a) {
  const srcDur = a.srcDuration ?? a.duration ?? 0;
  const g = [];
  if ((+a.padBefore || 0) > 0) g.push({ id: 'before', at: 0, dur: +a.padBefore, ord: 0 });
  for (const x of (a.gaps || [])) g.push({ id: x.id, at: Math.max(0, Math.min(srcDur, +x.at || 0)), dur: +x.dur || 0, ord: 1 });
  if ((+a.padAfter || 0) > 0) g.push({ id: 'after', at: srcDur, dur: +a.padAfter, ord: 2 });
  return g.filter(x => x.dur > 0).sort((p, q) => p.at - q.at || p.ord - q.ord);
}
let sEdit = null, sAud = null, sHearT = null;     // the silence editor (see sOpen)
let sDrag = null;                                  // a silence being dragged on the AUDIO track
// every silence on the chapter's whole audio line: [{audioId, id, from, to}]
function allSilences() {
  const out = []; let base = 0;
  for (const a of (S.audio || [])) {
    let o = 0;
    for (const g of bedGaps(a)) { const from = base + g.at + o; out.push({ audioId: a.id, id: g.id, from, to: from + g.dur, dur: g.dur }); o += g.dur; }
    base += a.duration || 0;
  }
  return out;
}
const fmt = t => {
  if (!isFinite(t)) return '0:00.00';
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
/* A toast with ONE button — used for undo after anything destructive. Stays up long
   enough to actually reach for (12s), and clicking it clears itself. */
const fmtPad = a => [a.padBefore ? `${a.padBefore}s silence before` : '',
                      a.padAfter ? `${a.padAfter}s after` : ''].filter(Boolean).join(', ');
function toastAction(msg, label, fn) {
  const el = $('toast');
  el.textContent = msg + '  ';
  const b = document.createElement('button');
  b.className = 'btn sm'; b.textContent = label; b.style.marginLeft = '10px';
  b.onclick = async () => { el.style.display = 'none'; try { await fn(); } catch (e) { toast(e.message, true); } };
  el.appendChild(b);
  el.className = 'toast';
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', 12000);
}
function toast(msg, bad) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', bad ? 5200 : 2200);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const err = new Error(j.error || `request failed (${r.status})`);
    err.payload = j; err.status = r.status;
    throw err;
  }
  return j;
}

/* POST some JSON. `api()` is a bare fetch wrapper, so a caller passing a plain object as
   `body` would send the string "[object Object]" and get a silent 400 — this puts the
   stringify+header in ONE place instead of at every new call site. */
const postJSON = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

/* ---------- screens ---------- */
function showScreen(which, fromHistory) {
  screen = which;
  /* the address follows the screen, so a reload comes back to the same one */
  if (!fromHistory && location.pathname !== '/' + which) history.pushState({ screen: which }, '', '/' + which);
  /* OUTPUT is a THEATER OVERLAY now — it floats over the input rather than replacing
     it, so the work stays put underneath (Josh, 2026-09-11). */
  $('screen-input').hidden  = (which === 'assets');
  $('screen-output').hidden = which !== 'output';
  $('screen-assets').hidden = which !== 'assets';
  $('sc-input').classList.toggle('on',  which === 'input');
  $('sc-output').classList.toggle('on', which === 'output');
  $('sc-assets').classList.toggle('on', which === 'assets');
  if (which === 'output') { stopInput(); stopChunk(); loadOutputPlayer(); resumeOutputPos(); }
  else pauseOutputKeepPos();
  if (which === 'assets') { stopInput(); stopChunk(); renderAssets(); renderTranscript(); }
  paint();
}

/* ---- the ASSETS screen: the raw files, playable, reorderable, removable ----
   Josh, 2026-09-10: "I want to be able to see what videos there are and be able to
   reorganize the order and remove them... clicking on them shouldn't put that one into
   view, that should just look like one long timeline at the bottom period."
   So: NO selection here. Reorder and remove only. */
/* While ANYTHING is preparing, refresh() re-runs every 900ms (see the `busy` tail of
   refresh()), which lands here. This used to blow away #ass-videos and build brand-new
   <video> elements every pass — so every player on the screen, including the ones that
   were long since ready, got torn down and re-fetched about once a second.
   Josh, 2026-09-11: "it gets really glitchy on that screen... it seems to kind of do
   this constant reloading thing... only the video that actually is uploading was
   supposed to have the loading screen."
   So: rebuild ONLY when the actual shape changes (same dataset.sig guard used by the
   output timeline and the chip list), and let the per-clip progress update in place.
   The signature deliberately EXCLUDES the percentage — a ticking number must never
   cost you the DOM. */
function jobPct(srcId) {
  const j = (S.jobs || {})[srcId];
  return j && j.status === 'working' ? `preparing… ${j.pct || 0}%` : 'preparing…';
}
function assetsSig() {
  // trimIn/trimOut MUST be in here — a trim changes the row's text and its buttons, and
  // a signature that ignored it would leave the old numbers on screen until a reload.
  return S.sources.map(s => `${s.id}:${s.name}:${s.ready ? 1 : 0}:${s.proxy || ''}:${s.off ? 1 : 0}:`
    + `${useIn(s)}:${useOut(s)}:`
    + `${(S.ramps || []).filter(r => r.sourceId === s.id).length}:`
    + `${(S.timeline || []).filter(c => c.sourceId === s.id).length}`).join(',')
    + '|' + S.audio.map(a => `${a.id}:${a.file}:${a.name}:${JSON.stringify(a.gaps || [])}`).join(',');   // name: a rename must repaint
}
/* ✎ CLICK A NAME TO RENAME IT (Josh, 2026-09-22). Enter or clicking away saves, Esc
   cancels. The server updates the label everywhere it was copied (chunks, moments,
   other chapters). textContent, never innerHTML — a name is his text, not markup. */
function wireRename(el, kind, item) {
  if (!el) return;
  el.textContent = item.name;
  el.title = 'click to rename';
  el.onclick = () => {
    if (el.isContentEditable) return;
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  };
  /* Enter SAVES DIRECTLY — it used to save only by blurring, so if focus never landed
     (verified in testing: the edit field was editable but not focused) the typing went
     nowhere and nothing was saved, silently. One commit path, guarded so Enter +
     the blur that follows can't save twice. */
  let busy = false;
  const finish = async (save) => {
    if (busy || !el.isContentEditable) return;
    busy = true;
    el.contentEditable = 'false'; el.classList.remove('editing');
    const next = el.textContent.trim();
    if (!save || !next || next === item.name) { el.textContent = item.name; busy = false; return; }
    try {
      await postJSON('/api/rename', { kind, id: item.id, name: next });
      item.name = next;
      await refresh(); renderAssets(); renderChips();
      toast(`renamed to “${next}”`);
    } catch (e) { el.textContent = item.name; toast(e.message, true); }
    busy = false;
  };
  el.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();                 // keep his typing out of the page's shortcuts
  };
  el.onblur = () => finish(true);        // clicking away also saves
}
/* ---- ASSETS grid: drag a card to move it, drop a FILE on a card to insert there ----
   One drop indicator: a bar on the left or right edge of the card you're over,
   depending on which half the pointer is in. "before card j" / "after card j" is
   turned into the final index /api/source/move expects (index AFTER removal). */
let assDragFrom = -1;
function pickVideosAt(at) {
  const inp = $('filev');
  inp.dataset.at = String(at);
  inp.click();
}
async function uploadVideosAt(files, at) {
  // one at a time, so three files dropped together keep their order in the slot
  for (const f of files) { await upload(f, '/api/upload-source', at); at++; }
}
function clearDropMarks() {
  document.querySelectorAll('.asscard.dropbefore,.asscard.dropafter,.asscard.dragging')
    .forEach(el => el.classList.remove('dropbefore', 'dropafter', 'dragging'));
}
function dropSide(row, e) {
  const r = row.getBoundingClientRect();
  return (e.clientX - r.left) < r.width / 2 ? 'before' : 'after';
}
function wireCardDrag(row, i) {
  /* Only arm the drag when the press starts OUTSIDE the player / buttons / name —
     otherwise scrubbing the video or selecting the name to rename it would drag the card. */
  row.addEventListener('mousedown', e => {
    row.draggable = !e.target.closest('video,audio,button,input,label,.assname');
  });
  row.addEventListener('dragstart', e => {
    if (!row.draggable) { e.preventDefault(); return; }
    assDragFrom = i;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'magpie-card');
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  row.addEventListener('dragend', () => { assDragFrom = -1; row.draggable = false; clearDropMarks(); });
  row.addEventListener('dragover', e => {
    const files = [...(e.dataTransfer.types || [])].includes('Files');
    if (assDragFrom < 0 && !files) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = files ? 'copy' : 'move';
    const side = dropSide(row, e);
    document.querySelectorAll('.asscard.dropbefore,.asscard.dropafter').forEach(el => {
      if (el !== row) el.classList.remove('dropbefore', 'dropafter'); });
    row.classList.toggle('dropbefore', side === 'before');
    row.classList.toggle('dropafter', side === 'after');
  });
  row.addEventListener('dragleave', e => {
    if (!row.contains(e.relatedTarget)) row.classList.remove('dropbefore', 'dropafter');
  });
  row.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    const side = dropSide(row, e);
    const slot = side === 'before' ? i : i + 1;          // position in the CURRENT list
    const files = [...(e.dataTransfer.files || [])];
    const from = assDragFrom;
    clearDropMarks(); assDragFrom = -1;
    if (files.length) return uploadVideosAt(files, slot);
    if (from < 0) return;
    const to = from < slot ? slot - 1 : slot;            // index after removing `from`
    if (to === from) return;
    await dMoveSource(S.sources[from].id, to);
  });
}
/* ↪ move a clip to another chapter — a small menu of the other chapters under the button */
async function dMoveToChapter(sc, btn) {
  document.querySelectorAll('.chmenu').forEach(m => m.remove());
  let list;
  try { list = (await api('/api/chapters')).chapters.filter(c => !c.active); } catch (e) { toast(e.message, true); return; }
  if (!list.length) { toast('there is no other chapter yet — make one with ＋ NEW'); return; }
  const m = document.createElement('div'); m.className = 'chmenu';
  const r = btn.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - 230) + 'px'; m.style.top = (r.bottom + 4) + 'px';
  const head = document.createElement('div'); head.className = 'chmhead'; head.textContent = 'Move this clip to…'; m.appendChild(head);
  for (const c of list) {
    const b = document.createElement('button');
    b.textContent = `${c.title}  ·  ${c.sources} clip${c.sources === 1 ? '' : 's'}`;
    b.onclick = async () => {
      m.remove();
      const home = S.chapterId;      // undo returns it HERE, even if he switches chapters meanwhile
      try {
        const res = await postJSON('/api/source/to-chapter', { id: sc.id, to: c.id });
        await refresh(); renderAssets();
        const extra = res.moments || res.chunks
          ? ` (its ${[res.moments ? res.moments + ' moment(s)' : '', res.chunks ? res.chunks + ' chunk(s)' : ''].filter(Boolean).join(' + ')} went with it)` : '';
        toastAction(`moved “${res.name}” to ${res.toTitle}${extra}`, 'Undo', async () => {
          await postJSON('/api/source/to-chapter', { id: sc.id, from: c.id, to: home, at: res.fromIndex });
          await refresh(); renderAssets(); toast('moved back');
        });
      } catch (e) { toast(e.message, true); }
    };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function renderAssets() {
  const vb = $('ass-videos');
  const ready = S.sources.filter(x => x.ready);
  /* The total already EXCLUDES archived clips (useLen returns 0), so the count must too
     — otherwise the header reads "6 clips · 22:58" while only 5 are in the video. */
  const inUse = ready.filter(x => !x.off);
  const shelved = ready.length - inUse.length;
  $('ass-total').textContent = ready.length
    ? `${inUse.length} clip(s) · ${fmt(dTotal())} total`
      + (shelved ? ` · ${shelved} set aside` : '')
    : 'none yet';

  // a preparing clip's % moves constantly — update that text in place, no rebuild
  if (vb.dataset.sig === assetsSig()) {
    S.sources.forEach(sc => {
      const el = vb.querySelector(`[data-prep="${sc.id}"]`);
      if (el) el.textContent = jobPct(sc.id);
    });
    return;
  }
  vb.dataset.sig = assetsSig();
  vb.innerHTML = '';
  S.sources.forEach((sc, i) => {
    const marks = (S.ramps || []).filter(r => r.sourceId === sc.id).length;
    const clips = (S.timeline || []).filter(c => c.sourceId === sc.id).length;
    const row = document.createElement('div'); row.className = 'assrow asscard';
    row.dataset.idx = i;

    /* CARD HEAD — grip, position, and ＋ (add a video right after this one).
       Josh, 2026-09-23: "maybe three wide on full screen. So I can kind of shovel
       things around... I should be able to upload a video in between these videos." */
    const n = document.createElement('div'); n.className = 'asshead';
    n.innerHTML = `<span class="assgrip" title="drag to move">⠿</span>`
      + `<span class="assnum">${i + 1}</span><span class="sp" style="flex:1"></span>`;
    const addAfter = document.createElement('button'); addAfter.className = 'assadd';
    addAfter.textContent = '＋'; addAfter.title = 'add a video right after this one';
    addAfter.onclick = () => pickVideosAt(i + 1);
    n.appendChild(addAfter);
    wireCardDrag(row, i);

    // a clip that is still preparing has no proxy to play yet — asking for one is a
    // guaranteed 404 and a broken-looking player, so show a placeholder until it lands
    /* A split now writes REAL files (server.js /api/source/split), so a half IS a whole
       clip — its own file, its own duration, no offset to honour. The media-fragment
       machinery that used to live here is gone with the fake trim that needed it.
       A MANUAL trim still only changes what a clip contributes, and that is fine:
       he set those bounds himself and can see them on the trim bar. */
    let vid;
    if (sc.ready && sc.proxy) {
      vid = document.createElement('video');
      vid.controls = true; vid.preload = 'metadata'; vid.src = `/media/proxy/${sc.proxy}`;
    } else {
      vid = document.createElement('div');
      vid.className = 'assprep';
      vid.textContent = 'preparing…';
    }

    /* Length and size are the clip's OWN now — after a real split each half is its own
       file, so this reads the truth with no special-casing. A manually trimmed clip
       still shows its file length here and its kept range on the trim bar. */
    const meta = document.createElement('div'); meta.className = 'assmeta';
    meta.innerHTML = `<span class="assname"></span><div class="s">${fmt(sc.duration || 0)} · `
      + `${((sc.bytes || 0) / 1048576).toFixed(0)}MB</div>`
      // ONLY the clip that is actually preparing carries the preparing line
      + (sc.ready ? '' : `<div class="s prep" data-prep="${sc.id}">${jobPct(sc.id)}</div>`)
      + (marks || clips ? `<div class="assmark">${marks ? marks + ' real-time moment(s)' : ''}`
          + `${marks && clips ? ' · ' : ''}${clips ? clips + ' chunk(s)' : ''}</div>` : '');

    wireRename(meta.querySelector('.assname'), 'source', sc);

    /* TRIM — shorten what this clip CONTRIBUTES, never the file.
       Josh, 2026-09-11: "we should clip them from a what will actually be used and
       seen in the video standpoint." Set either end from where the player is parked,
       so he picks the point by watching rather than by typing a number. */
    /* ONE button. The trimming happens in a modal where you can see and drag the kept
       range — "Start here / End here" on the row silently read a player position he
       couldn't see, which he (rightly) called unintuitive. */
    /* ONE row of controls, in one place. Josh, 2026-09-14: "there's a totally different
       set of buttons for edit and not using it and then to remove it or to reorganize it
       on the other side... get all that in one easy to read spot and don't use stuff
       like not using it and use it again — use a toggle."
       So: a single strip — [Use it ✓ toggle] [Trim] [Move ▲▼] [Delete] — left to right,
       with the status text after it. No second cluster on the far side of the row. */
    const bar = document.createElement('div'); bar.className = 'assbar';
    const mk = (label, title, fn, cls) => { const b = document.createElement('button');
      b.innerHTML = label; b.title = title; if (cls) b.className = cls; b.onclick = fn; return b; };

    if (sc.ready) {
      const tin = useIn(sc), tout = useOut(sc), full = sc.duration || 0;
      const trimmed = tin > 0.01 || tout < full - 0.01;

      // a real toggle, not two differently-worded buttons
      const tog = document.createElement('label');
      tog.className = 'asstoggle' + (sc.off ? '' : ' on');
      tog.title = sc.off ? 'put this clip back in the video'
                         : 'keep the file and its moments, but leave it out of the video';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !sc.off;
      cb.onchange = () => dSetOff(sc, !cb.checked);
      const tl = document.createElement('span'); tl.textContent = 'Use it';
      tog.appendChild(cb); tog.appendChild(tl);
      bar.appendChild(tog);

      bar.appendChild(mk('Edit', 'edit this clip — trim it, split it (the file is never changed)',
                         () => tOpen(sc.id)));
      row.classList.toggle('archived', !!sc.off);

      const lbl = document.createElement('span'); lbl.className = 'asstrimlbl';
      const marks = (S.ramps || []).filter(r => r.sourceId === sc.id).length;
      lbl.innerHTML = sc.off
        ? `<b class="offlbl">not in the video</b> · file &amp; ${marks || 'no'} moment${marks === 1 ? '' : 's'} kept`
        : trimmed
          ? `using <b>${fmt(tin)} → ${fmt(tout)}</b> · ${fmt(useLen(sc))} of ${fmt(full)}`
          : `whole clip · ${fmt(full)}`;
      bar.appendChild(mk('▲', 'move earlier', () => dMoveSource(sc.id, i - 1), 'sq'));
      bar.appendChild(mk('▼', 'move later',   () => dMoveSource(sc.id, i + 1), 'sq'));
      bar.appendChild(mk('↪ Chapter', 'move this clip to another chapter', ev => dMoveToChapter(sc, ev.currentTarget)));
      bar.appendChild(mk('✕', 'delete this video for good', () => dRemoveSource(sc), 'sq del'));
      bar.appendChild(lbl);
    } else {
      bar.appendChild(mk('▲', 'move earlier', () => dMoveSource(sc.id, i - 1), 'sq'));
      bar.appendChild(mk('▼', 'move later',   () => dMoveSource(sc.id, i + 1), 'sq'));
      bar.appendChild(mk('✕', 'delete this video for good', () => dRemoveSource(sc), 'sq del'));
    }
    meta.appendChild(bar);

    row.appendChild(n); row.appendChild(vid); row.appendChild(meta);
    vb.appendChild(row);
  });
  if (!S.sources.length) vb.innerHTML = '<div class="hint">no videos yet — drop one below</div>';

  const ab = $('ass-audio'); ab.innerHTML = '';
  $('ass-atotal').textContent = S.audio.length ? fmt(mAudioTotalAll ? mAudioTotalAll() : 0) : 'none yet';
  S.audio.forEach((a, i) => {
    const row = document.createElement('div'); row.className = 'assrow';
    const n = document.createElement('div'); n.className = 'assnum'; n.textContent = i + 1;
    const au = document.createElement('audio'); au.controls = true; au.preload = 'metadata';
    au.src = `/media/audio/${a.file}`;
    const meta = document.createElement('div'); meta.className = 'assmeta';
    meta.innerHTML = `<span class="assname"></span><div class="s">${fmt(a.duration || 0)}`
      + ((a.padBefore || a.padAfter) ? ` · includes ${fmtPad(a)}` : '') + `</div>`;
    wireRename(meta.querySelector('.assname'), 'audio', a);
    /* SILENCE BEFORE / AFTER — Josh, 2026-09-22: "a brief pause before I launch into
       the audio... select like how much buffer I want either before or after." The
       server pads the real file and shifts moments + captions to match, so here it is
       just two numbers. Steps of a quarter second; the change is applied a beat after
       the last tap, so tapping + four times makes ONE new file, not four. */
    const pads = document.createElement('div'); pads.className = 'asspad';
    const padCtl = (key, label) => {
      const w = document.createElement('span'); w.className = 'padctl';
      const v = document.createElement('b'); let val = +(a[key] || 0);
      const show = () => { v.textContent = val ? `${val.toFixed(2).replace(/0$/, '')}s` : 'none'; };
      const bump = d => { val = Math.max(0, Math.min(10, +(val + d).toFixed(2))); show(); commit(); };
      const minus = document.createElement('button'); minus.textContent = '−'; minus.onclick = () => bump(-0.25);
      const plus  = document.createElement('button'); plus.textContent  = '+'; plus.onclick  = () => bump(+0.25);
      w.append(label, ' ', minus, v, plus); show();
      w.get = () => val;
      return w;
    };
    let padT = null;
    const commit = () => {
      clearTimeout(padT);
      padT = setTimeout(async () => {
        pads.classList.add('busy');
        try {
          await postJSON('/api/audio/pad', { id: a.id, before: pb.get(), after: pa.get() });
          await refresh(); renderAssets();
          toast(pb.get() || pa.get() ? `silence set — ${pb.get()}s before, ${pa.get()}s after`
                                     : 'silence removed — back to the original');
        } catch (e) { toast(e.message, true); pads.classList.remove('busy'); }
      }, 700);
    };
    const pb = padCtl('padBefore', 'silence before');
    const pa = padCtl('padAfter', 'after');
    pads.append(pb, pa);
    meta.appendChild(pads);
    /* 🔇 the silences in the MIDDLE of this bed (the before/after ones are the steppers above) */
    const mids = allSilences().filter(x => x.audioId === a.id && x.id !== 'before' && x.id !== 'after');
    if (mids.length) {
      const box = document.createElement('div'); box.className = 'asssil';
      for (const x of mids) {
        const row = document.createElement('div'); row.className = 'silrow';
        const edit = async (body, method = 'POST') => {
          try { await api('/api/audio/silence', { method, headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ audioId: a.id, gapId: x.id, ...body }) });
                await refresh(); renderAssets(); }
          catch (e) { toast(e.message, true); }
        };
        const mk = (t, fn, cls) => { const b = document.createElement('button'); b.textContent = t; if (cls) b.className = cls; b.onclick = fn; return b; };
        const val = document.createElement('b'); val.textContent = `${x.dur}s`;
        row.append(`silence at ${fmt(x.from)}`, mk('−', () => edit({ dur: Math.max(0.1, +(x.dur - 0.5).toFixed(2)) })), val,
                   mk('+', () => edit({ dur: +(x.dur + 0.5).toFixed(2) })),
                   mk('✕', () => edit({}, 'DELETE'), 'del'));
        box.appendChild(row);
      }
      meta.appendChild(box);
    }
    const ops = document.createElement('div'); ops.className = 'assops';
    const del = document.createElement('button'); del.textContent = '✕'; del.className = 'del';
    del.title = 'remove this audio';
    del.onclick = async () => {
      await api('/api/audio', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: a.id }) });
      await refresh(); renderAssets();
    };
    ops.appendChild(del);
    row.appendChild(n); row.appendChild(au); row.appendChild(meta); row.appendChild(ops);
    ab.appendChild(row);
  });
  if (!S.audio.length) ab.innerHTML = '<div class="hint">no audio yet — drop one below</div>';
}
/* ---- the TRANSCRIPT: the words, against the audio ----
   Josh, 2026-09-10: "pair an actual transcription to the audio, independent of which
   videos I choose behind it... in my export actually have a transcription on it based
   not on the video, just on the audio."
   Timings are AUDIO timings, and the output IS the audio's length — so they hold no
   matter how the video is cut, reordered or replaced. */
function renderTranscript() {
  const box = $('tr-list'); if (!box) return;
  const t = S.transcript || [];
  $('tr-burn').checked = !!S.burnSubs;
  const job = (S.jobs || {}).transcribe;
  $('tr-state').textContent = job && job.status === 'working'
    ? `listening… ${job.pct || 0}%`
    : (t.length ? `${t.length} line(s) · from your audio bed` : 'not transcribed yet');
  $('tr-run').textContent = t.length ? 'Redo it' : 'Transcribe the audio';
  box.innerHTML = '';
  t.forEach((x, i) => {
    const row = document.createElement('div'); row.className = 'trrow';
    const tm = document.createElement('div'); tm.className = 'trtime';
    tm.textContent = `${fmt(x.start)}`;
    const ta = document.createElement('textarea'); ta.className = 'trtext'; ta.rows = 1;
    ta.value = x.text;
    const commit = () => { if (ta.value === x.text) return;
      api('/api/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: i, text: ta.value }) })
        .then(() => refresh()).catch(e => toast(e.message, true)); };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
    const go = document.createElement('button'); go.className = 'trgo'; go.textContent = '▶';
    go.title = 'play the output from this line';
    go.onclick = () => { showScreen('output'); seekOutput(x.start, true); };
    row.appendChild(tm); row.appendChild(ta); row.appendChild(go);
    box.appendChild(row);
  });
  if (!t.length) box.innerHTML = '<div class="hint">no transcript yet — it reads your audio bed, '
    + 'so it survives swapping or reordering the videos</div>';
}
/* ---- the caption ON the output preview ----
   Josh, 2026-09-11: "I actually want to see it in the output as well so I can tweak it
   there. I can't just have it in the export."

   Two things worth being careful about:
   · `tlPos` IS audio time (the output is the audio's length), and the transcript's
     timings are audio timings — so the lookup is direct, with no remapping. That
     holds no matter how the video behind it is cut or reordered.
   · The video LETTERBOXES inside .outvid (max-width/max-height on a flex-centred
     box), so anchoring the caption to the box would float it against the black
     bars instead of the picture. Compute the video's real rendered rect and sit
     the caption on THAT, scaling the type with it, so the preview matches the
     burned-in export instead of merely resembling it. */
let subsOn = true;                       // preview toggle, independent of the burn flag
function subAt(t) {
  const tr = S.transcript || [];
  for (const x of tr) if (t >= x.start && t < x.end) return x;
  return null;                           // gaps between lines stay empty, as they do burned in
}
/* TWIN of server.js lineWords() — keep the two identical. The words of one line, each
   timed: whisper's real timings when they still match his text, else his words spread
   across the line by length, so every line lights word by word. */
function lineWords(seg) {
  const text = String(seg.text || '').trim();
  const toks = text.split(/\s+/).filter(Boolean);
  const ws = (seg.words || []).filter(w => w && String(w.word || '').trim());
  const norm = x => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (ws.length && ws.length === toks.length
      && ws.every((w, i) => norm(w.word) === norm(toks[i]))) {
    return ws.map((w, i) => ({ word: toks[i], start: +w.start, end: +w.end }));
  }
  if (!toks.length) return [];
  const span = Math.max(0.01, seg.end - seg.start);
  const weight = toks.map(t => t.length + 1);
  const sum = weight.reduce((a, b) => a + b, 0);
  let t = seg.start;
  return toks.map((w, i) => { const d = span * weight[i] / sum;
    const o = { word: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }; t += d; return o; });
}
let subLineKey = '';
function paintSubs() {
  const box = $('subov'); if (!box) return;
  const line = subsOn ? subAt(tlPos) : null;
  if (!line) { box.hidden = true; return; }

  // the video's actual painted rect inside its letterbox.
  // videoWidth is 0 until the proxy's metadata lands, so fall back to the 16:9 the
  // export is rendered at — otherwise the caption blinks out on a fresh load.
  const wrap = $('outvid').getBoundingClientRect();
  if (!wrap.width || !wrap.height) { box.hidden = true; return; }
  const vw = ov.videoWidth || 1280, vh = ov.videoHeight || 720;
  const scale = Math.min(wrap.width / vw, wrap.height / vh);
  const w = vw * scale, h = vh * scale;
  const left = (wrap.width - w) / 2;

  box.style.left   = left + 'px';
  box.style.width  = w + 'px';
  box.style.bottom = ((wrap.height - h) / 2 + h * 0.045) + 'px';   // ≈ the export's MarginV
  $('subovtext').style.fontSize = Math.max(10, h * 0.047) + 'px';  // ≈ Fontsize=22 at 720p
  /* word by word: said · SAYING · not yet — the same three states the export burns in.
     Spans are built once per line (textContent — his words are text, not markup);
     only the classes move as the playhead does. */
  const el = $('subovtext');
  const key = `${line.start}|${line.end}|${line.text}`;
  const ws = lineWords(line);
  if (subLineKey !== key) {
    subLineKey = key;
    el.textContent = '';
    ws.forEach((w, i) => { const sp = document.createElement('span'); sp.className = 'kw';
      sp.textContent = w.word; el.appendChild(sp); if (i < ws.length - 1) el.appendChild(document.createTextNode(' ')); });
  }
  let now = -1;
  ws.forEach((w, i) => { if (tlPos >= (i === 0 ? line.start : w.start)) now = i; });
  [...el.querySelectorAll('.kw')].forEach((sp, i) => {
    sp.classList.toggle('said', i < now); sp.classList.toggle('now', i === now);
  });
  box.hidden = false;
}
$('tr-preview').onchange = () => { subsOn = $('tr-preview').checked; paintSubs(); };

$('tr-run').onclick = async () => {
  if (!S.audio.length) { toast('add an audio bed first'); return; }
  $('tr-state').textContent = 'listening…';
  try {
    await api('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}' });
    const poll = setInterval(async () => {
      await refresh(); renderTranscript();
      const j = (S.jobs || {}).transcribe;
      if (!j || j.status === 'done' || j.status === 'error') { clearInterval(poll);
        if (j && j.status === 'error') toast(j.error || 'transcription failed', true); }
    }, 1200);
  } catch (e) { toast(e.message, true); }
};
$('tr-clear').onclick = async () => {
  await api('/api/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }) });
  await refresh(); renderTranscript();
};
$('tr-burn').onchange = async () => {
  await api('/api/burn-subs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: $('tr-burn').checked }) });
  await refresh();
};

/* ================= THE TRIM MODAL =================
   Josh, 2026-09-11: "an edit section where I click on edit and then it pulls up a modal
   that like allows me to like trim the video and play the video more sensibly... I don't
   even know how start here and end here are supposed to work, but it's not intuitive."
   The kept range is drawn as a lit band you drag by its ends, the playhead rides the
   same bar, and Play only plays what's kept — so the thing he is setting is the thing
   he is looking at. Edits are LOCAL until he closes, then saved once. */
const tv = $('tv');
let tEdit = null;                 // the source being trimmed
let tIn = 0, tOut = 0, tFull = 0; // working values, in FILE seconds
let tLoop = null;

function tOpen(id) {
  const s = S.sources.find(x => x.id === id);
  if (!s || !s.ready) return;
  tEdit = s; tFull = s.duration || 0;
  tIn = useIn(s); tOut = useOut(s);
  stopInput(); stopChunk(); stopOutput();
  $('tmodal').hidden = false;
  $('t-name').textContent = s.name;
  $('t-zero').textContent = '0:00';
  $('t-full').textContent = fmt(tFull);
  tv.src = `/media/proxy/${s.proxy}`;
  const go = () => { tv.currentTime = tIn; tPaint(); };
  if (tv.readyState >= 2) go(); else tv.addEventListener('loadeddata', go, { once: true });
  tPaint();
}
async function tClose() {
  tStop();
  const s = tEdit; tEdit = null;
  $('tmodal').hidden = true;
  tv.pause(); tv.removeAttribute('src'); tv.load();
  if (!s) return;
  // save once, on the way out — not on every drag frame
  const whole = tIn <= 0.01 && tOut >= (s.duration || 0) - 0.01;
  await dSetTrim(s, whole ? { trimIn: null, trimOut: null }
                          : { trimIn: +tIn.toFixed(3), trimOut: +tOut.toFixed(3) });
}
function tPaint() {
  if (!tEdit) return;
  const pct = x => (tFull ? (x / tFull) * 100 : 0);
  $('t-keep').style.left = pct(tIn) + '%';
  $('t-keep').style.width = Math.max(0.4, pct(tOut - tIn)) + '%';
  $('t-in').style.left = pct(tIn) + '%';
  $('t-out').style.left = pct(tOut) + '%';
  $('t-head').style.left = pct(tv.currentTime || 0) + '%';
  $('t-now').textContent = fmt(tv.currentTime || 0);
  $('t-instart').value = (+tIn).toFixed(1);
  $('t-outend').value = (+tOut).toFixed(1);
  const kept = Math.max(0, tOut - tIn);
  $('t-sum').innerHTML = `keeping <b>${fmt(kept)}</b> of ${fmt(tFull)}`
    + (kept < tFull - 0.01 ? ` — dropping ${fmt(tFull - kept)}` : ' — the whole clip');
  $('t-play').textContent = tLoop ? '■ Stop' : '▶ Play what\'s kept';
  // moments that would fall outside the kept range
  const orph = (S.ramps || []).filter(r => r.sourceId === tEdit.id
    && !(r.start + r.len > tIn - 0.01 && r.start < tOut + 0.01)).length;
  const w = $('t-warn');
  if (orph) {
    w.hidden = false;
    w.textContent = `${orph} real-time moment${orph > 1 ? 's' : ''} on this clip `
      + `${orph > 1 ? 'are' : 'is'} outside what you're keeping, so `
      + `${orph > 1 ? 'they' : 'it'} won't appear in the video.`;
  } else w.hidden = true;
}
function tStop() { if (tLoop) { clearInterval(tLoop); tLoop = null; } tv.pause(); tPaint(); }
function tPlay() {
  if (tLoop) return tStop();
  if (tv.currentTime < tIn || tv.currentTime >= tOut - 0.05) tv.currentTime = tIn;
  tv.play().catch(() => {});
  tLoop = setInterval(() => {                     // only ever plays the kept range
    if (tv.currentTime >= tOut - 0.03) tv.currentTime = tIn;
    tPaint();
  }, 100);
  tPaint();
}
/* drag either end, or scrub the bar itself */
function tBarX(e) {
  const r = $('t-bar').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))) * tFull;
}
for (const [el, which] of [['t-in', 'in'], ['t-out', 'out']]) {
  $(el).onpointerdown = e => {
    e.preventDefault(); e.stopPropagation();
    const h = $(el); h.setPointerCapture(e.pointerId);
    h.onpointermove = ev => {
      const t = tBarX(ev);
      if (which === 'in') tIn = Math.max(0, Math.min(t, tOut - 0.2));
      else                tOut = Math.min(tFull, Math.max(t, tIn + 0.2));
      tv.currentTime = which === 'in' ? tIn : tOut;   // scrub to the edge you're setting
      tPaint();
    };
    h.onpointerup = () => { h.onpointermove = h.onpointerup = null; tPaint(); };
  };
}
$('t-bar').onpointerdown = e => {                    // click the bar = move the playhead
  if (e.target !== $('t-bar') && e.target !== $('t-keep')) return;
  tv.currentTime = tBarX(e); tPaint();
};
$('t-play').onclick = tPlay;
$('t-toin').onclick  = () => { tv.currentTime = tIn;  tPaint(); };
$('t-toout').onclick = () => { tv.currentTime = tOut; tPaint(); };
$('t-setin').onclick  = () => { tIn  = Math.max(0, Math.min(tv.currentTime, tOut - 0.2)); tPaint(); };
$('t-setout').onclick = () => { tOut = Math.min(tFull, Math.max(tv.currentTime, tIn + 0.2)); tPaint(); };
$('t-all').onclick = () => { tIn = 0; tOut = tFull; tv.currentTime = 0; tPaint(); };
$('t-instart').onchange = () => { tIn  = Math.max(0, Math.min(+$('t-instart').value || 0, tOut - 0.2)); tPaint(); };
$('t-outend').onchange  = () => { tOut = Math.min(tFull, Math.max(+$('t-outend').value || 0, tIn + 0.2)); tPaint(); };
/* Split at the playhead. Josh, 2026-09-21: "what if I'd like to actually start breaking
   out chunks of the video into their own... completely split the video".
   The trim in the modal is saved FIRST — otherwise a trim he just dragged would be
   thrown away by the reload that follows the split. */
$('t-split').onclick = async () => {
  const s = tEdit;
  if (!s) return;
  const at = +(tv.currentTime || 0);
  if (at <= tIn + 0.2 || at >= tOut - 0.2) {
    toast('move the playhead into the middle of the clip first', true); return;
  }
  try {
    const whole = tIn <= 0.01 && tOut >= (s.duration || 0) - 0.01;
    await api('/api/source/trim', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, ...(whole ? { trimIn: null, trimOut: null }
                                                 : { trimIn: +tIn.toFixed(3), trimOut: +tOut.toFixed(3) }) }) });
    /* The cut writes two real files now, so it takes a beat on a long recording. Say so
       — a silent pause on a button reads as a dead button. */
    toast('cutting into two pieces…');
    const r = await api('/api/source/split', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, at: +at.toFixed(3) }) });
    tEdit = null; $('tmodal').hidden = true;
    tStop(); tv.pause(); tv.removeAttribute('src'); tv.load();
    await refresh(); renderAssets();
    const moved = r && r.moved ? r.moved : 0;
    /* Report the two REAL lengths — that is the whole point of cutting for real. */
    const pcs = (r && r.pieces) || [];
    toast((pcs.length === 2
            ? `cut into ${fmt(pcs[0].duration)} and ${fmt(pcs[1].duration)}`
            : `split into two at ${fmt(at)}`)
      + (moved ? ` — ${moved} marked moment${moved > 1 ? 's' : ''} moved to the second piece` : '')
      + (r && r.orphaned ? ` — but ${r.orphaned} moment${r.orphaned > 1 ? 's fall' : ' falls'} outside both pieces` : ''));
  } catch (e) { toast(e.message, true); }
};
$('t-close').onclick = tClose;
tv.addEventListener('timeupdate', () => { if (tEdit && !tLoop) tPaint(); });

/* Archive / restore a clip. Nothing is deleted — the file and every moment on it stay. */
async function dSetOff(sc, off) {
  try {
    const r = await api('/api/source/off', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sc.id, off }) });
    await refresh(); renderAssets();
    const n = r && r.keptMoments ? r.keptMoments : 0;
    toast(off
      ? `${sc.name.slice(0, 22)} left out of the video`
        + (n ? ` — its ${n} moment${n > 1 ? 's are' : ' is'} kept, not deleted` : '')
      : `${sc.name.slice(0, 22)} is back in the video`);
  } catch (e) { toast(e.message, true); }
}

/* Set (or clear) a clip's trim. The file is untouched — only what it contributes. */
async function dSetTrim(sc, body) {
  try {
    const r = await api('/api/source/trim', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sc.id, ...body }) });
    await refresh(); renderAssets();
    if ('trimIn' in body && body.trimIn == null) { toast('using the whole clip again'); return; }
    // a trim that cuts past a marked moment takes it out of the output — never silently
    if (r && r.orphaned) {
      toast(`trimmed — but ${r.orphaned} marked moment${r.orphaned > 1 ? 's are' : ' is'} `
          + `outside what you kept, so ${r.orphaned > 1 ? 'they' : 'it'} won't appear`, true);
    } else {
      const p = (plan && plan.ok === false && plan.why) ? ` — heads up: ${plan.why}` : '';
      toast(`trimmed${p}`);
    }
  } catch (e) { toast(e.message, true); }
}

async function dMoveSource(id, to) {
  if (to < 0 || to >= S.sources.length) return;
  await api('/api/source/move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, to }) });
  await refresh(); renderAssets();
}
/* Remove, but WARN when work is attached (his ask). The server refuses with 409 +
   the counts unless `confirm` is set, so the warning can name what will be lost. */
async function dRemoveSource(sc) {
  const body = { id: sc.id };
  let r;
  try { r = await api('/api/source', { method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { r = e && e.payload ? e.payload : null; }
  if (r && r.needsConfirm) {
    const bits = [];
    if (r.ramps) bits.push(`${r.ramps} real-time moment${r.ramps > 1 ? 's' : ''}`);
    if (r.clips) bits.push(`${r.clips} chunk${r.clips > 1 ? 's' : ''}`);
    if (!confirm(`"${sc.name}" has ${bits.join(' and ')} attached.\n\n`
               + `Removing the video removes ${r.ramps > 1 || r.clips > 1 ? 'them' : 'it'} too. Go ahead?`)) return;
    await api('/api/source', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, confirm: true }) });
  }
  await refresh(); renderAssets();
}
async function setMode(m) {
  mode = m;
  $('md-grab').classList.toggle('on', m === 'grab');
  $('md-ramp').classList.toggle('on', m === 'ramp');
  $('planbox').hidden = (m !== 'ramp');
  stopChunk(); stopInput(); stopOutput();
  editingId = null;
  try { await api('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: m }) }); } catch {}
  await refresh();
  toast(m === 'ramp' ? 'speed mode — mark what plays at real speed'
                     : 'grab mode — collect chunks');
}
$('md-grab').onclick = () => setMode('grab');
$('md-ramp').onclick = () => setMode('ramp');

/* All three tabs are clickable. ASSETS was reachable by its `A` key but had NO click
   handler at all — Josh, 2026-09-11: "when I click on assets at the top it doesn't take
   me there. If I click A, I can get taken to the assets screen, but not when I just
   click with my mouse." A keyboard shortcut is never the proof a tab works. */
$('sc-input').onclick  = () => showScreen('input');
$('sc-output').onclick = () => toggleTheater();   // the tab toggles it too
$('sc-assets').onclick = () => showScreen('assets');
function toggleTheater() { showScreen(screen === 'output' ? 'input' : 'output'); }
$('outclose').onclick = () => showScreen('input');   // leave theater, keep the position
/* click the dark space AROUND the player to close — "it should be very closable" */
$('screen-output').addEventListener('click', e => {
  if (e.target === $('screen-output')) showScreen('input');
});

/* ---------- CHAPTERS ----------
   Josh, 2026-09-15: "I can only have one active chapter at a time, but when I'm in that
   chapter, that chapter has its own movie assets, it has its own audio, and it just works
   exactly like chapter one, but all this stuff is out of the way."

   ⚠️ WHY THERE IS ALMOST NO CODE HERE, deliberately: the server keeps the ACTIVE chapter's
   sources/ramps/timeline/audio at the top level of /api/state, exactly where they have
   always been. So switching chapters is just "ask the server to switch, then refresh()" —
   every existing painter repaints from the new active chapter with no idea chapters exist.
   Nothing in this file had to learn "which chapter am I in?", so nothing here can get it
   wrong or drift. */
let CHAPS = [], chapBusy = false;

function renderChapters() {
  const box = $('chaptabs');
  if (!box) return;
  box.innerHTML = '';
  for (const c of CHAPS) {
    const b = document.createElement('button');
    b.className = 'chap' + (c.active ? ' on' : '');
    b.title = c.active ? 'Double-click to rename' : `Switch to “${c.title}”`;
    const marks = c.marks, secs = c.seconds;
    b.innerHTML = `<span class="nm"></span><span class="cnt"></span>`;
    b.querySelector('.nm').textContent = c.title;
    /* Say what is actually IN each chapter, so the strip answers "which one was that?"
       without him having to switch into it and look. */
    b.querySelector('.cnt').textContent =
      `${c.sources}v · ${marks}${c.mode === 'grab' ? 'c' : 'm'}` + (secs ? ` · ${secs}s` : '');
    b.onclick = () => { if (!c.active) switchChapter(c.id); };
    b.ondblclick = () => { if (c.active) renameChapter(c); };
    box.appendChild(b);
  }
}

async function loadChapters() {
  try {
    const j = await api('/api/chapters');
    CHAPS = j.chapters || [];
    renderChapters();
  } catch {}
}

async function switchChapter(id) {
  if (chapBusy) return;                 // a double-tap must not start two swaps
  chapBusy = true;
  try {
    await postJSON('/api/chapter/switch', { id });
    /* The incoming chapter has its OWN clips, so whatever the player was showing belongs
       to the chapter we just left — drop it and let refresh() pick this chapter's first
       source. Without this the video element keeps playing the old chapter's footage. */
    cur = null;
    dRestored = false;                  // restore the view THIS chapter was left at
    await loadChapters();
    await refresh();
    toast('Now in “' + (CHAPS.find(c => c.active) || {}).title + '”');
  } catch (e) { toast(e.message, true); }
  finally { chapBusy = false; }
}

async function newChapter() {
  const title = (prompt('Name this chapter', `Chapter ${CHAPS.length + 1}`) || '').trim();
  if (!title) return;                   // cancelled
  if (chapBusy) return;
  chapBusy = true;
  try {
    await postJSON('/api/chapter/new', { title });
    cur = null; dRestored = false;
    await loadChapters();
    await refresh();
    toast('Started “' + title + '” — it is empty, add its clips');
  } catch (e) { toast(e.message, true); }
  finally { chapBusy = false; }
}

async function renameChapter(c) {
  const title = (prompt('Rename this chapter', c.title) || '').trim();
  if (!title || title === c.title) return;
  try {
    await postJSON('/api/chapter/rename', { id: c.id, title });
    await loadChapters();
  } catch (e) { toast(e.message, true); }
}

/* ---------- state ---------- */
async function refresh() {
  const j = await api('/api/state');
  S = j;
  // MODE FIRST: renderChips() paints a different list per mode, so syncing the mode
  // after drawing left the OUTPUT showing the OTHER mode's work on every page load.
  // (Josh, 2026-09-09: "I switched to speed mode, went to output, and I still had the
  //  same thing there that I had last time.")
  if (S.mode && S.mode !== mode) {
    mode = S.mode;
    $('md-grab').classList.toggle('on', mode === 'grab');
    $('md-ramp').classList.toggle('on', mode === 'ramp');
    $('planbox').hidden = (mode !== 'ramp');
  }
  if (mode === 'ramp') { try { plan = await api('/api/ramp/plan'); } catch {} }
  renderLens();
  renderSources(j.jobs || {});
  renderAudio();
  renderChips();
  /* the project name is painted by ensureProjectName() at the end of this function —
     it also decides whether to show the "Name this project" nudge, so setting the text
     here too would just fight it */
  loadChapters();          // keep the strip's counts honest as clips/moments change
  loadProjects();
  if (typeof isMobile === 'function' && isMobile()) mBoot();   // phone view follows the same state
  if (screen === 'assets') { renderAssets(); renderTranscript(); }
  if (cur) {
    const still = S.sources.find(s => s.id === cur.id);
    if (!still) { cur = null; v.removeAttribute('src'); $('cnone').style.display = ''; }
    else cur = still;
  }
  if (!cur) {
    const first = S.sources.find(s => s.ready);
    if (first) selectSource(first);
  }
  if (!dRestored) dRestoreView();     // once per load — pick up where he left off
  paint();
  ensureProjectName();                // "Untitled" is not a name — ask once, early
  const busy = Object.values(j.jobs || {}).some(x => x.status === 'working');
  if (busy) setTimeout(refresh, 900);
}

/* ---- the SAME saved view the phone writes (2026-09-09) ----
   Josh: "whether I'm on my phone or the machine, it should all be pulling from the
   same place." The view lives in project.json; the phone stores positions along the
   CONTINUOUS input, so convert to (source, offset) for the desktop's single-source
   player. Restored once per load, never fighting him afterwards. */
let dRestored = false, dRestoring = false;
function dRestoreView() {
  const view = S.view; if (!view || !S.sources.length) return;
  dRestored = true; dRestoring = true;
  setTimeout(() => { dRestoring = false; }, 500);
  if (view.chunkLen) setGrabLen(view.chunkLen);

  // which source does the saved continuous position fall in?
  const ready = S.sources.filter(x => x.ready);
  let acc = 0, hit = null;
  for (const sc of ready) {
    const d = useLen(sc);
    if ((view.chunkStart || 0) < acc + d || sc === ready[ready.length - 1]) {
      hit = { src: sc, into: Math.max(0, (view.chunkStart || 0) - acc) + useIn(sc) }; break;
    }
    acc += d;
  }
  /* Put the audio playhead back BEFORE the no-video early-return below — it belongs to
     the audio bed, so it must survive even when nothing matched on the video side. */
  if (view.audioPos != null) dSetAudioAt(+view.audioPos || 0);

  if (!hit) return;
  if (!cur || cur.id !== hit.src.id) selectSource(hit.src);
  chunkStart = hit.into;
  const put = () => { v.currentTime = hit.into; paint(); };
  if (v.readyState >= 2) put(); else v.addEventListener('loadeddata', put, { once: true });
}

/* ---- desktop writes it too, so the phone picks HIS desk position up ---- */
let dViewTimer = null;
function dSaveView() {
  if (dRestoring) return;                     // never echo back a restore in progress
  if (isMobile && isMobile()) return;         // the phone has its own saver
  clearTimeout(dViewTimer);
  dViewTimer = setTimeout(() => {
    const ready = S.sources.filter(x => x.ready);
    let acc = 0;
    for (const sc of ready) { if (cur && sc.id === cur.id) break; acc += useLen(sc); }
    const off = cur ? useIn(cur) : 0;      // file position -> timeline position
    api('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPos: acc + Math.max(0, (v.currentTime || 0) - off),
                             chunkStart: acc + Math.max(0, chunkStart - off),
                             chunkLen: S.grabLen,
                             /* the audio playhead is part of the work, not a scratch
                                value — it is WHERE THE NEXT MOMENT LANDS. Josh,
                                2026-09-11: "where the audio trailhead is at on the
                                input page ... super annoying whenever the page
                                refreshes that it's not saved." Same key the phone
                                uses, so the two stay in step. */
                             audioPos: dAudioAt }) }).catch(() => {});
  }, 700);
}

/* ---- ONE CONTINUOUS INPUT on desktop too (2026-09-10) ----
   Josh: "I see three total recordings, but in the bottom input section I'm still just
   seeing the first two concatenated together. I thought that once I add a video it
   would automatically append that in the input section as well."
   He was right to expect it — the PHONE already worked this way; the desktop input was
   still one-source-at-a-time (`v.duration`). These map a position on the whole stitched
   input to (file, offset) and back, exactly like the mobile helpers. */
/* A trimmed clip contributes only its kept range to the stitched input, and a position
   inside the file is offset by whatever was trimmed off the head. These three mirror
   the server's useIn/useOut/useLen exactly — if they ever disagree, preview and export
   drift apart. (Josh's trim, 2026-09-11: the FILE is never cut, only what's used.) */
const useIn  = s => Math.max(0, Math.min(+s.trimIn || 0, s.duration || 0));
const useOut = s => { const d = s.duration || 0;
  const o = (s.trimOut == null || s.trimOut === '') ? d : +s.trimOut;
  return Math.max(useIn(s), Math.min(o, d)); };
/* mirrors the server: an archived clip contributes ZERO, so it leaves the timeline,
   the plan, the preview and the export together — file and marks intact. */
const useLen = s => (s.off ? 0 : Math.max(0, useOut(s) - useIn(s)));

/* IS THIS MOMENT ACTUALLY IN THE VIDEO? The one answer, mirroring the server's
   rampPlan(): its clip must exist, not be archived, and the mark must still overlap
   the kept range. Anything false here is SHELVED — kept on screen, out of the film.
   ⚠️ SHELVED MOMENTS MUST NOT TAKE PART IN ANY CHECK. They aren't in the video, so
   they can't order wrongly and they can't be collided with. Josh, 2026-09-14:
     "it's taking into consideration moments that are archived... we need to make sure
      that we don't allow these to collide and we actually show that that's open if
      that video is not enabled."
   This lived as THREE separate copies (rampTrouble's `inVideo`, mmapData's `cut`, and
   nothing at all in markCollision — which is exactly why the overlap check kept
   flagging shelved marks after the ordering walk had been taught to skip them). One
   predicate now, so a future fix can't reach two of three call sites again. */
function rampInVideo(r) {
  const s = S.sources.find(x => x.id === r.sourceId);
  if (!s || s.off) return false;
  return r.start + r.len > useIn(s) - 0.01 && r.start < useOut(s) + 0.01;
}

const dReady = () => S.sources.filter(x => x.ready);
const dTotal = () => dReady().reduce((a, x) => a + useLen(x), 0);
function dAt(t) {                       // whole-input seconds -> {src, into, base}
  let acc = 0;                          // `into` is a real position INSIDE the file
  const list = dReady();
  for (const x of list) {
    const dd = useLen(x);
    if (t < acc + dd || x === list[list.length - 1])
      return { src: x, into: Math.max(0, t - acc) + useIn(x), base: acc };
    acc += dd;
  }
  return null;
}
function dBase(srcId) {                 // where a source starts on the whole input
  let acc = 0;
  for (const x of dReady()) { if (x.id === srcId) return acc; acc += useLen(x); }
  return 0;
}
const dPos = () => (cur ? dBase(cur.id) + Math.max(0, (v.currentTime || 0) - useIn(cur)) : 0);
const dChunkInFile = () => { const h = dAt(chunkStart); return h ? h.into : chunkStart; };   // where we are, overall
/* Seek the whole input, loading whichever file that position falls in. */
function dSeek(t, thenDo) {
  const total = dTotal(); if (!total) return;
  const hit = dAt(Math.max(0, Math.min(total - 0.02, t)));
  if (!hit) return;
  const go = () => { v.currentTime = hit.into; if (thenDo) thenDo(); paint(); };
  if (!cur || cur.id !== hit.src.id) { selectSource(hit.src); v.addEventListener('loadeddata', go, { once: true }); }
  else if (v.readyState >= 2) go(); else v.addEventListener('loadeddata', go, { once: true });
}

/* ---------- the INPUT ---------- */
function selectSource(s) {
  if (!s.ready) { toast('still preparing that one'); return; }
  stopInput(); stopChunk();
  cur = s;
  v.src  = `/media/proxy/${s.proxy}`;
  cv.src = `/media/proxy/${s.proxy}`;
  v.load(); cv.load();
  $('cnone').style.display = 'none';
  $('cnone').style.display = 'none';
  $('srcname').textContent = s.name;
  v.onloadedmetadata = () => {
    const total = dTotal() || v.duration || 0;
    chunkStart = Math.max(0, Math.min(Math.max(0, total - S.grabLen), chunkStart));
    paint();
  };
  renderSources({});
}
function playInput() {
  if (!cur) { toast('load a video first'); return; }
  stopChunk();
  // "playing the input should start at the beginning of the chunk"
  const cif = dChunkInFile();
  if (v.paused && Math.abs(v.currentTime - cif) > 0.35) v.currentTime = cif;
  v.play().catch(() => {});
  inputPlaying = true;
  paint();
}
function stopInput() { v.pause(); v.playbackRate = 1; inputPlaying = false;
                       clearInterval(backTimer); backTimer = null; holding = null; paint(); }
function toggleInput() { inputPlaying || !v.paused ? stopInput() : playInput(); }

function stepInput(delta) {
  if (!cur) return;
  stopInput();
  v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
  paint();
}

/* hold an arrow to run through the input; release stops right there */
let holding = null, backTimer = null;
function startForward(fast) { stopChunk(); v.playbackRate = fast ? 6 : 1; v.play().catch(() => {}); inputPlaying = true; }
function startBackward(fast) {
  stopChunk(); v.pause();
  const step = fast ? 0.20 : 0.05;
  clearInterval(backTimer);
  backTimer = setInterval(() => {
    v.currentTime = Math.max(0, v.currentTime - step);
    paint();
    if (v.currentTime <= 0) { clearInterval(backTimer); backTimer = null; }
  }, 33);
}

/* ---------- the CHUNK ---------- */
/* S taps to relocate it here; S held + arrows nudges it. Same key, one idea. */
function setChunkStart(t, quiet) {
  // whole-input coordinates now, so a chunk can sit in any of the stitched sources
  const total = dTotal() || (v.duration || 1e9);
  chunkStart = Math.max(0, Math.min(Math.max(0, total - S.grabLen), t));
  const hit = dAt(chunkStart);
  if (hit && (!cur || cur.id !== hit.src.id)) {      // crossed into another recording
    selectSource(hit.src);
    v.addEventListener('loadeddata', () => { v.currentTime = hit.into; paint(); }, { once: true });
  }
  if (editingId) pushChunkEdit();
  if (!quiet) toast(`chunk starts at ${fmt(chunkStart)}`);
  restartChunkIfPlaying();
  dSaveView();
  paint();
}
function nudgeChunk(delta) { setChunkStart(chunkStart + delta, true); }

function pushChunkEdit() {
  if (!editingId) return;
  const hit = dAt(chunkStart);                 // whole-input -> (source, offset)
  api('/api/clip/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: editingId, start: hit ? hit.into : chunkStart, len: S.grabLen }) })
    .then(j => { S.timeline = j.timeline; renderChips(); paint(); })
    .catch(e => toast(e.message, true));
}

/* THE BED LOOPS WITH THE CHUNK (Josh, 2026-09-10):
   "the one thing I really wanted from this interface in the bottom right... is that I
   can actually hear the audio in the loop that I'm building."
   Same idea as the phone: when audio is ON, the bed restarts at HIS chosen audio spot
   on every wrap, so he can hear whether the picture matches the words. */
function playChunk() {
  if (!cur) { toast('load a video first'); return; }
  stopChunk();
  const hit0 = dAt(chunkStart);
  if (hit0) {                                  // the chunk may live in another recording
    const url = `/media/proxy/${hit0.src.proxy}`;
    if (!cv.src.endsWith(url)) cv.src = url;
  }
  cv.currentTime = hit0 ? hit0.into : chunkStart;
  /* play the footage at the RATE this chunk will have in the film, so the loop he
     watches is the loop he'll get. Outside what a browser plays smoothly, steer by
     seeking (a flipbook) instead of clamping to a speed that isn't the real one. */
  const rate = grabRate();
  const manual = !PLAYABLE(rate);
  let vpos = cv.currentTime, last = performance.now();
  cv.playbackRate = manual ? 1 : rate;
  if (manual) cv.pause(); else cv.play().catch(() => {});
  dLoopAudioStart();
  const tick = () => {
    if (!chunkLooper) return;
    const cs = dChunkInFile();
    if (manual) {
      const now = performance.now(); vpos += ((now - last) / 1000) * rate; last = now;
      if (!cv.seeking) cv.currentTime = vpos;
    } else vpos = cv.currentTime;
    /* 🚨 ALSO WRAP WHEN THE FILE RAN OUT. Josh, 2026-09-22: "when I click play, it
       doesn't even loop the video." His chunk started 69.03s into Intro - 2a, a 70.73s
       file, and ran 2.2s — so it crosses into the next clip. `cv` holds ONE clip's proxy,
       so playback hit `ended` at 70.73 and the arithmetic end (71.21) was unreachable:
       the video just stopped. The phone loop had this exact bug and was fixed this
       morning (mStartLoop); this is its desktop twin, which kept its own copy of the
       check. `cv.ended` is the signal the arithmetic cannot see. */
    if (vpos >= cs + S.grabLen - 0.015 || cv.ended) {
      if ($('looppre').checked) { cv.currentTime = cs; vpos = cs; last = performance.now();
                                  if (!manual) cv.play().catch(() => {});
                                  dLoopAudioStart(); }        // bed wraps WITH the picture
      else { cv.pause(); dLoopAudioStop(); chunkLooper = null; paint(); return; }
    }
    chunkLooper = requestAnimationFrame(tick);
  };
  chunkLooper = requestAnimationFrame(tick);
  paint();
}
/* the bed, riding the chunk loop — only when he's asked for it */
function dLoopAudioStart() {
  if (!$('chunkaud') || !$('chunkaud').checked) return;
  const a = dEnsureAudio(); if (!a) return;
  const dur = a.duration || dAudioTotal() || 0;
  const put = () => { try { a.currentTime = Math.max(0, Math.min(Math.max(0, dur - 0.05), dAudioAt)); } catch {}
                      a.play().catch(() => {}); };
  if (a.readyState >= 1) put(); else a.addEventListener('loadedmetadata', put, { once: true });
}
function dLoopAudioStop() { if (dAudioEl) dAudioEl.pause(); }
function stopChunk() { if (chunkLooper) cancelAnimationFrame(chunkLooper); chunkLooper = null;
                       cv.pause(); cv.playbackRate = 1; dLoopAudioStop(); paint(); }
/* The RATE the next mark will play at — typed, or a preset. Same footage, different
   speed: it changes how much AUDIO the chunk takes, so LANDS AT re-clamps. */
function setGrabRate(r) {
  const v = rateOf({ rate: r });
  S.grabRate = +v.toFixed(3);
  dSetAudioAt(dAudioAt);                 // keep the whole chunk inside the audio at the new rate
  restartChunkIfPlaying();
  paint();
  api('/api/grab-len', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate: S.grabRate }) }).catch(() => {});
}
function toggleChunk() { chunkLooper ? stopChunk() : playChunk(); }
function restartChunkIfPlaying() { if (chunkLooper) playChunk(); }
$('chunkaud').onchange = () => {
  if (chunkLooper) { if ($('chunkaud').checked) dLoopAudioStart(); else dLoopAudioStop(); }
};
/* typed times on the left readout — seconds (63.08) or m:ss.xx (1:03.08) */
function parseTime(x) {
  const t = String(x || '').trim();
  if (!t) return NaN;
  if (t.includes(':')) { const [m, sec] = t.split(':'); return (+m) * 60 + (+sec); }
  return +t;
}
for (const [id, apply, cur] of [
  ['posfield',  v => setChunkStart(v, true), () => chunkStart],
  ['aposfield', v => dSetAudioAt(v),         () => dAudioAt],
]) {
  const f = $(id);
  const commit = () => { const v2 = parseTime(f.value);
    if (isFinite(v2)) { apply(Math.max(0, v2)); paint(); } f.value = fmt(cur()); };
  f.addEventListener('change', commit);
  f.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f.blur(); }
                                        if (e.key === 'Escape') { f.value = fmt(cur()); f.blur(); } });
}
{
  const f = $('ratefield');
  const commit = () => { const v2 = parseFloat(String(f.value).replace(/[x×]/gi, ''));
    if (isFinite(v2) && v2 > 0) setGrabRate(v2); f.value = +grabRate().toFixed(2); };
  f.addEventListener('change', commit);
  f.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f.blur(); }
                                        if (e.key === 'Escape') { f.value = +grabRate().toFixed(2); f.blur(); } });
  document.querySelectorAll('[data-grate]').forEach(b => b.onclick = () => setGrabRate(+b.dataset.grate));
}
// typed chunk length — any value, not just the presets
(() => {
  const f = $('clenfield');
  const commit = () => { const v2 = parseFloat(f.value);
    if (isFinite(v2)) setGrabLen(Math.max(0.1, Math.min(600, v2))); else f.value = S.grabLen; };
  f.addEventListener('change', commit);
  f.addEventListener('blur', commit);
  f.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f.blur(); } });
})();
$('cplay').onclick = toggleChunk;
$('chunkaction').onclick = () => { editingId ? finishEditing() : grab(); };
$('tpmark').onclick = () => $('chunkaction').click();   // side-bar twin, same path
/* ✕ REMOVE THE CHUNK BEING EDITED (GRAB). Named, and undoable back into its own slot —
   one tap must never silently cost him work (the lesson from this morning's lost moment). */
$('tpremove').onclick = async () => {
  const i = S.timeline.findIndex(x => x.id === editingId); if (i < 0) return;
  const c = S.timeline[i];
  try {
    await api('/api/clip', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id }) });
    editingId = null; await refresh();
    toastAction(`removed chunk ${i + 1}`, 'Undo', async () => {
      await postJSON("/api/grab", { sourceId: c.sourceId, start: c.start, len: c.len, audioAt: c.audioAt, rate: rateOf(c) });
      await refresh(); toast('put back');
    });
  } catch (e) { toast(e.message, true); }
};

async function setGrabLen(l) {
  l = Math.max(0.1, Math.round(l * 100) / 100);      // keep 2 decimals — 2.25 is valid
  S.grabLen = l;
  const total = dTotal() || (v.duration || 1e9);     // whole input, not one file
  if (chunkStart + l > total) chunkStart = Math.max(0, total - l);
  // same rule on the audio side: lengthening a chunk that sits at the end of the audio
  // slides it earlier rather than hanging it off the end (mirrors the video line above)
  const aTotL = dAudioTotal();
  if (aTotL && dAudioAt + l / grabRate() > aTotL) dAudioAt = Math.max(0, aTotL - l / grabRate());
  renderLens();
  if (editingId) pushChunkEdit();
  restartChunkIfPlaying();
  dSaveView();
  paint();
  api('/api/grab-len', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ len: l }) }).catch(() => {});
}
/* The WHERE-THE-CHUNK-IS track: the playhead, the chunk window, and the moments he has
   already marked — the same three things the phone's VIDEO bar shows. Positions are
   whole-input (trimmed) seconds; a mark's stored start is FILE-relative, so it converts
   with -useIn like everywhere else. */
/* ===== THE GRABBER: two parallel tracks, one block drawn on both =====
   Josh, 2026-09-11: "I want audio and video to have like a very similar track situation
   right next to each other, but it's very obvious as to which one you're controlling...
   you can see it both over the audio and over the video... adjust it with little bars
   too, like I can drag it to get certain footage."
   VIDEO shows WHAT he grabs (gold, draggable). AUDIO shows WHERE it lands (green, a
   readout — it follows the audio playhead, which is its own control). */
let cvSeeking = false;   // declared ABOVE its use: a `let` below would be in the TDZ
function paintGrabber() {
  const vb = $('gt-vbar'); if (!vb) return;
  const total = dTotal() || (v.duration || 0);
  const len = S.grabLen || 0;

  // ---- VIDEO track
  $('gt-vsub').textContent = total
    ? `${fmt(chunkStart)} → ${fmt(chunkStart + len)} of ${fmt(total)}` : '—';
  const pv = $('posval'); if (pv) pv.textContent = total ? fmt(chunkStart) : '—';
  // the LEFT readout — never overwrite a box he is typing in
  const pf = $('posfield'); if (pf && document.activeElement !== pf) pf.value = total ? fmt(chunkStart) : '';
  { const hit = total ? dAt(chunkStart) : null;
    $('gs-vnote').textContent = hit ? `${hit.src.name} @ ${fmt(hit.into)}` : '—';
    $('gs-vnote').title = $('gs-vnote').textContent;
    $('gs-lnote').textContent = `uses ${fmt(len)} of video`
      + (Math.abs(grabRate() - 1) > 0.001 ? ` · plays in ${fmt(nextOLen())}` : ''); }
  { const rf = $('ratefield'); if (rf && document.activeElement !== rf) rf.value = +grabRate().toFixed(2);
    const rn = $('gs-rnote'); if (rn) rn.textContent = fmtRate(grabRate()); }
  const vblk = $('gt-vblock');
  vblk.style.left = total ? (chunkStart / total) * 100 + '%' : '0%';
  /* NO width floor: 0.5% of a 31-minute input is ~9 SECONDS of visual lie. The block
     draws its true span; `.gtbar` keeps it findable with a min visible marker instead. */
  vblk.style.width = total ? ((len / total) * 100) + '%' : '0%';
  /* When the chunk is thinner than its own 2px borders, those borders would draw it
     WIDER than it is (a 2s chunk is 1.6px here and measured 3.3s too wide). Below that
     threshold, drop to a single hairline so the mark stays honest — the caret under it
     is what makes it findable. */
  const thinV = total && (len / total) * vb.clientWidth < 5;
  vblk.classList.toggle('thin', !!thinV);

  /* The three grips live OUTSIDE the block so they never shrink it or each other.
     Edges sit ON the true boundaries; the move bar spans the chunk underneath, with a
     minimum width so a thin chunk is still draggable WITHOUT the block itself lying. */
  const pctL = total ? (chunkStart / total) * 100 : 0;
  const pctR = total ? ((chunkStart + len) / total) * 100 : 0;
  const barW = vb.clientWidth || 1;
  const spanPx = ((pctR - pctL) / 100) * barW;
  const el = $('gt-el'), er = $('gt-er'), mv = $('gt-mv');

  /* When the chunk is narrower than three side-by-side targets, the grips WOULD stack —
     which is exactly the "glitchy, can't tell what I'm grabbing" Josh hit. Rather than
     let them fight, push the edge grips OUTWARD (they stay centred on the true edge,
     the block never moves) and give move the middle. Below that, move wins the pixels
     and the edges sit clear of it — you can always still resize via the LENGTH row. */
  const TIGHT = spanPx < 44;
  el.classList.toggle('tight', TIGHT);
  er.classList.toggle('tight', TIGHT);
  el.style.left = pctL + '%';
  er.style.left = pctR + '%';
  mv.style.left = pctL + '%';
  mv.style.width = Math.max(0, pctR - pctL) + '%';
  // a tight chunk gets its move bar widened around the centre instead of the span
  mv.classList.toggle('tight', TIGHT);
  if (TIGHT) {
    const midPct = (pctL + pctR) / 2;
    mv.style.left = midPct + '%';
    mv.style.width = '0%';           // .tight gives it a fixed px width, centred
  }
  $('gt-vhead').style.left = total
    ? ((dTotal() ? dPos() : (v.currentTime || 0)) / total) * 100 + '%' : '0%';

  const vm = $('gt-vmarks');
  /* 🚨 ONLY MOMENTS THAT ARE IN THE FILM ARE DRAWN — AND ONLY THEY ARE CLICKABLE.
     Josh, 2026-09-22: "if we have removed the video that a grab is a part of, that
     should definitely not show up in the main page because now when I go and I try to
     click on that section of the timeline, it pops up. Even though it's not a part of
     this anymore." A shelved moment used to be drawn (faded) AND wired to the editor,
     so a click on empty-looking timeline opened a moment that plays nowhere. Same one
     rule as every check (rampInVideo). Switching the clip back on brings it back —
     the signature includes in-film state so that repaint actually happens. */
  const liveMarks = (S.ramps || []).filter(rampInVideo);
  const grabView = mode !== 'ramp';
  const vsig = mode + '|' + (grabView
      ? S.timeline.map(c => `${c.id}:${c.sourceId}:${c.start}:${c.len}:${rateOf(c)}`).join(',') + '|ed:' + editingId
      : liveMarks.map(r => `${r.sourceId}:${r.start}:${r.len}:${rateOf(r)}`).join(','))
             + '|' + total.toFixed(1);
  if (vm.dataset.sig !== vsig && grabView) {
    /* GRAB: each chunk already in the output sits on the track where its footage is.
       Click one to load it into the editor above; Remove is in the side bar. */
    vm.dataset.sig = vsig; vm.innerHTML = '';
    if (total) S.timeline.forEach((c, n) => {
      const sc = S.sources.find(x => x.id === c.sourceId); if (!sc || sc.off) return;
      const i = document.createElement('i');
      i.style.left = ((dBase(c.sourceId) + (c.start - useIn(sc))) / total) * 100 + '%';
      i.style.width = Math.max(0.5, (c.len / total) * 100) + '%';
      if (c.id === editingId) i.className = 'sel';
      i.dataset.id = c.id; i.title = `chunk ${n + 1} · ${c.len}s · ${fmtRate(rateOf(c))} — click to edit`;
      i.onclick = ev => { ev.stopPropagation(); openChunk(c.id); };
      vm.appendChild(i);
    });
  } else if (vm.dataset.sig !== vsig) {
    vm.dataset.sig = vsig; vm.innerHTML = '';
    if (total) for (const r of liveMarks) {
      const s = S.sources.find(x => x.id === r.sourceId); if (!s) continue;
      const i = document.createElement('i');
      i.style.left = ((dBase(r.sourceId) + (r.start - useIn(s))) / total) * 100 + '%';
      i.style.width = Math.max(0.5, (r.len / total) * 100) + '%';
      // click an existing moment to edit it right here (his ask, 2026-09-11) — no trip
      // to another screen. Same modal from either track.
      i.dataset.id = r.id; i.title = `moment at ${fmt(r.audioAt)} · ${fmtRate(rateOf(r))} — click to edit`;
      i.onclick = ev => { ev.stopPropagation(); dOpenMoment(r.id); };
      vm.appendChild(i);
    }
  }
  const sb = $('gt-vseams');
  const ssig = dReady().map(x => x.id).join(',') + '|' + total.toFixed(1);
  if (sb.dataset.sig !== ssig) {
    sb.dataset.sig = ssig; sb.innerHTML = '';
    let acc = 0;
    for (const x of dReady().slice(0, -1)) {
      acc += useLen(x);
      const u = document.createElement('u');
      u.style.left = (acc / total) * 100 + '%';
      sb.appendChild(u);
    }
  }

  // ---- AUDIO track: the same block, where it LANDS
  const aTot = audioTotal();
  const aLen = nextOLen();          // the AUDIO this chunk will take, at its rate
  $('gt-asub').textContent = aTot
    ? `lands at ${fmt(dAudioAt)} → ${fmt(dAudioAt + aLen)} of ${fmt(aTot)}` : 'no audio bed yet';
  const apv = $('aposval'); if (apv) apv.textContent = aTot ? fmt(dAudioAt) : '—';
  const af = $('aposfield'); if (af && document.activeElement !== af) af.value = aTot ? fmt(dAudioAt) : '';
  $('gs-anote').textContent = aTot ? `→ ${fmt(dAudioAt + aLen)}` : 'no audio bed';
  { const sb = $('gt-asil'); const sils = aTot ? allSilences() : [];
    const sig = sils.map(x => `${x.from.toFixed(2)}:${x.dur}`).join(',') + '|' + aTot.toFixed(2) + '|' + (sEdit ? sEdit.id : '');
    if (sb && sb.dataset.sig !== sig && !sDrag) { sb.dataset.sig = sig; sb.innerHTML = '';
      for (const x of sils) { const i = document.createElement('i');
        i.style.left = (x.from / aTot) * 100 + '%'; i.style.width = (x.dur / aTot) * 100 + '%';
        i.title = `${x.dur}s of silence at ${fmt(x.from)} — click to edit`;
        if (sEdit && sEdit.audioId === x.audioId && sEdit.id === x.id) i.className = 'sel';
        i.onclick = ev => ev.stopPropagation();          // the tap is handled on pointerup below
        i.onpointerdown = ev => sDragStart(ev, x, i, aTot);
        sb.appendChild(i); } } }
  const ablk = $('gt-ablock');
  ablk.style.left = aTot ? (dAudioAt / aTot) * 100 + '%' : '0%';
  ablk.style.width = aTot ? ((aLen / aTot) * 100) + '%' : '0%';
  ablk.classList.toggle('thin', !!(aTot && (aLen / aTot) * $('gt-abar').clientWidth < 5));
  const live = (dAudioPlaying && dAudioEl) ? dAudioEl.currentTime : dAudioAt;
  $('gt-ahead').style.left = aTot ? (live / aTot) * 100 + '%' : '0%';
  $('gt-aplay').textContent = dAudioPlaying ? '■' : '▶';

  const am = $('gt-amarks');
  const liveA = (S.ramps || []).filter(rampInVideo);          // same rule as the video track
  const asig = mode + '|' + (mode !== 'ramp'
      ? S.timeline.map(c => `${c.id}:${c.len}:${c.audioAt}:${rateOf(c)}`).join(',') + '|ed:' + editingId
      : liveA.map(r => `${r.id}:${r.audioAt}:${r.len}:${rateOf(r)}`).join(',')) + '|' + aTot.toFixed(1);
  if (am.dataset.sig !== asig && mode !== 'ramp') {
    am.dataset.sig = asig; am.innerHTML = '';
    if (aTot) chunkPlaces().forEach((p, n) => {
      const c = p.c;
      const i = document.createElement('i');
      i.style.left = (p.at / aTot) * 100 + '%';
      i.style.width = Math.max(0.5, (p.len / aTot) * 100) + '%';
      if (c.id === editingId) i.className = 'sel';
      i.dataset.id = c.id; i.title = `chunk ${n + 1} plays at ${fmt(p.at)} — click to edit`;
      i.onclick = ev => { ev.stopPropagation(); openChunk(c.id); };
      am.appendChild(i);
    });
  } else if (am.dataset.sig !== asig) {
    am.dataset.sig = asig; am.innerHTML = '';
    if (aTot) for (const r of liveA) {
      const i = document.createElement('i');
      i.style.left = ((r.audioAt || 0) / aTot) * 100 + '%';
      i.style.width = Math.max(0.5, (oLen(r) / aTot) * 100) + '%';     // its AUDIO span
      i.dataset.id = r.id; i.title = `moment at ${fmt(r.audioAt)} · ${fmtRate(rateOf(r))} — click to edit`;
      i.onclick = ev => { ev.stopPropagation(); dOpenMoment(r.id); };
      am.appendChild(i);
    }
  }
  $('stagetag').textContent = chunkLooper ? 'CHUNK — looping' : 'CHUNK';

  /* The mark button says whether marking HERE is even possible, so he isn't invited to
     create a broken moment (his ask 2026-09-11). Also lights the block red so the
     collision is visible on the track, not just in a toast. */
  const clash = (mode === 'ramp') ? markCollision() : null;
  const act = $('chunkaction');
  if (act && mode === 'ramp') {
    act.classList.toggle('blocked', !!clash);
    act.title = clash
      ? (clash.kind === 'past-end'
          ? `runs ${clash.over.toFixed(2)}s past the end of your audio`
          : `would land on the moment at ${fmt(clash.r.audioAt)}`)
      : '';
  }
  $('gt-ablock').classList.toggle('clash', !!clash);
  /* Flag the moment he'd collide with AND every moment that is already broken, on both
     tracks. Josh, 2026-09-11: "I can't see what's actually overlapping... I can't tell
     which ones are down there that are bad." The plan named a problem it never pointed at. */
  const hitId = clash && clash.r ? clash.r.id : null;
  const tr = rampTrouble();
  const badIds = new Set((tr.list || []).filter(x => x.bad).map(x => x.id));
  /* A moment on an archived/trimmed-away clip is NOT IN THE VIDEO. Josh, 2026-09-14:
     "the two moments associated with the one that I archived are still there... I
     expected those moments would not be here." Show them faded and struck out rather
     than as live marks, so the state is obvious and nothing silently disappears. */
  const goneIds = new Set((tr.all || []).filter(x => !x.inVideo).map(x => x.id));
  for (const box of [$('gt-amarks'), $('gt-vmarks')])
    for (const el of box.querySelectorAll('i[data-id]')) {
      el.classList.toggle('clash', el.dataset.id === hitId);
      el.classList.toggle('broken', badIds.has(el.dataset.id));
      el.classList.toggle('shelved', goneIds.has(el.dataset.id));
    }

  /* Park the stage on the chunk's FIRST FRAME whenever it isn't looping. Without this
     the player sat at 0 while the chunk was somewhere else entirely (a blank frame at
     the top of the screen), because only the loop ever seeked it. `into` is already a
     file position; `cv` may also need a different source than it currently holds. */
  if (!chunkLooper && !cvSeeking) {
    const hit = dAt(chunkStart);
    if (hit && hit.src && hit.src.proxy) {
      const url = `/media/proxy/${hit.src.proxy}`;
      const want = hit.into;
      if (!cv.src.endsWith(url)) {
        cvSeeking = true;
        cv.src = url;
        cv.addEventListener('loadeddata', () => {
          try { cv.currentTime = want; } catch {}
          cvSeeking = false;
        }, { once: true });
      } else if (cv.readyState >= 2 && Math.abs(cv.currentTime - want) > 0.12) {
        try { cv.currentTime = want; } catch {}
      }
    }
  }
}


/* Drag the block: middle slides it, each edge resizes from that end (his pick — the
   way every editor trims a clip). All three go through setChunkStart/setGrabLen, so
   the keyboard, the phone and this stay one mechanism. */
function wireGrabberDrag() {
  const bar = $('gt-vbar'), blk = $('gt-vblock');
  if (!bar || !blk) return;
  const span = () => dTotal() || (v.duration || 0);
  const secsPerPx = () => { const w = bar.getBoundingClientRect().width || 1; return span() / w; };

  const start = (e, mode) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, s0 = chunkStart, l0 = S.grabLen || 0, k = secsPerPx();
    const t = e.currentTarget;
    t.setPointerCapture(e.pointerId);
    t.onpointermove = ev => {
      const d = (ev.clientX - x0) * k;
      if (mode === 'move') setChunkStart(s0 + d, true);
      else if (mode === 'l') {                 // left edge: move the start, hold the end
        const end = s0 + l0;
        const ns = Math.max(0, Math.min(end - 0.1, s0 + d));
        setGrabLen(end - ns); setChunkStart(ns, true);
      } else {                                 // right edge: move the end
        setGrabLen(Math.max(0.1, l0 + d));
      }
    };
    t.onpointerup = () => { t.onpointermove = t.onpointerup = null; dSaveView(); };
  };
  // one target per intent — never the same pixel twice
  $('gt-mv').onpointerdown = e => start(e, 'move');
  $('gt-el').onpointerdown = e => start(e, 'l');
  $('gt-er').onpointerdown = e => start(e, 'r');

  // click the empty bar to jump the chunk there
  bar.addEventListener('click', e => {
    if (e.target !== bar && !e.target.classList.contains('gtmarks')
        && !e.target.classList.contains('gtseams')) return;
    const r = bar.getBoundingClientRect();
    setChunkStart(((e.clientX - r.left) / r.width) * span() - (S.grabLen || 0) / 2, true);
  });
  /* click the audio bar to set LANDS AT — and keep holding to DRAG it (Josh, 2026-09-26:
     "I can click on the audio line... but I can't drag anything"). Grabbing inside the
     green block drags it by where you grabbed; anywhere else jumps there, then follows. */
  /* THE GREEN BLOCK IS GRABBED FIRST. Josh, 2026-09-26: "I want to make sure that that's
     the first thing I'm gonna grab, not anything else." A CAPTURE-phase listener runs before
     the silences' and moments' own handlers, so a press inside the block (≥ 8px wide target,
     for a thin one) always drags the block; the click that follows is swallowed too. */
  let ablkGrabbed = false;
  $('gt-abar').addEventListener('click', e => {
    if (ablkGrabbed) { ablkGrabbed = false; e.stopPropagation(); e.preventDefault(); } }, true);
  $('gt-abar').addEventListener('pointerdown', e => {
    const aTot = audioTotal(); if (!aTot) return;
    const bar = e.currentTarget, r = bar.getBoundingClientRect(), k = aTot / (r.width || 1);
    const len = nextOLen(), bx0 = r.left + dAudioAt / k, bx1 = r.left + (dAudioAt + len) / k;
    const pad = Math.max(0, (8 - (bx1 - bx0)) / 2);
    const onBlock = e.clientX >= bx0 - pad && e.clientX <= bx1 + pad;
    const t = e.target;
    if (!onBlock && (t.tagName === 'I' || t.id === 'gt-aplay')) return;   // silences + moments own clicks OFF the block
    e.preventDefault(); e.stopPropagation();
    ablkGrabbed = onBlock && t.tagName === 'I';
    const at = (e.clientX - r.left) * k;
    const a0 = onBlock ? dAudioAt : at;
    if (a0 !== dAudioAt) dSetAudioAt(a0);
    const x0 = e.clientX;
    bar.setPointerCapture(e.pointerId);
    bar.onpointermove = ev => dSetAudioAt(a0 + (ev.clientX - x0) * k);
    bar.onpointerup = () => { bar.onpointermove = bar.onpointerup = null; };
  }, true);
  $('gt-aplay').onclick = () => $('da-play').click();
}
wireGrabberDrag();

/* paintChunkTrack() removed 2026-09-11 — the grabber's VIDEO track supersedes it */
function renderLens() {
  const box = $('lens');
  box.innerHTML = '';
  const f = $('clenfield');
  if (f && document.activeElement !== f) f.value = +(+S.grabLen).toFixed(2);
  LENS.forEach(l => {
    const b = document.createElement('button');
    b.className = 'len' + (Math.abs(l - S.grabLen) < 1e-6 ? ' on' : '');
    b.textContent = l + 's';
    b.onclick = () => setGrabLen(l);
    box.appendChild(b);
  });
}

async function grab() {
  if (!cur) { toast('load a video first'); return; }
  if (mode === 'ramp') return markRealTime();
  if (editingId) { finishEditing(); return; }   // G means "I'm done with this one"
  try {
    const hit = dAt(chunkStart) || { src: cur, into: chunkStart };
    await api('/api/grab', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: hit.src.id, start: hit.into, len: S.grabLen,
                             audioAt: S.audio.length ? dAudioAt : undefined, rate: grabRate() }) });
    const landed = dAudioAt;
    await refresh();
    /* next mark lands right after this one, so marking in a row still reads left to right */
    if (S.audio.length) dSetAudioAt(landed + nextOLen());
    toast(`added ${S.grabLen}s at ${fmtRate(grabRate())}, at ${fmt(landed)} in the audio`);
  } catch (e) { toast(e.message, true); }
}

/* ---- DESKTOP: where in the audio the next moment lands ----
   Josh, 2026-09-10: "when we mark real time, we're not choosing the audio being hooked
   up to it... that whole lower right interface in speed mode can just change to whatever
   the mobile is where we can change what sound we're trying to associate it."
   Same model as the phone: `dAudioAt` is HIS position, moved only by him, and
   markRealTime() pins the new moment there. */
let dAudioAt = 0;
let dAudioEl = null, dAudioPlaying = false;
const dAudioTotal = () => S.audio.reduce((a, x) => a + (x.duration || 0), 0);

function dEnsureAudio() {
  if (!S.audio.length) return null;
  if (!dAudioEl) { dAudioEl = document.createElement('audio'); dAudioEl.preload = 'auto';
                   document.body.appendChild(dAudioEl);
                   dAudioEl.addEventListener('ended', () => { dAudioPlaying = false; paint(); }); }
  const want = `/media/audio/${S.audio[0].file}`;
  if (!dAudioEl.src.endsWith(want)) dAudioEl.src = want;
  return dAudioEl;
}
/* THE WHOLE CHUNK STAYS INSIDE THE AUDIO — its END, not just its start. Josh,
   2026-09-22: "it could butt up right against the end... but it can't go beyond it.
   Right now I think we just make sure that the starting point doesn't go beyond the
   end of the audio, but it should be like the whole audio can't go beyond the end of
   the audio, similar to how we do the video." It stops flush with the end: the plan
   now skips any video left with no audio after the last moment, so flush is valid. */
function dSetAudioAt(t) {
  const total = dAudioTotal(); if (!total) return;
  const len = Math.min(nextOLen(), total);          // the AUDIO it takes, at its rate
  dAudioAt = Math.max(0, Math.min(total - len, t));
  const a = dEnsureAudio();
  if (a) { const put = () => { try { a.currentTime = dAudioAt; } catch {} };
           if (a.readyState >= 1) put(); else a.addEventListener('loadedmetadata', put, { once: true }); }
  dSaveView();        // every way the head moves funnels through here (dSaveView is
                      // debounced and no-ops while a restore is in flight)
  paint();
}
$('da-bar').addEventListener('click', e => {
  const total = dAudioTotal(); if (!total) return;
  const r = e.currentTarget.getBoundingClientRect();
  dSetAudioAt(((e.clientX - r.left) / r.width) * total);
});
/* BOTH audio rows: the grabber's visible one (.gtskip) and the hidden legacy .daskip,
   which other code still delegates to. Selecting on [data-da] catches every one — the
   earlier `.daskip button` selector left all 8 VISIBLE buttons dead, and a coordinate
   click landed on the hidden row so the test still passed. */
[...document.querySelectorAll('[data-da]')].forEach(b => {
  b.onclick = () => dSetAudioAt(dAudioAt + parseFloat(b.dataset.da));
});

/* ---- the other two nudge rows, mirroring the phone (2026-09-11) ----
   Josh: "I really want the nudge ahead system... three bars that we control the things.
   So we can control the audio, we can control the how long the [chunk is] and where the
   chunk is at." Each row drives the SAME setter the keyboard and the phone already use,
   so there is one path per idea rather than three that can drift. */
[...document.querySelectorAll('[data-vskip]')].forEach(b => {
  b.onclick = () => setChunkStart(chunkStart + parseFloat(b.dataset.vskip), true);
});
[...document.querySelectorAll('[data-lskip]')].forEach(b => {
  b.onclick = () => setGrabLen((S.grabLen || 1) + parseFloat(b.dataset.lskip));
});
// click the video bar to put the chunk there — same gesture as the audio bar
$('da-play').onclick = () => {
  const a = dEnsureAudio(); if (!a) { toast('no audio bed yet'); return; }
  if (dAudioPlaying) {
    /* Stop does NOT move LANDS AT. Josh, 2026-09-24: "it shouldn't adjust after I hit
       stop, it should just stop and then let me manually adjust where the audio is at...
       if I clicked play, waited two seconds, hit stop and clicked play again, I would
       imagine it would start from the exact same spot." Play always starts from LANDS AT. */
    a.pause(); dAudioPlaying = false;
    try { a.currentTime = dAudioAt; } catch {}
  } else { a.currentTime = dAudioAt; a.play().catch(() => {}); dAudioPlaying = true; }
  paint();
};

/* ---------- SPEED mode ----------
   He marks windows that must play at REAL speed; everything else is compressed so
   the whole video lands exactly on the audio. */
/* Would a mark placed right now collide with one that already exists? Returns the
   moment it would hit, or null. Josh, 2026-09-11: "if the cursor is overlapping
   something, it shouldn't let me mark it in real time. It should remove that as an
   option." Checking BEFORE the write beats explaining an impossible plan afterwards. */
function markCollision() {
  const from = dAudioAt, to = dAudioAt + nextOLen();
  const aTot = audioTotal();
  /* only what actually plays can be collided with — a moment on an archived or
     trimmed-away clip holds no ground in the audio (see rampInVideo) */
  for (const r of (S.ramps || [])) {
    if (!rampInVideo(r)) continue;
    const rs = +r.audioAt || 0, re = rs + oLen(r);
    if (from < re - 0.01 && to > rs + 0.01) return { kind: 'overlap', r };
  }
  if (aTot && to > aTot + 0.01) return { kind: 'past-end', over: to - aTot };
  return null;
}

async function markRealTime() {
  const clash = markCollision();
  if (clash) {
    if (clash.kind === 'past-end') {
      toast(`that would run ${clash.over.toFixed(2)}s past the end of your audio — `
          + `move it earlier or make it shorter`, true);
    } else {
      toast(`that would land on top of the moment at ${fmt(clash.r.audioAt)} — `
          + `move the audio playhead clear of it`, true);
    }
    return;                                   // never create a mark we know is broken
  }
  try {
    const hit = dAt(chunkStart) || { src: cur, into: chunkStart };
    // a mark also needs WHERE IN THE AUDIO it lands — default to after the last one
    const landAt = dAudioAt;                 // WHERE HE PUT IT — his choice, not a default
    await api('/api/ramp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: hit.src.id, start: hit.into, len: S.grabLen,
                             audioAt: landAt, rate: grabRate() }) });
    await refresh();
    toast(`${S.grabLen}s at ${fmtRate(grabRate())}, landing at ${fmt(landAt)} in the audio`);
  } catch (e) { toast(e.message, true); }
}
function paintPlan() {
  // the desktop audio-placement track rides with the plan box
  const showBed = (mode === 'ramp');
  $('dabed').hidden = !showBed;
  if (showBed) {
    const at = dAudioTotal();
    const live = (dAudioPlaying && dAudioEl) ? dAudioEl.currentTime : dAudioAt;
    $('da-pos').textContent = `${fmt(live)} / ${fmt(at)}`;
    $('da-head').style.left = at ? (live / at) * 100 + '%' : '0%';
    $('da-play').textContent = dAudioPlaying ? '■' : '▶';
    $('da-lands').textContent = at ? `at ${fmt(dAudioAt)}` : 'add an audio bed first';
    // his existing moments, so he can see what is already claimed
    const mb = $('da-marks');
    /* ⚠️ the signature must carry IN-VIDEO state too — archiving a clip changes none of
       audioAt/len/total, so without it the track keeps its stale solid blocks and the
       space still LOOKS claimed after the collision check has stopped claiming it */
    const sig = (S.ramps || []).map(r => `${r.audioAt}:${r.len}:${rateOf(r)}:${rampInVideo(r) ? 1 : 0}`)
      .join(',') + '|' + at.toFixed(1);
    if (mb.dataset.sig !== sig) {
      mb.dataset.sig = sig; mb.innerHTML = '';
      if (at) for (const r of (S.ramps || [])) {
        const i = document.createElement('i');
        i.style.left = ((r.audioAt || 0) / at) * 100 + '%';
        i.style.width = Math.max(0.6, (oLen(r) / at) * 100) + '%';
        // faded + dashed: still on screen, but this audio is OPEN to mark
        if (!rampInVideo(r)) i.className = 'shelved';
        mb.appendChild(i);
      }
    }
  }
  if (mode !== 'ramp' || !plan) return;
  $('pl-real').textContent = `${plan.windows} · ${plan.realTotal}s`;
  const sp = $('pl-speed');
  sp.textContent = plan.speed ? `${plan.speed}×` : '—';
  sp.classList.toggle('hot', !!plan.speed && plan.speed > 1);
  $('pl-total').textContent = plan.audioTotal ? `${plan.audioTotal}s (your audio)` : 'no audio yet';
  $('pl-why').hidden = !plan.why;
  $('pl-why').textContent = plan.why || '';
}

/* ---------- editing one already in the output ---------- */
/* Clicking a chunk opens the CENTER editor — the one and only way to change a chunk.
   Josh, 2026-09-23: "when I click on the actual chunk at the bottom... it should be
   opening up that center chunk to update, not updating it any other way... the only
   way to update a chunk should be able to have that interface pop up in the middle."
   It used to put the MAIN PAGE into an editing mode where moving the playhead or the
   length silently rewrote the chunk, with "✓ Update chunk" on the right. That whole
   path is retired: editingId is never set any more, so pushChunkEdit() can't fire. */
function openChunk(id) {
  const c = S.timeline.find(x => x.id === id);
  if (!c) return;
  const src = S.sources.find(s => s.id === c.sourceId);
  if (!src || !src.ready) { toast('that chunk’s video is not loaded'); return; }
  editingId = null;
  dOpenChunk(id);
}
/* Done editing: the change is already saved (every tweak writes through), so this
   just hands him back a NEW chunk — which was the thing he could not figure out. */
function finishEditing(silent) {
  if (!editingId) return;
  editingId = null;
  renderChips();
  paint();
  if (!silent) toast('saved — back to a new chunk');
}
function closeChunk() { finishEditing(true); stopChunk(); }

/* ---------- the OUTPUT ----------
   Two modes, two genuinely separate outputs. GRAB stacks chunks; SPEED squeezes the
   whole input onto the audio. They share nothing but the input videos and the bed.

   THE AUDIO LEADS (Josh, 2026-09-09): "we are just playing audio as long as there's
   video. So if I want to hear the audio and I only have two seconds of video, I'm
   gonna hear two seconds of audio instead of the whole audio." The audio is the
   TARGET LENGTH — so it is the clock, and the video plays against it. Video running
   out no longer stops playback.

   Real PAUSE, not stop-and-rewind — pause holds position, play resumes there. */

/* Where each GRAB chunk plays: at its own audioAt, in audio order; cut short where the
   next begins; gaps hold the frame before. TWIN of server.js chunkPlaces(). */
function chunkPlaces() {
  const list = (S.timeline || []).map((c, i) => ({ c, i, at: +c.audioAt || 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  return list.map((p, k) => {
    const next = list[k + 1];
    const len = Math.max(0, Math.min(oLen(p.c), next ? next.at - p.at : oLen(p.c)));   // OUTPUT seconds
    return { c: p.c, i: p.i, at: p.at, len };
  });
}
// the GRAB output runs to the END of the last chunk (not the sum — they can have gaps)
const total = () => { const pl = chunkPlaces(); const l = pl[pl.length - 1];
                      return l ? l.at + l.len : 0; };
const audioTotal = () => S.audio.reduce((a, x) => a + (x.duration || 0), 0);

// what THIS mode's output is worth, in seconds
function outLength() {
  return mode === 'ramp' ? audioTotal() : total();
}
// does this mode have anything to play at all?
function outHasContent() {
  return mode === 'ramp' ? (audioTotal() > 0 && S.sources.some(x => x.ready))
                         : S.timeline.length > 0;
}

let outRAF = null;          // the drive loop
let lastSeg = null, lastIdx = -1;   // what is highlighted right now
let outPaused = false;      // paused (position held) vs stopped (position cleared)
let audioIdx = 0;           // which bed file is playing
let audioBase = 0;          // seconds of bed that finished before this file

function loadOutputPlayer() {
  const c = S.timeline[0];
  if (c) {
    const src = S.sources.find(s => s.id === c.sourceId);
    if (src) { ov.src = `/media/proxy/${src.proxy}`; ov.onloadeddata = () => { ov.currentTime = c.start; }; }
    return;
  }
  const first = S.sources.find(s => s.ready);
  if (first) ov.src = `/media/proxy/${first.proxy}`;
}

/* ---- the audio bed: one element, files back to back, position always known ---- */
function bedPosition() {
  if (!audioEl) return tlPos;
  return audioBase + (audioEl.currentTime || 0);
}
function buildAudio(startAt = 0) {
  if (audioEl) { audioEl.pause(); audioEl.remove(); audioEl = null; }
  if (!S.audio.length) return;
  audioEl = document.createElement('audio');
  audioEl.preload = 'auto';
  document.body.appendChild(audioEl);

  // find which bed file `startAt` lands in
  let i = 0, base = 0;
  while (i < S.audio.length - 1 && base + (S.audio[i].duration || 0) <= startAt) {
    base += S.audio[i].duration || 0; i++;
  }
  audioIdx = i; audioBase = base;
  const into = Math.max(0, startAt - base);

  audioEl.onended = () => {
    if (!outPlaying) return;
    audioBase += S.audio[audioIdx].duration || 0;
    audioIdx++;
    if (audioIdx >= S.audio.length) { stopOutput(); toast('end of output'); return; }
    audioEl.src = `/media/audio/${S.audio[audioIdx].file}`;
    audioEl.play().catch(() => {});
  };
  audioEl.src = `/media/audio/${S.audio[audioIdx].file}`;
  audioEl.onloadedmetadata = () => { if (into > 0) audioEl.currentTime = into; };
  if (outPlaying) audioEl.play().catch(() => {});
}

/* ---- GRAB: which chunk covers output-second t, and where inside it ---- */
function chunkAt(t) {
  const pl = chunkPlaces().filter(p => p.len > 0.01);
  if (!pl.length) return null;
  if (t < pl[0].at) return { i: pl[0].i, c: pl[0].c, into: 0, hold: true };      // lead-in
  for (let k = 0; k < pl.length; k++) {
    const p = pl[k];
    if (t < p.at + p.len) return { i: p.i, c: p.c, into: t - p.at };
    const next = pl[k + 1];
    if (next && t < next.at) return { i: p.i, c: p.c, into: Math.max(0, p.len - 0.04), hold: true };
  }
  return null;
}
/* ---- SPEED: map an output second onto a source second, using the same plan the
        render uses — real windows play 1:1, everything else at plan.speed ---- */
/* The SEQUENCE the speed output actually plays: sped-up → real → sped-up → real …
   Josh, 2026-09-09: "you're still sort of having to assemble the parts that are
   sped up and then real time and then sped up and real time. So that back and forth
   is what I'm imagining from the output screen."
   ONE source of truth — the chips list this and the player walks this, so what he
   sees listed is exactly what plays. Mirrors renderRamp() on the server. */
function rampSegments() {
  /* THE SERVER OWNS THE MATH. Its rampPlan() computes a per-span speed from each
     mark's audio anchor; recomputing it here would let the preview and the export
     drift apart. We just map its spans onto the sources for playback. */
  if (!plan || !plan.spans) return [];
  const out = [];
  for (const sp of plan.spans) {
    if (sp.srcTo - sp.srcFrom <= 0.02) continue;
    let acc = 0;
    let a = sp.srcFrom;
    for (const src of S.sources) {
      const d = useLen(src), s0 = acc, s1 = acc + d;   // trimmed length owns the line
      acc = s1;
      if (sp.srcTo <= s0 || a >= s1) continue;
      const from = Math.max(a, s0), to = Math.min(sp.srcTo, s1);
      if (to - from <= 0.02) continue;
      const frac0 = (from - sp.srcFrom) / (sp.srcTo - sp.srcFrom);
      const frac1 = (to   - sp.srcFrom) / (sp.srcTo - sp.srcFrom);
      const spanOut = sp.outTo - sp.outFrom;
      /* `from`/`to` are TIMELINE seconds; `src.from`/`src.to` must be positions INSIDE
         the file, so add back whatever was trimmed off the head — exactly as the
         server's renderRamp() does. Without this the preview played a trimmed clip
         from 0 while the export cut from trimIn (480s out for Josh, 2026-09-11:
         "I basically trimmed out the whole beginning of that video but I'm still
         seeing the beginning"). Preview and export MUST convert identically. */
      const t0 = useIn(src);
      out.push({
        src, from: from - s0 + t0, to: to - s0 + t0, real: sp.kind === 'real',
        outFrom: sp.outFrom + frac0 * spanOut,
        outLen: (frac1 - frac0) * spanOut,
        rate: sp.kind === 'real' ? (sp.speed || 1) : (sp.speed || null),   // a moment's own rate
        id: sp.id,
      });
      a = to;
    }
  }
  return out;
}

function rampAt(t) {
  if (!plan || !plan.ok) return null;
  const segs = rampSegments();
  for (const g of segs) {
    if (t < g.outFrom + g.outLen) {
      const frac = g.outLen > 0 ? (t - g.outFrom) / g.outLen : 0;
      return { src: g.src, at: g.from + frac * (g.to - g.from), real: g.real, rate: g.rate, seg: g };
    }
  }
  return null;
}

/* Leaving theater must NOT rewind. Josh, 2026-09-11: "it should be playing from the
   last time it was playing, not always from the beginning." stopOutput() zeroes tlPos,
   which is right for a real stop and wrong for closing the overlay — so closing pauses
   and remembers, and reopening seeks back there. The position rides in the saved view,
   so it survives a reload too. */
let outLastPos = 0;
function pauseOutputKeepPos() {
  if (outPlaying || outPaused) outLastPos = tlPos;
  outPlaying = false; outPaused = false;
  cancelAnimationFrame(outRAF); outRAF = null;
  ov.pause();
  if (audioEl) { audioEl.pause(); audioEl.remove(); audioEl = null; }
  paint();
}
function resumeOutputPos() {
  const end = outLength();
  const at = Math.max(0, Math.min(end ? end - 0.05 : 0, outLastPos || 0));
  if (end && at > 0.02) seekOutput(at, false);
}
function stopOutput() {
  outPlaying = false; outPaused = false;
  cancelAnimationFrame(outRAF); outRAF = null;
  ov.pause();
  if (audioEl) { audioEl.pause(); audioEl.remove(); audioEl = null; }
  tlPos = 0; outIdx = 0; audioIdx = 0; audioBase = 0;
  lastSeg = null; lastIdx = -1;
  renderChips();
  paint();
}
function pauseOutput() {
  if (!outPlaying) return;
  outPlaying = false; outPaused = true;
  cancelAnimationFrame(outRAF); outRAF = null;
  ov.pause();
  if (audioEl) audioEl.pause();
  paint();
}
function playOutput() {
  if (!outHasContent()) {
    toast(mode === 'ramp' ? 'speed mode needs an input video and an audio bed'
                          : 'nothing in the output yet');
    return;
  }
  if (mode === 'ramp' && (!plan || !plan.ok)) { toast(plan && plan.why ? plan.why : 'no plan yet'); return; }

  const resumeAt = outPaused ? tlPos : 0;
  outPaused = false;
  outPlaying = true;
  tlPos = resumeAt;

  if (S.audio.length) {
    if (!audioEl) buildAudio(resumeAt);
    else audioEl.play().catch(() => {});
  }
  driveOutput();
  paint();
}
function toggleOutput() { outPlaying ? pauseOutput() : playOutput(); }
$('outplay').onclick = toggleOutput;
$('outstop').onclick = stopOutput;

/* The drive loop. The clock is the AUDIO when there is one (that is the target
   length); otherwise it is wall time. The video is steered to follow — and when the
   video runs out, playback keeps going. Silence-over-black is the honest picture of
   "your audio is longer than what you've built." */
function driveOutput() {
  let last = performance.now();
  const step = () => {
    if (!outPlaying) return;
    const now = performance.now();
    const dt = (now - last) / 1000; last = now;

    if (audioEl && S.audio.length) tlPos = bedPosition();
    else tlPos += dt;

    const end = outLength();
    if (end > 0 && tlPos >= end - 0.005 && !(audioEl && S.audio.length)) {
      stopOutput(); toast('end of output'); return;
    }

    if (mode === 'ramp') driveRampVideo();
    else driveGrabVideo();

    // keep the highlighted segment/chunk in step with what is playing
    const nowSeg = mode === 'ramp' ? (rampAt(tlPos) || {}).seg : null;
    if (mode === 'ramp') { if (nowSeg !== lastSeg) { lastSeg = nowSeg; renderChips(); } }
    else if (outIdx !== lastIdx) { lastIdx = outIdx; renderChips(); }

    paint();
    outRAF = requestAnimationFrame(step);
  };
  outRAF = requestAnimationFrame(step);
}

function wantSrc(src) {
  const url = `/media/proxy/${src.proxy}`;
  if (!ov.src.endsWith(url)) { ov.src = url; return false; }   // still loading
  return ov.readyState >= 2;
}
function driveGrabVideo() {
  const hit = chunkAt(tlPos);
  if (!hit) {                       // past the last chunk — audio keeps running
    if (!ov.paused) ov.pause();
    outIdx = S.timeline.length;
    return;
  }
  outIdx = hit.i;
  const src = S.sources.find(s => s.id === hit.c.sourceId);
  if (!src || !src.ready) return;
  if (!wantSrc(src)) return;
  const r = rateOf(hit.c);
  const want = hit.c.start + hit.into * r;       // `into` is OUTPUT seconds; footage runs at r
  if (hit.hold || !PLAYABLE(r)) {   // a gap holds the frame; an extreme rate steers by seeking
    if (!ov.paused) ov.pause();
    if (!ov.seeking && Math.abs(ov.currentTime - want) > (hit.hold ? 0.05 : 1 / 30)) ov.currentTime = want;
    return;
  }
  if (Math.abs(ov.playbackRate - r) > 0.01) ov.playbackRate = r;
  if (Math.abs(ov.currentTime - want) > 0.25) ov.currentTime = want;   // resync only when adrift
  if (ov.paused) ov.play().catch(() => {});
}
function driveRampVideo() {
  const hit = rampAt(tlPos);
  if (!hit) { if (!ov.paused) ov.pause(); return; }
  if (!wantSrc(hit.src)) return;
  /* Browsers only PLAY between 0.25x and 4x. Outside that (a 63s lead-in squeezed into
     half a second is 132x) the old code clamped to 4x and then kept yanking the player
     back — so the fast part showed as a frozen frame, not the slide building. Josh,
     2026-09-23: "I don't see any of the movement of the video there." Outside the
     playable range, STEER BY SEEKING: hold the player paused and put it on the exact
     frame the export shows at this moment — a flipbook that matches the render. */
  const r = hit.rate || 1;
  if (r > 4 || r < 0.25) {
    if (!ov.paused) ov.pause();
    if (!ov.seeking && Math.abs(ov.currentTime - hit.at) > 1 / 30) {
      if (r > 4 && ov.fastSeek) ov.fastSeek(hit.at); else ov.currentTime = hit.at;
    }
    return;
  }
  if (Math.abs(ov.playbackRate - r) > 0.01) ov.playbackRate = r;
  if (Math.abs(ov.currentTime - hit.at) > 0.35) ov.currentTime = hit.at;
  if (ov.paused) ov.play().catch(() => {});
}

/* ---------- painting ---------- */
function paint() {
  /* The old INPUT scrub bar is gone — the grabber's own VIDEO track replaced it
     (2026-09-11). paintGrabber() draws the playhead, the block, the marks and the
     seams now. */

  // the chunk panel
  $('chunkwhere').textContent = cur ? `${fmt(chunkStart)} → ${fmt(chunkStart + S.grabLen)}` : '—';
  const gl = S.grabLen || 0;
  $('clen').textContent = (Math.round(gl * 100) % 10 ? gl.toFixed(2) : gl.toFixed(1)) + 's';
  $('chunkstate').textContent = editingId
    ? `editing chunk ${S.timeline.findIndex(x => x.id === editingId) + 1} — changes save as you go`
    : 'new — not added yet';
  $('chunkstate').classList.toggle('editing', !!editingId);
  paintPlan();
  const act = $('chunkaction');
  if (mode === 'ramp') {
    act.innerHTML = 'Mark real-time &nbsp;<span style="opacity:.7">G</span>';
    act.style.background = 'var(--pie-sheen)'; act.style.borderColor = 'var(--pie-sheen)';
    act.style.color = '#fff';
    $('chunkstate').textContent = `${(S.ramps || []).length} real-time window(s)`;
    $('chunkhints').innerHTML =
      '<span class="hgroup"><kbd>P</kbd><em>play this window</em></span>' +
      '<span class="hgroup"><kbd>G</kbd><em>mark it real-time</em></span>';
  } else if (editingId) {
    act.innerHTML = 'Done editing &nbsp;<span style="opacity:.7">G</span>';
    act.style.background = 'var(--warn)'; act.style.borderColor = 'var(--warn)';
    act.style.color = '#221a10';
    $('chunkhints').innerHTML =
      '<span class="hgroup"><kbd>P</kbd><em>play the chunk</em></span>' +
      '<span class="hgroup"><kbd>G</kbd><em>done — back to a new chunk</em></span>' +
      '<span class="hgroup"><kbd>esc</kbd><em>same thing</em></span>';
  } else {
    act.innerHTML = 'Add to output &nbsp;<span style="opacity:.7">G</span>';
    act.style.background = ''; act.style.borderColor = ''; act.style.color = '';
    $('chunkhints').innerHTML =
      '<span class="hgroup"><kbd>P</kbd><em>play the chunk</em></span>' +
      '<span class="hgroup"><kbd>G</kbd><em>add it to the output</em></span>';
  }
  const into = Math.max(0, Math.min(S.grabLen, cv.currentTime - dChunkInFile()));
  $('cprog').style.width = (S.grabLen ? (into / S.grabLen) * 100 : 0) + '%';
  $('cplay').textContent = chunkLooper ? '❚❚ Pause' : '▶ Play';
  $('tpremove').hidden = !(editingId && mode !== 'ramp');
  $('tpmark').innerHTML = (editingId ? '✓ Update chunk' : '✚ Mark it') + ' <kbd>G</kbd>';
  $('cplay').classList.toggle('playing', !!chunkLooper);

  paintSubs();
  paintGrabber();

  // output — each mode shows ITS OWN output, never the other's
  $('tlcur').textContent = fmt(tlPos);
  $('tltot').textContent = fmt(outLength());
  $('outbadge').textContent = mode === 'ramp'
    ? ((S.ramps || []).length ? ` ${(S.ramps || []).length}` : '')
    : (S.timeline.length ? ` ${S.timeline.length}` : '');
  $('outmode').textContent = mode === 'ramp' ? 'SPEED output' : 'GRAB output';
  $('outmode').className = 'outtag ' + (mode === 'ramp' ? 'speed' : 'grab');
  /* 🚨 THE OUTPUT VIEW MUST CARRY THE REAL EXPLANATION, NOT THE SERVER'S BARE STRING.
     Josh, 2026-09-22, having hit exactly this: "I hit space and it says no room before
     a moment... I don't know what it means... Please explain what is going on
     here." The plain-English diagnosis and the one-click fixes existed the whole time —
     on the INPUT screen, behind the output overlay he was standing in. So the screen he
     was actually looking at showed him the one sentence that explains nothing.
     `rampTrouble()` is the same source the input panel reads. */
  $('outinfo').textContent = mode === 'ramp'
    ? (plan && plan.ok
        ? `whole video squeezed onto your audio · ${plan.windows} real-time window(s) · rest at ${plan.speed}×`
        : (plan && plan.why
            ? ((S.ramps || []).length
                ? `${rampTrouble().msg} — press esc for the fixes`
                : plan.why)
            : 'speed mode'))
    : (S.timeline.length
        ? `${S.timeline.length} chunk(s) · ${total().toFixed(1)}s of video`
          + (S.audio.length ? ` · audio runs ${audioTotal().toFixed(1)}s` : ' · no audio yet')
        : 'nothing added yet');
  $('outhint').textContent = mode === 'ramp'
    ? 'mark real-time windows on the input · esc back'
    : 'click a chunk to edit it · esc back';
  // the output timeline
  const oEnd = outLength();
  $('ohead').style.left = oEnd ? (tlPos / oEnd) * 100 + '%' : '0%';
  const ob = $('osegs');
  const sig = mode + '|' + oEnd.toFixed(2) + '|' + (mode === 'ramp'
    ? (plan && plan.spans ? plan.spans.map(x =>
        `${x.kind}${x.outFrom.toFixed(2)}-${x.outTo.toFixed(2)}`).join(',') : '')
      + '|' + (S.ramps || []).map(r => `${r.id}:${r.audioAt}:${r.len}:${rateOf(r)}`).join(',')
    : S.timeline.map(c => `${c.id}:${c.len}:${c.audioAt}:${rateOf(c)}`).join(','));
  if (ob.dataset.sig !== sig) {          // only rebuild when the shape actually changes
    ob.dataset.sig = sig;
    ob.innerHTML = '';
    if (oEnd) {
      if (mode === 'ramp') {
        let mi = 0;
        for (const g of rampSegments()) {
          const i = document.createElement('i');
          // his moments carry a colour index matching their chip; fillers stay neutral
          i.className = g.real ? ('real m' + ((mi++) % 6)) : 'fast';
          i.style.left = (g.outFrom / oEnd) * 100 + '%';
          i.style.width = Math.max(0.4, (g.outLen / oEnd) * 100) + '%';
          ob.appendChild(i);
        }
      } else {
        for (const p of chunkPlaces()) {
          const i = document.createElement('i');
          i.className = 'real';
          i.style.left = (p.at / oEnd) * 100 + '%';
          i.style.width = Math.max(0.4, (p.len / oEnd) * 100) + '%';
          ob.appendChild(i);
        }
      }
    }
  }

  $('outplay').innerHTML = (outPlaying ? '❚❚ Pause' : (outPaused ? '▶ Resume' : '▶ Play output'))
    + ' &nbsp;<span style="opacity:.7">space</span>';
  $('outstop').hidden = !(outPlaying || outPaused);
}
setInterval(paint, 100);
/* 📥 Inbox imports show up the INSTANT the server has them — pushed, not polled (Josh,
   2026-09-26: "it needs to be immediate... it can't be this polling thing"). A new clip is
   added to ASSETS, scrolled into view and flashed, and the note says where the original went. */
async function onSourcesPush(d) {
  const had = new Set((S.sources || []).map(x => x.id));
  await refresh();
  if (!$('screen-assets').hidden) renderAssets();
  if (d && d.added && !had.has(d.added)) {
    toast(`📥 ${d.name} is in — processing (original kept in Movies › Magpie Inbox › Imported)`);
    setTimeout(() => { const i = S.sources.findIndex(x => x.id === d.added);
      const el = i < 0 ? null : document.querySelector(`#screen-assets .asscard[data-idx="${i}"]`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.animate([{ outline: '3px solid #7fe0ab' }, { outline: '3px solid transparent' }], { duration: 2400 }); } }, 150);
  } else if (d && d.ready) toast(`✓ ${d.name} is ready to use`);
}
(function listen() {
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('sources', ev => { let d = {}; try { d = JSON.parse(ev.data); } catch {} onSourcesPush(d); });
    es.onerror = () => { es.close(); setTimeout(listen, 2000); };     // server restarted: reconnect
  } catch {}
})();

/* DRAG THE CHUNK with the mouse (his ask, 2026-09-10). Dragging the marker moves
   the chunk; clicking bare track still just parks the playhead. */
/* the old scrub-bar drag and click moved onto the grabber's VIDEO track */

/* ---------- keys ----------
   S = chunk starts here (tap) or nudge it (held + arrows).
   R = held + arrows resizes. Everything else is the input. */
let holdS = false, holdR = false, sUsedArrows = false;

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key.toLowerCase();

  /* While the trim modal is up it owns the keyboard — otherwise Space would toggle the
     INPUT player behind it and the screen keys would jump him off the clip he's editing. */
  if (!$('tmodal').hidden) {
    if (e.code === 'Space') { e.preventDefault(); tPlay(); return; }
    if (e.key === 'Escape') { e.preventDefault(); tClose(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 1 : 0.1;
      tv.currentTime = Math.max(0, Math.min(tFull,
        (tv.currentTime || 0) + (e.key === 'ArrowRight' ? step : -step)));
      tPaint(); return;
    }
    return;                                   // swallow the rest
  }

  /* The center chunk / moment editor owns the keyboard too — otherwise G behind it would
     mark a NEW chunk and space would play the main page. Space/L loops, Esc closes. */
  if (!$('smodal').hidden) {
    if (e.target && e.target.tagName === 'INPUT' && e.key !== 'Escape') return;   // let him type
    if (e.code === 'Space') { e.preventDefault(); sHear(); return; }
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); sClose(); return; }
    return;
  }
  if (!$('dmodal').hidden) {
    if (e.code === 'Space' || k === 'l') { e.preventDefault(); dModalLoop ? dStopModalLoop() : dStartModalLoop(); return; }
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); dCloseMoment(); return; }
    return;                                   // swallow the rest
  }

  if (k === 's') { if (!holdS) { holdS = true; e.preventDefault(); } return; }
  if (k === 'r') { holdR = true; e.preventDefault(); return; }

  if (e.code === 'Space') {
    e.preventDefault();
    /* Josh, 2026-09-11: "I want to take over the space shortcut to be playing the chunk
       video in a loop." On INPUT the chunk IS the screen now, so space loops it. */
    screen === 'output' ? toggleOutput() : toggleChunk();
    return;
  }
  if (k === 'p') { e.preventDefault(); toggleChunk(); return; }
  /* L / M — Josh, 2026-09-22: "I should also have a shortcut key so I can toggle
     looping" and "it should default to having the audio play with it". Each flips the
     same checkbox the side bar shows, so the button, the key and the state never disagree. */
  if (k === 'l') { e.preventDefault(); const c = $('looppre'); c.checked = !c.checked;
                   c.dispatchEvent(new Event('change')); toast(c.checked ? 'loop on' : 'loop off'); return; }
  if (k === 'm') { e.preventDefault(); const c = $('chunkaud'); c.checked = !c.checked;
                   c.dispatchEvent(new Event('change')); toast(c.checked ? 'audio on' : 'audio off'); return; }
  if (k === 'g') { e.preventDefault(); grab(); return; }
  /* O TOGGLES the theater overlay (Josh, 2026-09-11: "just have O be the one that I can
     just click O back and forth to toggle whether the output is up or not"). */
  if (k === 'o') { e.preventDefault(); toggleTheater(); return; }
  if (k === 'a') { e.preventDefault(); showScreen('assets'); return; }
  if (k === 'i') { e.preventDefault(); showScreen('input'); return; }

  /* Inside the theater the keyboard drives PLAYBACK: space plays/pauses, arrows scrub
     (shift = bigger jumps). "I should be able to control it all from there." */
  if (screen === 'output') {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const end = outLength();
      seekOutput(Math.max(0, Math.min(end - 0.05,
        tlPos + (e.key === 'ArrowRight' ? step : -step))), outPlaying);
      return;
    }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!$('tmodal').hidden) { tClose(); return; }
    if (!$('dmodal').hidden) { dCloseMoment(); return; }
    if (!$('exdrawer').hidden) { closeExport(); return; }
    if (!$('drawer').hidden) { $('drawer').hidden = true; return; }
    stopInput(); stopChunk(); stopOutput();
    if (editingId) { finishEditing(); return; }   // first esc = done editing
    if (screen === 'output') showScreen('input');
    return;
  }
  if (e.key === ',' || e.key === '.') { e.preventDefault(); stepInput(e.key === '.' ? 1/30 : -1/30); return; }

  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  if (!cur) return;
  const dir = e.key === 'ArrowRight' ? 1 : -1;

  if (holdS) { nudgeChunk(dir * (e.shiftKey ? 0.5 : 0.05)); return; }
  if (holdR) { setGrabLen((S.grabLen || 1) + dir * (e.shiftKey ? 0.5 : 0.1)); return; }

  const sig = (dir > 0 ? 'f' : 'b') + (e.shiftKey ? 'F' : '');
  if (holding === sig) return;
  holding = sig;
  clearInterval(backTimer); backTimer = null;
  if (dir > 0) startForward(e.shiftKey); else startBackward(e.shiftKey);
});

document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === 's') {
    // a TAP of S (no arrows used) relocates the chunk to where you are
    if (holdS && !sUsedArrows) setChunkStart(v.currentTime);
    holdS = false; sUsedArrows = false;
    return;
  }
  if (k === 'r') { holdR = false; return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stopInput(); }
  if (e.key === 'Shift' && holding) {
    const dir = holding[0];
    holding = dir;
    if (dir === 'f') startForward(false); else startBackward(false);
  }
});
document.addEventListener('keydown', e => {
  if (holdS && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) sUsedArrows = true;
}, true);
window.addEventListener('blur', () => { stopInput(); holdS = holdR = false; });

/* ---------- sidebar: sources, audio, projects, exports ----------
   The INPUT screen's file lists were removed 2026-09-11 (Josh: "get the assets stuff
   that's currently on the input screen out of there") — ASSETS owns file management
   now and renders them via renderAssets(). These two keep their shape and bail when
   their box is gone, so every existing caller in refresh() stays valid. */
function renderSources(jobs) {
  const box = $('srcs');
  if (!box) return;
  box.innerHTML = '';
  S.sources.forEach(s => {
    const d = document.createElement('div');
    d.className = 'card' + (cur && cur.id === s.id ? ' sel' : '');
    const job = jobs[s.id];
    const prepping = !s.ready;
    d.innerHTML = `<div class="nm">${s.name}</div>
      <div class="meta">${s.duration ? fmt(s.duration) : '…'} · ${(s.bytes/1e6).toFixed(0)}MB</div>
      ${prepping ? `<div class="meta" style="color:var(--warn)">preparing… ${job ? job.pct + '%' : ''}</div>
                    <div class="bar"><i style="width:${job ? job.pct : 0}%"></i></div>` : ''}`;
    if (!prepping) { d.onclick = () => selectSource(s); d.style.cursor = 'pointer'; }
    const del = document.createElement('button');
    del.className = 'btn sm';
    del.style.marginTop = '7px';
    del.textContent = 'Remove';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${s.name}" and any chunks from it?`)) return;
      await api('/api/source', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id }) });
      if (cur && cur.id === s.id) { cur = null; v.removeAttribute('src'); $('cnone').style.display = ''; }
      refresh();
    };
    d.appendChild(del);
    box.appendChild(d);
  });
}
function renderAudio() {
  const box = $('auds');
  if (!box) return;
  box.innerHTML = '';
  S.audio.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = `<div class="nm">${i + 1}. ${a.name}</div><div class="meta">${fmt(a.duration || 0)}</div>`;
    const del = document.createElement('button');
    del.className = 'btn sm';
    del.style.marginTop = '7px';
    del.textContent = 'Remove';
    del.onclick = async () => {
      await api('/api/audio', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: a.id }) });
      refresh();
    };
    d.appendChild(del);
    box.appendChild(d);
  });
}
/* Which moment breaks the plan, and why — in his words, not the server's.
   Mirrors the server's ordering rule: marks must advance through the VIDEO in the same
   order they advance through the AUDIO, and each gap in the audio has to be long enough
   to hold the video that must play before it. A mark pinned to audio 0 with video ahead
   of it is impossible by definition, since 0 seconds of audio can't cover any video. */
function rampTrouble() {
  const off = {};                        // where each source starts in the stitched input
  let acc = 0;
  for (const s of S.sources) { off[s.id] = acc; acc += useLen(s); }
  /* ⚠️ `r.start` is a position INSIDE its file — subtract the trimmed head to put it on
     the timeline, exactly as the server's rampPlan() does. Without this a mark on a
     trimmed clip reads far later than it really is (b638c8 came out at 864.87 instead
     of 384.22), and the detector invents a "points backwards" conflict on a plan the
     server calls perfectly valid. Josh hit this as "it's always complaining that
     something's overlapping". */
  /* ⚠️ A moment on an ARCHIVED or trimmed-away clip IS NOT IN THE VIDEO, so it must not
     take part in the ordering walk — the server's rampPlan() drops it, and if we don't,
     its stale videoAt makes the NEXT real moment look like it points backwards.
     Josh, 2026-09-14: "one of the recordings shows a conflict... I do not have any idea
     what the conflict is... it makes me think that it's more of a calculation issue on
     the outside than it is actually an issue with anything with the video." He was right.
     Archived clips' moments (774.4 and 1252.7) were still being compared against a real
     moment at 1163.9 and flagging it red on a plan the server called valid. */
  const all = (S.ramps || []).map(r => {
    const s = S.sources.find(x => x.id === r.sourceId);
    const inVideo = rampInVideo(r);
    return {
      /* len = footage, alen = the AUDIO it takes at its rate. Every audio sum below
         uses alen; every video comparison uses len. */
      id: r.id, audioAt: +r.audioAt || 0, len: +r.len || 0, alen: oLen(r), rate: rateOf(r),
      videoAt: (off[r.sourceId] || 0) + ((+r.start || 0) - (s ? useIn(s) : 0)),
      name: r.sourceName || '', bad: false, warn: false, why: '', inVideo
    };
  }).sort((a, b) => a.audioAt - b.audioAt);
  const list = all.filter(x => x.inVideo);      // only what actually plays is checked

  let prevAudioEnd = 0, prevVideo = 0, msg = '', warnMsg = '';
  for (const r of list) {
    const room = r.audioAt - prevAudioEnd;      // audio available before this moment
    const need = r.videoAt - prevVideo;         // video that must play in that room
    /* 🚨 ONE MEANING FOR RED: `bad` = THE FILM WILL NOT BUILD. Nothing else.
       Josh, 2026-09-22: "it says red is a problem, but when I actually click into the
       moment, it doesn't have any complaints in there. And then when I go to output it
       actually does play it. I just wish some of this logic was centralized... you've
       just spread out these rules everywhere, causing a million bugs."
       He was describing MY bug: I had added a legibility OPINION (>120x) and painted it
       in the same red as a genuine failure, so a plan that built fine looked broken.
       A speed that may be hard to read is a `warn`, carried separately and shown in
       amber. Red must mean the one thing the server means by it. */
    if (need < 0) {
      r.bad = true;
      r.why = 'this points at earlier video than the moment before it';
      if (!msg) msg = 'Two moments are out of order — one points backwards in the video. '
                    + 'They have to move forward through the video in the same order as the audio.';
    } else if (need > 0 && room > 0.01 && (need / room) > 120) {
      r.warn = true;
      r.why = `${fmt(need)} of video sweeps past in ${room.toFixed(2)}s `
            + `(${Math.round(need / room)}x — may be too fast to read)`;
      if (!warnMsg) warnMsg = `This builds fine. Just so you know: ${fmt(need)} of video `
        + `sweeps past in ${room.toFixed(2)}s of audio — about ${Math.round(need / room)}x, `
        + `which may read as a blur. Give it more room if you want to see it.`;
    }
    prevAudioEnd = r.audioAt + r.alen;
    prevVideo = r.videoAt + r.len;
  }

  /* PAST THE END OF THE AUDIO — the case he actually hit, and the one rampTrouble
     never used to detect, so he only got the server's bare sentence. */
  /* Flag this EVEN IF an ordering problem was already found — a state can have both
     (his did), and hiding one behind the other means fixing the first just reveals the
     second with no warning. `msg` still names whichever the server is reporting. */
  const aTot = audioTotal();
  const last = list[list.length - 1];
  let overMsg = '';
  if (aTot && last && last.audioAt + last.alen > aTot + 0.01) {
    last.bad = true;
    const over = last.audioAt + last.alen - aTot;
    last.why = `runs ${over.toFixed(2)}s past the end of your audio`;
    overMsg = `Your last moment runs ${over.toFixed(2)}s past the end of your audio.`;
  }
  /* The panel must describe whatever the BUTTONS fix, or it reads as a non-sequitur.
     rampFixes handles the overflow first (it's the cheapest to fix), so lead with it
     and mention the ordering problem as what's still waiting behind it. */
  if (overMsg) msg = msg ? `${overMsg} There's also an ordering problem to sort out after this.`
                         : overMsg;

  /* ⚠️ Only invent a failure message when something IS failing. This used to fall
     through to "they cannot be arranged in this order" unconditionally, so a perfectly
     valid plan carried a doom sentence waiting for any caller that read `msg`. */
  const anyBad = list.some(x => x.bad);
  if (anyBad && !msg) msg = (plan && plan.why) ? plan.why : 'they cannot be arranged in this order';
  // `all` so callers can still SHOW every moment; `list` is only what's in the video
  return { list, all, msg: anyBad ? msg : '', warnMsg, fixes: rampFixes(list, aTot) };
}

/* ---- SUGGESTED FIXES ----
   Josh, 2026-09-11: "why can't you just help me figure out how to fix it? ... it would
   be kinda nice if the error panel came up with suggestions for you, like the things
   that you're likely wanting to do ... I'm probably likely wanting to shift it back
   just inside the border ... Or I might want to shorten it ... they can just suggest
   different things. I think that would be more helpful than what it's doing right now."
   So: compute the ACTUAL numbers for each likely intent and offer them as one click.
   Every fix is expressed as edits to apply, so the panel never has to guess twice. */
/* A RED BUTTON MUST SAY WHAT IT DELETES. Josh, 2026-09-22: "if you click it it
   just like takes out part of your stuff... I didn't know that's how it works." Every
   remove used to read "Remove this moment — takes it out and leaves the rest alone",
   which names no clip and no time, so he could not tell WHICH of two colliding
   moments would go. Name it, and promise the undo (applyFix provides it). */
function removeFix(m) {
  const clip = String(m.name || 'a clip').replace(/\.[a-z0-9]+$/i, '');
  return { label: `Remove the moment from ${clip}`,
           detail: `the one landing at ${fmt(m.audioAt)} — just that one, and you can undo it` };
}
function rampFixes(list, aTot) {
  const out = [];
  if (!list.length || !aTot) return out;

  // 1) a moment hanging off the end
  const last = list[list.length - 1];
  const over = last.audioAt + last.alen - aTot;
  if (over > 0.01) {
    /* Land just INSIDE the end, not exactly on it: the plan needs a non-zero tail
       (`tailOut <= 0.01` is rejected), so a fix that ends at exactly audioTotal is
       arithmetically right and still fails. Verified the hard way. */
    const EDGE = 0.05;
    const prevEnd = list.length > 1 ? list[list.length - 2].audioAt + list[list.length - 2].alen : 0;
    const shifted = aTot - last.alen - EDGE;
    if (shifted >= prevEnd - 0.001) {
      out.push({ label: `Slide it back to just inside the end`,
                 detail: `moves it ${(last.audioAt - shifted).toFixed(2)}s earlier, to ${fmt(shifted)} — same length`,
                 edits: [{ id: last.id, audioAt: +shifted.toFixed(3) }] });
    }
    const shorter = aTot - last.audioAt - EDGE;
    if (shorter >= 0.2) {
      out.push({ label: `Shorten it to fit`,
                 detail: `keeps it at ${fmt(last.audioAt)}, trims it ${(last.alen - shorter).toFixed(2)}s to ${shorter.toFixed(2)}s`,
                 edits: [{ id: last.id, len: +(shorter * last.rate).toFixed(3) }] });   // footage = audio × rate
    }
    /* Make room by moving the moment IN FRONT of it. Josh, 2026-09-11: "if I'm butted
       up against the end, it should even offer to move the other one down for me, like
       or merge — it should be creative with how it offers it." */
    const prev = list[list.length - 2];
    if (prev) {
      const beforePrev = list.length > 2 ? list[list.length - 3].audioAt + list[list.length - 3].alen : 0;
      const prevTo = last.audioAt - over - EDGE - prev.alen;
      /* Say which way each one actually moves — a label that claims "back" while the
         moment moves later is the kind of thing he called goofy. */
      if (prevTo >= beforePrev + 0.001) {
        const dir = prevTo > prev.audioAt ? 'later' : 'earlier';
        out.push({ label: 'Close the gap between these two',
                   detail: `moves the moment at ${fmt(prev.audioAt)} ${dir} to ${fmt(prevTo)} and `
                         + `this one to ${fmt(aTot - last.alen - EDGE)}, back to back — both keep their length`,
                   edits: [{ id: prev.id, audioAt: +prevTo.toFixed(3) },
                           { id: last.id, audioAt: +(aTot - last.alen - EDGE).toFixed(3) }] });
      }
      // merge: one moment spanning both, if the video they point at is contiguous
      const gap = last.videoAt - (prev.videoAt + prev.len);
      // (only when both play at the same rate — one moment has one rate)
      if (gap > -0.01 && gap < 2 && Math.abs(prev.rate - last.rate) < 0.001) {
        const mergedA = Math.min(prev.alen + last.alen, aTot - prev.audioAt - EDGE);   // audio
        if (mergedA >= prev.alen + 0.1) {
          out.push({ label: 'Merge the two into one longer moment',
                     detail: `one ${mergedA.toFixed(2)}s moment at ${fmt(prev.audioAt)} — `
                           + `they point at back-to-back video anyway`,
                     edits: [{ id: prev.id, len: +(mergedA * prev.rate).toFixed(3) },
                             { id: last.id, remove: true }] });
        }
      }
    }
    out.push({ ...removeFix(last),
               danger: true, edits: [{ id: last.id, remove: true }] });
    return out;
  }

  // 2) a moment pointing BACKWARDS in the video relative to the one before it
  for (let i = 1; i < list.length; i++) {
    const r = list[i], prev = list[i - 1];
    if (r.videoAt >= prev.videoAt + prev.len - 0.01) continue;
    // where in the AUDIO would it have to sit to be in video order? just after whichever
    // moment it truly follows by video position
    const earlier = list.filter(x => x.videoAt + x.len <= r.videoAt + 0.01)
                        .sort((a, b) => b.audioAt - a.audioAt)[0];
    const later = list.find(x => x.videoAt > r.videoAt + r.len - 0.01);
    if (earlier && later && earlier.audioAt + earlier.alen + r.alen <= later.audioAt - 0.001) {
      const to = earlier.audioAt + earlier.alen + 0.05;
      out.push({ label: 'Move it to where it belongs in the order',
                 detail: `sends it to ${fmt(to)}, between the moments it actually sits between in the video`,
                 edits: [{ id: r.id, audioAt: +to.toFixed(3) }] });
    }
    out.push({ ...removeFix(r),
               danger: true, edits: [{ id: r.id, remove: true }] });
    return out;
  }

  /* 2b) THE FIRST MOMENT PINNED AT (or too near) THE START, with video in front of it.
     Josh, 2026-09-22: "I just moved a moment to a very early spot in the flow... I don't
     know what it means to when it says no room before a moment. I think that this should
     be ALLOWED."
     He is right that the INTENT is legitimate — he wants that moment to open the film.
     The old code produced no fixes at all here (case 3 needs a `prev`, and the first
     moment has none), so he got a bare sentence and no way forward. The constraint
     itself is real: N seconds of video cannot play in 0 seconds of audio. But there are
     three honest ways to give him what he asked for, and the first one is the one he
     actually means — start the film AT that moment and drop what came before it. */
  /* ⚠️ THE GUARD IS "IS THIS THE FIRST MARK AND IS IT BROKEN" — NOT AN EPSILON.
     It was `first.audioAt <= 0.001`, so when Josh took my own advice and nudged the
     mark to 0.01 the fixes VANISHED and he got the bare sentence a second time.
     Any first mark with video in front of it belongs here; how close to zero it sits
     is not the question. */
  const first = list[0];
  if (first && first.bad && first.videoAt > 0.01) {
    /* The real answer: he wants to OPEN on this. Trim the video in front of it away. */
    out.push({ label: 'Start the film here — skip the video before it',
               detail: `trims the ${fmt(first.videoAt)} of video in front of this moment, `
                     + `so the film opens on it`,
               trimBefore: first.id });
    /* Or keep that video and let it race past — but pick the run-up by the SPEED it
       implies, not by the first number that technically fits.
       🚨 Josh, 2026-09-22, after taking my "move it later" advice literally: he set it
       to 0:00.01 and got the same refusal. At 0.01s of audio the 25.26s in front needs
       **2525x** — arithmetically "allowed" (the planner only rejects gapOut <= 0.01)
       and totally useless. A nudge is not a fix here; the run-up has to be big enough
       to mean something, so aim at a watchable speed and say the multiplier out loud. */
    const EDGE = 0.05;
    const ceiling = list[1] ? list[1].audioAt : aTot;
    const room = Math.min(
      Math.max(1, +(first.videoAt / 12).toFixed(2)),   // ~12x, a fast-but-readable sweep
      Math.max(0, ceiling - first.alen - EDGE));
    if (room > 0.2) {
      const x = Math.round(first.videoAt / room);
      out.push({ label: `Give it ${room.toFixed(1)}s of run-up`,
                 detail: `moves it to ${fmt(room)} — the ${fmt(first.videoAt)} before it `
                       + `sweeps past in ${room.toFixed(1)}s (${x}x)`,
                 edits: [{ id: first.id, audioAt: +room.toFixed(3) }] });
    }
    out.push({ ...removeFix(first),
               danger: true, edits: [{ id: first.id, remove: true }] });
    return out;
  }

  // 3) two moments overlapping / no room between them
  for (let i = 0; i < list.length; i++) {
    const r = list[i]; if (!r.bad) continue;
    const prev = list[i - 1];
    if (prev) {
      const prevEnd = prev.audioAt + prev.alen;
      const next = list[i + 1];
      const ceiling = next ? next.audioAt : aTot;
      const moved = prevEnd + 0.05;
      if (moved + r.alen <= ceiling + 0.001) {
        out.push({ label: `Move this one just after the one before it`,
                   detail: `sends it to ${fmt(moved)}, clear of the moment ending at ${fmt(prevEnd)}`,
                   edits: [{ id: r.id, audioAt: +moved.toFixed(3) }] });
      }
      const trimmed = r.audioAt - prev.audioAt - 0.05;
      if (trimmed >= 0.2) {
        out.push({ label: `Shorten the one before it so they don't collide`,
                   detail: `takes the moment at ${fmt(prev.audioAt)} down to ${trimmed.toFixed(2)}s`,
                   edits: [{ id: prev.id, len: +(trimmed * prev.rate).toFixed(3) }] });   // footage = audio × rate
      }
    } else if (r.audioAt < 0.05 && r.videoAt > 0.01) {
      // pinned to the very start with video ahead of it — needs SOME room
      const room = Math.min(2, aTot * 0.1);
      out.push({ label: `Move it off the very start`,
                 detail: `sends it to ${fmt(room)} so the video before it has somewhere to go`,
                 edits: [{ id: r.id, audioAt: +room.toFixed(3) }] });
    }
    out.push({ ...removeFix(r),
               danger: true, edits: [{ id: r.id, remove: true }] });
    break;                                  // one problem at a time — fix it, then re-plan
  }
  return out;
}

/* Apply a suggested fix. Each edit is either a field change or a removal. */
async function applyFix(fix) {
  try {
    /* "Start the film here" — everything in front of this moment comes OUT, so the
       moment itself becomes the opening frame. Clips entirely before it are switched
       off (never deleted — the file and its own moments are kept), and the clip the
       moment lives in is trimmed to start at it. Nothing is re-encoded; this is the
       ordinary trim/off machinery, so it is undoable by hand afterwards. */
    if (fix.trimBefore) {
      const r = (S.ramps || []).find(x => x.id === fix.trimBefore);
      if (!r) { toast('that moment is gone', true); return; }
      const host = S.sources.find(x => x.id === r.sourceId);
      if (!host) { toast('that clip is gone', true); return; }
      for (const s of S.sources) {
        if (s.id === host.id) break;                 // stop at the moment's own clip
        if (!s.off) await api('/api/source/off', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: s.id, off: true }) });
      }
      if (r.start > useIn(host) + 0.01) {
        await api('/api/source/trim', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: host.id, trimIn: +r.start.toFixed(3),
                                 trimOut: host.trimOut ?? null }) });
      }
      await refresh();
      toast(plan && plan.ok ? 'the film starts on that moment now'
                            : 'trimmed — there is still a conflict');
      return;
    }
    /* Keep a copy of anything this fix is about to delete, so ONE tap is never
       permanent. The server gives a re-added moment a new id, which is fine — the id
       is ours, not his; start/len/audioAt/clip are what he made. */
    const removing = (fix.edits || []).filter(e => e.remove)
      .map(e => (S.ramps || []).find(r => r.id === e.id)).filter(Boolean)
      .map(r => ({ sourceId: r.sourceId, start: r.start, len: r.len, audioAt: r.audioAt, rate: rateOf(r) }));
    for (const e of fix.edits) {
      if (e.remove) {
        await api('/api/ramp', { method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: e.id }) });
      } else {
        const body = { id: e.id };
        if (e.audioAt != null) body.audioAt = e.audioAt;
        if (e.len != null) body.len = e.len;
        await api('/api/ramp/edit', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
    }
    await refresh();
    const said = plan && plan.ok ? 'fixed — everything fits now' : 'done — there is still a conflict';
    if (removing.length) {
      toastAction(`${said} · removed ${removing.length} moment${removing.length > 1 ? 's' : ''}`,
                  'Undo', async () => {
        for (const r of removing) await postJSON('/api/ramp', r);
        await refresh();
        toast('put back');
      });
    } else toast(said);
  } catch (e) { toast(e.message, true); }
}
/* ---- THE MOMENT MAP ----
   Josh, 2026-09-11: "I should be able to see my moments in a way that I can like see
   them on a timeline, move them back and forth as needed... I can't visualize what the
   problem is and if I saw them like overlapping on a timeline, that might be more
   helpful."
   Words were the wrong tool. Two tracks — where each moment LANDS in the audio, and
   what it POINTS AT in the video — with a line joining each pair. When two moments are
   out of order, their lines CROSS, and an overlap in the audio is two blocks touching.
   Both are things you see at a glance. Drag an audio block sideways to move it. */
const MCOL = ['#7fe0ab','#6bb6ff','#ffc46b','#e59dd6','#9de5df','#f0a58a'];
let mmapSel = null;

function mmapData() {
  const off = {}; let acc = 0;
  for (const s of S.sources) { off[s.id] = acc; acc += useLen(s); }
  const videoTotal = acc || 1;
  const aTotal = audioTotal() || 1;      // named aTotal: a local `audioTotal` here would
                                         // shadow the module-level one via the TDZ
  const t = rampTrouble();
  const byId = {}; t.list.forEach(r => { byId[r.id] = r; });
  const items = (S.ramps || []).map(r => {
    const s = S.sources.find(x => x.id === r.sourceId);
    // out of the video if its clip is archived, missing, or its footage was trimmed away
    const cut = !rampInVideo(r);
    return {
    cut,
    id: r.id, len: +r.len || 0, alen: oLen(r),     // alen = its AUDIO span at its rate
    audioAt: +r.audioAt || 0,
    videoAt: (off[r.sourceId] || 0) + ((+r.start || 0) - (s ? useIn(s) : 0)),
    bad: !!(byId[r.id] && byId[r.id].bad),
    warn: !!(byId[r.id] && byId[r.id].warn),
    why: byId[r.id] ? byId[r.id].why : '',
    name: r.sourceName || ''
  }; }).sort((a, b) => a.audioAt - b.audioAt);
  return { items, videoTotal, aTotal, msg: t.msg, warnMsg: t.warnMsg, fixes: t.fixes };
}

function renderMomentMap() {
  const wrap = $('mmap'); if (!wrap) return;
  if (mode !== 'ramp' || !(S.ramps || []).length) { wrap.hidden = true; return; }
  /* The map's tracks duplicated the tracks above (Josh, 2026-09-22: "I don't think we
     need the moments at the bottom. If I can click the chunks at the top... I don't need
     to do it at the bottom too"). What's left is its problem line + fix buttons, and it
     only appears when there IS a problem. */
  { const t0 = rampTrouble();
    const trouble = (plan && !plan.ok) || t0.list.some(x => x.bad);
    if (!trouble) { wrap.hidden = true; return; } }
  wrap.hidden = false;

  const { items, videoTotal, aTotal, msg, warnMsg, fixes: allFixes } = mmapData();
  const anyBad = items.some(x => x.bad);
  const nCut = items.filter(x => x.cut).length;
  /* THREE STATES, THREE COLOURS — red only when the film will not build. A legibility
     note is amber and says so; everything else is green. */
  $('mmapmsg').textContent = anyBad ? msg
    : nCut ? `these all fit · ${nCut} more moment${nCut > 1 ? 's are' : ' is'} hidden — on a clip `
           + `you switched off or trimmed away. Kept, not deleted: turn the clip back on and `
           + `${nCut > 1 ? 'they' : 'it'} come${nCut > 1 ? '' : 's'} back.`
    : warnMsg ? warnMsg
    : 'these all fit — they run in order';
  $('mmapmsg').style.color = anyBad ? '#e59d9d'
    : (nCut || warnMsg) ? 'var(--warn)' : 'var(--good)';

  /* Don't just name the problem — offer the fixes, with their real numbers.
     Josh, 2026-09-11: "why can't you just help me figure out how to fix it?" */
  const fx = $('mmapfix');
  // offer fixes whenever something is actually wrong — the server can call a plan OK
  // while a moment still points backwards, and a red warning with no recourse is the
  // exact thing he objected to
  const fixes = ((plan && !plan.ok) || anyBad) ? (allFixes || []) : [];
  fx.innerHTML = '';
  fx.hidden = !fixes.length;
  fixes.forEach(f => {
    const b = document.createElement('button');
    b.className = 'fixbtn' + (f.danger ? ' danger' : '');
    b.innerHTML = `<b>${f.label}</b><span>${f.detail}</span>`;
    b.onclick = () => applyFix(f);
    fx.appendChild(b);
  });

  const at = $('mmap-audio'), vt = $('mmap-video');
  at.innerHTML = ''; vt.innerHTML = '';

  /* Shelved moments are NOT drawn here either (Josh, 2026-09-22 — see the track
     painter). The line above says how many are hidden and how to get them back. */
  items.filter(m => !m.cut).forEach((m, i) => {
    const col = MCOL[i % 6];
    // AUDIO track — where it lands. This one is draggable.
    const a = document.createElement('div');
    a.className = 'mmapblk' + (m.bad ? ' bad' : m.warn ? ' warn' : '') + (m.cut ? ' cut' : '')
                + (mmapSel === m.id ? ' sel' : '');
    a.style.left = (m.audioAt / aTotal) * 100 + '%';
    a.style.width = Math.max(0.9, (m.alen / aTotal) * 100) + '%';
    a.style.background = col;
    a.textContent = i + 1;
    a.title = `moment ${i + 1} — lands at ${fmt(m.audioAt)} in the audio`
            + (m.cut ? '\nthis one is outside what you kept of its clip, so it will not appear' : '')
            + (m.why ? `\n${m.why}` : '');
    a.dataset.id = m.id;
    mmapDrag(a, m, aTotal);
    at.appendChild(a);

    // VIDEO track — what it points at.
    const v = document.createElement('div');
    v.className = 'mmapblk vid' + (m.bad ? ' bad' : m.warn ? ' warn' : '') + (m.cut ? ' cut' : '')
                + (mmapSel === m.id ? ' sel' : '');
    v.style.left = (m.videoAt / videoTotal) * 100 + '%';
    v.style.width = Math.max(0.9, (m.len / videoTotal) * 100) + '%';
    v.style.background = col;
    v.textContent = i + 1;
    v.title = `moment ${i + 1} — points at ${fmt(m.videoAt)} in your video`;
    v.onclick = () => { mmapSel = m.id; dOpenMoment(m.id); };
    vt.appendChild(v);
  });

  /* The joining lines — they cross exactly when two moments are out of order.
     Drawn in a 0-100 viewBox with preserveAspectRatio=none, i.e. in the SAME percentage
     space as the blocks. Measuring the track's pixel width here reads 0 before layout
     settles, which silently collapsed the whole viewBox to ~51 units and squashed every
     line into the left edge. Percentages need no measurement, so they can't be wrong. */
  const svg = $('mmap-links');
  svg.innerHTML = '';
  svg.setAttribute('viewBox', '0 0 100 26');
  svg.setAttribute('preserveAspectRatio', 'none');
  items.filter(m => !m.cut).forEach((m, i) => {   // lines: same filter, same colours as the blocks
    const x1 = ((m.audioAt + m.alen / 2) / aTotal) * 100;
    const x2 = ((m.videoAt + m.len / 2) / videoTotal) * 100;
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', x1); ln.setAttribute('y1', 0);
    ln.setAttribute('x2', x2); ln.setAttribute('y2', 26);
    ln.setAttribute('stroke', m.bad ? '#ff6b63' : m.warn ? '#e8a93f' : MCOL[i % 6]);
    ln.setAttribute('stroke-width', m.bad ? 2.5 : 1.5);
    ln.setAttribute('vector-effect', 'non-scaling-stroke');   // or the x-squash thins it
    if (m.bad) ln.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(ln);
  });
}

/* Drag an audio block: moves ONLY where the moment lands in the audio (audioAt).
   What it points at in the video never changes — that is the whole invariant. */
function mmapDrag(el, m, audioTotal) {
  el.onpointerdown = e => {
    e.preventDefault();
    const track = el.parentElement;
    const W = track.getBoundingClientRect().width || 1;
    const startX = e.clientX, startAt = m.audioAt;
    let at = startAt, moved = false;
    el.setPointerCapture(e.pointerId);
    mmapSel = m.id;

    el.onpointermove = ev => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      at = Math.max(0, Math.min(audioTotal - m.alen, startAt + (dx / W) * audioTotal));
      el.style.left = (at / audioTotal) * 100 + '%';
      $('mmapmsg').textContent = `moment lands at ${fmt(at)} in the audio`;
      $('mmapmsg').style.color = 'var(--ink)';
    };
    el.onpointerup = async () => {
      el.onpointermove = el.onpointerup = null;
      if (!moved) { dOpenMoment(m.id); return; }       // a click still opens the editor
      try {
        await api('/api/ramp/edit', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: m.id, audioAt: +at.toFixed(3) }) });
        await refresh();                                 // re-plans and repaints
      } catch (err) { toast(err.message, true); }
    };
  };
}
function renderChips() {
  renderMomentMap();          // the map lives on the same data; keep them in lockstep
  const box = $('chips');
  box.innerHTML = '';
  /* GRAB only. In SPEED every moment is already drawn and clickable on both tracks
     above; the list was a third copy of the same thing (Josh, 2026-09-22). */
  /* THE LIST IS GONE, BOTH MODES. Josh, 2026-09-22: "I just want the interface where I
     click on the chunks that are just in the actual timeline. This 'your chunks' thing
     at the bottom... get rid of this." GRAB chunks are now drawn on the two tracks and
     clicked there, exactly like SPEED moments; removing one lives in the side bar. */
  const head = document.querySelector('.chipshead');
  box.hidden = true; if (head) head.hidden = true;
  return;
  // the heading says what THIS mode's list lets him do (it lives on the main page now)
  const ch = document.querySelector('.chipshead b'), hint = $('chipshint');
  if (ch) ch.textContent = mode === 'ramp' ? 'YOUR REAL-TIME MOMENTS' : 'YOUR CHUNKS';
  if (hint) hint.textContent = mode === 'ramp'
    ? 'in the order they play · click one to edit or remove it'
    : 'in the order they play · ◀ ▶ move · ✕ remove · click one to edit';
  if (mode === 'ramp') {
    // The BACK AND FORTH, in the order it plays: sped-up → real → sped-up → real …
    // This is the assembly Josh asked to see, not just a list of his marks.
    // ONLY HIS MOMENTS. Josh, 2026-09-10: "we don't need to actually include all the
    // fast portions in the bottom part, we can just include just the slowdowns and where
    // they're at... make it really obvious using colour coding which of the chunks
    // visualized on the timeline correlate to the actual editable chunks."
    /* Show his moments EVEN WHEN THE PLAN IS IMPOSSIBLE. This used to be
       `(plan && plan.ok) ? rampSegments() : []`, so a broken plan emptied the list and
       the fallback below told him "nothing marked yet" while he had six moments marked.
       Josh, 2026-09-11: "it says nothing marked yet... but when I go to the input screen
       I have definitely added like three different... in the output screen I should be
       able to see all the moments I've marked and if there's any overlap that's where I
       should see the conflict and be able to easily solve it there." */
    const segs = (plan && plan.ok) ? rampSegments() : [];
    const mine = segs.filter(g => g.real && g.id);
    const broken = !!(plan && !plan.ok && (S.ramps || []).length);

    if (!mine.length && !broken) {
      box.innerHTML = '<div class="hint">' + (!S.sources.some(x => x.ready)
        ? 'add an input video'
        : !S.audio.length ? 'add an audio bed — it sets how long the output runs'
        : 'nothing marked yet — the whole video is squeezed onto your audio') + '</div>';
      return;
    }

    if (broken) {
      /* The MAP above carries the diagnosis visually now, so these stay compact —
         he pushed back on exactly this: "right now we have this like verbal
         descriptions or written descriptions at the end". Short labels only. */
      const t = rampTrouble();
      t.list.forEach((r, i) => {
        const d = document.createElement('div');
        d.className = 'chip seg real m' + (i % 6) + (r.bad ? ' bad' : '')
                    + (dEditId === r.id ? ' editing' : '');
        d.innerHTML = `<div class="n"><span class="dot"></span>${i + 1} · ${r.len.toFixed(1)}s`
                    + `${Math.abs(r.rate - 1) > 0.001 ? ' · ' + fmtRate(r.rate) : ''}</div>
                       <div class="t">at ${fmt(r.audioAt)} in the audio</div>`;
        d.onclick = () => dOpenMoment(r.id);
        box.appendChild(d);
      });
      return;
    }

    mine.forEach((g, i) => {
      const d = document.createElement('div');
      const live = (outPlaying || outPaused) && tlPos >= g.outFrom && tlPos < g.outFrom + g.outLen;
      d.className = 'chip seg real m' + (i % 6) + (live ? ' play' : '')
                  + (dEditId === g.id ? ' editing' : '');
      d.innerHTML = `<div class="n"><span class="dot"></span>${i + 1} · REAL 1×</div>
                     <div class="t">${g.outLen.toFixed(1)}s at ${fmt(g.outFrom)} in the audio</div>`;
      d.onclick = () => dOpenMoment(g.id);
      box.appendChild(d);
    });
    return;
  }
  S.timeline.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'chip' + (outPlaying && i === outIdx ? ' play' : '')
                         + (editingId === c.id ? ' editing' : '');
    d.innerHTML = `<div class="n">${i + 1} · ${c.len}s${Math.abs(rateOf(c) - 1) > 0.001 ? ' · ' + fmtRate(rateOf(c)) : ''}</div>
                   <div class="t">${c.sourceName} @ ${fmt(c.start)}</div>`;
    d.onclick = (ev) => { if (ev.target.tagName !== 'BUTTON') openChunk(c.id); };
    const ops = document.createElement('div');
    ops.className = 'ops';
    const mk = (label, title, fn) => {
      const b = document.createElement('button'); b.textContent = label; b.title = title;
      b.onclick = fn; return b;
    };
    ops.appendChild(mk('◀', 'earlier', async () => {
      if (i === 0) return;
      await api('/api/clip/move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id, to: i - 1 }) }); refresh();
    }));
    ops.appendChild(mk('▶', 'later', async () => {
      if (i === S.timeline.length - 1) return;
      await api('/api/clip/move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id, to: i + 1 }) }); refresh();
    }));
    ops.appendChild(mk('✕', 'delete', async () => {
      await api('/api/clip', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id }) });
      if (editingId === c.id) editingId = null;
      refresh();
    }));
    d.appendChild(ops);
    box.appendChild(d);
  });
}

function openDrawer(title, render) {
  $('drawertitle').textContent = title;
  $('drawer').hidden = false;
  render($('drawerbody'));
}
$('drawerclose').onclick = () => $('drawer').hidden = true;
$('chapadd').onclick = newChapter;
$('drawer').onclick = e => { if (e.target.id === 'drawer') $('drawer').hidden = true; };
$('openproj').onclick = () => openDrawer('Projects', box => loadProjects(box));

async function loadProjects(box) {
  let j; try { j = await api('/api/projects'); } catch { return; }
  $('projcount').textContent = j.projects.length ? ` ${j.projects.length}` : '';
  if (!box) return;
  box.innerHTML = '';
  j.projects.forEach(pr => {
    const d = document.createElement('div');
    d.className = 'prow' + (pr.name === (S.name || 'Untitled') ? ' on' : '');
    d.innerHTML = `<span class="pn">${pr.name}</span><span class="pm">${pr.chunks}c · ${pr.seconds}s</span>`;
    const open = document.createElement('button');
    open.textContent = 'open';
    open.onclick = async () => {
      if (!confirm(`Open "${pr.name}"? Current work is saved under "${S.name || 'Untitled'}".`)) return;
      await api('/api/project/open', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pr.name }) });
      cur = null; editingId = null; stopChunk(); stopInput();
      await refresh();
      $('drawer').hidden = true;
      toast(`opened ${pr.name}`);
    };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = async () => {
      if (!confirm(`Delete saved project "${pr.name}"? Videos and audio stay.`)) return;
      await api('/api/project/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pr.name }) });
      loadProjects($('drawerbody'));
    };
    d.appendChild(open); d.appendChild(del);
    box.appendChild(d);
  });
  if (!j.projects.length) box.innerHTML = '<div class="hint">no saved projects yet</div>';
}
async function saveAs(opts) {
  const forced = opts && opts.forced;
  const name = prompt(forced
    ? 'Give this project a name — it saves itself from here on.'
    : 'Name this project:', S.name === 'Untitled' ? '' : S.name);
  if (!name || !name.trim()) return false;
  await postJSON('/api/project/save', { name: name.trim() });
  S.name = name.trim();
  $('projname').textContent = S.name;
  loadProjects();
  toast(`saved as ${S.name}`);
  return true;
}
$('projname').onclick = () => saveAs();

/* FORCE A NAME. Josh, 2026-09-15: "let's force that I name the project."
   "Untitled" is not a name — it is the absence of one, and it left him unsure whether his
   work was saved anywhere.

   ⚠️ NOT a prompt()/confirm() from here. This runs inside refresh(), which re-runs on a
   timer while a render is going — and a modal prompt BLOCKS the page: the first version
   of this froze the whole app on load, with the tab unresponsive to any script at all.
   So the nudge is INLINE and non-blocking: the project name shows as "Name this project"
   in warning colour and pulses until he clicks it. He is pushed, never trapped. */
function ensureProjectName() {
  const unnamed = !S.name || S.name === 'Untitled';
  const hasWork = (S.sources || []).length || (S.ramps || []).length || (S.timeline || []).length;
  const el = $('projname');
  el.classList.toggle('needsname', unnamed && !!hasWork);
  el.textContent = unnamed ? (hasWork ? 'Name this project' : 'Untitled') : S.name;
}

/* The EXPORTS drawer is GONE (Josh, 2026-09-15: "now we're just downloading to the
   downloads. Remove exports"). Films land in ~/Downloads, so a second in-app list of
   them was one more button whose purpose he had to guess. /api/exports still exists
   server-side and media/out still holds every render — nothing was deleted. */

/* ---- the OUTPUT timeline: drop the playhead anywhere ----
   Josh, 2026-09-10: "on the output screen I'd like to see the ability to kind of drop
   a cursor wherever I'd want to play it from. Right now I feel like I have to play it
   from the beginning or nothing at all."
   Seeks BOTH modes: in SPEED it maps through rampAt(); in GRAB it walks the chunks. */
function seekOutput(t, thenPlay) {
  const end = outLength();
  if (!end) return;
  const wasPlaying = outPlaying;
  stopOutput();                       // clears position; we set it deliberately below
  tlPos = Math.max(0, Math.min(end - 0.02, t));
  outPaused = true;                   // so playOutput() resumes HERE, not at zero

  if (S.audio.length) buildAudio(tlPos);
  if (mode === 'ramp') {
    const hit = rampAt(tlPos);
    if (hit) {
      const url = `/media/proxy/${hit.src.proxy}`;
      const put = () => { ov.currentTime = hit.at; paint(); };
      if (!ov.src.endsWith(url)) { ov.src = url; ov.addEventListener('loadeddata', put, { once: true }); }
      else if (ov.readyState >= 2) put(); else ov.addEventListener('loadeddata', put, { once: true });
    }
  } else {
    const hit = chunkAt(tlPos);
    if (hit) {
      const src = S.sources.find(x => x.id === hit.c.sourceId);
      if (src) {
        const url = `/media/proxy/${src.proxy}`;
        const put = () => { ov.currentTime = hit.c.start + hit.into; paint(); };
        if (!ov.src.endsWith(url)) { ov.src = url; ov.addEventListener('loadeddata', put, { once: true }); }
        else if (ov.readyState >= 2) put(); else ov.addEventListener('loadeddata', put, { once: true });
      }
    }
  }
  if (thenPlay || wasPlaying) playOutput();
  paint();
}
$('oscrub').addEventListener('click', e => {
  const end = outLength(); if (!end) return;
  const r = e.currentTarget.getBoundingClientRect();
  seekOutput(((e.clientX - r.left) / r.width) * end, true);   // click = play from there
});

/* ================= DESKTOP MOMENT EDITOR =================
   Josh, 2026-09-10: "when I'm in the output mode screen and I click on one of the
   existing ones... a modal pops up that I can edit it, and I can see the preview of
   where I'm editing it to... I should be able to move the audio, move the video,
   adjust its length. Basically do everything right there."
   Same three numbers as the phone's mini editor, same endpoint — this is a second
   VIEW of one model, never a second model. */
const dv = $('dv');            // the modal's own preview player
let dEditId = null;
let dKind = 'moment';        // 'moment' (SPEED) or 'chunk' (GRAB) — same center editor

function dOpenMoment(id) {
  const r = (S.ramps || []).find(x => x.id === id);
  if (!r) return;
  dEditId = id; dKind = 'moment';
  stopInput(); stopChunk(); stopOutput();
  $('dmodal').hidden = false;
  renderChips();          // light the chip he just opened
  dFill();
}
function dOpenChunk(id) {
  if (!S.timeline.find(x => x.id === id)) return;
  dStopModalLoop();
  dEditId = id; dKind = 'chunk';
  stopInput(); stopChunk(); stopOutput();
  $('dmodal').hidden = false;
  renderChips();
  dFill();
  dStartModalLoop();           // open it already playing, the way clicking a chunk used to
}
/* a chunk's place in the OUTPUT: GRAB stacks chunks, so it lands after the ones before it */
function chunkOutAt(id) {
  let acc = 0;
  void acc;
  const c = S.timeline.find(x => x.id === id);
  return c ? (+c.audioAt || 0) : 0;
}
function dCloseMoment() {
  dStopModalLoop();
  dEditId = null;
  $('dmodal').hidden = true;
  dv.pause();
  renderChips();          // the chip highlight follows the modal
  paint();
}
function dFill() {
  const r = dCur();
  if (!r) return dCloseMoment();
  const isChunk = dKind === 'chunk';
  const tag = $('d-tag');
  tag.className = 'outtag ' + (isChunk ? 'grab' : 'speed');
  tag.textContent = isChunk
    ? `CHUNK ${S.timeline.findIndex(x => x.id === r.id) + 1} OF ${S.timeline.length}`
    : 'REAL-TIME MOMENT';
  $('d-audfield').hidden = false;         // chunks land where he puts them, like moments
  $('d-del').textContent = isChunk ? 'Remove this chunk' : 'Remove this moment';
  $('d-audio').value = (+(r.audioAt || 0)).toFixed(2);
  $('d-video').value = (+r.start).toFixed(2);
  $('d-len').value   = (+r.len).toFixed(2);
  if (document.activeElement !== $('d-rate')) $('d-rate').value = +rateOf(r).toFixed(2);
  $('d-ratehint').textContent = `${fmtRate(rateOf(r))} · takes ${oLen(r).toFixed(2)}s of audio`;
  document.querySelectorAll('[data-dr]').forEach(b =>
    b.classList.toggle('on', Math.abs(+b.dataset.dr - rateOf(r)) < 0.001));

  // the frame this moment starts on — the preview he asked for
  const src = S.sources.find(x => x.id === r.sourceId);
  if (src) {
    const url = `/media/proxy/${src.proxy}`;
    const seek = () => { try { dv.currentTime = r.start; } catch {} };
    if (!dv.src.endsWith(url)) { dv.src = url; dv.addEventListener('loadeddata', seek, { once: true }); }
    else if (dv.readyState >= 2) seek(); else dv.addEventListener('loadeddata', seek, { once: true });
    $('d-cap').textContent = `${src.name} · ${fmt(r.start)}`;
  }

  if (isChunk) {
    const at = r.audioAt;
    $('d-plan').innerHTML = `Plays in the output from <b>${fmt(at)}</b> to <b>${fmt(at + oLen(r))}</b>`
      + ` · <b>${r.len.toFixed(2)}s</b> of ${src ? src.name : 'video'} at <b>${fmtRate(rateOf(r))}</b>`;
    $('d-why').textContent = `output ${fmt(total())}`;
  } else {
  // what this pin DOES — the causal line, in plain words
  const before = (plan && plan.spans || []).filter(x => x.outTo <= (r.audioAt || 0) + 0.01 && x.kind === 'filler');
  const mine = (plan && plan.spans || []).find(x => x.id === r.id);
  const sq = before.length ? before[before.length - 1] : null;
  $('d-plan').innerHTML =
    `Everything before this is squeezed into <b>${(r.audioAt || 0).toFixed(2)}s</b> of audio`
    + (sq && sq.speed ? ` — that's <b>${sq.speed.toFixed(2)}×</b>` : '')
    + `<br>It plays at <b>${fmtRate(rateOf(r))}</b> from <b>${fmt(r.audioAt || 0)}</b> to <b>${fmt((r.audioAt || 0) + oLen(r))}</b>`
    + (plan && !plan.ok && plan.why ? `<br><span style="color:var(--hot)">${plan.why}</span>` : '');
  $('d-why').textContent = plan && plan.ok ? `lands on ${plan.audioTotal}s` : (plan && plan.why) || '';
  }
  // WHICH audio is under this moment (his ask) — walk the bed files in order
  let acc = 0, which = null;
  for (const a of S.audio) { const d2 = a.duration || 0;
    if ((r.audioAt || 0) < acc + d2) { which = { name: a.name, into: (r.audioAt || 0) - acc }; break; }
    acc += d2; }
  $('d-aud').textContent = which
    ? `${which.name} · ${fmt(which.into)}`
    : (S.audio.length ? 'past the end of the audio' : 'no audio bed yet');
}
async function dPush(patch) {
  if (!dEditId) return;
  try {
    await api(dKind === 'chunk' ? '/api/clip/edit' : '/api/ramp/edit',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dEditId, ...patch }) });
    await refresh();
    renderChips();                 // chip labels show outFrom — they move with the edit
    dFill();                       // preview + plan follow the edit live
    if (dModalLoop) dStartModalLoop();   // keep looping the moment he is shaping
  } catch (e) { toast(e.message, true); }
}
const dCur = () => {
  if (dKind === 'chunk') {
    const c = S.timeline.find(x => x.id === dEditId);
    return c ? { ...c, audioAt: chunkOutAt(c.id) } : null;
  }
  return (S.ramps || []).find(x => x.id === dEditId);
};
function dWire(inputId, attr, field, min) {
  const inp = $(inputId);
  const commit = () => { const v2 = parseFloat(inp.value);
    if (isFinite(v2)) dPush({ [field]: Math.max(min, v2) }); else dFill(); };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  [...document.querySelectorAll(`[${attr}]`)].forEach(b => {
    b.onclick = () => { const r = dCur(); if (!r) return;
      const base = field === 'audioAt' ? (r.audioAt || 0) : field === 'rate' ? rateOf(r) : r[field];
      dPush({ [field]: Math.max(min, base + parseFloat(b.getAttribute(attr))) }); };
  });
}
dWire('d-audio', 'data-dn', 'audioAt', 0);
dWire('d-video', 'data-dv', 'start', 0);
dWire('d-len',   'data-dl', 'len',   0.1);
dWire('d-rate',  'data-dr-none', 'rate', 0.05);   // the typed box; the presets SET a rate:
document.querySelectorAll('[data-dr]').forEach(b => b.onclick = () => dPush({ rate: +b.dataset.dr }));

$('d-close').onclick = dCloseMoment;
$('dmodal').onclick = e => { if (e.target.id === 'dmodal') dCloseMoment(); };
$('d-del').onclick = async () => {
  const r = dCur(); if (!r) return;
  if (dKind === 'chunk') {
    // named and undoable back into its own slot — one tap must never silently cost work
    const i = S.timeline.findIndex(x => x.id === r.id);
    try {
      await api('/api/clip', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id }) });
      dCloseMoment(); await refresh();
      toastAction(`removed chunk ${i + 1}`, 'Undo', async () => {
        await postJSON('/api/grab', { sourceId: r.sourceId, start: r.start, len: r.len, audioAt: r.audioAt, rate: rateOf(r) });
        await refresh(); toast('put back');
      });
    } catch (e) { toast(e.message, true); }
    return;
  }
  await api('/api/ramp', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: r.id }) });
  dCloseMoment(); refresh();
};
/* Loop THIS moment inside the editor, with its audio — so he can judge the match
   without leaving the modal. Josh, 2026-09-10. */
let dModalLoop = null;
function dStopModalLoop() {
  if (dModalLoop) cancelAnimationFrame(dModalLoop);
  dModalLoop = null;
  dv.pause(); dv.playbackRate = 1;
  if (dAudioEl) dAudioEl.pause();
  if ($('d-loop')) $('d-loop').textContent = dKind === 'chunk' ? '▶ Loop this chunk' : '▶ Loop this moment';
}
function dStartModalLoop() {
  const r = dCur(); if (!r) return;
  dStopModalLoop();
  const src = S.sources.find(x => x.id === r.sourceId); if (!src) return;
  const url = `/media/proxy/${src.proxy}`;
  const withAudio = $('d-loopaud').checked;
  const rate = rateOf(r), manual = !PLAYABLE(rate);   // play it the way the film will
  let vpos = r.start, last = performance.now();
  const begin = () => {
    dv.currentTime = r.start; vpos = r.start; last = performance.now();
    dv.playbackRate = manual ? 1 : rate;
    if (!manual) dv.play().catch(() => {});
    if (withAudio) {
      const a = dEnsureAudio();
      if (a) { const put = () => { try { a.currentTime = r.audioAt || 0; } catch {}
                                   a.play().catch(() => {}); };
               if (a.readyState >= 1) put(); else a.addEventListener('loadedmetadata', put, { once: true }); }
    }
    $('d-loop').textContent = '■ Stop';
    const tick = () => {
      if (!dModalLoop) return;
      // `ended` too: a piece running past the end of its clip never reaches start+len
      if (manual) { const now = performance.now(); vpos += ((now - last) / 1000) * rate; last = now;
                    if (!dv.seeking) dv.currentTime = vpos; }
      else vpos = dv.currentTime;
      if (dv.ended || vpos >= r.start + r.len - 0.02) {
        dv.currentTime = r.start; vpos = r.start; last = performance.now();
        if (!manual) dv.play().catch(() => {});
        if (withAudio && dAudioEl) { try { dAudioEl.currentTime = r.audioAt || 0; } catch {}
                                     dAudioEl.play().catch(() => {}); }
      }
      dModalLoop = requestAnimationFrame(tick);
    };
    dModalLoop = requestAnimationFrame(tick);
  };
  if (!dv.src.endsWith(url)) { dv.src = url; dv.addEventListener('loadeddata', begin, { once: true }); }
  else if (dv.readyState >= 2) begin(); else dv.addEventListener('loadeddata', begin, { once: true });
}
$('d-loop').onclick = () => { dModalLoop ? dStopModalLoop() : dStartModalLoop(); };
$('d-loopaud').onchange = () => { if (dModalLoop) dStartModalLoop(); };
$('d-save').onclick = () => dCloseMoment();      // every edit already saved as you go

/* 🔇 DRAG A SILENCE. Josh, 2026-09-26: "I can't drag anything. I'd much prefer to be able
   to drag something." Drag the middle = move it; drag within 7px of an edge = resize from
   that edge; a tap with no drag = open its editor. It moves on screen as he drags and is
   written ONCE on release (each write rebuilds the audio file). */
function sDragStart(ev, x, el, aTot) {
  ev.preventDefault(); ev.stopPropagation();
  const r = el.getBoundingClientRect(), bar = $('gt-abar').getBoundingClientRect();
  const k = aTot / (bar.width || 1);
  // drag only MOVES it — Josh, 2026-09-26: "I should not be able to adjust the length of a
  // silence by just dragging it on the line." Length lives in the editor (tap it).
  sDrag = { x, el, k, x0: ev.clientX, from: x.from, dur: +x.dur, mode: 'move', moved: false };
  el.setPointerCapture(ev.pointerId);
  el.onpointermove = e2 => {
    const d = (e2.clientX - sDrag.x0) * k;
    if (Math.abs(e2.clientX - sDrag.x0) > 3) sDrag.moved = true;
    if (!sDrag.moved) return;
    let f = x.from, len = +x.dur;
    if (sDrag.mode === 'move') f = Math.max(0, Math.min(aTot - len, x.from + d));
    else if (sDrag.mode === 'r') len = Math.max(0.1, Math.min(60, x.dur + d));
    else { const end = x.from + x.dur; f = Math.max(0, Math.min(end - 0.1, x.from + d)); len = end - f; }
    sDrag.from = +f.toFixed(2); sDrag.dur = +len.toFixed(2);
    el.style.left = (sDrag.from / aTot) * 100 + '%'; el.style.width = (sDrag.dur / aTot) * 100 + '%';
    $('gt-asub').textContent = `silence ${fmt(sDrag.from)} → ${fmt(sDrag.from + sDrag.dur)} · ${sDrag.dur.toFixed(2)}s — let go to set it`;
  };
  el.onpointerup = async () => {
    el.onpointermove = null; el.onpointerup = null;
    const dr = sDrag; sDrag = null;
    if (!dr.moved) { sOpen(x.audioId, x.id); return; }
    try {
      const body = dr.mode === 'r' ? { dur: dr.dur } : { moveTo: dr.from, dur: dr.dur };
      const res = await api('/api/audio/silence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioId: x.audioId, gapId: x.id, ...body }) });
      if (sEdit && sEdit.id === x.id && res.silence) sEdit = res.silence;
      await refresh(); if (sEdit) sFill();
      toast(`silence now ${fmt(dr.from)} → ${fmt(dr.from + dr.dur)} (${dr.dur.toFixed(2)}s)`);
    } catch (e) { toast(e.message, true); await refresh(); }
    $('gt-asil').dataset.sig = ''; paint();
  };
}

/* 🔇 EDIT ONE SILENCE — click it on the AUDIO track. Josh, 2026-09-26: "Once a bit of
   silence is injected, I can't actually remove it... I want to be able to like click on
   it like I can the other bits and then edit where it's at how long it is." Every change
   writes through (the server rebuilds the bed from the original), same as moments. */
const sCur = () => sEdit && allSilences().find(x => x.audioId === sEdit.audioId && x.id === sEdit.id);
function sOpen(audioId, id) {
  sEdit = { audioId, id };
  stopInput(); stopChunk(); stopOutput();
  $('smodal').hidden = false; sFill(); paint();
}
function sClose() { sStopHear(); sEdit = null; $('smodal').hidden = true; paint(); }
function sFill() {
  const x = sCur(); if (!x) return sClose();
  if (document.activeElement !== $('s-at'))  $('s-at').value  = x.from.toFixed(2);
  if (document.activeElement !== $('s-len')) $('s-len').value = (+x.dur).toFixed(2);
  const a = S.audio.find(b => b.id === x.audioId);
  $('s-why').textContent = a ? a.name : '';
  $('s-plan').innerHTML = `Silent from <b>${fmt(x.from)}</b> to <b>${fmt(x.to)}</b> · <b>${(+x.dur).toFixed(2)}s</b>`
    + `<br>Everything after it in the audio plays <b>${(+x.dur).toFixed(2)}s</b> later — moments, chunks and captions ride along.`;
}
async function sPush(body, method = 'POST') {
  const x = sCur(); if (!x) return;
  try {
    const r = await api('/api/audio/silence', { method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioId: x.audioId, gapId: x.id, ...body }) });
    if (r && r.silence) sEdit = r.silence;             // the before/after pads can change id when moved
    await refresh(); sFill(); paint();
  } catch (e) { toast(e.message, true); }
}
const sMove = t => { const x = sCur(); if (x) sPush({ moveTo: Math.max(0, t), dur: x.dur }); };
const sLen  = d => sPush({ dur: Math.max(0.05, Math.min(60, d)) });
$('s-at').addEventListener('change', () => { const v = parseFloat($('s-at').value); isFinite(v) ? sMove(v) : sFill(); });
$('s-len').addEventListener('change', () => { const v = parseFloat($('s-len').value); isFinite(v) ? sLen(v) : sFill(); });
['s-at', 's-len'].forEach(id => $(id).addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); $(id).blur(); } }));
document.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => { const x = sCur(); if (x) sMove(x.from + +b.dataset.sa); });
document.querySelectorAll('[data-sl]').forEach(b => b.onclick = () => { const x = sCur(); if (x) sLen(+x.dur + +b.dataset.sl); });
function sStopHear() { if (sHearT) clearTimeout(sHearT); sHearT = null; if (sAud) sAud.pause(); $('s-hear').textContent = '▶ Hear it'; }
function sHear() {
  if (sHearT) return sStopHear();
  const x = sCur(); if (!x) return;
  const a = S.audio.find(b => b.id === x.audioId); if (!a) return;
  let base = 0; for (const b of S.audio) { if (b === a) break; base += b.duration || 0; }
  if (!sAud) { sAud = document.createElement('audio'); sAud.preload = 'auto'; document.body.appendChild(sAud); }
  const want = `/media/audio/${a.file}`;
  if (!sAud.src.endsWith(want)) sAud.src = want;
  const from = Math.max(0, x.from - base - 1), len = (x.to - base + 1) - from;
  const go = () => { try { sAud.currentTime = from; } catch {} sAud.play().catch(() => {});
                     $('s-hear').textContent = '■ Stop'; sHearT = setTimeout(sStopHear, len * 1000); };
  if (sAud.readyState >= 1) go(); else sAud.addEventListener('loadedmetadata', go, { once: true });
}
$('s-hear').onclick = sHear;
$('s-close').onclick = sClose;
$('s-done').onclick = sClose;
$('smodal').onclick = e => { if (e.target.id === 'smodal') sClose(); };
$('s-del').onclick = async () => {
  const x = sCur(); if (!x) return;
  try {
    await api('/api/audio/silence', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioId: x.audioId, gapId: x.id }) });
    sClose(); await refresh();
    toastAction(`removed ${(+x.dur).toFixed(2)}s of silence at ${fmt(x.from)}`, 'Undo', async () => {
      await postJSON('/api/audio/silence', { at: x.from, dur: x.dur }); await refresh(); toast('put back');
    });
  } catch (e) { toast(e.message, true); }
};

/* 🔇 insert silence at LANDS AT — the audio file itself gets the gap */
$('siladd').onclick = async () => {
  if (!S.audio.length) { toast('add an audio bed first'); return; }
  const dur = Math.max(0.1, Math.min(60, parseFloat($('silfield').value) || 2));
  const at = dAudioAt;
  try {
    await postJSON('/api/audio/silence', { at, dur });
    await refresh();
    toast(`added ${dur}s of silence at ${fmt(at)} — everything after it moved ${dur}s later`);
  } catch (e) { toast(e.message, true); }
};
$('silfield').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('siladd').click(); } e.stopPropagation(); });

/* ---------- uploads ---------- */
async function upload(file, endpoint, at) {
  toast(`uploading ${file.name}…`);
  try {
    const pos = Number.isInteger(at) ? `&at=${at}` : '';
    await api(`${endpoint}?name=${encodeURIComponent(file.name)}${pos}`, { method: 'POST', body: file });
    toast(endpoint.includes('source')
      ? `${file.name} — preparing it` + (Number.isInteger(at) ? ` · slot ${at + 1}` : '')
      : `${file.name} added`);
    await refresh(); if (!$('screen-assets').hidden) renderAssets();
  } catch (e) { toast(e.message, true); }
}
/* The hidden file inputs are wired on their OWN, not as a side effect of a drop zone —
   the INPUT screen's drop zones are gone (ASSETS owns file management), but the ASSETS
   zones click these same inputs, so their onchange is what actually performs the upload. */
for (const [inputId, ep] of [['filev', '/api/upload-source'], ['filea', '/api/upload-audio']]) {
  const input = $(inputId);
  input.onchange = () => {
    const files = [...input.files];
    const at = input.dataset.at === undefined || input.dataset.at === '' ? NaN : Number(input.dataset.at);
    delete input.dataset.at;
    if (Number.isInteger(at)) uploadVideosAt(files, at);
    else files.forEach(f => upload(f, ep));
    input.value = '';
  };
}
// the ASSETS screen's drop zones — click opens the shared input, drag drops straight in
$('dropv2').onclick = () => { delete $('filev').dataset.at; $('filev').click(); };
/* A file dropped in the GAPS of the grid (not on a card) goes on the end, same as the
   add zone — without this the browser would navigate away to the dropped file. */
{
  const g = $('ass-videos');
  g.addEventListener('dragover', e => {
    if ([...(e.dataTransfer.types || [])].includes('Files') || assDragFrom >= 0) e.preventDefault();
  });
  g.addEventListener('drop', e => {
    e.preventDefault();
    clearDropMarks(); assDragFrom = -1;
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) files.forEach(f => upload(f, '/api/upload-source'));
  });
}
$('dropa2').onclick = () => $('filea').click();
$('addaudio').onclick = () => $('filea').click();   // add an audio bed from the grabber
for (const [el, ep] of [['dropv2','/api/upload-source'], ['dropa2','/api/upload-audio']]) {
  const d = $(el);
  d.ondragover = e => { e.preventDefault(); d.classList.add('over'); };
  d.ondragleave = () => d.classList.remove('over');
  d.ondrop = e => { e.preventDefault(); d.classList.remove('over');
                    [...e.dataTransfer.files].forEach(f => upload(f, ep)); };
}

/* ---------- export screen ----------
   Josh, 2026-09-15: "when I go to export, it should provide me a screen of like what I
   want to export in the assumption everything in the order it's in ... allow me to choose
   a name ... But keep it simple, don't make it weird."
   It confirms WHAT is going out (the active chapter, as it stands) and takes a name. */
function openExport() {
  /* Is there anything to export AT ALL? Per-chapter readiness is judged on each chapter's
     OWN mode below (a Speed chapter's work is in its moments, a Grab chapter's in its
     chunks) — checking one mode against every chapter is exactly the bug that made a
     valid Speed project un-exportable before. */
  if (!CHAPS.some(c => c.marks > 0)) {
    toast(mode === 'ramp'
      ? 'nothing to export yet — mark a moment with G first'
      : 'nothing to export — add a chunk to the output first', true);
    return;
  }
  $('exname').dataset.touched = '';

  /* THE PICKER. Josh, 2026-09-15: "if I have a chapter open and it has two chapters it
     should always allow me to export those as one long movie as one long MP4 — that was
     the whole point ... give it a menu that actually lets me choose what I'm exporting."
     Starts with just the chapter he is in ticked, because that is the common case; tick
     more and they stitch, in chapter order, into one film. */
  const box = $('expick');
  box.innerHTML = '';
  for (const c of CHAPS) {
    const row = document.createElement('label');
    row.className = 'exrowc';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = c.id; cb.checked = c.active;
    cb.onchange = exSummarise;
    const nm = document.createElement('span');
    nm.className = 'cn'; nm.textContent = c.title;
    const dt = document.createElement('span');
    dt.className = 'cd';
    dt.textContent = `${c.mode === 'grab' ? 'Grab' : 'Speed'} · ${c.marks} `
                   + `${c.mode === 'grab' ? 'chunks' : 'moments'} · ${c.sources} clips`
                   + (c.seconds ? ` · ${fmtLen(c.seconds)}` : '');
    row.append(cb, nm, dt);
    box.appendChild(row);
  }
  exSummarise();

  /* Default the name to what is ticked — the chapter when it is one, the project when it
     is the whole film. Either way he can type over it. */
  $('exname').value = exDefaultName();
  $('exdrawer').hidden = false;
  const inp = $('exname');
  inp.focus(); inp.select();
}
const fmtLen = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const exTicked = () => [...document.querySelectorAll('#expick input:checked')].map(x => x.value);
function exDefaultName() {
  const ids = exTicked();
  if (ids.length === 1) {
    const c = CHAPS.find(x => x.id === ids[0]);
    if (c) return c.title;
  }
  return S.name && S.name !== 'Untitled' ? S.name : 'Magpie';
}
/* Say what the film will actually BE, and keep saying it as he ticks. */
function exSummarise() {
  const ids = exTicked();
  const picked = CHAPS.filter(c => ids.includes(c.id));
  const secs = picked.reduce((a, c) => a + (c.seconds || 0), 0);
  const el = $('exsum');
  /* An EMPTY chapter cannot render, and the server would fail the whole job partway
     through. Say so here instead, and name which one — the failure is otherwise
     indistinguishable from the others. */
  const empty = picked.filter(c => !c.marks);
  if (!picked.length) {
    el.innerHTML = 'Nothing ticked — pick at least one chapter.';
  } else if (empty.length) {
    el.innerHTML = `“${empty.map(c => c.title).join('”, “')}” `
                 + `${empty.length > 1 ? 'have' : 'has'} nothing in `
                 + `${empty.length > 1 ? 'them' : 'it'} yet — untick to export the rest.`;
  } else if (picked.length === 1) {
    el.innerHTML = `One chapter — about <b>${fmtLen(secs)}</b>.`;
  } else {
    el.innerHTML = `<b>${picked.length} chapters</b> stitched into one film, in the order `
                 + `they sit in the strip — about <b>${fmtLen(secs)}</b> total.`;
  }
  $('exgo').disabled = !picked.length || !!empty.length;
  /* Only re-default the NAME while he has not typed his own, so ticking another chapter
     does not throw away something he already wrote. */
  if (!$('exname').dataset.touched) $('exname').value = exDefaultName();
}
function closeExport() { $('exdrawer').hidden = true; }
$('excancel').onclick = closeExport;
$('exdrawer').addEventListener('click', e => { if (e.target === $('exdrawer')) closeExport(); });
$('exname').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('exgo').click(); return; }
  /* ESC must still close the screen — the button literally says "CANCEL ESC", and this
     field is FOCUSED the moment the screen opens, so swallowing Escape here would break
     that promise on the most likely path of all. Handle it rather than pass it on: the
     global handler would also stop playback and leave the editing screen. */
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExport(); return; }
  e.stopPropagation();          // any OTHER typing must not trigger the editor's hotkeys
});
$('exname').addEventListener('input', () => { $('exname').dataset.touched = '1'; });
$('exgo').onclick = () => {
  const n = $('exname').value, ids = exTicked();
  if (!ids.length) return;
  closeExport();
  doExport(n, ids);
};

/* ---------- export ---------- */
/* `chapterIds` — which chapters go in the film. The export SCREEN decides that and does
   the "is there anything to render" checking (per chapter, on each chapter's own mode);
   this function just runs the job it was handed.
   ⚠️ Historical note worth keeping: this used to guard on S.timeline regardless of mode,
   and in SPEED mode the timeline is empty BY DESIGN — the work lives in S.ramps. A valid
   speed project was refused here and never reached the endpoint that would have rendered
   it. Josh, 2026-09-14: "I want to click export and it says nothing to export." Any new
   guard here must be mode-correct, or per-chapter, for the same reason. */
async function doExport(wantName, chapterIds) {
  $('render').disabled = true; $('render').textContent = 'Exporting…';
  try {
    await postJSON('/api/render', { name: wantName, chapters: chapterIds || [] });
    const poll = setInterval(async () => {
      const j = await api('/api/state');
      const job = (j.jobs || {}).render;
      if (!job) return;
      if (job.status === 'working') $('render').textContent = `Exporting ${job.pct}%`;
      if (job.status === 'done') {
        clearInterval(poll);
        $('render').disabled = false; $('render').textContent = 'Export';
        /* SAY WHERE IT WENT. Josh, 2026-09-14: "what are they getting
           exported to?" — the old toast said "it's under Exports" and then
           window.open()'d the file into a NEW TAB, which PLAYS it rather than saving
           it. So a finished film looked like it had vanished. The server now also
           copies it to ~/Downloads and reports that name back as `saved`. */
        toast(job.saved
          ? `done — saved to your Downloads as “${job.saved}”`
          : `done — it’s under Exports${job.saveError ? ` (couldn’t reach Downloads: ${job.saveError})` : ''}`,
          !!job.saveError);
            }
      if (job.status === 'error') {
        clearInterval(poll);
        $('render').disabled = false; $('render').textContent = 'Export';
        toast(job.error, true);
      }
    }, 900);
  } catch (e) {
    $('render').disabled = false; $('render').textContent = 'Export';
    toast(e.message, true);
  }
}
/* The Export button opens the screen; the screen is what actually starts the render. */
$('render').onclick = openExport;

/* Josh, 2026-09-15: "we have this button called clear and I'm nervous to even click it
   because I don't know what that does." So it now says its own name ("Start over") and
   the confirm spells out exactly what goes and what stays — including, now, that it takes
   EVERY chapter with it, which is the thing he could least afford to discover by doing. */
$('reset').onclick = async () => {
  const chapterNames = CHAPS.map(c => `“${c.title}”`).join(', ');
  if (!confirm(
    `Start over?\n\n`
    + `This empties the project “${S.name || 'Untitled'}” — all ${CHAPS.length} chapter`
    + `${CHAPS.length === 1 ? '' : 's'} (${chapterNames}), their clips, audio and moments.\n\n`
    + `KEPT: every film you have already exported (they are in your Downloads), your saved `
    + `projects, and all the video and audio files themselves.\n\n`
    + `If you have not saved this project under a name, there is no way back.`)) return;
  await api('/api/reset', { method: 'POST' });
  cur = null; editingId = null; chunkStart = 0;
  v.removeAttribute('src'); $('cnone').style.display = '';
  $('srcname').textContent = 'no video loaded';
  refresh();
};

refresh();
{ const want = location.pathname.replace(/^\/+|\/+$/g, '');
  showScreen(['input', 'output', 'assets'].includes(want) ? want : 'input', true);
  history.replaceState({ screen }, '', '/' + screen); }
addEventListener('popstate', e => { const w = (e.state && e.state.screen) || location.pathname.slice(1);
  if (['input', 'output', 'assets'].includes(w)) showScreen(w, true); });

/* ================= MOBILE =================
   Josh, 2026-09-09: "this will actually make it a mobile friendly experience,
   so I won't have to be near my computer."

   SPEED MODE ONLY — no grab mode on a phone (his call). One screen: video track,
   audio track, a length picker, and one button that does what G does on desktop.

   THE HARD REQUIREMENT (his): "It should be easily able to transfer the same
   functionality that I'm able to do on mobile onto desktop in the end. So that I
   don't ever find myself editing a video that I can only edit on my phone."
   -> This writes the SAME `ramps[]` through the SAME endpoints the desktop uses.
      There is no mobile format, no mobile file, nothing to migrate. Open the same
      project on either and keep going. */

const MOBILE_Q = window.matchMedia('(max-width: 820px)');
const mv = $('mv');                    // the phone's video element
let mAudio = null;                     // its audio element
let mLen = 2;                          // how long the next real-time moment is
let mSel = null;                       // id of the mark being edited
let mPlaying = null;                   // 'loop' | 'both' | null
let mRAF = null, mBothPos = 0;
let mScreen = 'input';           // 'input' | 'output'
let mLoopFrom = 0, mLoopTo = 0;
let mChunkStart = 0;     // where the pending chunk BEGINS — only a drag moves this
let mAudioStart = 0;     // where HE parked the bed — only he moves it
let mBlocked = false;    // the browser refused to autoplay — say so, don't hide it
const M_LENS = [0.5, 1, 2, 3, 5];   // half-second in, per his ask

function isMobile() { return MOBILE_Q.matches; }
const mReady = () => S.sources.filter(s => s.ready);
const mSrc = () => mReady()[0] || null;         // the first part — kept for boot
const mAud = () => S.audio[0] || null;

/* The phone shows ONE continuous video and ONE continuous audio, however many
   files are stapled behind them (his design). These map a position on that single
   timeline onto (file, offset) — the same order the server's render walks. */
const mVideoTotal = () => mReady().reduce((a, s) => a + useLen(s), 0);
/* The chunk must ALWAYS fit inside the input — a start past (total - len) leaves
   the loop nothing valid to play, which is why pushing it to the end killed the
   loop entirely. Clamp in ONE place and use it everywhere. */
function mClampStart(t, len) {
  const total = mVideoTotal();
  const L = Math.min(len != null ? len : mLen, total || 0);
  return Math.max(0, Math.min(Math.max(0, total - L), t));
}
const mAudioTotalAll = () => S.audio.reduce((a, x) => a + (x.duration || 0), 0);
function mVideoAt(t) {                      // t = seconds along the whole input
  let acc = 0;                             // `into` is a real position INSIDE the file
  for (const s of mReady()) {
    const d = useLen(s);                   // a trimmed clip contributes only its kept part
    if (t < acc + d || s === mReady()[mReady().length - 1])
      return { src: s, into: Math.max(0, t - acc) + useIn(s), base: acc };
    acc += d;
  }
  return null;
}
function mVideoPos() {                      // where we are on the whole input
  const cur = S.sources.find(s => mv.src.endsWith(s.proxy));
  if (!cur) return 0;
  let acc = 0;
  for (const s of mReady()) { if (s.id === cur.id) break; acc += useLen(s); }
  return acc + Math.max(0, (mv.currentTime || 0) - useIn(cur));   // file -> timeline
}

/* ---- the two tracks: drag anywhere, it's a thumb not a cursor ---- */
function wireTrack(barId, onSeek, onDragEnd) {
  const bar = $(barId);
  let dragging = false;
  const at = e => {
    const r = bar.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return Math.max(0, Math.min(1, x / r.width));
  };
  const go = e => { e.preventDefault(); onSeek(at(e)); };
  bar.addEventListener('pointerdown', e => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT')
      document.activeElement.blur();         // commit a typed length before scrubbing
    e.preventDefault();                      // claim it before Android reads a back-swipe
    dragging = true; bar.setPointerCapture(e.pointerId); go(e);
  });
  // belt and braces on the Android edge-swipe: never let the page itself pan sideways
  bar.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  bar.addEventListener('touchmove',  e => e.preventDefault(), { passive: false });
  bar.addEventListener('pointermove', e => { if (dragging) go(e); });
  bar.addEventListener('pointerup',   e => { dragging = false; if (onDragEnd) onDragEnd(); });
  bar.addEventListener('pointercancel', () => { dragging = false; if (onDragEnd) onDragEnd(); });
}

function mStopAll() {
  mPlaying = null;
  cancelAnimationFrame(mRAF); mRAF = null;
  mv.pause();
  if (mAudio) mAudio.pause();
  $('m-live').hidden = true;
  mPaint();
}
function mEnsureAudio() {
  const a = mAud();
  if (!a) return null;
  if (!mAudio) { mAudio = document.createElement('audio'); mAudio.preload = 'auto'; document.body.appendChild(mAudio); }
  const want = `/media/audio/${a.file}`;
  if (!mAudio.src.endsWith(want)) mAudio.src = want;
  return mAudio;
}

/* ---- PREVIEW TOGETHER: what the output will actually look like ----
   His: "when I click play, like the play together feature, I should be able to see
   what the actual output screen would be. So I would see it all slowed down."
   Reuses rampAt() — the SAME mapping the desktop preview and the render use. */
function mPlayBoth() {
  if (!plan || !plan.ok) { toast(plan && plan.why ? plan.why : 'add a video and audio first'); return; }
  const from = (mBothPos > 0.05 && mBothPos < outLength() - 0.05) ? mBothPos : 0;
  mStopAll();
  mPlaying = 'both';
  mBothPos = from;
  $('m-live').hidden = false;
  $('m-live').textContent = 'PREVIEW';
  const a = mEnsureAudio();
  if (a) { a.currentTime = from; a.play().catch(() => {}); }
  let last = performance.now();
  const step = () => {
    if (mPlaying !== 'both') return;
    const now = performance.now(); const dt = (now - last) / 1000; last = now;
    mBothPos = a ? a.currentTime : mBothPos + dt;
    if (mBothPos >= outLength() - 0.01) { mStopAll(); toast('end of output'); return; }
    const hit = rampAt(mBothPos);
    if (hit) {
      const url = `/media/proxy/${hit.src.proxy}`;
      if (!mv.src.endsWith(url)) mv.src = url;
      else if (mv.readyState >= 2) {
        // TWIN of driveRampVideo(): outside 0.25x–4x, steer by seeking (a flipbook)
        const r = hit.rate || 1;
        if (r > 4 || r < 0.25) {
          if (!mv.paused) mv.pause();
          if (!mv.seeking && Math.abs(mv.currentTime - hit.at) > 1 / 30) {
            if (r > 4 && mv.fastSeek) mv.fastSeek(hit.at); else mv.currentTime = hit.at;
          }
        } else {
          if (Math.abs(mv.playbackRate - r) > 0.01) mv.playbackRate = r;
          if (Math.abs(mv.currentTime - hit.at) > 0.35) mv.currentTime = hit.at;
          if (mv.paused) mv.play().catch(() => {});
        }
      }
    }
    mPaint();
    mRAF = requestAnimationFrame(step);
  };
  mRAF = requestAnimationFrame(step);
}
/* THE INPUT VIDEO ALWAYS LOOPS THE CHUNK — it never plays straight through.
   Josh, 2026-09-09: "there's really no version of it where you can just play it
   straight through, it really is just like a hunt down the chunk you're looking
   for until it's in view, match it up to the audio you want, and then you can
   select it." So: scrubbing MOVES the loop, it doesn't stop it.
   Optionally the audio bed rides along while it loops (his ask). */
let mLoopOn = true;         // looping is the default state, not a mode you enter
let mLoopAudio = false;     // does the bed play along with the loop

function mLoopWindowStart() {
  const sel = mSel ? (S.ramps || []).find(x => x.id === mSel) : null;
  if (!sel) return mChunkStart;
  // a mark stores (sourceId, start-within-that-source) — put it on the whole line
  let acc = 0;
  for (const s of mReady()) {
    if (s.id === sel.sourceId) return acc + (sel.start - useIn(s));   // file -> timeline
    acc += useLen(s);
  }
  return sel.start;
}
function mLoopWindow() {
  // editing an existing mark? loop THAT. otherwise loop the pending one.
  // mChunkStart is an EXPLICIT anchor moved only by dragging the track — reading
  // mv.currentTime here made a length change snap the start to the live playhead.
  const sel = mSel ? (S.ramps || []).find(x => x.id === mSel) : null;
  return { start: mLoopWindowStart(), len: sel ? sel.len : mLen };
}
function mStartLoop() {
  const src = mSrc(); if (!src || !mLoopOn) return;
  // load whichever part the loop's start falls in
  const at = mVideoAt(mLoopWindowStart());
  if (at) { const url = `/media/proxy/${at.src.proxy}`;
            if (!mv.src.endsWith(url)) { mv.src = url;
              mv.addEventListener('loadeddata', () => mStartLoop(), { once:true }); return; } }
  mPlaying = 'loop';
  $('m-live').hidden = false;
  $('m-live').textContent = 'LOOPING';
  const w = mLoopWindow();
  mLoopFrom = w.start; mLoopTo = w.start + w.len;
  /* TWIN of the desktop loops: play at this chunk's rate; steer by seeking beyond 0.25–4x */
  const selR = mSel ? (S.ramps || []).find(x => x.id === mSel) : null;
  const mRate = selR ? rateOf(selR) : grabRate(), mManual = !PLAYABLE(mRate);
  let mLast = performance.now();
  mv.playbackRate = mManual ? 1 : mRate;
  // Phones block UNMUTED autoplay. The loop is a background behaviour, not a
  // user-initiated play, so it must be muted to run at all — the bed is what
  // carries sound, and only when he turns it on (which is itself a tap).
  mv.muted = true;
  const pos0 = mVideoPos();
  if (pos0 < mLoopFrom || pos0 > mLoopTo) {
    const at0 = mVideoAt(mLoopFrom);
    if (at0) mv.currentTime = at0.into;
  }
  if (mManual) mv.pause();
  else mv.play().then(() => { mBlocked = false; mPaint(); })
           .catch(() => { mBlocked = true; mPaint(); });   // never swallow it
  mSyncLoopAudio(true);
  cancelAnimationFrame(mRAF);
  const step = () => {
    if (mPlaying !== 'loop') return;
    if (mManual) { const now = performance.now();
                   if (!mv.seeking) mv.currentTime = (mv.currentTime || 0) + ((now - mLast) / 1000) * mRate;
                   mLast = now; }
    const pos = mVideoPos();          // where we are on the WHOLE input
    /* 🚨 ALSO WRAP WHEN THE FILE RAN OUT. Josh, 2026-09-22: "when it gets like outside
       of the chunk that I'm looking at, it doesn't loop back to the beginning of that
       chunk, it just like stops the video, continues the audio."
       A loop window can SPAN A CLIP BOUNDARY (his did: 28.03→31.09 across clip 1, which
       ends at 30.53). `mv` only ever holds ONE clip's proxy, so playback hit `ended` at
       30.53 — and because `mVideoPos()` then FREEZES there, `pos >= mLoopTo - 0.02` was
       never true and the wrap never fired. The video sat paused while the bed played on,
       which is exactly the confusing thing he described. `mv.ended` is the signal the
       arithmetic cannot see. */
    if (pos >= mLoopTo - 0.02 || pos < mLoopFrom - 0.05 || mv.ended) {
      const at = mVideoAt(mLoopFrom);
      if (at) {
        const url = `/media/proxy/${at.src.proxy}`;
        if (!mv.src.endsWith(url)) { mv.src = url;
          mv.addEventListener('loadeddata', () => { mv.currentTime = at.into; mv.play().catch(()=>{}); }, { once:true }); }
        else {
          mv.currentTime = at.into;
          /* After `ended`, seeking alone does NOT resume — the element stays paused
             and the loop would wrap once and then sit there. */
          if (mv.paused && !mManual) mv.play().catch(() => {});
          mLast = performance.now();
        }
      }
      mSyncLoopAudio(true);          // the bed loops WITH the video, every wrap
    }
    mPaint();
    mRAF = requestAnimationFrame(step);
  };
  mRAF = requestAnimationFrame(step);
}
/* The bed plays the moment of the AUDIO that this chunk will land on, and
   restarts with every loop — so he can hear whether the picture matches the words.
   Where a chunk lands in the output: if it's already a real-time mark, that's its
   own outFrom; otherwise it's where a mark placed here WOULD land. */
/* WHERE HE PUT THE AUDIO IS WHERE THE AUDIO GOES.
   Josh, 2026-09-09: "I'll change where the audio is at with my thumb, and then when
   I hit play loop, it starts playing from the beginning every time, and so it doesn't
   seem to actually care where I put it."
   The old version COMPUTED the bed position from where the video chunk mapped into
   the output, and with no marks that computation returned 0 — so his drag was thrown
   away on every loop. The video and the audio are two INDEPENDENT transports he lines
   up by hand; mAudioStart is his, and only he moves it. */
function mSyncLoopAudio(restart) {
  const a = mEnsureAudio();
  if (!a) return;
  if (!mLoopAudio || mPlaying !== 'loop') { a.pause(); return; }
  if (restart) {
    const dur = a.duration || mAudioTotalAll() || 0;
    a.currentTime = Math.max(0, Math.min(Math.max(0, dur - 0.05), mAudioStart));
  }
  a.play().catch(() => {});
}

function mRetargetLoop() {
  // he scrubbed or resized — move the loop, don't stop it
  if (mPlaying !== 'loop') return;
  const w = mLoopWindow();
  mLoopFrom = w.start; mLoopTo = w.start + w.len;
  const pos = mVideoPos();
  if (pos < mLoopFrom || pos > mLoopTo) {
    const at = mVideoAt(mLoopFrom);
    if (at) {
      const url = `/media/proxy/${at.src.proxy}`;
      if (!mv.src.endsWith(url)) { mv.src = url;
        mv.addEventListener('loadeddata', () => { mv.currentTime = at.into; }, { once:true }); }
      else mv.currentTime = at.into;
    }
  }
  mSyncLoopAudio(true);
}

/* ---- mark / edit — the same endpoints the desktop uses ---- */
async function mMark() {
  const hit = mVideoAt(mChunkStart);
  if (!hit) { toast('add a video first'); return; }
  try {
    const r = await api('/api/ramp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: hit.src.id, start: hit.into, len: mLen,
                             audioAt: mAudioStart, rate: grabRate() }) });   // pinned to HIS audio spot
    await refresh();
    mSel = r.ramp ? r.ramp.id : null;      // open it for tweaking straight away
    toast(`${mLen}s at ${fmtRate(grabRate())}, landing at ${fmt(mAudioStart)} in the audio`);
    if (mLoopOn) mStartLoop();             // keep looping what he just claimed
    mSaveView(true);
    mPaint();
  } catch (e) { toast(e.message, true); }
}
async function mEditSel(patch) {
  if (!mSel) return;
  const r = (S.ramps || []).find(x => x.id === mSel); if (!r) return;
  try {
    await api('/api/ramp/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: mSel, ...patch }) });
    await refresh();
    const now = (S.ramps || []).find(x => x.id === mSel);
    if (now) { mv.currentTime = now.start; if (mPlaying === 'loop') mRetargetLoop(); }
    mSaveView(true);
    mPaint();
  } catch (e) { toast(e.message, true); }
}
async function mDeleteSel() {
  if (!mSel) return;
  await api('/api/ramp', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mSel }) });
  mSel = null;
  await refresh();
  mSaveView(true);
  mPaint();
}

/* ---- paint ---- */
function mPaint() {
  if (!isMobile()) return;
  const src = mSrc(), aud = mAud();
  $('m-none').hidden = !!(src && aud);
  $('m-plan').innerHTML = (plan && plan.ok)
    ? `${plan.windows} real-time · rest <b style="color:#fff">${plan.speed}×</b><br>lands on ${plan.audioTotal}s`
    : (plan && plan.why ? plan.why : '—');

  // video track
  const vd = mVideoTotal();
  const vt = mVideoPos();
  const nParts = mReady().length;
  $('m-vpos').textContent = `${fmt(vt)} / ${fmt(vd)}`
    + (nParts > 1 ? ` · ${nParts} clips` : '');
  $('m-vhead').style.left = vd ? (vt / vd) * 100 + '%' : '0%';
  const marks = $('m-vmarks'); marks.innerHTML = '';
  if (vd) {
    // where each source begins on the continuous line — a mark's stored start is
    // relative to ITS source, so it has to be offset onto the whole timeline
    const base = {}; let acc = 0;   // NB: a mark's start is file-relative; subtract useIn
    for (const sc of mReady()) { base[sc.id] = acc; acc += useLen(sc); }
    // faint seams so he can see where one clip ends and the next begins
    if (nParts > 1) { let a2 = 0;
      for (const sc of mReady().slice(0, -1)) { a2 += useLen(sc);
        const j = document.createElement('u');
        j.style.cssText = `position:absolute;top:0;bottom:0;left:${(a2/vd)*100}%;width:1px;background:var(--dim);opacity:.6`;
        marks.appendChild(j); } }
    (S.ramps || []).forEach(r => {
      if (base[r.sourceId] == null) return;
      const sc = S.sources.find(x => x.id === r.sourceId);
      const i = document.createElement('i');
      // r.start is FILE-relative; the bar is the trimmed timeline
      i.style.left = ((base[r.sourceId] + r.start - (sc ? useIn(sc) : 0)) / vd) * 100 + '%';
      i.style.width = Math.max(0.6, (r.len / vd) * 100) + '%';
      if (r.id === mSel) i.className = 'sel';
      marks.appendChild(i);
    });
  }
  // The window sits where the CHUNK is, not where the playhead is — the cursor
  // sweeps across it while it stays put.
  const w = $('m-vwin');
  const sel0 = mSel ? (S.ramps || []).find(x => x.id === mSel) : null;
  const winFrom = sel0 ? sel0.start
                : (mPlaying === 'loop') ? mLoopFrom
                : mChunkStart;
  const winLen = sel0 ? sel0.len : mLen;
  if (vd) { w.hidden = false;
            w.style.left = (winFrom / vd) * 100 + '%';
            w.style.width = Math.max(0.6, (winLen / vd) * 100) + '%'; }
  else w.hidden = true;

  // audio track
  const ad = mAudioTotalAll() || (mAudio && mAudio.duration) || 0;
  const at = (mAudio && mAudio.currentTime) || 0;
  $('m-apos').textContent = `${fmt(at)} / ${fmt(ad)}`
    + (S.audio.length > 1 ? ` · ${S.audio.length} clips` : '');
  $('m-ahead').style.left = ad ? (at / ad) * 100 + '%' : '0%';
  // where each real-time moment lands IN THE AUDIO (the output clock)
  const am = $('m-amarks'); am.innerHTML = '';
  if (ad && plan && plan.ok) {
    for (const g of rampSegments()) {
      if (!g.real) continue;
      const i = document.createElement('i');
      i.style.left = (g.outFrom / ad) * 100 + '%';
      i.style.width = Math.max(0.6, (g.outLen / ad) * 100) + '%';
      am.appendChild(i);
    }
  }

  // ---- OUTPUT screen ----
  if (mScreen === 'output') {
    const end = outLength();
    $('m-opos').textContent = `${fmt(mBothPos)} / ${fmt(end)}`;
    $('m-ohead').style.left = end ? (mBothPos / end) * 100 + '%' : '0%';
    const om = $('m-omarks'); om.innerHTML = '';
    const segs = (plan && plan.ok) ? rampSegments() : [];
    if (end) segs.forEach(g => {
      const i = document.createElement('i');
      i.style.left = (g.outFrom / end) * 100 + '%';
      i.style.width = Math.max(0.5, (g.outLen / end) * 100) + '%';
      if (!g.real) i.className = 'fastseg';
      om.appendChild(i);
    });
    const sl = $('m-seglist'); sl.innerHTML = '';
    if (!segs.length) {
      const d = document.createElement('div'); d.className = 'mempty';
      /* SAY WHAT IS ACTUALLY TRUE. Josh, 2026-09-22 (via Rooster): "it's saying that
         there's no audio bed which is weird because there definitely is an audio bed for
         all the chapters." This line fell back to 'add a video and an audio bed first'
         whenever there was no SPEED plan — and the plan is only ever fetched in SPEED
         mode, so in GRAB it said that with a video and a bed both present (reproduced
         on his live Intro: 8 videos, a 37.59s bed, message still claimed neither). Every
         clause now checks the real thing it names. */
      const grabSecs = total();          // the real GRAB output length (placement + rate)
      d.textContent = !mReady().length ? 'add a video first'
        : !S.audio.length ? 'add an audio bed first'
        : mode !== 'ramp'
          ? (S.timeline.length ? `${S.timeline.length} chunk${S.timeline.length > 1 ? 's' : ''} in the output · ${fmt(grabSecs)}`
                               : 'nothing grabbed yet — scrub to a moment and grab it')
        : (plan && plan.why) ? plan.why : 'nothing marked yet';
      sl.appendChild(d);
    }
    segs.forEach(g => {
      const d = document.createElement('div');
      const live = mPlaying === 'both' && mBothPos >= g.outFrom && mBothPos < g.outFrom + g.outLen;
      d.className = 'mseg ' + (g.real ? 'real' : 'fast') + (live ? ' play' : '');
      const rate = g.rate;
      d.innerHTML = `<span><b>${g.real ? 'REAL 1×' : 'FAST ' + (rate ? rate.toFixed(2) : '—') + '×'}</b>
                       <span class="w">${g.outLen.toFixed(1)}s</span></span>
                     <span class="w">${g.real ? 'tap to edit' : 'auto'} · at ${fmt(g.outFrom)}</span>`;
      d.onclick = () => {
        if (g.real && g.id) { mMiniOpen = (mMiniOpen === g.id) ? null : g.id; mPaint(); return; }
        mStopAll();                        // a filler span: just jump there
        mBothPos = g.outFrom + 0.01;
        const a = mEnsureAudio(); if (a) a.currentTime = mBothPos;
        const url = `/media/proxy/${g.src.proxy}`;
        if (!mv.src.endsWith(url)) mv.src = url;
        const seek = () => { mv.currentTime = g.from; mPaint(); };
        if (mv.readyState >= 2) seek(); else mv.addEventListener('loadeddata', seek, { once: true });
        mPaint();
      };
      sl.appendChild(d);
      if (g.real && g.id && mMiniOpen === g.id) sl.appendChild(mMiniEditor(g));
    });
    $('m-o-play').textContent = mPlaying === 'both' ? '■ Pause' : '▶ Play output';
  }

  $('m-loop').textContent = mBlocked ? '▶ Tap to start loop'
                          : (mPlaying === 'loop') ? '❚❚ Pause loop' : '▶ Loop chunk';
  $('m-loop').classList.toggle('pri', mPlaying === 'loop');
  $('m-loopaud').textContent = mLoopAudio ? '♪ Audio ON' : '♪ Audio OFF';
  $('m-loopaud').classList.toggle('pri', mLoopAudio);
  $('m-golen').textContent = (mLen % 1 ? mLen.toFixed(1) : mLen) + 's';
  $('m-mark').disabled = !src;

  // the editor for a selected mark
  const sel = mSel ? (S.ramps || []).find(x => x.id === mSel) : null;
  if (!sel) mSel = null;
  $('m-edit').hidden = !sel;
  if (sel) {
    $('m-elen').textContent = sel.len + 's' + (Math.abs(rateOf(sel) - 1) > 0.001 ? ' · ' + fmtRate(rateOf(sel)) : '');
    $('m-eat').textContent = fmt(sel.start);
    if (Math.abs(parseFloat($('m-lenfield').value) - sel.len) > 0.05) {
      $('m-lenfield').value = sel.len; $('m-lenval').textContent = sel.len.toFixed(1) + 's';
    }
  }

  // the list of his moments
  const list = $('m-list'); list.innerHTML = '';
  const rs = S.ramps || [];
  if (!rs.length) {
    const d = document.createElement('div'); d.className = 'mempty';
    d.innerHTML = src && aud
      ? 'Nothing marked yet — your whole video is sped up to fit the audio.<br>Scrub to a moment and tap the green button.'
      : 'Add a video and an audio bed on a computer first.';
    list.appendChild(d);
  }
  rs.forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'mitem real' + (r.id === mSel ? ' sel' : '');
    d.innerHTML = `<span><b>${r.len}s ${fmtRate(rateOf(r))}</b> <span class="w">at ${fmt(r.start)}</span></span>
                   <span class="w">${r.id === mSel ? 'editing' : 'tap to edit'}</span>`;
    d.onclick = () => { mSel = (mSel === r.id) ? null : r.id;
                        if (mSel) { mv.currentTime = r.start; if (mLoopOn) mStartLoop(); }
                        else if (mPlaying === 'loop') mRetargetLoop();
                        mSaveView(); mPaint(); };
    list.appendChild(d);
  });
}

/* ---- the MINI EDITOR, opened inside the OUTPUT list ----
   Josh, 2026-09-09: "when I'm in the output section and I click on one of mine, then
   I should almost open up like a mini editor where I can change the audio, change the
   start time, change the duration... just to make it really easy on my brain."
   The AUDIO anchor is the important one — it decides how hard the video before it is
   squeezed. */
let mMiniOpen = null;
function mMiniEditor(g) {
  const r = (S.ramps || []).find(x => x.id === g.id);
  const box = document.createElement('div');
  box.className = 'mmini';
  if (!r) { box.textContent = 'that moment is gone'; return box; }

  const row = (label, value, step, onSet, nudges) => {
    const wrap = document.createElement('div');
    const line = document.createElement('div'); line.className = 'mmrow';
    const l = document.createElement('div'); l.className = 'mmlab'; l.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'mmval'; inp.step = step; inp.value = (+value).toFixed(2);
    inp.inputMode = 'decimal';
    const commit = () => { const v2 = parseFloat(inp.value); if (isFinite(v2)) onSet(v2); };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    line.appendChild(l); line.appendChild(inp);
    wrap.appendChild(line);
    const nb = document.createElement('div'); nb.className = 'mmnudge';
    nudges.forEach(n => {
      const b = document.createElement('button');
      b.textContent = (n > 0 ? '+' : '') + n;
      b.onclick = () => onSet(+value + n);
      nb.appendChild(b);
    });
    wrap.appendChild(nb);
    return wrap;
  };

  const push = patch => {
    api('/api/ramp/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id, ...patch }) })
      .then(() => refresh()).then(() => mPaint())
      .catch(e => toast(e.message, true));
  };

  const hdr = document.createElement('div');
  hdr.className = 'meh';
  hdr.innerHTML = `Everything before this is squeezed into <b>${(r.audioAt || 0).toFixed(2)}s</b> of audio`;
  box.appendChild(hdr);

  box.appendChild(row('IN AUDIO', r.audioAt || 0, '0.1',
    v => push({ audioAt: Math.max(0, v) }), [-5, -1, -0.5, 0.5, 1, 5]));
  box.appendChild(row('IN VIDEO', r.start, '0.1',
    v => push({ start: Math.max(0, v) }), [-5, -1, -0.5, 0.5, 1, 5]));
  box.appendChild(row('LASTS', r.len, '0.1',
    v => push({ len: Math.max(0.1, v) }), [-1, -0.5, 0.5, 1]));
  box.appendChild(row('RATE ×', rateOf(r), '0.05',
    v => push({ rate: Math.max(0.05, v) }), [-0.5, -0.25, 0.25, 0.5]));

  const foot = document.createElement('div'); foot.className = 'mmfoot';
  const preview = document.createElement('button');
  preview.textContent = '▶ Play from here';
  preview.onclick = () => {
    mStopAll();
    mBothPos = Math.max(0, (r.audioAt || 0) - 1.5);
    const a = mEnsureAudio(); if (a) a.currentTime = mBothPos;
    mPlayBoth();
  };
  const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Remove';
  del.onclick = async () => {
    await api('/api/ramp', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id }) });
    mMiniOpen = null; await refresh(); mPaint();
  };
  const done = document.createElement('button'); done.className = 'done'; done.textContent = 'Done';
  done.onclick = () => { mMiniOpen = null; mPaint(); };
  foot.appendChild(preview); foot.appendChild(del); foot.appendChild(done);
  box.appendChild(foot);
  return box;
}

/* ---- FILES: the raw assets, played plainly ----
   His: "where I could just view the whole video or listen to the audio on its own."
   Deliberately dumb — real controls, whole file, no chunk logic anywhere near it. */
function mRenderFiles() {
  const mk = (parent, name, meta, el) => {
    const d = document.createElement('div'); d.className = 'mfile';
    const n = document.createElement('div'); n.className = 'mfname'; n.textContent = name;
    const m = document.createElement('div'); m.className = 'mfmeta'; m.textContent = meta;
    d.appendChild(n); d.appendChild(m); d.appendChild(el);
    parent.appendChild(d);
  };
  const vb = $('m-fvideos'); vb.innerHTML = '';
  if (!S.sources.length) vb.innerHTML = '<div class="mempty">no video yet</div>';
  S.sources.forEach((sc, i) => {
    const v2 = document.createElement('video');
    v2.controls = true; v2.playsInline = true; v2.preload = 'metadata';
    v2.src = `/media/proxy/${sc.proxy}`;
    mk(vb, `${i + 1}. ${sc.name}`,
       `${fmt(sc.duration || 0)}${sc.ready ? '' : ' · still preparing'}`, v2);
  });
  const ab = $('m-faudios'); ab.innerHTML = '';
  if (!S.audio.length) ab.innerHTML = '<div class="mempty">no audio yet</div>';
  S.audio.forEach((a, i) => {
    const a2 = document.createElement('audio');
    a2.controls = true; a2.preload = 'metadata';
    a2.src = `/media/audio/${a.file}`;
    mk(ab, `${i + 1}. ${a.name}`, fmt(a.duration || 0), a2);
  });
}

/* ---- WHERE HE WAS: saved with the project, shared phone <-> desktop ----
   Josh, 2026-09-09: "whenever I went back to that site it would pick up wherever
   I left off... whether I'm on my phone or the machine, it should all be pulling
   from the same place."
   DEBOUNCED: the loop repaints ~60fps; this must not write at that rate. */
let mViewTimer = null, mRestoring = false;
function mSaveView(immediate) {
  if (mRestoring) return;                     // never echo back what we just restored
  clearTimeout(mViewTimer);
  const send = () => {
    const body = {
      videoPos: mVideoPos(), chunkStart: mChunkStart, chunkLen: mLen,
      audioPos: mAudioStart,
      selected: mSel, screen: mScreen, loopAudio: mLoopAudio,
    };
    api('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }).catch(() => {});
  };
  if (immediate) send(); else mViewTimer = setTimeout(send, 700);
}
function mRestoreView() {
  const v = S.view; if (!v) return;
  mRestoring = true;
  mLen = Math.max(0.1, Math.min(120, v.chunkLen || 2));
  $('m-lenfield').value = mLen;
  $('m-lenval').textContent = mLen.toFixed(1) + 's';
  [...$('m-lens').children].forEach(c => c.classList.toggle('on', +c.dataset.len === mLen));
  mChunkStart = mClampStart(v.chunkStart || 0);
  mLoopAudio = !!v.loopAudio;
  // only restore a selection that still exists
  mSel = (v.selected && (S.ramps || []).some(r => r.id === v.selected)) ? v.selected : null;
  // put the picture back where he left it
  const at = mVideoAt(v.videoPos || mChunkStart);
  if (at) {
    const url = `/media/proxy/${at.src.proxy}`;
    const seek = () => { mv.currentTime = at.into; mPaint(); };
    if (!mv.src.endsWith(url)) { mv.src = url; mv.addEventListener('loadeddata', seek, { once: true }); }
    else if (mv.readyState >= 2) seek(); else mv.addEventListener('loadeddata', seek, { once: true });
  }
  mAudioStart = Math.max(0, v.audioPos || 0);
  const a = mEnsureAudio();
  if (a && mAudioStart) {
    const put = () => { try { a.currentTime = mAudioStart; } catch {} };
    if (a.readyState >= 1) put(); else a.addEventListener('loadedmetadata', put, { once: true });
  }
  if (v.screen === 'output' || v.screen === 'files') {
    mScreen = v.screen;
    $('m-screen-in').hidden    = true;
    $('m-screen-out').hidden   = v.screen !== 'output';
    $('m-screen-files').hidden = v.screen !== 'files';
    $('m-nav-in').classList.remove('on');
    $('m-nav-out').classList.toggle('on',   v.screen === 'output');
    $('m-nav-files').classList.toggle('on', v.screen === 'files');
    if (v.screen === 'files') mRenderFiles();
  }
  setTimeout(() => { mRestoring = false; }, 400);
}

/* ---- boot ---- */
function mBoot() {
  if (!isMobile()) { $('mobile').hidden = true; return; }
  $('mobile').hidden = false;
  // a phone only ever does speed mode
  if (mode !== 'ramp') setMode('ramp');
  const src = mSrc();
  if (src) {
    const url = `/media/proxy/${src.proxy}`;
    if (!mv.src.endsWith(url)) mv.src = url;
  }
  mEnsureAudio();
  mRestoreView();          // pick up wherever he left off — his phone or his desk
  mPaint();
  if (mScreen === 'input' && mLoopOn) {
    if (mv.readyState >= 2) mStartLoop();
    else mv.addEventListener('loadeddata', () => mStartLoop(), { once: true });
  }
}

// length picker
M_LENS.forEach(n => {
  const b = document.createElement('button');
  b.textContent = n + 's';
  b.dataset.len = n;
  b.onclick = () => mSetLen(n);
  if (n === mLen) b.classList.add('on');
  $('m-lens').appendChild(b);
});
// typed duration — commit on change/blur/Enter, not on every keystroke
const mLenField = $('m-lenfield');
const mCommitLen = () => { const v2 = parseFloat(mLenField.value);
  if (isFinite(v2)) mSetLen(v2, true); else mLenField.value = mLen; };
mLenField.addEventListener('change', mCommitLen);
mLenField.addEventListener('blur', mCommitLen);
mLenField.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mLenField.blur(); } });

/* Chunk length: the presets are shortcuts, the SLIDER is the real control.
   Josh: "the size of the chunk is all hard-coded to five options. I should have a
   purely custom option as well... a slider bar and then a purely custom option." */
function mSetLen(n, fromField) {
  mLen = Math.max(0.1, Math.min(120, +(+n).toFixed(2)));
  mChunkStart = mClampStart(mChunkStart, mLen);   // a longer chunk must still fit
  $('m-lenval').textContent = mLen.toFixed(1) + 's';
  if (!fromField) $('m-lenfield').value = mLen;
  // a preset lights up only when it matches exactly; otherwise this is a custom length
  [...$('m-lens').children].forEach(c => c.classList.toggle('on', +c.dataset.len === mLen));
  if (mSel) mEditSel({ len: mLen });
  else if (mPlaying === 'loop') mRetargetLoop();
  mSaveView();
  mPaint();
}

let mWasLooping = false;
/* Coalesced scrub seeking. One seek in flight at a time; while it runs we only
   remember the newest target, then chase it on `seeked`. That keeps the picture
   on the thumb instead of queueing a backlog the decoder can't clear. */
let mSeekTarget = null, mSeekBusy = false;
function mPumpSeek() {
  if (mSeekBusy || mSeekTarget == null) return;
  const t = mSeekTarget; mSeekTarget = null;
  const hit = mVideoAt(t);
  if (!hit) return;
  const url = `/media/proxy/${hit.src.proxy}`;
  const go = () => {
    mSeekBusy = true;
    const done = () => { mSeekBusy = false; mPaint(); mPumpSeek(); };   // chase the newest
    mv.addEventListener('seeked', done, { once: true });
    setTimeout(() => { if (mSeekBusy) { mSeekBusy = false; mPumpSeek(); } }, 250);  // never wedge
    mv.currentTime = hit.into;
  };
  if (!mv.src.endsWith(url)) { mv.src = url; mv.addEventListener('loadeddata', go, { once: true }); }
  else go();
}

wireTrack('m-vbar', f => {
  const total = mVideoTotal(); if (!total) return;
  if (mSel) { mSel = null; }              // scrubbing means "hunting", not editing
  // PREVIEW WHILE DRAGGING: stop the loop driving the clock so the picture can
  // follow the finger, and pause so each seek actually renders a frame.
  if (mPlaying === 'loop') { mWasLooping = true; mPlaying = null;
                             cancelAnimationFrame(mRAF); mRAF = null;
                             mv.pause(); if (mAudio) mAudio.pause(); }
  mChunkStart = mClampStart(f * total);        // ONLY a drag moves it — always valid
  mSeekTarget = mChunkStart;
  mPumpSeek();
  mPaint();
}, () => {                                 // released — pick the loop back up here
  if (mWasLooping || mLoopOn) { mWasLooping = false; mStartLoop(); }
  mSaveView();
  mPaint();
});
wireTrack('m-abar', f => {
  const a = mEnsureAudio(); if (!a) return;
  const dur = a.duration || mAudioTotalAll(); if (!dur) return;
  mAudioStart = Math.max(0, Math.min(dur - 0.05, f * dur));   // HIS position
  a.currentTime = mAudioStart;
  mPaint();
}, () => { mSaveView(); });

/* Skip buttons — move the CHUNK by a fixed amount. Same clamp as the drag, so the
   chunk stays valid; the loop follows without stopping. */
function mSkip(sec) {
  const total = mVideoTotal(); if (!total) return;
  if (mSel) {                                    // editing a mark? move the MARK
    const r = (S.ramps || []).find(x => x.id === mSel);
    if (r) { mEditSel({ start: r.start + sec }); return; }
  }
  mChunkStart = mClampStart(mChunkStart + sec);
  mSeekTarget = mChunkStart; mPumpSeek();
  if (mPlaying === 'loop') mRetargetLoop();
  mSaveView();
  mPaint();
}
/* Two independent sets: the video row moves the CHUNK, the audio row moves the BED.
   His layout: "the top one's the video frame with buttons directly underneath it to
   control the video where it's starting, and then same thing for the audio." */
[...document.querySelectorAll('.mskip .sk[data-skip]')].forEach(b => {
  b.onclick = () => mSkip(+b.dataset.skip);
});
[...document.querySelectorAll('.mskip .sk[data-askip]')].forEach(b => {
  b.onclick = () => mSkipAudio(+b.dataset.askip);
});
function mSkipAudio(sec) {
  const a = mEnsureAudio(); if (!a) return;
  const dur = a.duration || mAudioTotalAll(); if (!dur) return;
  mAudioStart = Math.max(0, Math.min(dur - 0.05, mAudioStart + sec));
  a.currentTime = mAudioStart;
  mSaveView();
  mPaint();
}

$('m-loop').onclick = () => {
  if (mPlaying === 'loop' && !mBlocked) { mLoopOn = false; mStopAll(); }
  else { mLoopOn = true; mBlocked = false; mStopAll(); mStartLoop(); mPaint(); }
};
// tapping the video itself also starts/stops the loop — the biggest target on screen
$('mv').onclick = () => $('m-loop').click();
/* Audio is ON or OFF, period (his call). When ON it loops WITH the video so he
   can hear whether the picture matches the words at that spot. */
$('m-loopaud').onclick = () => {
  mLoopAudio = !mLoopAudio;
  if (mLoopAudio && mPlaying !== 'loop') { mLoopOn = true; mBlocked = false; mStopAll(); mStartLoop(); }
  else mSyncLoopAudio(true);              // this tap IS the user gesture
  mSaveView(true);
  mPaint();
};
$('m-mark').onclick = mMark;
$('m-e-back').onclick  = () => { const r = (S.ramps||[]).find(x=>x.id===mSel); if (r) mEditSel({ start: r.start - 0.25 }); };
$('m-e-fwd').onclick   = () => { const r = (S.ramps||[]).find(x=>x.id===mSel); if (r) mEditSel({ start: r.start + 0.25 }); };
$('m-e-short').onclick = () => { const r = (S.ramps||[]).find(x=>x.id===mSel); if (r) mEditSel({ len: r.len - 0.5 }); };
$('m-e-long').onclick  = () => { const r = (S.ramps||[]).find(x=>x.id===mSel); if (r) mEditSel({ len: r.len + 0.5 }); };
$('m-e-del').onclick   = mDeleteSel;
$('m-e-done').onclick  = () => { mSel = null; mPaint(); };
/* Two screens, switched from the bottom like a normal app (his revision,
   2026-09-09: "I think I'm going to need its own output screen... input and
   output mode selectable at the bottom, like a normal web app").
   INPUT = line it up precisely and mark it. OUTPUT = see the whole thing. */
function mShow(which) {
  mScreen = which;
  mStopAll();
  $('m-screen-in').hidden    = which !== 'input';
  $('m-screen-out').hidden   = which !== 'output';
  $('m-screen-files').hidden = which !== 'files';
  $('m-nav-in').classList.toggle('on',    which === 'input');
  $('m-nav-out').classList.toggle('on',   which === 'output');
  $('m-nav-files').classList.toggle('on', which === 'files');
  if (which === 'files') mRenderFiles();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (which === 'input' && mLoopOn) mStartLoop();   // the input is always looping
  mSaveView(true);
  mPaint();
}
$('m-nav-in').onclick  = () => mShow('input');
$('m-nav-out').onclick = () => mShow('output');
$('m-nav-files').onclick = () => mShow('files');
$('m-o-play').onclick  = () => mPlaying === 'both' ? mStopAll() : mPlayBoth();
$('m-o-stop').onclick  = mStopAll;
wireTrack('m-obar', f => {
  // scrub the OUTPUT: jump straight to that moment of the finished thing
  if (!plan || !plan.ok) return;
  const end = outLength(); if (!end) return;
  mStopAll();
  mBothPos = f * end;
  const a = mEnsureAudio(); if (a) a.currentTime = mBothPos;
  const hit = rampAt(mBothPos);
  if (hit) {
    const url = `/media/proxy/${hit.src.proxy}`;
    if (!mv.src.endsWith(url)) mv.src = url;
    const seek = () => { mv.currentTime = hit.at; mPaint(); };
    if (mv.readyState >= 2) seek(); else mv.addEventListener('loadeddata', seek, { once: true });
  }
  mPaint();
});

MOBILE_Q.addEventListener('change', () => { mStopAll(); mBoot(); });
// flush on the way out — a phone backgrounding the tab must not lose his spot
document.addEventListener('visibilitychange', () => { if (document.hidden && isMobile()) mSaveView(true); });
window.addEventListener('pagehide', () => { if (isMobile()) mSaveView(true); });
mv.addEventListener('loadeddata', mPaint);
setInterval(() => { if (isMobile() && mPlaying) mPaint(); }, 120);
setInterval(() => { if (isMobile() && mPlaying === 'loop') mSaveView(); }, 5000);

// Explicit boot. refresh() runs above this module and its mBoot() call only lands
// after this file finishes evaluating; don't rely on that timing.
mBoot();
